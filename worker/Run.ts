import { DurableObject } from 'cloudflare:workers'
import { privateKeyToAccount } from 'viem/accounts'
import * as Admission from '../src/Admission.ts'
import * as Branch from '../src/Branch.ts'
import * as Atif from '../src/Atif.ts'
import * as Bootstrap from '../src/Bootstrap.ts'
import * as Budget from '../src/Budget.ts'
import * as Config from '../src/Config.ts'
import * as E2b from '../src/E2b.ts'
import * as Eval from '../src/Eval.ts'
import * as Fallback from '../src/Fallback.ts'
import * as Gateway from '../src/Gateway.ts'
import * as Harbor from '../src/Harbor.ts'
import * as Hold from '../src/Hold.ts'
import * as Installed from '../src/Installed.ts'
import * as Judge from '../src/Judge.ts'
import * as Ledger from '../src/Ledger.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Logins from '../src/Logins.ts'
import * as Opening from '../src/Opening.ts'
import * as Pace from '../src/Pace.ts'
import * as Payment from '../src/Payment.ts'
import * as Pins from '../src/Pins.ts'
import * as Members from '../src/Pool.ts'
import * as Preflight from '../src/Preflight.ts'
import * as Price from '../src/Price.ts'
import * as Protocol from '../src/Protocol.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Result from '../src/Result.ts'
import * as Retry from '../src/Retry.ts'
import * as Route from '../src/Route.ts'
import type * as Runs from '../src/Runs.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as SqlSetup from '../src/Sql.ts'
import * as Timeline from '../src/Timeline.ts'
import * as Turn from '../src/Turn.ts'
import * as Verdict from '../src/Verdict.ts'
import * as Blobs from './Blobs.ts'
import type { Env } from './Env.ts'
import * as Evals from './Evals.ts'
import * as Harness from './Harness.ts'
import type * as Meter from './Meter.ts'
import * as Model from './Model.ts'
import * as PoolObject from './Pool.ts'
import * as Sessions from './Sessions.ts'
import * as Storage from './Storage.ts'
import * as Vault from './Vault.ts'

type SandboxRow = {
  capabilities: string | null
  created_at: number
  error: string | null
  expires_at: number | null
  handle: string | null
  id: number
  member: number | null
  paid_until: number | null
  runner: number | null
  state: 'closed' | 'creating' | 'ending' | 'failed' | 'kept' | 'ready' | 'starting' | 'unknown'
}

type RunnerRow = {
  capabilities: string | null
  drained: string | null
  ends_at: number | null
  error: string | null
  id: number
  registered_at: number
  report: string | null
  sandbox: number | null
  seen_at: number
  state: 'left' | 'lost' | 'ready' | 'refused' | 'starting'
}

type KeyRead = Gateway.KeyUsage & { at: number }

type Meta = {
  cancelled: boolean
  createdAt: number
  eval: { name: string; version: string }
  finishedAt: number | null
  harness?: string
  id: string
  key?: {
    end?: KeyRead
    error?: string
    funded?: { at: number }
    funding?: Gateway.Funding & { at: number }
    fundingError?: string
    start?: KeyRead
  }
  location?: string
  opening?: Opening.Failed
  publicUrl: string
  refused?: { at: number; message: string; plan?: true }
  reruns: string[]
  restranded?: true
  runnerToken: string
  starvedAt?: number
  strandedAt?: number
}

type Lineage = {
  attempts: Ledger.retries.Parent[]
  eval: { name: string; version: string }
  id: string
}

const agentEvents = 'agent/events.jsonl'
const agentTrajectory = 'agent/trajectory.json'
const judgeRequest = 'verifier/' + Judge.requestFile
const judgeResponse = 'verifier/' + Judge.responseFile
const judgePath = 'judge/'
const asking: readonly Ledger.Phase[] = ['attach', 'claimed', 'run']
const judgeRequestId = 'judge'
const modelRequests = 'agent/model-requests.jsonl'
const partCharacters = 524_288
const requestId = 'attempt'
const verifierLog = 'verifier/test-stdout.txt'
const version = '0.2.0'

const tables = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS tasks (name TEXT PRIMARY KEY, body TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS sandboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL,
    handle TEXT,
    capabilities TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    error TEXT,
    runner INTEGER,
    paid_until INTEGER,
    member INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sandbox INTEGER,
    state TEXT NOT NULL,
    capabilities TEXT,
    registered_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    report TEXT,
    error TEXT,
    ends_at INTEGER,
    drained TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    usd REAL NOT NULL,
    detail TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    attempt TEXT NOT NULL,
    name TEXT NOT NULL,
    part INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (attempt, name, part)
  )`,
  'CREATE TABLE IF NOT EXISTS binary_artifacts (attempt TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (attempt, name))',
  `CREATE TABLE IF NOT EXISTS model_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt TEXT NOT NULL,
    claim INTEGER NOT NULL,
    at INTEGER NOT NULL,
    path TEXT NOT NULL,
    ms INTEGER,
    status INTEGER,
    usage TEXT,
    cost REAL,
    refusal TEXT,
    searches INTEGER,
    tools_usd REAL,
    unpriced INTEGER,
    wait INTEGER,
    listed INTEGER,
    again INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS model_flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt TEXT NOT NULL,
    claim INTEGER NOT NULL,
    at INTEGER NOT NULL,
    instance TEXT NOT NULL
  )`,
  'CREATE TABLE IF NOT EXISTS model_pace (model TEXT PRIMARY KEY, next_at REAL NOT NULL)',
  'CREATE TABLE IF NOT EXISTS model_paced (attempt TEXT NOT NULL, claim INTEGER NOT NULL, requests INTEGER NOT NULL, held REAL NOT NULL, PRIMARY KEY (attempt, claim))',
  ...Ledger.tables,
  ...Payment.tables,
  ...Timeline.tables,
]

const json = Storage.json
const message = Storage.message

type Settled = Proxy.Session & {
  admit?: { waitedMs: number }
  outcome?: Meter.Outcome
  pace?: true
  path?: string
  provider?: Proxy.Provider
  refused?: Meter.Refused
  released?: number
}

function detail(text: string): string {
  let found: unknown
  try {
    found = (JSON.parse(text) as { detail?: unknown } | null)?.detail
  } catch {
    found = undefined
  }
  return (typeof found === 'string' && found ? found : text).slice(0, 500)
}

function over(row: Pick<SandboxRow, 'expires_at' | 'paid_until'>): boolean {
  return Math.min(row.paid_until ?? Infinity, row.expires_at ?? Infinity) <= Date.now()
}

function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function same(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', Bytes.fromText(left) as Uint8Array<ArrayBuffer>),
    crypto.subtle.digest('SHA-256', Bytes.fromText(right) as Uint8Array<ArrayBuffer>),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

class Refusal extends Error {
  override name = 'Run.Refusal'
  readonly status: number
  constructor(status: number, text: string) {
    super(text)
    this.status = status
  }
}

export class Run extends DurableObject<Env> {
  private attended = false
  private readonly creating = new Set<number>()
  private readonly cursors = new Map<string, number>()
  private readonly holds = Hold.create()
  private readonly instance = secret()
  private readonly specs = new Map<string, Eval.Task>()
  private readonly sql: SqlSetup.Sql
  private ticking: Promise<void> | undefined
  private readonly wallet: Payment.Wallet

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = Storage.sql(ctx)
    SqlSetup.setup(this.sql, tables)
    this.wallet = Payment.wallet(Payment.stored(this.sql))
    const columns = this.sql.all('PRAGMA table_info(sandboxes)')
    if (!columns.some((column) => column['name'] === 'paid_until'))
      this.sql.run('ALTER TABLE sandboxes ADD COLUMN paid_until INTEGER')
    if (!columns.some((column) => column['name'] === 'member'))
      this.sql.run('ALTER TABLE sandboxes ADD COLUMN member INTEGER')
    const added: [table: string, column: string, type: string][] = [
      ['claims', 'error', 'TEXT'],
      ['model_requests', 'again', 'INTEGER'],
      ['model_requests', 'cost', 'REAL'],
      ['model_requests', 'listed', 'INTEGER'],
      ['model_requests', 'refusal', 'TEXT'],
      ['model_requests', 'searches', 'INTEGER'],
      ['model_requests', 'tools_usd', 'REAL'],
      ['model_requests', 'unpriced', 'INTEGER'],
      ['model_requests', 'wait', 'INTEGER'],
      ['runners', 'drained', 'TEXT'],
      ['runners', 'ends_at', 'INTEGER'],
    ]
    for (const [table, column, type] of added)
      if (!this.sql.all('PRAGMA table_info(' + table + ')').some((row) => row['name'] === column))
        this.sql.run('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type)
  }

  override async fetch(request: Request): Promise<Response> {
    const response = await this.answer(request)
    if (!request.bodyUsed) await request.body?.pipeTo(new WritableStream())
    return response
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    try {
      if (request.method === 'POST' && parts[0] === 'create')
        return await this.create(request, url.searchParams)
      const meta = this.meta()
      if (!meta) return json({ error: 'run not found' }, 404)
      if (parts[0] === 'model') return await this.model(request, parts.slice(1), url.search)
      if (request.method === 'POST' && parts[0] === 'metered')
        return json(this.settled((await request.json()) as Settled))
      if (parts[0] === 'runner') {
        const header = request.headers.get('authorization') ?? ''
        if (!(await same(header, 'Bearer ' + meta.runnerToken)))
          return json({ error: 'unauthorized' }, 401)
        return await this.runner(request, parts.slice(1))
      }
      if (request.method === 'GET' && parts[0] === 'status') return json(this.status())
      if (request.method === 'GET' && parts[0] === 'harbor') return json(this.harbor())
      if (request.method === 'GET' && parts[0] === 'config') return json(this.config())
      if (request.method === 'GET' && parts[0] === 'counts')
        return json({ counts: this.counts(), finishedAt: meta.finishedAt })
      if (request.method === 'GET' && parts[0] === 'timeline')
        return json({ createdAt: meta.createdAt, id: meta.id, marks: Timeline.all(this.sql) })
      if (request.method === 'GET' && parts[0] === 'results')
        return json({
          attempts: this.results(),
          eval: meta.eval,
          id: meta.id,
          name: this.config().name,
          nanocode: this.pins(),
          state: meta.finishedAt === null ? 'running' : 'finished',
        })
      if (request.method === 'GET' && parts[0] === 'lineage')
        return json({
          attempts: Ledger.all(this.sql).map((row) => ({
            agent: row.agent,
            id: row.id,
            n: row.n,
            ...(row.result ? { outcome: (JSON.parse(row.result) as Result.Attempt).outcome } : {}),
            task: row.task,
          })),
          eval: meta.eval,
          id: meta.id,
        } satisfies Lineage)
      if (request.method === 'POST' && parts[0] === 'reruns') {
        const { id } = (await request.json()) as { id: string }
        this.setMeta({ ...meta, reruns: [...meta.reruns, id] })
        return json({ ok: true })
      }
      if (request.method === 'POST' && parts[0] === 'runners')
        return json(this.attach((await request.json().catch(() => ({}))) as Protocol.Attach), 201)
      if (request.method === 'POST' && parts[0] === 'cancel') {
        this.setMeta({ ...meta, cancelled: true })
        this.wake()
        this.ctx.waitUntil(this.tick())
        return json({ cancelled: true })
      }
      if (request.method === 'GET' && parts[0] === 'attempts' && parts[1]) {
        const row = Ledger.get(this.sql, decodeURIComponent(parts[1]))
        if (!row)
          return json(
            {
              error:
                'the run has no attempt ' +
                decodeURIComponent(parts[1]) +
                ': its attempts are named as status lists them, a00001 and on',
            },
            404,
          )
        if (parts[2] === 'artifacts' && parts[3]) {
          const name = decodeURIComponent(parts[3])
          const body = this.artifact(row.id, name) ?? (await this.live(row, name))
          return body === undefined
            ? json({ error: this.absent(row, name) }, 404)
            : new Response(body as string | Uint8Array<ArrayBuffer>, {
                headers: {
                  'content-type':
                    typeof body === 'string'
                      ? 'text/plain; charset=utf-8'
                      : 'application/octet-stream',
                },
              })
        }
        return json({
          artifacts: [...new Set([...this.artifactNames(row.id), ...this.liveNames(row)])].sort(),
          attempt: this.view(row),
          claims: Ledger.claims(this.sql, row.id).map((claim) => ({
            claimedAt: claim.claimed_at,
            endedAt: claim.ended_at,
            ending: claim.ending,
            ...(claim.error === null ? {} : { error: claim.error }),
            n: claim.n,
            phase: claim.phase,
            runner: claim.runner,
            session: claim.session,
          })),
          result: row.result ? JSON.parse(row.result) : null,
        })
      }
      return json({ error: 'route not found' }, 404)
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status)
      if (
        error instanceof Config.InvalidError ||
        error instanceof Config.UnsupportedError ||
        error instanceof Eval.InvalidError ||
        error instanceof Eval.NotFoundError
      )
        return json({ error: error.message }, 400)
      throw error
    }
  }

  override async alarm(): Promise<void> {
    await this.tick()
  }

  private async create(request: Request, params: URLSearchParams): Promise<Response> {
    if (this.meta()) return json({ error: 'the run exists' }, 409)
    const receivedAt = Date.now()
    const id = params.get('id')!
    const config = Config.parse(await request.json().catch(() => null))
    if (config.sandbox.max > 0) {
      if (
        config.sandbox.provider === 'local' &&
        !(this.env.LOCAL_SANDBOX_URL && this.env.LOCAL_SANDBOX_TOKEN)
      )
        return json(
          { error: 'the local provider needs LOCAL_SANDBOX_URL and LOCAL_SANDBOX_TOKEN' },
          400,
        )
      if (config.sandbox.provider === 'e2b' && !this.env.TEMPO_PRIVATE_KEY)
        return json({ error: 'the e2b provider needs TEMPO_PRIVATE_KEY' }, 400)
      if (config.sandbox.provider === 'gateway' && !this.env.TEMPO_KEY)
        return json({ error: 'the gateway provider needs TEMPO_KEY' }, 400)
    }
    if (config.payer === 'plan') {
      const reason = await Vault.unusable(this.env)
      if (reason !== undefined)
        return json(
          {
            error:
              'payer plan needs a Claude plan signed in on the Worker: ' +
              reason +
              ' (' +
              Config.planSignIn +
              ')',
          },
          400,
        )
    }

    const query = new URLSearchParams({ tasks: '1' })
    if (config.eval.version) query.set('digest', config.eval.version)
    for (const only of config.only ?? []) query.append('only', only)
    if (config.limit !== undefined) query.set('limit', String(config.limit))
    const found = await Evals.object(this.env, config.eval.name).fetch(
      'https://eval.internal/version?' + query.toString(),
    )
    if (!found.ok)
      return json(
        {
          error:
            'the eval ' +
            config.eval.name +
            ' cannot be read: ' +
            ((await found.json()) as { error: string }).error +
            '. nanoeval evals lists the evals of this Worker, and nanoeval import makes one',
        },
        400,
      )
    const snapshot = (await found.json()) as { tasks: Eval.Task[]; version: Eval.Version }
    const solved = Config.oracle(config) !== undefined
    let tasks = snapshot.tasks.map((task) => (solved ? task : Eval.withoutSolution(task)))

    let seeds: Ledger.Seed[] = []
    if (config.rerun) {
      const parent = await this.env.RUNS.get(this.env.RUNS.idFromName(config.rerun.run)).fetch(
        'https://run.internal/lineage',
      )
      if (!parent.ok) return json({ error: 'the run ' + config.rerun.run + ' is not found' }, 400)
      const lineage = (await parent.json()) as Lineage
      if (
        lineage.eval.name !== config.eval.name ||
        lineage.eval.version !== snapshot.version.digest
      )
        return json(
          {
            error:
              'a rerun uses the eval version of its run, ' +
              lineage.eval.name +
              '@' +
              lineage.eval.version,
          },
          400,
        )
      const names = new Set(tasks.map((task) => task.name))
      const agents = new Set(config.agents.map((agent) => agent.id))
      seeds = Ledger.retries(
        { attempts: lineage.attempts, run: lineage.id },
        config.rerun.select,
      ).filter((seed) => names.has(seed.task) && agents.has(seed.agent))
      if (!seeds.length)
        return json({ error: 'the run has no ' + config.rerun.select + ' attempt to rerun' }, 400)
      const wanted = new Set(seeds.map((seed) => seed.task))
      tasks = tasks.filter((task) => wanted.has(task.name))
    }
    Config.check(config, tasks)
    if (!config.rerun)
      for (let n = 1; n <= config.attempts; n++)
        for (const task of tasks)
          for (const agent of config.agents) seeds.push({ agent: agent.id, n, task: task.name })

    const byName = new Map(tasks.map((task) => [task.name, Config.bounded(config.limits, task)]))
    const longest =
      config.sandbox.provider === 'e2b'
        ? E2b.maxTimeoutSec
        : config.sandbox.provider === 'gateway'
          ? Gateway.maxTimeoutSec
          : undefined
    if (
      config.sandbox.max > 0 &&
      longest !== undefined &&
      config.sandbox.timeoutSec !== undefined &&
      config.sandbox.timeoutSec > longest
    )
      return json(
        {
          error:
            'the ' +
            config.sandbox.provider +
            ' provider keeps a sandbox for at most ' +
            longest +
            ' s, and the run asks for ' +
            config.sandbox.timeoutSec +
            ': name ' +
            longest +
            ' s or less, and the run opens another sandbox for the rows that one cannot finish',
        },
        400,
      )
    const timeoutSec =
      config.sandbox.timeoutSec ??
      Math.min(
        config.sandbox.warm && config.sandbox.provider === 'gateway'
          ? Gateway.maxTimeoutSec
          : Config.lifetimeSec(
              config,
              seeds.map((seed) => byName.get(seed.task)!),
            ) + (config.sandbox.warm?.idleSec ?? 0),
        longest ?? Infinity,
      )

    this.ctx.storage.transactionSync(() => {
      this.sql.run(
        'INSERT INTO meta (key, value) VALUES (?, ?)',
        'config',
        JSON.stringify({
          ...config,
          eval: { name: config.eval.name, version: snapshot.version.digest },
          sandbox: { ...config.sandbox, timeoutSec },
        }),
      )
      for (const task of tasks)
        this.sql.run(
          'INSERT INTO tasks (name, body) VALUES (?, ?)',
          task.name,
          JSON.stringify(task),
        )
      Ledger.create(this.sql, seeds)
      Timeline.add(this.sql, { at: receivedAt, ms: Date.now() - receivedAt, name: 'run.created' })
      this.setMeta({
        cancelled: false,
        createdAt: receivedAt,
        eval: { name: config.eval.name, version: snapshot.version.digest },
        finishedAt: null,
        harness: Sessions.revision,
        id,
        ...(params.get('location') ? { location: params.get('location')! } : {}),
        publicUrl: params.get('url')!,
        reruns: [],
        runnerToken: secret(),
      })
    })
    if (config.rerun)
      await this.env.RUNS.get(this.env.RUNS.idFromName(config.rerun.run)).fetch(
        'https://run.internal/reruns',
        { body: JSON.stringify({ id }), method: 'POST' },
      )
    await this.list('runs', {
      attempts: seeds.length,
      createdAt: receivedAt,
      eval: { name: config.eval.name, version: snapshot.version.digest },
      id,
      name: config.name,
    } satisfies Runs.Entry)
    this.ctx.waitUntil(this.fundKey().then(() => this.readKey('start')))
    this.ctx.waitUntil(this.tick())
    return json(
      {
        attempts: seeds.length,
        eval: { name: config.eval.name, version: snapshot.version.digest },
        id,
      },
      201,
    )
  }

  private async list(path: 'runs' | 'runs/ended', body: Runs.Ended | Runs.Entry): Promise<void> {
    await Evals.object(this.env, Evals.indexName)
      .fetch('https://eval.internal/' + path, { body: JSON.stringify(body), method: 'POST' })
      .then(
        async (response) => {
          if (!response.ok)
            console.error('nanoeval run list answered', response.status, await response.text())
        },
        (error) => console.error('nanoeval run list failed', message(error)),
      )
  }

  private counts(): Runs.Counts {
    const rows = this.rows()
    const results = this.results()
    const count = (outcome: Result.Attempt['outcome']) =>
      results.filter((result) => result.outcome === outcome).length
    return {
      active: rows.filter(Ledger.active).length,
      errored: count('errored'),
      failed: count('failed'),
      passed: count('passed'),
      total: rows.length,
      unclaimed: rows.filter((row) => row.phase === 'unclaimed').length,
    }
  }

  private meta(): Meta | undefined {
    const row = this.sql.all('SELECT value FROM meta WHERE key = ?', 'run')[0]
    return row ? (JSON.parse(row['value'] as string) as Meta) : undefined
  }

  private setMeta(meta: Meta): void {
    this.sql.run(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
      'run',
      JSON.stringify(meta),
    )
  }

  private config(): Config.Config & { eval: { name: string; version: string } } {
    const row = this.sql.all('SELECT value FROM meta WHERE key = ?', 'config')[0]!
    return JSON.parse(row['value'] as string)
  }

  private task(name: string): Eval.Task {
    let spec = this.specs.get(name)
    if (!spec) {
      spec = Config.bounded(this.config().limits, this.imported(name))
      this.specs.set(name, spec)
    }
    return spec
  }

  private imported(name: string): Eval.Task {
    const row = this.sql.all('SELECT body FROM tasks WHERE name = ?', name)[0]!
    return JSON.parse(row['body'] as string) as Eval.Task
  }

  private tasks(): Eval.Task[] {
    return this.sql
      .all('SELECT name FROM tasks ORDER BY name')
      .map((row) => this.task(row['name'] as string))
  }

  private rows(): Ledger.Attempt[] {
    return Ledger.all(this.sql)
  }

  private sandboxes(): SandboxRow[] {
    return this.sql.all('SELECT * FROM sandboxes ORDER BY id') as unknown as SandboxRow[]
  }

  private runners(): RunnerRow[] {
    return this.sql.all('SELECT * FROM runners ORDER BY id') as unknown as RunnerRow[]
  }

  private update(
    table: 'runners' | 'sandboxes',
    id: number,
    fields: Record<string, SqlSetup.Value>,
  ): void {
    const names = Object.keys(fields)
    this.sql.run(
      'UPDATE ' + table + ' SET ' + names.map((name) => name + ' = ?').join(', ') + ' WHERE id = ?',
      ...names.map((name) => fields[name]!),
      id,
    )
  }

  private spent(): number {
    return (
      (this.sql.all('SELECT COALESCE(SUM(usd), 0) AS usd FROM payments')[0]!['usd'] as number) ?? 0
    )
  }

  private modelSpent(): number {
    const priced = new Set<string>()
    let total = 0
    for (const row of this.sql.all(
      'SELECT attempt, SUM(COALESCE(cost, tools_usd, 0)) AS usd, COUNT(cost) AS priced FROM model_requests GROUP BY attempt',
    )) {
      if (row['priced']) priced.add(row['attempt'] as string)
      total += row['usd'] as number
    }
    for (const row of this.rows())
      if (row.result && !priced.has(row.id)) {
        const result = JSON.parse(row.result) as Result.Attempt
        total +=
          (result.usage?.costUsd ?? 0) -
          (result.usage?.toolsUsd ?? 0) +
          (result.judge?.usage?.costUsd ?? 0)
      }
    for (const lost of Ledger.lostUsage(this.sql))
      if (!priced.has(lost.attempt)) total += (JSON.parse(lost.usage) as Atif.Usage).costUsd ?? 0
    return total
  }

  private flights(): number {
    const flights = this.sql.all('SELECT id, attempt, claim, instance FROM model_flights')
    let held = 0
    for (const flight of flights) {
      const row = Ledger.get(this.sql, flight['attempt'] as string)
      const flying = Budget.flying(
        { claim: flight['claim'] as number, instance: flight['instance'] as string },
        { claim: row && Ledger.active(row) ? row.claims : undefined, instance: this.instance },
      )
      if (flying) held++
      else this.sql.run('DELETE FROM model_flights WHERE id = ?', flight['id'] as number)
    }
    return held
  }

  private largest(): number | undefined {
    const seen = this.sql.all(
      'SELECT COUNT(*) AS responses, MAX(COALESCE(cost, tools_usd, 0)) AS usd FROM model_requests WHERE usage IS NOT NULL',
    )[0]!
    return seen['responses'] ? (seen['usd'] as number) : undefined
  }

  private held(): boolean {
    const limitUsd = this.config().budget.modelUsd
    return (
      limitUsd !== undefined &&
      Budget.held({
        flights: this.flights(),
        largestUsd: this.largest(),
        limitUsd,
        spentUsd: this.modelSpent(),
      })
    )
  }

  private admit(input: { attempt: string; claim: number; waitedMs: number }): Meter.Admission {
    const config = this.config()
    const limitUsd = config.budget.modelUsd
    if (limitUsd === undefined) return {}
    const flights = this.flights()
    const largestUsd = this.largest()
    const spentUsd = this.modelSpent()
    const admission = Budget.admit({
      flights,
      largestUsd,
      limitUsd,
      spentUsd,
      waitMs: config.limits.leaseSec * 1000,
      waitedMs: input.waitedMs,
    })
    if (admission.state === 'waiting') return { pauseMs: config.sandbox.pollMs }
    if (admission.state === 'refused') {
      if (!this.sql.all("SELECT id FROM timeline WHERE name = 'model.budget' LIMIT 1").length)
        Timeline.add(this.sql, { at: Date.now(), name: 'model.budget' })
      return {
        refused:
          'the model budget of $' +
          limitUsd +
          (admission.reason === 'spent'
            ? ' is spent: the run recorded $' + spentUsd.toFixed(6)
            : ' has $' +
              (limitUsd - spentUsd).toFixed(6) +
              ' left, and the ' +
              flights +
              (flights === 1 ? ' request' : ' requests') +
              ' in flight may spend it: the largest response of the run cost $' +
              largestUsd!.toFixed(6)),
      }
    }
    this.sql.run(
      'INSERT INTO model_flights (attempt, claim, at, instance) VALUES (?, ?, ?, ?)',
      input.attempt,
      input.claim,
      Date.now(),
      this.instance,
    )
    return {
      flight: this.sql.all('SELECT MAX(id) AS id FROM model_flights')[0]!['id'] as number,
    }
  }

  private payer(provider: 'claude' | 'codex'): Config.Payer | undefined {
    if (this.config().payer === 'plan') return 'plan'
    return Logins.held(this.env, provider) ? undefined : 'deployment'
  }

  private keyed(): boolean {
    const config = this.config()
    if (!this.env.TEMPO_KEY) return false
    if (config.sandbox.provider === 'gateway' && config.sandbox.max > 0) return true
    if (config.payer === 'plan') return false
    const users: readonly Pick<Config.Agent, 'api' | 'provider'>[] = [
      ...config.agents,
      ...(config.judge ? [config.judge] : []),
    ]
    return users.some((agent) => {
      if (agent.provider === 'oracle') return false
      const held = Model.credential(
        this.env,
        Installed.is(agent.provider)
          ? Installed.provider(agent.provider, agent.api)
          : agent.provider,
      )
      return held?.kind === 'key' && held.key === this.env.TEMPO_KEY
    })
  }

  private async fundKey(): Promise<void> {
    const funding = this.config().key
    if (!funding) return
    const meta = this.meta()!
    if (!this.keyed()) {
      this.setMeta({
        ...meta,
        key: { ...meta.key, fundingError: 'the run pays nothing with the key of the Worker' },
      })
      return
    }
    this.setMeta({ ...meta, key: { ...meta.key, funding: { ...funding, at: Date.now() } } })
    let read: NonNullable<Meta['key']>
    try {
      await Gateway.fund(
        {
          key: this.env.TEMPO_KEY!,
          ...(this.env.TEMPO_GATEWAY_URL ? { url: this.env.TEMPO_GATEWAY_URL } : {}),
        },
        funding,
      )
      read = { funded: { at: Date.now() } }
    } catch (error) {
      read = { fundingError: message(error) }
    }
    const after = this.meta()!
    this.setMeta({ ...after, key: { ...after.key, ...read } })
  }

  private async readKey(edge: 'end' | 'start'): Promise<void> {
    if (!this.keyed()) return
    let read: NonNullable<Meta['key']>
    try {
      const used = await Gateway.usage({
        key: this.env.TEMPO_KEY!,
        ...(this.env.TEMPO_GATEWAY_URL ? { url: this.env.TEMPO_GATEWAY_URL } : {}),
      })
      read = { [edge]: { ...used, at: Date.now() } }
    } catch (error) {
      read = { error: message(error) }
    }
    const meta = this.meta()!
    this.setMeta({ ...meta, key: { ...meta.key, ...read } })
  }

  private record(input: {
    attempt: string
    claim: number
    listed: boolean
    outcome: Meter.Outcome
    path: string
    provider: Proxy.Provider
  }): void {
    const { outcome } = input
    const reported = outcome.usage
    const tools = reported
      ? Proxy.tools(input.provider, reported, { listed: input.listed })
      : undefined
    const price = reported && reported.costUsd === undefined ? this.price(input) : undefined
    const usage: Proxy.Usage | undefined =
      reported && price
        ? { ...reported, costBy: 'list', costUsd: Price.usd(price, reported) + (tools?.usd ?? 0) }
        : reported
    if (outcome.flight !== undefined)
      this.sql.run('DELETE FROM model_flights WHERE id = ?', outcome.flight)
    this.sql.run(
      'INSERT INTO model_requests (attempt, claim, at, path, ms, status, usage, cost, refusal, searches, tools_usd, unpriced, wait, listed, again) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.attempt,
      input.claim,
      outcome.at,
      input.path,
      outcome.ms,
      outcome.status,
      usage ? JSON.stringify(usage) : null,
      usage?.costUsd ?? null,
      outcome.refusal ?? null,
      tools ? tools.calls : null,
      tools?.usd ?? null,
      tools ? tools.unpriced : null,
      outcome.waitMs ?? null,
      price ? 1 : null,
      outcome.again ? 1 : null,
    )
    const { refused, ...rest } = this.meta()!
    if (refused && outcome.status < 400) {
      this.setMeta(rest)
      Timeline.add(this.sql, { at: outcome.at, name: 'model.paid' })
    }
  }

  private served(input: { attempt: string; path: string }): string | undefined {
    const row = Ledger.get(this.sql, input.attempt)
    return input.path.startsWith(judgePath)
      ? this.config().judge?.model
      : row && this.agentOf(row).model
  }

  private price(input: { attempt: string; path: string }): Price.Price | undefined {
    const model = this.served(input)
    return model === undefined ? undefined : this.config().prices?.[model]
  }

  private nextAt(model: string): number | undefined {
    return this.sql.all('SELECT next_at FROM model_pace WHERE model = ?', model)[0]?.['next_at'] as
      | number
      | undefined
  }

  private pace(input: { attempt: string; claim: number; path: string }): number | undefined {
    const model = this.served(input)
    const perMin = model === undefined ? undefined : this.config().paces?.[model]
    if (model === undefined || perMin === undefined) return undefined
    const reserved = Pace.reserve({ nextAt: this.nextAt(model), now: Date.now(), perMin })
    this.sql.run(
      'INSERT OR REPLACE INTO model_pace (model, next_at) VALUES (?, ?)',
      model,
      reserved.nextAt,
    )
    if (!input.path.startsWith(judgePath))
      this.paced({ attempt: input.attempt, claim: input.claim, held: reserved.waitMs, requests: 1 })
    return reserved.waitMs > 0 ? reserved.waitMs : undefined
  }

  private paced(input: { attempt: string; claim: number; held: number; requests: number }): void {
    this.sql.run(
      'INSERT INTO model_paced (attempt, claim, requests, held) VALUES (?, ?, ?, ?) ON CONFLICT (attempt, claim) DO UPDATE SET requests = requests + excluded.requests, held = held + excluded.held',
      input.attempt,
      input.claim,
      input.requests,
      input.held,
    )
  }

  private room(input: { model: string; now: number; perMin: number }): number {
    const { model, now, perMin } = input
    if (Pace.waiting({ nextAt: this.nextAt(model), now, perMin })) return 0
    const asked = new Map(
      this.sql
        .all('SELECT attempt, claim, requests, held FROM model_paced')
        .map((paced) => [paced['attempt'] + ' ' + paced['claim'], paced]),
    )
    const rows = this.rows().filter((row) => this.agentOf(row).model === model)
    return Pace.room({
      demand: Pace.demand(
        rows.flatMap((row) => {
          const span = (JSON.parse(row.timing) as Result.Attempt['timing']).agentExecution
          const seen = asked.get(row.id + ' ' + row.claims)
          const until = row.phase === 'run' ? now : span?.finishedAt
          return span && seen && until !== undefined && until > span.startedAt
            ? [
                {
                  busyMs: until - span.startedAt - (seen['held'] as number),
                  requests: seen['requests'] as number,
                },
              ]
            : []
        }),
      ),
      perMin,
      rows: rows.filter((row) => asking.includes(row.phase)).length,
    })
  }

  private feeding(now: number): { declined(): boolean; feeds(row: Ledger.Attempt): boolean } {
    const paces = this.config().paces ?? {}
    const left = new Map<string, number>()
    let declined = false
    return {
      declined: () => declined,
      feeds: (row) => {
        const model = this.agentOf(row).model
        const perMin = paces[model]
        if (perMin === undefined) return true
        const room = left.get(model) ?? this.room({ model, now, perMin })
        left.set(model, room - 1)
        if (room <= 0) declined = true
        return room > 0
      },
    }
  }

  private refuse(refused: Meter.Refused): number | undefined {
    const config = this.config()
    const now = Date.now()
    const meta = this.meta()!
    if (refused.kind !== 'passing' && !meta.refused) {
      this.setMeta({
        ...meta,
        refused: {
          at: now,
          message: detail(refused.text),
          ...(refused.kind === 'plan' ? { plan: true as const } : {}),
        },
      })
      Timeline.add(this.sql, { at: now, name: 'model.refused' })
      this.ctx.waitUntil(this.tick())
    }
    if (refused.kind === 'plan') return undefined
    return Payment.pause({
      kind: refused.kind,
      leaseSec: config.limits.leaseSec,
      now,
      pollMs: config.sandbox.pollMs,
      refusedAt: this.meta()!.refused?.at ?? now,
      stepRetries: config.limits.stepRetries,
      tries: refused.tries,
      waitSec: config.limits.setupSec,
    })
  }

  private limited(input: {
    attempt: string
    claim: number
    limited: Meter.Limited
  }): number | undefined {
    const row = Ledger.get(this.sql, input.attempt)
    if (!row || row.claims !== input.claim || row.phase !== 'run') return undefined
    const config = this.config()
    const { retryAfterMs, tries } = input.limited
    const perMin = config.paces?.[this.agentOf(row).model]
    const pauseMs = Retry.pause({
      deadlineAt: row.deadline_at ?? 0,
      now: Date.now(),
      ...(perMin === undefined ? {} : { paceMs: Pace.interval(perMin) }),
      pollMs: config.sandbox.pollMs,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      stepRetries: config.limits.stepRetries,
      tries,
    })
    if (perMin !== undefined && pauseMs !== undefined)
      this.paced({ attempt: row.id, claim: row.claims, held: pauseMs, requests: 0 })
    return pauseMs
  }

  private refusedOut(row: Ledger.Attempt, now: number): Result.Failure | undefined {
    const refused = this.meta()!.refused
    return Retry.refused({
      now,
      requests: this.sql
        .all(
          "SELECT at, refusal, status FROM model_requests WHERE attempt = ? AND claim = ? AND status IS NOT NULL AND path NOT LIKE 'judge/%' ORDER BY id",
          row.id,
          row.claims,
        )
        .map((request) => ({
          at: request['at'] as number,
          ...(request['refusal'] === null ? {} : { refusal: request['refusal'] as Proxy.Refusal }),
          status: request['status'] as number,
        })),
      ...(refused && !refused.plan ? { spent: { at: refused.at, message: refused.message } } : {}),
      waitSec: this.config().limits.setupSec,
    })
  }

  private async unpaid(row: Ledger.Attempt, error: unknown): Promise<Refusal> {
    const reason =
      error instanceof Harness.RequestError && this.config().payer === 'plan'
        ? await Vault.unusable(this.env)
        : undefined
    if (reason === undefined) throw error
    const text =
      'the Claude plan that pays for this run gives no credential: ' +
      reason +
      ' (' +
      Config.planSignIn +
      ')'
    this.refuse({ kind: 'plan', text, tries: 0 })
    await this.complete(Ledger.get(this.sql, row.id)!, {
      failure: { at: Date.now(), kind: 'environment', message: text },
      reward: null,
    })
    return new Refusal(410, text)
  }

  private settled(body: Settled): Meter.Admission {
    if (typeof body?.attempt !== 'string' || !Ledger.get(this.sql, body.attempt))
      throw new Refusal(404, 'the run has no such attempt')
    if (body.refused) {
      const pauseMs = this.refuse(body.refused)
      if (pauseMs !== undefined) return { pauseMs }
      this.wake(body.attempt)
      return {}
    }
    if (body.admit)
      return this.admit({
        attempt: body.attempt,
        claim: Number(body.claim),
        waitedMs: Number(body.admit.waitedMs),
      })
    if (body.pace && typeof body.path === 'string') {
      const pauseMs = this.pace({
        attempt: body.attempt,
        claim: Number(body.claim),
        path: body.path,
      })
      return pauseMs === undefined ? {} : { pauseMs }
    }
    if (body.released !== undefined)
      this.sql.run('DELETE FROM model_flights WHERE id = ?', Number(body.released))
    if (body.outcome && typeof body.path === 'string')
      this.record({
        attempt: body.attempt,
        claim: Number(body.claim),
        listed: true,
        outcome: body.outcome,
        path: body.path,
        provider: body.provider === 'codex' ? 'codex' : 'claude',
      })
    return {}
  }

  private life(runner: RunnerRow): Admission.Life | undefined {
    const sandbox =
      runner.sandbox === null
        ? undefined
        : this.sandboxes().find((candidate) => candidate.id === runner.sandbox)
    const ends = [runner.ends_at, sandbox?.expires_at ?? null].filter(
      (end): end is number => end !== null,
    )
    if (!ends.length) return undefined
    return { endsAt: Math.min(...ends), startedAt: sandbox?.created_at ?? runner.registered_at }
  }

  private fitting(runner: RunnerRow, now: number): (task: string) => boolean {
    const config = this.config()
    const life = this.life(runner)
    return (task) =>
      Admission.fits({
        life,
        now,
        rowSec: Config.rowSec(config.limits, this.task(task)),
        setupSec: config.limits.setupSec,
      })
  }

  private drain(runner: RunnerRow, now: number): string | undefined {
    const life = this.life(runner)
    if (!life) return undefined
    const open = this.rows().filter((row) => row.phase !== 'done')
    const fits = this.fitting(runner, now)
    if (!open.length || open.some((row) => fits(row.task))) return undefined
    const reason =
      'its sandbox ends in ' +
      Math.max(0, Math.floor((life.endsAt - now) / 1000)) +
      ' s, and the timeouts of every row that is left pass that'
    this.update('runners', runner.id, { drained: reason })
    Timeline.add(this.sql, { at: now, name: 'runner.drain', runner: runner.id })
    return reason
  }

  private share(runner: number, capacityMb: number): Admission.Share {
    const config = this.config()
    const runners = this.runners().filter(
      (candidate) => candidate.state === 'ready' && candidate.drained === null,
    )
    const capacity = new Map(
      runners.map((candidate) => [
        candidate.id,
        (candidate.report ? (JSON.parse(candidate.report) as Protocol.Report) : undefined)?.offer
          ?.capacityMb ?? capacityMb,
      ]),
    )
    const holders = new Set<number>()
    let otherSec = 0
    let wholeSec = 0
    for (const row of this.rows()) {
      if (row.phase === 'done') continue
      const task = this.task(row.task)
      const seconds = Config.rowSec(config.limits, task)
      if (task.resources.memoryMb >= capacityMb) wholeSec += seconds
      else otherSec += (seconds * task.resources.memoryMb) / capacityMb
      if (
        row.runner !== null &&
        row.runner !== runner &&
        Ledger.active(row) &&
        task.resources.memoryMb >= (capacity.get(row.runner) ?? capacityMb)
      )
        holders.add(row.runner)
    }
    return { holders: holders.size, otherSec, runners: runners.length, wholeSec }
  }

  private provider(): Sandbox.Provider {
    const config = this.config()
    if (config.sandbox.provider === 'local')
      return Local.create({
        token: this.env.LOCAL_SANDBOX_TOKEN!,
        url: this.env.LOCAL_SANDBOX_URL!,
      })

    const budget = Budget.create({ limitUsd: config.budget.sandboxUsd, spentUsd: this.spent() })
    const onCharge = (charge: Payment.Charge) => {
      this.sql.run(
        'INSERT INTO payments (at, usd, detail) VALUES (?, ?, ?)',
        Date.now(),
        charge.usd,
        JSON.stringify(charge),
      )
    }
    if (config.sandbox.provider === 'gateway')
      return Gateway.create({
        budget,
        key: this.env.TEMPO_KEY!,
        onCall: (call) =>
          Timeline.add(this.sql, {
            at: Date.now() - call.ms,
            ms: call.ms,
            name: 'gateway.' + call.operation + (call.paid ? '.paid' : '.quote'),
          }),
        onCharge,
        ...(this.env.TEMPO_GATEWAY_URL ? { url: this.env.TEMPO_GATEWAY_URL } : {}),
      })
    return E2b.create({
      pay: Payment.payer({
        account: privateKeyToAccount(this.env.TEMPO_PRIVATE_KEY as `0x${string}`),
        budget,
        maxDepositUsd: config.budget.sandboxUsd,
        onCharge,
        wallet: this.wallet,
      }),
    })
  }

  private async closeChannels(): Promise<void> {
    if (!Payment.open(this.wallet) || !this.env.TEMPO_PRIVATE_KEY) return
    const startedAt = Date.now()
    const result = await Payment.close({
      account: privateKeyToAccount(this.env.TEMPO_PRIVATE_KEY as `0x${string}`),
      wallet: this.wallet,
    })
    const ms = Date.now() - startedAt
    result.closed.forEach(() =>
      Timeline.add(this.sql, { at: startedAt, ms, name: 'payment.close' }),
    )
    for (const unclosed of result.unclosed) {
      Timeline.add(this.sql, { at: startedAt, ms, name: 'payment.unclosed' })
      console.error('nanoeval channel not closed', unclosed.channelId, unclosed.error)
    }
  }

  private putArtifact(attempt: string, name: string, content: string | Uint8Array): void {
    const text = typeof content === 'string' ? content : Bytes.toValidText(content)
    const body = text ?? Bytes.toBase64(content as Uint8Array)
    this.sql.run('DELETE FROM artifacts WHERE attempt = ? AND name = ?', attempt, name)
    this.sql.run('DELETE FROM binary_artifacts WHERE attempt = ? AND name = ?', attempt, name)
    if (text === undefined)
      this.sql.run('INSERT INTO binary_artifacts (attempt, name) VALUES (?, ?)', attempt, name)
    for (let part = 0; part * partCharacters < Math.max(body.length, 1); part++)
      this.sql.run(
        'INSERT INTO artifacts (attempt, name, part, body) VALUES (?, ?, ?, ?)',
        attempt,
        name,
        part,
        body.slice(part * partCharacters, (part + 1) * partCharacters),
      )
  }

  private artifact(attempt: string, name: string): string | Uint8Array | undefined {
    const parts = this.sql.all(
      'SELECT body FROM artifacts WHERE attempt = ? AND name = ? ORDER BY part',
      attempt,
      name,
    )
    if (!parts.length) return undefined
    const body = parts.map((part) => part['body'] as string).join('')
    const binary = this.sql.all(
      'SELECT name FROM binary_artifacts WHERE attempt = ? AND name = ?',
      attempt,
      name,
    ).length
    return binary ? Bytes.fromBase64(body) : body
  }

  private textArtifact(attempt: string, name: string): string | undefined {
    const body = this.artifact(attempt, name)
    return typeof body === 'string' ? body : undefined
  }

  private artifactNames(attempt: string): string[] {
    return this.sql
      .all('SELECT DISTINCT name FROM artifacts WHERE attempt = ? ORDER BY name', attempt)
      .map((row) => row['name'] as string)
  }

  private requestLog(attempt: string): string | undefined {
    const requests = this.sql.all(
      'SELECT again, claim, at, path, ms, status, usage, refusal, wait FROM model_requests WHERE attempt = ? ORDER BY id',
      attempt,
    )
    return requests.length
      ? requests
          .map(
            ({ again, refusal, wait, ...request }) =>
              JSON.stringify({
                ...request,
                ...(again === null ? {} : { again: true }),
                ...(refusal === null ? {} : { refusal }),
                ...(wait === null ? {} : { wait }),
                usage: request['usage'] ? JSON.parse(request['usage'] as string) : null,
              }) + '\n',
          )
          .join('')
      : undefined
  }

  private projected(
    row: Ledger.Attempt,
    input: { events: readonly Atif.SessionEvent[]; session: string },
  ): Record<string, string> {
    const { events } = input
    return {
      [agentEvents]: events.map((event) => JSON.stringify(event) + '\n').join(''),
      [agentTrajectory]:
        JSON.stringify(
          Atif.fromEvents(events, {
            model: this.agentOf(row).model,
            name: 'nanocode',
            session: input.session,
            version: Pins.text(this.pins()),
          }),
          null,
          2,
        ) + '\n',
    }
  }

  private liveNames(row: Ledger.Attempt): string[] {
    if (!Ledger.active(row)) return []
    return [
      ...(this.submitted(row) ? [agentEvents, agentTrajectory] : []),
      ...(this.requestLog(row.id) === undefined ? [] : [modelRequests]),
    ]
  }

  private async live(row: Ledger.Attempt, name: string): Promise<string | Uint8Array | undefined> {
    if (!this.liveNames(row).includes(name)) return undefined
    if (name === modelRequests) return this.requestLog(row.id)
    try {
      return this.projected(row, {
        events: await Harness.events(this.env, row.session!, requestId),
        session: row.session!,
      })[name]
    } catch (error) {
      const ended = this.artifact(row.id, name)
      if (ended !== undefined) return ended
      throw new Refusal(
        502,
        'the session of the attempt did not give its events: ' + message(error),
      )
    }
  }

  private absent(row: Ledger.Attempt, name: string): string {
    const names = [...new Set([...this.artifactNames(row.id), ...this.liveNames(row)])].sort()
    if (row.phase === 'done')
      return 'the attempt has no ' + name + (names.length ? ': it has ' + names.join(', ') : '')
    return (
      'the attempt is in the ' +
      row.phase +
      ' phase and has no ' +
      name +
      ' yet' +
      (names.length ? ': it has ' + names.join(', ') + ' so far' : '')
    )
  }

  private view(row: Ledger.Attempt) {
    const result = row.result ? (JSON.parse(row.result) as Result.Attempt) : undefined
    return {
      agent: row.agent,
      claims: row.claims,
      failure: result?.failure ?? (row.failure ? JSON.parse(row.failure) : undefined),
      id: row.id,
      modelWaits: result?.modelWaits,
      n: row.n,
      oomKills: result?.oomKills,
      outcome: result?.outcome,
      phase: row.phase,
      retryOf: row.origin ? (JSON.parse(row.origin) as Ledger.Origin) : undefined,
      reward: result?.reward,
      runner: row.runner,
      task: row.task,
    }
  }

  private results(): Result.Attempt[] {
    return this.rows()
      .filter((row) => row.result)
      .map((row) => JSON.parse(row.result!) as Result.Attempt)
  }

  private pins(): Pins.Pins {
    const hands = this.runners().flatMap((row) => {
      const hand = row.capabilities
        ? (JSON.parse(row.capabilities) as Sandbox.Capabilities).hand
        : undefined
      return hand ? [hand] : []
    })
    return { hands: [...new Set(hands)].sort(), harness: this.meta()!.harness ?? null }
  }

  private status() {
    const meta = this.meta()!
    const config = this.config()
    const rows = this.rows()
    const results = this.results()
    const retries = new Map(
      this.sql
        .all(
          "SELECT attempt, COUNT(*) AS n FROM timeline WHERE name = 'attempt.retry' GROUP BY attempt",
        )
        .map((row) => [row['attempt'] as string, row['n'] as number]),
    )
    const unpriced = this.sql.all(
      'SELECT COUNT(*) AS responses, COALESCE(SUM(searches), 0) AS searches FROM model_requests WHERE status = 200 AND usage IS NOT NULL AND cost IS NULL',
    )[0]!
    const tools = this.sql.all(
      'SELECT COALESCE(SUM(searches), 0) AS calls, COALESCE(SUM(unpriced), 0) AS unpriced, COALESCE(SUM(tools_usd), 0) AS usd, COALESCE(SUM(listed), 0) AS listed FROM model_requests',
    )[0]!
    const claims = Ledger.claims(this.sql).filter(Ledger.lost)
    const lost = claims.at(-1)
    return {
      agents: Result.summarize(results),
      attempts: rows.map((row) => ({
        ...this.view(row),
        ...(retries.has(row.id) ? { retries: retries.get(row.id) } : {}),
      })),
      cancelled: meta.cancelled,
      counts: this.counts(),
      createdAt: meta.createdAt,
      eval: meta.eval,
      finishedAt: meta.finishedAt,
      id: meta.id,
      key: meta.key
        ? {
            ...meta.key,
            ...(meta.key.start && meta.key.end
              ? { charged: Gateway.charged(meta.key.start, meta.key.end) }
              : {}),
          }
        : null,
      ...(lost
        ? {
            lostClaim: {
              attempt: lost.attempt,
              ending: lost.ending,
              ...(lost.error === null ? {} : { error: lost.error }),
              n: lost.n,
              phase: lost.phase,
              runner: lost.runner,
            },
          }
        : {}),
      lostClaims: claims.length,
      name: config.name,
      nanocode: this.pins(),
      opening:
        meta.opening && rows.some((row) => row.phase === 'unclaimed')
          ? Opening.view(meta.opening, { limits: config.limits, now: Date.now() })
          : null,
      payer: config.payer ?? 'deployment',
      payments: this.sql.all('SELECT at, usd, detail FROM payments ORDER BY id'),
      refused: meta.refused ?? null,
      rerunOf: config.rerun ?? null,
      reruns: meta.reruns,
      start: Timeline.start(Timeline.all(this.sql), meta.createdAt),
      runners: this.runners().map((row) => ({
        capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
        drained: row.drained,
        endsAt: this.life(row)?.endsAt ?? null,
        error: row.error,
        id: row.id,
        sandbox: row.sandbox,
        seenAt: row.seen_at,
        state: row.state,
      })),
      sandboxes: this.sandboxes().map((row) => ({
        capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
        error: row.error,
        expiresAt: row.expires_at,
        handle: row.handle ? (JSON.parse(row.handle) as Sandbox.Handle).id : null,
        id: row.id,
        member: row.member,
        paidUntil: row.paid_until,
        provider: config.sandbox.provider,
        runner: row.runner,
        state: row.state,
      })),
      spend: {
        listedResponses: tools['listed'] as number,
        ...(config.budget.modelUsd === undefined ? {} : { modelBudgetUsd: config.budget.modelUsd }),
        modelUsd: this.modelSpent(),
        sandboxBudgetUsd: config.budget.sandboxUsd,
        sandboxUsd: this.spent(),
        toolsUsd: tools['usd'] as number,
        uncostedAttempts: Result.uncosted(results),
        unpricedResponses: unpriced['responses'] as number,
        unpricedTools: tools['unpriced'] as number,
        webSearches: tools['calls'] as number,
      },
      state: meta.finishedAt === null ? 'running' : 'finished',
      strandedAt: rows.some((row) => row.phase === 'unclaimed') ? (meta.strandedAt ?? null) : null,
    }
  }

  private harbor() {
    const meta = this.meta()!
    const config = this.config()
    const rows = this.rows()
    const attempts = this.results()
    return {
      artifacts: attempts.map((attempt) => ({
        attempt: attempt.id,
        names: this.artifactNames(attempt.id),
        trial: Harbor.trialName(attempt, meta.id),
      })),
      files: {
        ...Harbor.files({
          artifacts: {},
          attempts,
          job: {
            finishedAt: meta.finishedAt,
            id: meta.id,
            name: config.name,
            startedAt: meta.createdAt,
          },
          running: rows.filter(Ledger.active).length,
          nanocode: Pins.text(this.pins()),
          source: config.eval.name + '@' + config.eval.version,
          total: rows.length,
          version,
        }),
        'timeline.json':
          JSON.stringify(
            { createdAt: meta.createdAt, id: meta.id, marks: Timeline.all(this.sql) },
            null,
            2,
          ) + '\n',
      },
    }
  }

  private tick(): Promise<void> {
    this.ticking ??= this.step().finally(() => {
      this.ticking = undefined
    })
    return this.ticking
  }

  private async step(): Promise<void> {
    const meta = this.meta()
    if (!meta || meta.finishedAt !== null) return

    try {
      const provider = this.config().sandbox.max > 0 ? this.provider() : undefined
      for (const row of Ledger.expired(this.sql, Date.now())) {
        Ledger.explain(this.sql, {
          claim: row.claim!,
          error:
            'the lease of the attempt ran out: runner ' +
            row.runner +
            ' sent no word of it for the ' +
            this.config().limits.leaseSec +
            ' s that a lease lasts',
        })
        await this.lose(row, 'expired')
      }
      if (this.meta()!.cancelled) await this.cancelAll()
      await this.watch()
      if (provider) await this.advanceSandboxes(provider)
      if (!this.meta()!.cancelled) await this.enforce()
      if (provider) await this.closeIdle(provider)
      if (provider) await this.renew(provider)
      if (provider) await this.lapse(provider)
      if (provider && !this.meta()!.cancelled) await this.grow(provider)
      if (!provider && !this.meta()!.cancelled && this.wanting()) await this.adopt(false)
    } catch (error) {
      console.error('nanoeval tick failed', message(error))
    }

    const open = this.sandboxes().some((row) =>
      ['creating', 'ending', 'ready', 'starting'].includes(row.state),
    )
    if (this.rows().every((row) => row.phase === 'done') && !open) {
      await this.readKey('end')
      try {
        await this.closeChannels()
      } catch (error) {
        console.error('nanoeval channels not closed', message(error))
      }
      const finishedAt = Date.now()
      this.setMeta({ ...this.meta()!, finishedAt })
      const { errored, failed, passed } = this.counts()
      await this.list('runs/ended', {
        errored,
        failed,
        finishedAt,
        id: meta.id,
        passed,
      } satisfies Runs.Ended)
      return
    }
    await this.ctx.storage.setAlarm(Date.now() + Number(this.env.TICK_MS))
  }

  private submitted(row: Ledger.Attempt): boolean {
    return (
      Config.harness(this.agentOf(row)) === 'session' &&
      ['judge', 'run', 'verify'].includes(row.phase)
    )
  }

  private wake(row?: string): void {
    this.holds.release((key) =>
      row === undefined ? key.startsWith('claim:') : key.startsWith('row:' + row + ':'),
    )
  }

  private holdMs(asked: unknown): number {
    return typeof asked === 'number' && asked > 0 ? Math.min(asked, Number(this.env.HOLD_MS)) : 0
  }

  private agentOf(row: Pick<Ledger.Attempt, 'agent'>): Config.Agent {
    return this.config().agents.find((candidate) => candidate.id === row.agent)!
  }

  private route(
    row: Ledger.Attempt,
    reported: ReturnType<typeof Route.reported>,
  ): Route.Route | undefined {
    const agent = this.agentOf(row)
    if (agent.provider === 'oracle' || !['judge', 'run', 'verify'].includes(row.phase))
      return undefined
    return {
      ...Model.paid(this.env, {
        plan: this.config().payer === 'plan',
        provider: Installed.is(agent.provider)
          ? Installed.provider(agent.provider, agent.api)
          : agent.provider,
      }),
      ...reported,
    }
  }

  private installed(row: Ledger.Attempt): Installed.Kind | undefined {
    const provider = this.agentOf(row).provider
    return Installed.is(provider) ? provider : undefined
  }

  private async modelToken(row: Ledger.Attempt): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      Bytes.fromText(this.meta()!.runnerToken) as Uint8Array<ArrayBuffer>,
      { hash: 'SHA-256', name: 'HMAC' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      Bytes.fromText('model ' + row.id + ' ' + row.claim) as Uint8Array<ArrayBuffer>,
    )
    return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  private metered(row: Ledger.Attempt): Atif.Usage {
    const provider = Installed.provider(this.installed(row)!, this.agentOf(row).api)
    const total: Atif.Usage = {
      cacheWriteTokens: 0,
      cachedTokens: 0,
      costUsd: undefined,
      inputTokens: 0,
      modelCalls: 0,
      outputTokens: 0,
      toolCalls: 0,
    }
    const costs: (number | undefined)[] = []
    for (const request of this.sql.all(
      'SELECT path, usage FROM model_requests WHERE attempt = ? AND claim = ? ORDER BY id',
      row.id,
      row.claims,
    )) {
      if (!request['usage']) continue
      const usage = JSON.parse(request['usage'] as string) as Proxy.Usage
      if (!Proxy.generates(provider, request['path'] as string)) continue
      total.cacheWriteTokens += usage.cacheWriteTokens
      total.cachedTokens += usage.cachedTokens
      total.inputTokens += usage.inputTokens
      total.modelCalls++
      total.outputTokens += usage.outputTokens
      if (usage.reasoningTokens !== undefined)
        total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens
      if (usage.costBy) total.costBy = usage.costBy
      costs.push(usage.costUsd)
    }
    if (costs.length && costs.every((cost) => cost !== undefined))
      total.costUsd = costs.reduce<number>((sum, cost) => sum + cost!, 0)
    return total
  }

  private async model(
    request: Request,
    parts: readonly string[],
    search: string,
  ): Promise<Response> {
    const [id, ...rest] = parts
    const row = id ? Ledger.get(this.sql, decodeURIComponent(id)) : undefined
    const kind = row ? this.installed(row) : undefined
    const presented = Proxy.token(request.headers)
    if (
      !row ||
      !kind ||
      !row.claim ||
      row.phase !== 'run' ||
      Date.now() > (row.deadline_at ?? 0) ||
      !presented ||
      !(await same(presented, await this.modelToken(row)))
    )
      return Model.refuse(request, {
        message: 'no agent of this run is running with this token',
        status: 401,
      })
    const provider = Installed.provider(kind, this.agentOf(row).api)
    if (
      Installed.releases[kind].source === 'runtime' &&
      request.method === 'GET' &&
      rest.join('/') === 'models'
    )
      return Response.json({ data: [{ id: this.agentOf(row).model, object: 'model' }] })
    const path = Proxy.route(provider, rest.join('/'))
    if (!path)
      return Model.refuse(request, {
        message: 'the run forwards no ' + rest.join('/'),
        status: 404,
      })
    if (request.method !== 'POST')
      return Model.refuse(request, {
        message: 'the run forwards POST requests only',
        status: 405,
      })
    let forwarded = request
    if (Proxy.generates(provider, path)) {
      let body = await request.text()
      let value: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(body) as unknown
        if (typeof parsed === 'object' && parsed !== null) value = parsed as Record<string, unknown>
      } catch {}
      const model = this.agentOf(row).model
      if (value && !Fallback.served({ model, provider }).includes(value['model'] as string)) {
        this.record({
          attempt: row.id,
          claim: row.claims,
          listed: false,
          outcome: { at: Date.now(), ms: 0, refusal: 'model', status: 400 },
          path,
          provider,
        })
        return Response.json(
          {
            error: {
              message: Fallback.refusal(value['model']),
              type: 'invalid_request_error',
            },
          },
          { status: 400 },
        )
      }
      const limit = Number(this.env.NANOEVAL_REPLY_LIMIT ?? 0)
      if (value && path === 'responses' && limit > 0 && !value['max_output_tokens']) {
        value['max_output_tokens'] = limit
        body = JSON.stringify(value)
      }
      forwarded = new Request(request.url, {
        body,
        headers: request.headers,
        method: request.method,
      })
    }
    return Model.forward(this.env, {
      hooks: {
        admit: async (waitedMs) => this.admit({ attempt: row.id, claim: row.claims, waitedMs }),
        limited: (limited) => this.limited({ attempt: row.id, claim: row.claims, limited }),
        pace: () => this.pace({ attempt: row.id, claim: row.claims, path }),
        refused: async (refused) => this.refuse(refused),
        release: (flight) => void this.sql.run('DELETE FROM model_flights WHERE id = ?', flight),
        settle: (outcome) =>
          this.record({
            attempt: row.id,
            claim: row.claims,
            listed: false,
            outcome,
            path,
            provider,
          }),
      },
      path,
      provider,
      request: forwarded,
      search,
    })
  }

  private async within(work: Promise<unknown>): Promise<void> {
    const ended = work.catch(() => {})
    this.ctx.waitUntil(ended)
    await Promise.race([
      ended,
      new Promise((resolve) => setTimeout(resolve, Number(this.env.TICK_MS))),
    ])
  }

  private halt(session: string): Promise<void> {
    return this.within(Harness.cancel(this.env, session, requestId))
  }

  private remove(session: string): Promise<void> {
    return this.within(Harness.remove(this.env, session))
  }

  private judgeSessions(row: Ledger.Attempt): string[] {
    const request = this.textArtifact(row.id, judgeRequest)
    return request && row.session
      ? Judge.parse(request).map((_, index) => row.session + '-judge-' + index)
      : []
  }

  private async kept<T>(row: Ledger.Attempt, read: Promise<T>): Promise<T> {
    try {
      return await read
    } catch (error) {
      if (!(error instanceof Harness.LostError)) throw error
      return this.forgotten(row, error.message)
    }
  }

  private async forgotten(row: Ledger.Attempt, said: string): Promise<never> {
    const gone = 'the attempt is not claimed by this runner any more'
    if (!Ledger.held(this.sql, { claim: row.claim!, id: row.id })) throw new Refusal(410, gone)
    Ledger.explain(this.sql, { claim: row.claim!, error: said })
    Timeline.add(this.sql, { at: Date.now(), attempt: row.id, name: 'attempt.forgotten' })
    await this.lose(
      row,
      'forgotten',
      row.claims < this.config().limits.claims
        ? undefined
        : 'the attempt was claimed ' +
            row.claims +
            ' times, the limit of the run, and the session of its last claim no longer has its turn: ' +
            said,
    )
    throw new Refusal(410, gone + ': ' + said)
  }

  private async lose(
    row: Ledger.Attempt,
    ending: 'expired' | 'forgotten' | 'released' | 'retried',
    final?: string,
  ): Promise<void> {
    const config = this.config()
    const submitted = this.submitted(row)
    let usage: string | undefined
    const sessions: string[] = []
    if (row.session) {
      const branches = this.installed(row) === undefined ? this.branchSessions(row) : []
      if (submitted && row.phase === 'run') for (const name of branches) await this.halt(name)
      if (submitted)
        usage = await Promise.all(
          branches.map((name) => Harness.events(this.env, name, requestId)),
        ).then(
          (all) => {
            const requested = Timeline.modelRequest(all[0]!)
            if (requested !== undefined)
              Timeline.add(this.sql, { at: requested, attempt: row.id, name: 'attempt.model' })
            const usages = all.map((events) => Atif.usage(events))
            return JSON.stringify(usages.length === 1 ? usages[0]! : Atif.sum(usages))
          },
          () => undefined,
        )
      const installed = this.installed(row) !== undefined
      if (installed && ['judge', 'run', 'verify'].includes(row.phase))
        usage = JSON.stringify(this.metered(row))
      sessions.push(...this.judgeSessions(row))
      if (row.phase !== 'claimed' && !installed) sessions.push(...branches)
    }
    const requeued = Ledger.requeue(this.sql, {
      ending,
      id: row.id,
      limit: final !== undefined ? 0 : config.limits.claims,
      now: Date.now(),
      ...(usage ? { usage } : {}),
    })
    this.wake(row.id)
    if (requeued) {
      this.sql.run('DELETE FROM artifacts WHERE attempt = ?', row.id)
      this.sql.run('DELETE FROM binary_artifacts WHERE attempt = ?', row.id)
      this.wake()
    }
    for (const name of sessions) await this.remove(name)
    if (requeued) return
    const current = Ledger.get(this.sql, row.id)
    if (current && current.phase !== 'done')
      await this.complete(current, {
        collect: false,
        failure: {
          at: Date.now(),
          kind: 'environment',
          message:
            final ??
            'the attempt lost its runner ' +
              row.claims +
              ' times, the limit of the run: the lease of runner ' +
              row.runner +
              (ending === 'expired' ? ' expired' : ' was released') +
              ' in the ' +
              row.phase +
              ' phase',
        },
        reward: null,
      })
  }

  private async cancelAll(): Promise<void> {
    for (const row of this.rows()) {
      if (row.phase === 'done') continue
      if (row.session && row.phase === 'run' && this.submitted(row))
        for (const name of this.branchSessions(row)) await this.halt(name)
      await this.complete(row, {
        ending: 'cancelled',
        failure: { at: Date.now(), kind: 'cancelled', message: 'the run was cancelled' },
        reward: null,
      })
    }
  }

  private async watch(): Promise<void> {
    const config = this.config()
    const now = Date.now()
    for (const runner of this.runners()) {
      const life = ['lost', 'ready', 'starting'].includes(runner.state)
        ? this.life(runner)
        : undefined
      if (life && now >= life.endsAt) {
        const lived = Math.floor((life.endsAt - life.startedAt) / 1000)
        for (const row of this.rows()) {
          if (!Ledger.active(row) || row.runner !== runner.id) continue
          const seconds = Config.rowSec(config.limits, this.task(row.task))
          Ledger.explain(this.sql, {
            claim: row.claim!,
            error: 'the sandbox of runner ' + runner.id + ' ended after its ' + lived + ' s',
          })
          await this.lose(
            row,
            'expired',
            Admission.outlives(life, seconds)
              ? 'the sandbox of runner ' +
                  runner.id +
                  ' ended after its ' +
                  lived +
                  ' s with the attempt in the ' +
                  row.phase +
                  ' phase: the timeouts of the row allow ' +
                  seconds +
                  ' s, more than that sandbox lives, so it had the whole of it and is not claimed again'
              : undefined,
          )
        }
        this.update('runners', runner.id, {
          error: 'the sandbox of the runner ended',
          state: 'left',
        })
        continue
      }
      if (life && runner.state === 'ready' && runner.drained === null) this.drain(runner, now)
      if (runner.state === 'ready' && now - runner.seen_at > config.limits.leaseSec * 1000)
        this.update('runners', runner.id, {
          error: 'the runner stopped answering',
          state: 'lost',
        })
      if (
        runner.state === 'starting' &&
        runner.sandbox === null &&
        now - runner.registered_at > config.limits.setupSec * 1000
      )
        this.update('runners', runner.id, { error: 'the runner never reported', state: 'lost' })
    }
  }

  private async advanceSandboxes(provider: Sandbox.Provider): Promise<void> {
    const config = this.config()
    for (const { id } of this.sandboxes()) {
      const row = this.sandboxes().find((candidate) => candidate.id === id)!
      if (row.state === 'creating' && !this.creating.has(row.id)) {
        this.update('sandboxes', row.id, {
          error:
            'the orchestrator restarted while creating this sandbox; its outcome is unknown and it was not retried',
          state: 'unknown',
        })
        continue
      }
      if (!['ending', 'ready', 'starting'].includes(row.state)) continue
      const runner = this.runners().find((candidate) => candidate.id === row.runner)
      let started = false
      try {
        if (!runner) throw new Error('the sandbox has no runner')
        started =
          row.state === 'starting' &&
          runner.capabilities !== null &&
          ['left', 'ready', 'refused'].includes(runner.state)
        if (started) {
          this.update('sandboxes', row.id, { capabilities: runner.capabilities, state: 'ready' })
          this.setOpening(undefined)
        }
        const holds = this.rows().some((held) => Ledger.active(held) && held.runner === runner.id)
        if ((runner.state === 'refused' && !holds) || runner.state === 'lost')
          throw new Error(runner.error ?? 'the runner of the sandbox stopped')
        if (row.state !== 'starting' || started) continue
        if (Date.now() - row.created_at > config.limits.setupSec * 1000) {
          const handle = JSON.parse(row.handle!) as Sandbox.Handle
          const log = await provider
            .connect(handle)
            .exec('tail -c 2000 ' + Sandbox.quote(handle.home + '/runner.log'))
            .then(
              (output) => output.stdout,
              () => '',
            )
          throw new Error(
            'the runner did not start within ' + config.limits.setupSec + ' s: ' + log,
          )
        }
      } catch (error) {
        await this.failSandbox(
          provider,
          row,
          message(error),
          row.state === 'starting' && !started ? { passing: false } : undefined,
        )
      }
    }
  }

  private setOpening(opening: Opening.Failed | undefined): void {
    const { opening: before, ...rest } = this.meta()!
    if (opening || before) this.setMeta(opening ? { ...rest, opening } : rest)
  }

  private async failSandbox(
    provider: Sandbox.Provider,
    row: SandboxRow,
    error: string,
    unopened?: { passing: boolean; retryAfterSec?: number },
  ): Promise<void> {
    this.fail(row, error, unopened)
    await this.discard(provider, { ...row, error })
  }

  private fail(
    row: SandboxRow,
    error: string,
    unopened?: { passing: boolean; retryAfterSec?: number },
  ): void {
    this.update('sandboxes', row.id, { error, state: 'failed' })
    if (row.runner !== null) {
      const runner = this.runners().find((candidate) => candidate.id === row.runner)
      if (runner && (runner.state === 'ready' || runner.state === 'starting'))
        this.update('runners', runner.id, { error, state: 'lost' })
    }
    if (unopened)
      this.setOpening(
        Opening.failed(this.meta()!.opening, {
          at: Date.now(),
          message: error,
          ...unopened,
        }),
      )
  }

  private async discard(provider: Sandbox.Provider, row: SandboxRow): Promise<void> {
    if (row.handle) {
      const handle = JSON.parse(row.handle) as Sandbox.Handle
      await this.renewing(provider, () => provider.kill(handle).catch(() => {}))
    }
    await this.forget(row, row.error ?? undefined)
  }

  private async forget(row: Pick<SandboxRow, 'member'>, error?: string): Promise<void> {
    if (row.member === null) return
    await PoolObject.call(this.env, {
      action: 'drop',
      body: { ...(error === undefined ? {} : { error }), id: row.member, run: this.meta()!.id },
      location: this.meta()!.location,
    }).catch(() => {})
  }

  private ahead(runner: number): Protocol.Ahead[] {
    const found = new Map<string, Protocol.Ahead>()
    const config = this.config()
    const capabilities = this.known(runner).capabilities
    const slots =
      config.sandbox.slots ??
      (capabilities ? (JSON.parse(capabilities) as Sandbox.Capabilities).cpus : 0)
    for (const row of Ledger.queue(this.sql, (task) =>
      Config.rowSec(config.limits, this.task(task)),
    )) {
      if (found.size >= slots) break
      const environment = this.task(row.task).environment
      if (environment.kind === 'disk') found.set(environment.disk.digest, environment)
    }
    return [...found.values()]
  }

  private runnerConfig(runner: number, pool?: Protocol.Standing): Config.Runner {
    const meta = this.meta()!
    const config = this.config()
    const ahead = this.ahead(runner)
    const life = this.life(this.known(runner))
    return {
      ...(ahead.length ? { ahead } : {}),
      backend: config.sandbox.backend,
      disks: config.sandbox.disks,
      ...(life ? { endsAt: life.endsAt } : {}),
      ...(config.sandbox.freeDiskMb === undefined ? {} : { freeDiskMb: config.sandbox.freeDiskMb }),
      leaseSec: config.limits.leaseSec,
      limits: {
        attachSec: config.limits.attachSec,
        setupSec: config.limits.setupSec,
        stepRetries: config.limits.stepRetries,
      },
      ...(config.sandbox.memoryMb === undefined ? {} : { memoryMb: config.sandbox.memoryMb }),
      network: config.sandbox.network,
      oracle: Config.oracle(config) !== undefined,
      pollMs: config.sandbox.pollMs,
      ...(pool ? { pool } : {}),
      protocol: Protocol.version,
      run: meta.id,
      runner,
      ...(config.sandbox.slots === undefined ? {} : { slots: config.sandbox.slots }),
      token: meta.runnerToken,
      url: meta.publicUrl,
      ...(config.sandbox.verifierCache ? { verifierCache: true as const } : {}),
    }
  }

  private backend(runner: number): string {
    const record = this.runners().find((candidate) => candidate.id === runner)
    const chosen = record?.capabilities
      ? (JSON.parse(record.capabilities) as Sandbox.Capabilities).backend
      : undefined
    return chosen && chosen !== 'none' ? chosen : this.config().sandbox.backend
  }

  private register(sandbox: number | null): number {
    const now = Date.now()
    this.sql.run(
      'INSERT INTO runners (sandbox, state, registered_at, seen_at) VALUES (?, ?, ?, ?)',
      sandbox,
      'starting',
      now,
      now,
    )
    return this.sql.all('SELECT MAX(id) AS id FROM runners')[0]!['id'] as number
  }

  private attach(body: Protocol.Attach): Config.Runner {
    const left = body?.leftSec
    if (left !== undefined && !(typeof left === 'number' && Number.isFinite(left) && left > 0))
      throw new Refusal(400, 'leftSec is the seconds the machine of the runner still lives')
    const runner = this.register(null)
    if (left !== undefined)
      this.update('runners', runner, { ends_at: Date.now() + Math.floor(left * 1000) })
    return this.runnerConfig(runner)
  }

  private async open(provider: Sandbox.Provider): Promise<void> {
    const meta = this.meta()!
    const config = this.config()
    const asked = Date.now()
    this.sql.run('INSERT INTO sandboxes (state, created_at) VALUES (?, ?)', 'creating', asked)
    const id = this.sql.all('SELECT MAX(id) AS id FROM sandboxes')[0]!['id'] as number
    this.creating.add(id)
    const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const at = Date.now()
      try {
        return await work()
      } finally {
        Timeline.add(this.sql, { at, ms: Date.now() - at, name, sandbox: id })
      }
    }
    try {
      const created = await timed('sandbox.create', () =>
        provider.create({
          ...(config.sandbox.leaseSec === undefined ? {} : { leaseSec: config.sandbox.leaseSec }),
          metadata: { nanoeval_run: meta.id, nanoeval_sandbox: String(id) },
          template: config.sandbox.template,
          timeoutSec: config.sandbox.timeoutSec!,
        }),
      )
      const handle = created.handle
      const expiresAt =
        created.expiresAt === null
          ? null
          : Math.min(created.expiresAt, asked + config.sandbox.timeoutSec! * 1000)
      const runner = this.register(id)
      this.update('sandboxes', id, {
        expires_at: expiresAt,
        handle: JSON.stringify(handle),
        paid_until: created.paidUntil ?? null,
        runner,
      })
      const pool = config.sandbox.warm
        ? await PoolObject.call<Protocol.Standing>(this.env, {
            action: 'enroll',
            body: {
              expiresAt,
              handle,
              idleSec: config.sandbox.warm.idleSec,
              ...(config.sandbox.leaseSec === undefined
                ? {}
                : { leaseSec: config.sandbox.leaseSec }),
              noticeSec: config.limits.leaseSec,
              paidUntil: created.paidUntil ?? null,
              run: meta.id,
              spec: { ...Members.wanted(config.sandbox), backend: config.sandbox.backend },
              usd: config.sandbox.warm.usd,
            },
            location: meta.location,
          })
        : undefined
      if (pool) this.update('sandboxes', id, { member: pool.member })
      const sandbox = provider.connect(handle)
      const settings = JSON.stringify(this.runnerConfig(runner, pool))
      await this.renewing(provider, async () => {
        if (config.sandbox.runtime) {
          const runtime = config.sandbox.runtime
          await timed('sandbox.exec', () =>
            Sandbox.run(
              sandbox,
              Bootstrap.script({
                config: settings,
                home: handle.home,
                run: meta.id,
                runtime,
                token: meta.runnerToken,
                url: meta.publicUrl,
              }),
            ),
          )
        } else {
          const file = handle.home + '/' + Bootstrap.files.config
          await timed('sandbox.write', () => sandbox.write(file, Bytes.fromText(settings)))
          await timed('sandbox.exec', () =>
            Sandbox.run(sandbox, 'nanoeval runner --detach --config ' + Sandbox.quote(file)),
          )
        }
      })
      if (this.sandboxes().find((candidate) => candidate.id === id)!.state === 'creating')
        this.update('sandboxes', id, { state: 'starting' })
    } catch (error) {
      const row = this.sandboxes().find((candidate) => candidate.id === id)!
      if (['creating', 'ending', 'starting'].includes(row.state) && over(row)) {
        await this.expire(provider, row)
        this.setOpening(
          Opening.failed(this.meta()!.opening, {
            at: Date.now(),
            message: 'its lease ended while its runner started',
            passing: true,
          }),
        )
      } else if (row.state !== 'failed') {
        const retryAfterSec = Opening.retryAfterSec(error)
        await this.failSandbox(provider, row, message(error), {
          passing: row.handle === null && Opening.passing(error),
          ...(row.handle === null && retryAfterSec !== undefined ? { retryAfterSec } : {}),
        })
      }
    } finally {
      this.creating.delete(id)
    }
  }

  private async enforce(): Promise<void> {
    const config = this.config()
    if (!this.rows().some((row) => row.phase === 'unclaimed')) return this.unmark()
    if (await this.overBudget()) return
    await this.strand()
    const unclaimed = this.rows().filter((row) => row.phase === 'unclaimed')
    if (!unclaimed.length || config.sandbox.freeDiskMb === undefined) return

    const reports = this.runners()
      .filter((runner) => runner.state === 'ready')
      .map((runner) => (runner.report ? (JSON.parse(runner.report) as Protocol.Report) : undefined))
    const starved = reports.length > 0 && reports.every((report) => report?.starved)
    const meta = this.meta()!
    if (starved !== (meta.starvedAt !== undefined)) {
      const { starvedAt: _, ...rest } = meta
      this.setMeta(starved ? { ...rest, starvedAt: Date.now() } : rest)
    }
    if (!starved || Date.now() - (meta.starvedAt ?? Date.now()) <= config.limits.setupSec * 1000)
      return
    for (const row of unclaimed)
      await this.complete(row, {
        failure: {
          at: Date.now(),
          kind: 'environment',
          message:
            'the sandbox has ' +
            Math.max(...reports.map((report) => report?.freeDiskMb ?? 0)) +
            ' MB of free disk with no attempt running, and the run has required ' +
            config.sandbox.freeDiskMb +
            ' MB for ' +
            config.limits.setupSec +
            ' s',
        },
        reward: null,
      })
  }

  private unmark(): void {
    const { restranded, starvedAt, strandedAt, ...rest } = this.meta()!
    if (restranded || starvedAt !== undefined || strandedAt !== undefined) this.setMeta(rest)
  }

  private async strand(): Promise<void> {
    const config = this.config()
    const now = Date.now()
    const forget = () => {
      const { restranded, strandedAt, ...rest } = this.meta()!
      if (strandedAt !== undefined || restranded) this.setMeta(rest)
    }
    if (config.sandbox.max > 0) return forget()
    const able = this.runners()
      .filter(
        (runner) =>
          (runner.state === 'ready' || runner.state === 'starting') && runner.drained === null,
      )
      .map((runner) => this.fitting(runner, now))
    const stranded = this.rows().filter(
      (row) => row.phase === 'unclaimed' && !able.some((fits) => fits(row.task)),
    )
    if (!stranded.length) return forget()
    const since = this.meta()!.strandedAt
    if (since === undefined) {
      Timeline.add(this.sql, { at: now, name: 'run.stranded' })
      return this.setMeta({ ...this.meta()!, strandedAt: now })
    }
    if (now - since <= config.limits.setupSec * 1000) return
    if (!this.meta()!.restranded) {
      Timeline.add(this.sql, { at: now, name: 'run.restranded' })
      return this.setMeta({ ...this.meta()!, restranded: true, strandedAt: now })
    }
    for (const row of stranded)
      await this.complete(row, {
        failure: {
          at: now,
          kind: 'environment',
          message:
            'no runner of the run could take the row for ' +
            config.limits.setupSec +
            ' s: ' +
            (able.length
              ? 'its timeouts allow ' +
                Config.rowSec(config.limits, this.task(row.task)) +
                ' s, and the sandbox of every runner that is left ends sooner'
              : 'the run has no runner, and opens no sandbox itself'),
        },
        reward: null,
      })
    forget()
  }

  private async overBudget(): Promise<boolean> {
    const config = this.config()
    const refused = this.meta()!.refused
    if (refused && !refused.plan && Date.now() - refused.at <= config.limits.setupSec * 1000)
      return true
    if (
      !refused &&
      (config.budget.modelUsd === undefined || this.modelSpent() < config.budget.modelUsd)
    )
      return false
    for (const row of this.rows().filter((candidate) => candidate.phase === 'unclaimed'))
      await this.complete(row, {
        failure: {
          at: Date.now(),
          kind: refused?.plan ? 'environment' : 'budget',
          message: refused?.plan
            ? 'no row is started after a model request that the plan could not pay for: ' +
              refused.message
            : refused
              ? 'the payment for a model request was refused for ' +
                config.limits.setupSec +
                ' s, and no row is started after that: ' +
                refused.message
              : 'the model budget of $' + config.budget.modelUsd + ' is spent',
        },
        reward: null,
      })
    return true
  }

  private async grow(provider: Sandbox.Provider): Promise<void> {
    const config = this.config()
    const unclaimed = this.rows().filter((row) => row.phase === 'unclaimed')
    const sandboxes = this.sandboxes()
    const live = sandboxes.filter((sandbox) =>
      ['creating', 'ready', 'starting'].includes(sandbox.state),
    )
    const ending = new Set(
      sandboxes.filter((sandbox) => sandbox.state === 'ending').map((sandbox) => sandbox.runner),
    )
    const drained = new Set(
      this.runners()
        .filter((runner) => runner.drained !== null)
        .map((runner) => runner.id),
    )
    const ready = this.runners().filter(
      (runner) => runner.state === 'ready' && !ending.has(runner.id) && !drained.has(runner.id),
    )
    const now = Date.now()
    const serving = ready.length > 0 || live.some((sandbox) => sandbox.state === 'ready')
    const known = this.meta()!.opening
    const opening = Opening.seen(known, { now, stranded: unclaimed.length > 0 && !serving })
    if (opening !== known) this.setOpening(opening)
    if (!unclaimed.length || live.some((sandbox) => sandbox.state !== 'ready')) return
    const room = ready.some((runner) => {
      const report = runner.report ? (JSON.parse(runner.report) as Protocol.Report) : undefined
      return !report?.offer || (report.offer.slots > 0 && !report.unfit)
    })
    if (room) return
    const action = Opening.next(opening, { limits: config.limits, now })
    if (action === 'wait') return
    if (action === 'end') {
      const last = Opening.ended(opening!, { limits: config.limits, now })
      for (const row of unclaimed)
        await this.complete(row, {
          failure: {
            at: Date.now(),
            kind: last.startsWith('Budget.ExceededError') ? 'budget' : 'environment',
            message: last,
          },
          reward: null,
        })
      return
    }
    const claiming = live.filter(
      (sandbox) => sandbox.runner === null || !drained.has(sandbox.runner),
    )
    if (claiming.length < config.sandbox.max && !(await this.adopt(true))) await this.open(provider)
  }

  private wanting(): boolean {
    if (!this.rows().some((row) => row.phase === 'unclaimed')) return false
    return !this.runners().some((runner) => {
      if (runner.state !== 'ready') return false
      const report = runner.report ? (JSON.parse(runner.report) as Protocol.Report) : undefined
      return !report?.offer || (report.offer.slots > 0 && !report.unfit)
    })
  }

  private async adopt(marked: boolean): Promise<boolean> {
    const meta = this.meta()!
    const config = this.config()
    const at = Date.now()
    const unclaimed = this.rows().filter((row) => row.phase === 'unclaimed')
    const { member } = await PoolObject.call<{ member: Members.Taken | null }>(this.env, {
      action: 'take',
      body: {
        lifetimeSec: Config.lifetimeSec(
          config,
          unclaimed.map((row) => this.task(row.task)),
        ),
        run: meta.id,
        wanted: Members.wanted(config.sandbox),
      },
      location: meta.location,
    })
    const now = Date.now()
    if (member || marked) Timeline.add(this.sql, { at, ms: now - at, name: 'pool.take' })
    if (!member) return false
    let sandbox: number | null = null
    if (member.handle) {
      this.sql.run(
        'INSERT INTO sandboxes (state, created_at, handle, capabilities, expires_at, paid_until, member) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'ready',
        now,
        JSON.stringify(member.handle),
        JSON.stringify(member.capabilities),
        member.expiresAt,
        member.paidUntil,
        member.id,
      )
      sandbox = this.sql.all('SELECT MAX(id) AS id FROM sandboxes')[0]!['id'] as number
    }
    const runner = this.register(sandbox)
    this.update('runners', runner, {
      capabilities: JSON.stringify(member.capabilities),
      state: 'ready',
    })
    if (sandbox !== null) this.update('sandboxes', sandbox, { runner })
    Timeline.add(this.sql, {
      at: now,
      name: 'sandbox.adopt',
      ...(sandbox === null ? {} : { sandbox }),
    })
    Timeline.add(this.sql, { at: now, name: 'runner.hello', runner })
    const { assigned } = await PoolObject.call<{ assigned: boolean }>(this.env, {
      action: 'assign',
      body: { config: { ...this.runnerConfig(runner), ready: true }, id: member.id, run: meta.id },
      location: meta.location,
    })
    if (assigned) {
      this.setOpening(undefined)
      return true
    }
    const error = 'the pool did not hand its runner to this run'
    this.update('runners', runner, { error, state: 'lost' })
    if (sandbox !== null) this.update('sandboxes', sandbox, { error, state: 'failed' })
    return false
  }

  private async closeIdle(provider: Sandbox.Provider): Promise<void> {
    const rows = this.rows()
    const waiting = rows.some((row) => row.phase === 'unclaimed')
    const drained = new Set(
      this.runners()
        .filter((runner) => runner.drained !== null)
        .map((runner) => runner.id),
    )
    for (const { id } of this.sandboxes()) {
      const record = this.sandboxes().find((candidate) => candidate.id === id)!
      if (record.state !== 'ready' && record.state !== 'ending') continue
      if (waiting && !(record.runner !== null && drained.has(record.runner))) continue
      if (rows.some((row) => Ledger.active(row) && row.runner === record.runner)) continue
      const handle = JSON.parse(record.handle!) as Sandbox.Handle
      if (record.member !== null && record.state === 'ready') {
        const warm = this.config().sandbox.warm
        const { kept } = await PoolObject.call<{ kept: boolean }>(this.env, {
          action: 'settle',
          body: {
            ...(record.capabilities
              ? { capabilities: JSON.parse(record.capabilities) as Sandbox.Capabilities }
              : {}),
            id: record.member,
            ...(warm ? { idleSec: warm.idleSec, usd: warm.usd } : {}),
            paidUntil: record.paid_until,
            run: this.meta()!.id,
          },
          location: this.meta()!.location,
        })
        if (kept) {
          this.update('sandboxes', record.id, { state: 'kept' })
          if (record.runner !== null) this.update('runners', record.runner, { state: 'left' })
          continue
        }
      }
      this.update('sandboxes', record.id, { state: 'closed' })
      try {
        await this.renewing(provider, () => provider.kill(handle))
      } catch (error) {
        this.update('sandboxes', record.id, { error: message(error), state: 'failed' })
      }
      await this.forget(record)
      if (record.runner !== null) this.update('runners', record.runner, { state: 'left' })
    }
  }

  private async renewing<T>(provider: Sandbox.Provider, work: () => Promise<T>): Promise<T> {
    if (this.attended) return work()
    this.attended = true
    let ended = false
    let renewal: Promise<void> | undefined
    const failed: SandboxRow[] = []
    const renewals = async () => {
      while (!ended) {
        await new Promise((resolve) => setTimeout(resolve, Number(this.env.TICK_MS)))
        if (ended) return
        renewal = this.leases(provider).then(
          (rows) => void failed.push(...rows),
          (error) => console.error('nanoeval renewal failed', message(error)),
        )
        await renewal
      }
    }
    void renewals()
    try {
      return await work()
    } finally {
      ended = true
      await renewal
      this.attended = false
      for (const row of failed) await this.discard(provider, row)
    }
  }

  private async renew(provider: Sandbox.Provider): Promise<void> {
    for (const row of await this.leases(provider)) await this.discard(provider, row)
  }

  private async leases(provider: Sandbox.Provider): Promise<SandboxRow[]> {
    if (!provider.renew) return []
    const config = this.config()
    const failed: SandboxRow[] = []
    const leased = (id: number) => {
      const row = this.sandboxes().find((candidate) => candidate.id === id)
      return row && ['creating', 'ending', 'ready', 'starting'].includes(row.state)
        ? row
        : undefined
    }
    for (const { id } of this.sandboxes()) {
      const record = leased(id)
      if (!record) continue
      if (record.paid_until === null || record.expires_at === null) continue
      const left = record.paid_until - Date.now()
      if (left <= 0 || left > config.limits.leaseSec * 1000) continue
      const seconds = Math.min(
        config.sandbox.leaseSec ?? Gateway.leaseSec,
        Math.floor((record.expires_at - record.paid_until) / 1000),
      )
      if (seconds < 1) {
        if (record.state !== 'ending')
          this.update('sandboxes', record.id, {
            error: 'its lease runs to the end of the lifetime it was created with',
            state: 'ending',
          })
        continue
      }
      try {
        const renewed = await provider.renew(
          { ...(JSON.parse(record.handle!) as Sandbox.Handle), paidUntil: record.paid_until },
          seconds,
        )
        const current = leased(id)
        if (!current) continue
        const runner = this.runners().find((candidate) => candidate.id === current.runner)
        this.update('sandboxes', id, {
          error: null,
          paid_until: renewed.paidUntil,
          ...(current.state === 'ending'
            ? { state: runner?.state === 'ready' ? 'ready' : 'starting' }
            : {}),
        })
      } catch (error) {
        const current = leased(id)
        if (!current) continue
        const ends = Gateway.endsAt(error)
        if (ends !== undefined && ends < current.expires_at! && ends > current.created_at) {
          this.update('sandboxes', id, { expires_at: ends })
          continue
        }
        const unsold =
          error instanceof Budget.ExceededError ||
          (error instanceof Gateway.RefusedError && error.status !== 404) ||
          error instanceof Gateway.UnpricedError
        const passing =
          error instanceof Gateway.RefusedError && (error.status === 429 || error.status >= 500)
        if (unsold)
          this.update('sandboxes', id, {
            error: message(error),
            ...(passing ? {} : { state: 'ending' }),
          })
        else {
          this.fail(
            current,
            message(error),
            current.state === 'creating' || current.state === 'starting'
              ? { passing: false }
              : undefined,
          )
          failed.push({ ...current, error: message(error) })
        }
      }
    }
    return failed
  }

  private async lapse(provider: Sandbox.Provider): Promise<void> {
    for (const { id } of this.sandboxes()) {
      const record = this.sandboxes().find((candidate) => candidate.id === id)!
      if (!['ending', 'ready', 'starting'].includes(record.state)) continue
      if (!over(record)) continue
      await this.expire(provider, record)
    }
  }

  private async expire(provider: Sandbox.Provider, record: SandboxRow): Promise<void> {
    const paid = record.paid_until ?? Infinity
    const lifetime = record.expires_at ?? Infinity
    const reason = paid <= lifetime ? 'the lease of its sandbox ended' : 'its sandbox ended'
    for (const row of this.rows())
      if (Ledger.active(row) && row.runner === record.runner) {
        Ledger.explain(this.sql, {
          claim: row.claim!,
          error: reason.replace('its sandbox', 'the sandbox of runner ' + record.runner),
        })
        await this.lose(row, 'expired')
      }
    this.update('sandboxes', record.id, {
      error: record.error ?? (paid <= lifetime ? 'its lease ended' : 'its lifetime ended'),
      state: 'closed',
    })
    if (record.runner !== null)
      this.update('runners', record.runner, { error: reason, state: 'left' })
    if (record.handle) {
      const handle = JSON.parse(record.handle) as Sandbox.Handle
      await this.renewing(provider, () => provider.kill(handle).catch(() => {}))
    }
    await this.forget(record, reason)
  }

  private async runner(request: Request, parts: readonly string[]): Promise<Response> {
    const [resource, id, action, name] = parts
    if (request.method === 'GET' && resource === 'blobs' && id) {
      const known =
        this.config().sandbox.runtime?.digest === id ||
        this.tasks().some((task) =>
          Eval.blobs(task, { solution: true }).some((blob) => blob.digest === id),
        )
      if (!known) return json({ error: 'the run names no such blob' }, 404)
      return Blobs.serve(request, this.env, id)
    }
    if (request.method === 'PUT' && resource === 'rows' && id && action === 'artifacts' && name) {
      const row = this.fenced(id, new URL(request.url).searchParams.get('claim') ?? '')
      this.putArtifact(
        row.id,
        decodeURIComponent(name),
        new Uint8Array(await request.arrayBuffer()),
      )
      return json({ stored: true })
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (resource === 'hello') return json(await this.hello(body as unknown as Protocol.Hello))
    if (resource === 'claims') return json(await this.claim(body as Protocol.ClaimRequest))
    if (resource === 'heartbeat') return json(this.heartbeat(body as Protocol.Heartbeat))
    if (resource === 'yield') {
      const key = 'claim:' + this.known((body as Protocol.Yield).runner).id
      const yielded = this.holds.has(key)
      this.holds.end(key)
      return json({ yielded } satisfies Protocol.Yielded)
    }
    if (resource === 'leave') return json(await this.leave(body as Protocol.Leave))
    if (resource === 'rows' && id && action) {
      const row = this.fenced(id, String(body['claim'] ?? ''))
      if (Timeline.valid(body['timeline']))
        Timeline.report(this.sql, {
          attempt: row.id,
          receivedAt: Date.now(),
          report: body['timeline'],
          ...(row.runner === null ? {} : { runner: row.runner }),
        })
      if (action === 'session') return json(await this.handSession(row, body as Protocol.Hand))
      if (action === 'endpoint') return json(await this.endpoint(row))
      if (action === 'fault') return json(await this.fault(row, body as Protocol.Fault))
      if (action === 'gone') return json(await this.gone(row, body as Protocol.Fault))
      if (action === 'agent') return json(await this.agent(row, body as Protocol.Ask))
      if (action === 'verify') return json(this.verify(row, body as { solve?: { code: number } }))
      if (action === 'judge') return json(await this.judge(row, body as { request?: string }))
      if (action === 'finish') return json(await this.finish(row, body as Protocol.Finish))
    }
    return json({ error: 'route not found' }, 404)
  }

  private fenced(id: string, claim: string): Ledger.Attempt {
    const row = Ledger.held(this.sql, { claim, id: decodeURIComponent(id) })
    if (!row) throw new Refusal(410, 'the attempt is not claimed by this runner any more')
    Ledger.update(this.sql, row.id, {
      lease_until: Date.now() + this.config().limits.leaseSec * 1000,
    })
    return row
  }

  private known(id: number): RunnerRow {
    const runner = this.runners().find((candidate) => candidate.id === id)
    if (!runner) throw new Refusal(404, 'the run has no runner ' + id)
    return runner
  }

  private async hello(body: Protocol.Hello & { error?: string }): Promise<Config.Runner> {
    const config = this.config()
    const runner = this.known(body.runner)
    const refuse = (error: string): never => {
      this.update('runners', runner.id, { error, seen_at: Date.now(), state: 'refused' })
      throw new Refusal(409, error)
    }
    if (body.error) refuse(body.error)
    const capabilities = body.capabilities
    if (config.sandbox.backend === 'krun' && !capabilities.krun)
      refuse('the sandbox cannot start libkrun microVMs for the krun backend')
    if (config.agents.some((agent) => agent.branches) && !capabilities.fork)
      refuse('the run branches its agents, and the slots of this runner cannot fork')
    if (Config.kind(config.sandbox.backend) !== Config.kind(capabilities.backend))
      refuse(
        'the runner was set up for the ' +
          capabilities.backend +
          ' backend, and the run has ' +
          Config.kind(config.sandbox.backend) +
          ' environments',
      )
    if (capabilities.network !== config.sandbox.network)
      refuse(
        'the sandbox was set up for the ' +
          capabilities.network +
          ' network, and the run asks for ' +
          config.sandbox.network,
      )
    const now = Date.now()
    this.update('runners', runner.id, {
      capabilities: JSON.stringify(capabilities),
      error: null,
      seen_at: now,
      state: 'ready',
    })
    if (Timeline.valid(body.timeline))
      Timeline.report(this.sql, { receivedAt: now, report: body.timeline, runner: runner.id })
    Timeline.add(this.sql, { at: now, name: 'runner.hello', runner: runner.id })
    const held = new Set((body.held ?? []).map((entry) => entry.id + ' ' + entry.claim))
    for (const row of this.rows())
      if (row.runner === runner.id && Ledger.active(row) && !held.has(row.id + ' ' + row.claim))
        await this.lose(row, 'released')
    return this.runnerConfig(runner.id)
  }

  private async fault(row: Ledger.Attempt, body: Protocol.Fault): Promise<{ released: true }> {
    if (typeof body.message !== 'string')
      throw new Refusal(400, 'message is what the machine said when the slot did not come up')
    if (row.phase !== 'claimed')
      throw new Refusal(
        409,
        'the slot of the attempt came up: it is in the ' + row.phase + ' phase',
      )
    const now = Date.now()
    if (row.runner !== null) {
      this.update('runners', row.runner, {
        error: 'the machine could not bring a slot up: ' + body.message,
        seen_at: now,
        state: 'refused',
      })
      Timeline.add(this.sql, { at: now, name: 'runner.fault', runner: row.runner })
    }
    await this.lose(
      row,
      'released',
      row.claims < this.config().limits.claims
        ? undefined
        : 'the attempt was claimed ' +
            row.claims +
            ' times, the limit of the run, and the machine of runner ' +
            row.runner +
            ' could not bring its slot up: ' +
            body.message,
    )
    return { released: true }
  }

  private async gone(row: Ledger.Attempt, body: Protocol.Fault): Promise<{ released: true }> {
    if (typeof body.message !== 'string')
      throw new Refusal(400, 'message is what the machine said of the slot that ended')
    Ledger.explain(this.sql, { claim: row.claim!, error: body.message })
    Timeline.add(this.sql, {
      at: Date.now(),
      attempt: row.id,
      name: 'attempt.gone',
      ...(row.runner === null ? {} : { runner: row.runner }),
    })
    await this.lose(
      row,
      'released',
      row.claims < this.config().limits.claims
        ? undefined
        : 'the attempt was claimed ' +
            row.claims +
            ' times, the limit of the run, and the slot of its last claim ended under it in the ' +
            row.phase +
            ' phase: ' +
            body.message,
    )
    return { released: true }
  }

  private finished(): boolean {
    return this.rows().every((row) => row.phase === 'done')
  }

  private async claim(body: Protocol.ClaimRequest): Promise<Protocol.ClaimResponse> {
    const runner = this.known(body.runner)
    if (runner.state !== 'ready') throw new Refusal(409, 'the runner is ' + runner.state)
    if (Timeline.valid(body.timeline))
      Timeline.report(this.sql, {
        receivedAt: Date.now(),
        report: body.timeline,
        runner: runner.id,
      })
    const first = await this.grant(runner.id, body)
    const waitMs = this.holdMs(body.waitMs)
    if (
      first.rows.length ||
      first.finished ||
      !waitMs ||
      body.offer.slots < 1 ||
      this.meta()!.cancelled
    )
      return first
    const outcome = await this.holds.wait('claim:' + runner.id, waitMs)
    if (outcome !== 'released' || this.known(runner.id).state !== 'ready')
      return { finished: this.finished(), rows: [] }
    return this.grant(runner.id, body)
  }

  private async grant(
    runner: number,
    body: Protocol.ClaimRequest,
  ): Promise<Protocol.ClaimResponse> {
    const meta = this.meta()!
    const config = this.config()
    const now = Date.now()
    const idle = (unfit: boolean, takenMb = 0, taken = 0): Protocol.ClaimResponse => {
      const offer = {
        ...body.offer,
        memoryMb: Math.max(0, body.offer.memoryMb - takenMb),
        slots: Math.max(0, body.offer.slots - taken),
      }
      this.update('runners', runner, {
        report: JSON.stringify({ ...body.report, offer, unfit }),
        seen_at: now,
      })
      return { finished: this.finished(), rows: [] }
    }
    if (meta.cancelled || (await this.overBudget()) || this.held()) return idle(false)
    const record = this.known(runner)
    if (this.sandboxes().some((row) => row.id === record.sandbox && row.state === 'ending'))
      return idle(true)
    const drained = record.drained ?? this.drain(record, now)
    if (drained) return { ...idle(false), drained }
    const fits = this.fitting(record, now)
    const pace = this.feeding(now)
    const claimed = Ledger.claim(this.sql, {
      accepts: (row) => fits(row.task) && pace.feeds(row),
      leaseMs: config.limits.leaseSec * 1000,
      memoryOf: (task) => this.task(task).resources.memoryMb,
      now,
      offer: body.offer,
      run: meta.id,
      runner,
      secOf: (task) => Config.rowSec(config.limits, this.task(task)),
      token: secret,
      wholeLast: !Admission.wholeFirst(this.share(runner, body.offer.capacityMb)),
    })
    for (const row of claimed)
      Timeline.add(this.sql, { at: now, attempt: row.id, name: 'attempt.claimed', runner })
    const waiting = this.rows().some((row) => row.phase === 'unclaimed')
    const response = idle(
      !claimed.length && body.offer.slots > 0 && waiting && !pace.declined(),
      claimed.reduce((sum, row) => sum + this.task(row.task).resources.memoryMb, 0),
      claimed.length,
    )
    const ahead = waiting ? this.ahead(runner) : []
    return {
      ...response,
      ...(ahead.length ? { ahead } : {}),
      rows: claimed.map((row) => ({
        agent: this.claimedAgent(row),
        claim: row.claim!,
        id: row.id,
        leaseUntil: row.lease_until!,
        slot: row.slot!,
        task: this.task(row.task),
      })),
    }
  }

  private heartbeat(body: Protocol.Heartbeat): Protocol.HeartbeatResponse {
    const config = this.config()
    const runner = this.known(body.runner)
    const earlier = runner.report ? (JSON.parse(runner.report) as Protocol.Report) : {}
    this.update('runners', runner.id, {
      report: JSON.stringify({ ...earlier, ...body.report }),
      seen_at: Date.now(),
      ...(runner.state === 'lost' ? { error: null, state: 'ready' } : {}),
    })
    const ahead = this.ahead(runner.id)
    return {
      ...(ahead.length ? { ahead } : {}),
      finished: this.finished(),
      lost: Ledger.heartbeat(this.sql, {
        held: body.held,
        leaseMs: config.limits.leaseSec * 1000,
        now: Date.now(),
        runner: runner.id,
      }),
    }
  }

  private async leave(body: Protocol.Leave): Promise<{ left: true }> {
    const runner = this.known(body.runner)
    this.update('runners', runner.id, {
      seen_at: Date.now(),
      ...(runner.state === 'refused' ? {} : { state: 'left' }),
    })
    this.holds.end('claim:' + runner.id)
    for (const row of this.rows())
      if (row.runner === runner.id && Ledger.active(row)) await this.lose(row, 'released')
    this.ctx.waitUntil(this.tick())
    return { left: true }
  }

  private claimedAgent(row: Ledger.Attempt): Protocol.Claimed['agent'] {
    const agent = this.agentOf(row)
    return {
      ...(Installed.is(agent.provider)
        ? {
            cli: {
              ...(agent.api ? { api: agent.api } : {}),
              kind: agent.provider,
              model: agent.model,
              ...(agent.thinking ? { thinking: agent.thinking } : {}),
            },
          }
        : {}),
      ...(agent.branches ? { branches: agent.branches } : {}),
      id: agent.id,
      oracle: agent.provider === 'oracle',
      ...(agent.preflight ? { preflight: true as const } : {}),
    }
  }

  private async endpoint(row: Ledger.Attempt): Promise<Protocol.Endpoint> {
    if (!this.installed(row))
      throw new Refusal(409, 'the agent of the attempt is a session, not an installed command')
    this.attaching(row)
    const meta = this.meta()!
    return {
      token: await this.modelToken(row),
      url: meta.publicUrl + '/v1/runs/' + meta.id + '/model/' + row.id,
    }
  }

  private async handSession(row: Ledger.Attempt, body: Protocol.Hand): Promise<Protocol.Session> {
    if (this.installed(row))
      throw new Refusal(409, 'the agent of the attempt is an installed command, not a session')
    const branch = body.branch ?? 0
    if (!Number.isInteger(branch) || branch < 0 || branch >= this.branches(row))
      throw new Refusal(400, 'the attempt has no branch ' + branch)
    const session = Branch.session(row.session!, branch)
    const token = await Harness.token(this.env, session)
    return {
      name: Protocol.handName,
      token,
      url:
        this.meta()!.publicUrl.replace(/^http/, 'ws') +
        '/sessions/' +
        encodeURIComponent(session) +
        '/hands',
    }
  }

  private branches(row: Pick<Ledger.Attempt, 'agent'>): number {
    return this.agentOf(row).branches ?? 1
  }

  private branchSessions(row: Ledger.Attempt): string[] {
    return row.session
      ? Branch.indexes(this.branches(row)).map((index) => Branch.session(row.session!, index))
      : []
  }

  private branchRecord(row: Ledger.Attempt): Branch.Record | undefined {
    const recorded = this.textArtifact(row.id, Branch.record)
    return recorded === undefined ? undefined : (JSON.parse(recorded) as Branch.Record)
  }

  private attaching(row: Ledger.Attempt): void {
    const now = Date.now()
    if (row.phase === 'claimed') {
      Timeline.add(this.sql, { at: now, attempt: row.id, name: 'attempt.environment' })
      Ledger.update(this.sql, row.id, {
        phase: 'attach',
        phase_at: now,
        timing: Ledger.mark(
          Ledger.mark(row.timing, 'environmentSetup', { at: now, edge: 'finish' }),
          'agentSetup',
          { at: now, edge: 'start' },
        ),
      })
    }
  }

  private async listed(
    row: Ledger.Attempt,
    input: { session: string; waitMs: number },
  ): Promise<boolean> {
    const until = Date.now() + input.waitMs
    for (;;) {
      if ((await Harness.hands(this.env, input.session)).includes(Protocol.handName)) return true
      const left = until - Date.now()
      if (left <= 0) return false
      await this.holds.wait(
        'row:' + row.id + ':hand',
        Math.min(left, Number(this.env.HAND_LIST_MS)),
      )
      if (!Ledger.held(this.sql, { claim: row.claim!, id: row.id }))
        throw new Refusal(410, 'the attempt is not claimed by this runner any more')
    }
  }

  private async agent(claimed: Ledger.Attempt, body: Protocol.Ask): Promise<Protocol.Agent> {
    const task = this.task(claimed.task)
    const agent = this.agentOf(claimed)
    const harness = Config.harness(agent)
    const waitMs = this.holdMs(body.waitMs)
    if (claimed.phase === 'claimed') this.attaching(claimed)
    const row = Ledger.get(this.sql, claimed.id)!
    const session = row.session!
    if (row.phase === 'attach') {
      if (harness !== 'installed')
        for (const name of this.branchSessions(row))
          if (!(await this.listed(row, { session: name, waitMs }))) return { state: 'waiting' }
      if (harness !== 'oracle') {
        if (
          typeof body.instruction !== 'string' ||
          (await Bytes.sha256(Bytes.fromText(body.instruction))) !== task.instruction.digest
        )
          throw new Refusal(400, 'the instruction does not match the digest of the task')
      }
      if (harness === 'installed')
        this.putArtifact(row.id, Installed.instruction, body.instruction!)
      if (agent.preflight) {
        if (typeof body.facts !== 'string')
          throw new Refusal(
            400,
            'the agent takes a preflight, and the runner sent no facts from its probe',
          )
        this.putArtifact(row.id, Preflight.artifact, body.facts)
      }
      if (agent.provider === 'claude' || agent.provider === 'codex')
        for (const name of this.branchSessions(row))
          await this.ask(row, {
            prompt: agent.preflight
              ? Preflight.prompt({ facts: body.facts!, instruction: body.instruction! })
              : body.instruction!,
            requestId,
            session: name,
          })
      const now = Date.now()
      Timeline.add(this.sql, { at: now, attempt: row.id, name: 'attempt.agent' })
      Ledger.update(this.sql, row.id, {
        deadline_at: now + task.agent.timeoutSec * 1000,
        phase: 'run',
        phase_at: now,
        timing: Ledger.mark(
          Ledger.mark(Ledger.get(this.sql, row.id)!.timing, 'agentSetup', {
            at: now,
            edge: 'finish',
          }),
          'agentExecution',
          { at: now, edge: 'start' },
        ),
      })
      return harness === 'session'
        ? { detached: false, state: 'running' }
        : { state: 'attached', timeoutSec: task.agent.timeoutSec }
    }
    if (row.phase !== 'run' && row.phase !== 'verify')
      throw new Refusal(409, 'the attempt is in the ' + row.phase + ' phase')
    if (harness !== 'session') return { state: 'attached', timeoutSec: task.agent.timeoutSec }
    if (this.branches(row) > 1) return this.branched(row, waitMs)

    const read = async (): Promise<Protocol.Agent> => {
      const current = Ledger.held(this.sql, { claim: row.claim!, id: row.id })
      if (!current) throw new Refusal(410, 'the attempt is not claimed by this runner any more')
      const earlier = current.failure ? (JSON.parse(current.failure) as Result.Failure) : undefined
      if (earlier?.kind === 'agent_timeout' || earlier?.kind === 'environment')
        return { state: 'timeout' }
      if (earlier?.message.startsWith(Retry.refusedPrefix))
        return { error: earlier.message, state: 'failed' }
      const report = await this.kept(current, Harness.turn(this.env, session, requestId))
      if (report.status === 'completed')
        return { message: report.ok?.message ?? '', state: 'completed' }
      if (report.status === 'failed' || report.status === 'cancelled')
        return { error: report.error ?? 'the turn ended as ' + report.status, state: 'failed' }
      const now = Date.now()
      const refused = this.refusedOut(current, now)
      if (refused) {
        Ledger.update(this.sql, row.id, { failure: JSON.stringify(refused) })
        Timeline.add(this.sql, { at: now, attempt: row.id, name: 'attempt.refused' })
        await Harness.cancel(this.env, session, requestId)
        return { error: refused.message, state: 'failed' }
      }
      if (now > current.deadline_at!) {
        await Harness.cancel(this.env, session, requestId)
        Ledger.update(this.sql, row.id, {
          failure: JSON.stringify(
            (report.status === 'queued'
              ? {
                  at: now,
                  kind: 'environment',
                  message:
                    Retry.queued +
                    ': it was still queued after ' +
                    task.agent.timeoutSec +
                    ' s' +
                    (report.kind === 'detached' ? ', with no hand attached' : ''),
                }
              : {
                  at: now,
                  kind: 'agent_timeout',
                  message: 'the agent did not finish within ' + task.agent.timeoutSec + ' s',
                }) satisfies Result.Failure,
          ),
        })
        return { state: 'timeout' }
      }
      return { detached: report.kind === 'detached', state: 'running' }
    }
    const state = await read()
    if (state.state !== 'running' || state.detached || !waitMs) return state
    const key = 'row:' + row.id + ':agent'
    const released = this.holds.wait(key, waitMs).then(() => undefined)
    try {
      const seen = await Harness.watch(this.env, session, {
        after: this.cursors.get(session) ?? 0,
        released,
        requestId,
        types: ['result'],
        waitMs: Math.max(1, Math.min(waitMs, row.deadline_at! - Date.now() + 1)),
      })
      this.cursors.set(session, seen.cursor)
    } catch (error) {
      if (!(error instanceof Harness.RequestError)) throw error
      return state
    } finally {
      this.holds.release((held) => held === key)
    }
    return read()
  }

  private async ask(
    row: Ledger.Attempt,
    input: { prompt: string; requestId: string; session: string },
  ): Promise<Harness.Report> {
    const agent = this.agentOf(row)
    if (agent.provider !== 'claude' && agent.provider !== 'codex')
      throw new Refusal(409, 'the agent of the attempt is not a session')
    const now = Date.now()
    const deadline = Turn.deadline(this.config().limits, {
      limitMs: this.task(row.task).agent.timeoutSec * 1000,
      now,
    })
    const turn: Turn.Turn = {
      ...(deadline ? { deadline } : {}),
      hand: Protocol.handName,
      model: agent.model,
      ...(agent.orchestration ? { orchestration: agent.orchestration } : {}),
      payer: this.payer(agent.provider),
      prompt: input.prompt,
      provider: agent.provider,
      requestId: input.requestId,
      ...(agent.thinking ? { thinking: agent.thinking } : {}),
    }
    try {
      const report = await Harness.submit(this.env, input.session, turn)
      this.putArtifact(
        row.id,
        Turn.record,
        (this.textArtifact(row.id, Turn.record) ?? '') +
          Turn.sent(turn, { at: now, session: input.session }),
      )
      return report
    } catch (error) {
      throw await this.unpaid(row, error)
    }
  }

  private async branched(row: Ledger.Attempt, waitMs: number): Promise<Protocol.Agent> {
    const task = this.task(row.task)
    const decided = (record: Branch.Record): Protocol.Agent => {
      const outcome = record.branches[record.chosen]!
      if (outcome.state === 'completed')
        return { branch: record.chosen, message: outcome.message, state: 'completed' }
      if (outcome.state === 'failed') return { error: outcome.error, state: 'failed' }
      return { branch: record.chosen, state: 'timeout' }
    }
    type Read = { agent: Protocol.Agent; waiting?: { requestId: string; session: string } }
    const read = async (): Promise<Read> => {
      const current = Ledger.held(this.sql, { claim: row.claim!, id: row.id })
      if (!current) throw new Refusal(410, 'the attempt is not claimed by this runner any more')
      const recorded = this.branchRecord(current)
      if (recorded) return { agent: decided(recorded) }
      const earlier = current.failure ? (JSON.parse(current.failure) as Result.Failure) : undefined
      if (earlier?.kind === 'agent_timeout' || earlier?.kind === 'environment')
        return { agent: { state: 'timeout' } }
      if (earlier?.message.startsWith(Retry.refusedPrefix))
        return { agent: { error: earlier.message, state: 'failed' } }
      const now = Date.now()
      const late = now > current.deadline_at!
      const outcomes: (Branch.Outcome | undefined)[] = []
      let detached = false
      let queued = 0
      let waiting: Read['waiting']
      for (const name of this.branchSessions(current)) {
        const report = await this.kept(current, Harness.turn(this.env, name, requestId))
        if (report.status === 'failed' || report.status === 'cancelled') {
          outcomes.push({
            error: report.error ?? 'the turn ended as ' + report.status,
            state: 'failed',
          })
          continue
        }
        if (report.status !== 'completed') {
          if (report.status === 'queued') queued++
          if (late) {
            await Harness.cancel(this.env, name, requestId)
            outcomes.push({ state: 'timeout' })
            continue
          }
          detached ||= report.kind === 'detached'
          waiting ??= { requestId, session: name }
          outcomes.push(undefined)
          continue
        }
        const message = report.ok?.message ?? ''
        let check: Harness.Report | undefined
        try {
          check = await Harness.turn(this.env, name, Branch.checkRequestId)
        } catch (error) {
          if (!(error instanceof Harness.LostError)) throw error
        }
        if (!check && !late)
          check = await this.ask(current, {
            prompt: Branch.prompt,
            requestId: Branch.checkRequestId,
            session: name,
          })
        if (check?.status === 'completed') {
          outcomes.push({
            message,
            state: 'completed',
            verdict: Branch.verdict(check.ok?.message ?? ''),
          })
          continue
        }
        const open =
          check !== undefined && check.status !== 'failed' && check.status !== 'cancelled'
        if (open && !late) {
          waiting ??= { requestId: Branch.checkRequestId, session: name }
          outcomes.push(undefined)
          continue
        }
        if (open) await Harness.cancel(this.env, name, Branch.checkRequestId)
        outcomes.push({ message, state: 'completed', verdict: 'unknown' })
      }
      if (outcomes.includes(undefined)) {
        const refused = this.refusedOut(current, now)
        if (refused) {
          Ledger.update(this.sql, row.id, { failure: JSON.stringify(refused) })
          Timeline.add(this.sql, { at: now, attempt: row.id, name: 'attempt.refused' })
          for (const name of this.branchSessions(current)) {
            await Harness.cancel(this.env, name, requestId)
            await Harness.cancel(this.env, name, Branch.checkRequestId)
          }
          return { agent: { error: refused.message, state: 'failed' } }
        }
        return { agent: { detached, state: 'running' }, ...(waiting ? { waiting } : {}) }
      }
      const branches = outcomes as Branch.Outcome[]
      const chosen = Branch.choose(branches)
      if (branches[chosen]!.state === 'timeout')
        Ledger.update(this.sql, row.id, {
          failure: JSON.stringify(
            (queued === branches.length
              ? {
                  at: now,
                  kind: 'environment',
                  message:
                    Retry.queued +
                    ': every branch was still queued after ' +
                    task.agent.timeoutSec +
                    ' s',
                }
              : {
                  at: now,
                  kind: 'agent_timeout',
                  message: 'the agent did not finish within ' + task.agent.timeoutSec + ' s',
                }) satisfies Result.Failure,
          ),
        })
      const record: Branch.Record = { branches, chosen }
      this.putArtifact(row.id, Branch.record, JSON.stringify(record, null, 2) + '\n')
      return { agent: decided(record) }
    }
    const first = await read()
    if (first.agent.state !== 'running' || first.agent.detached || !waitMs || !first.waiting)
      return first.agent
    const key = 'row:' + row.id + ':agent'
    const released = this.holds.wait(key, waitMs).then(() => undefined)
    const session = first.waiting.session
    try {
      const seen = await Harness.watch(this.env, session, {
        after: this.cursors.get(session) ?? 0,
        released,
        requestId: first.waiting.requestId,
        types: ['result'],
        waitMs: Math.max(1, Math.min(waitMs, row.deadline_at! - Date.now() + 1)),
      })
      this.cursors.set(session, seen.cursor)
    } catch (error) {
      if (!(error instanceof Harness.RequestError)) throw error
      return first.agent
    } finally {
      this.holds.release((held) => held === key)
    }
    return (await read()).agent
  }

  private verify(row: Ledger.Attempt, body: { solve?: { code: number } }): { ok: true } {
    if (row.phase === 'verify') return { ok: true }
    if (row.phase !== 'run') throw new Refusal(409, 'the attempt is in the ' + row.phase + ' phase')
    const task = this.task(row.task)
    const now = Date.now()
    Timeline.add(this.sql, { at: now, attempt: row.id, name: 'attempt.verify' })
    Ledger.update(this.sql, row.id, {
      ...(body.solve && Verdict.timeoutCodes.includes(body.solve.code)
        ? {
            failure: JSON.stringify({
              at: now,
              kind: 'agent_timeout',
              message:
                'the ' +
                (this.installed(row) ? 'agent' : 'solution') +
                ' did not finish within ' +
                task.agent.timeoutSec +
                ' s',
            } satisfies Result.Failure),
          }
        : {}),
      phase: 'verify',
      phase_at: now,
      timing: Ledger.mark(
        Ledger.mark(row.timing, 'agentExecution', { at: now, edge: 'finish' }),
        'verifier',
        { at: now, edge: 'start' },
      ),
    })
    return { ok: true }
  }

  private async judge(
    row: Ledger.Attempt,
    body: { request?: string },
  ): Promise<Protocol.Judgement> {
    const config = this.config()
    const task = this.task(row.task)
    const now = Date.now()
    if (row.phase === 'verify') {
      const answered = this.textArtifact(row.id, judgeResponse)
      if (answered !== undefined) return { response: answered, state: 'answered' }
      if (typeof body.request !== 'string' || !task.verifier.judge || !config.judge)
        throw new Refusal(400, 'the attempt has no judge request')
      let requests: Judge.Request[]
      try {
        requests = Judge.parse(body.request)
      } catch (error) {
        return { error: message(error), state: 'invalid' }
      }
      this.putArtifact(row.id, judgeRequest, body.request)
      try {
        for (const [index, entry] of requests.entries())
          await Harness.submit(this.env, row.session + '-judge-' + index, {
            model: config.judge.model,
            payer: this.payer(config.judge.provider),
            prompt: entry.prompt,
            provider: config.judge.provider,
            requestId: judgeRequestId,
            ...(config.judge.thinking ? { thinking: config.judge.thinking } : {}),
          })
      } catch (error) {
        throw await this.unpaid(row, error)
      }
      Ledger.update(this.sql, row.id, {
        phase: 'judge',
        phase_at: now,
        timing: Ledger.mark(row.timing, 'judge', { at: now, edge: 'start' }),
      })
      return { state: 'waiting' }
    }
    if (row.phase !== 'judge')
      throw new Refusal(409, 'the attempt is in the ' + row.phase + ' phase')
    const requests = Judge.parse(this.textArtifact(row.id, judgeRequest)!)
    const reports = await this.kept(
      row,
      Promise.all(
        this.judgeSessions(row).map((name) => Harness.turn(this.env, name, judgeRequestId)),
      ),
    )
    const broken = reports.find(
      (report) => report.status === 'failed' || report.status === 'cancelled',
    )
    if (broken)
      return {
        error: 'the judge ' + broken.status + ': ' + (broken.error ?? 'no reason'),
        state: 'failed',
      }
    if (reports.some((report) => report.status !== 'completed'))
      return now - (row.phase_at ?? now) > task.verifier.timeoutSec * 1000
        ? { state: 'timeout' }
        : { state: 'waiting' }
    const response = Judge.answer(
      requests,
      reports.map((report) => report.ok?.message ?? ''),
    )
    this.putArtifact(row.id, judgeResponse, response)
    Ledger.update(this.sql, row.id, {
      phase: 'verify',
      phase_at: now,
      timing: Ledger.mark(row.timing, 'judge', { at: now, edge: 'finish' }),
    })
    return { response, state: 'answered' }
  }

  private async finish(row: Ledger.Attempt, body: Protocol.Finish): Promise<Protocol.Finished> {
    const config = this.config()
    const task = this.task(row.task)
    const own = this.imported(row.task)
    const ownSec = Config.cuts(config.limits, own) ? own.verifier.timeoutSec : undefined
    const now = Date.now()
    let end: {
      failure?: Result.Failure
      memoryMb?: number
      oomKills?: number
      reward: number | null
    }
    const refusals = new Set(
      this.sql
        .all(
          'SELECT DISTINCT refusal FROM model_requests WHERE attempt = ? AND claim = ? AND refusal IS NOT NULL',
          row.id,
          row.claims,
        )
        .map((request) => request['refusal'] as Proxy.Refusal),
    )
    const cut =
      'the model budget of $' +
      config.budget.modelUsd +
      ' ended the row, which was refused a model request'
    if (body.verifier) {
      end = {
        ...Verdict.verifier({
          ctrf: task.verifier.ctrf === true,
          ...(row.failure ? { earlier: JSON.parse(row.failure) as Result.Failure } : {}),
          facts: body.verifier,
          log: this.textArtifact(row.id, verifierLog) ?? '',
          memoryMb: task.resources.memoryMb,
          now,
          ...(ownSec === undefined ? {} : { ownSec }),
          timeoutSec: task.verifier.timeoutSec,
        }),
        ...(body.verifier.memoryMb === undefined ? {} : { memoryMb: body.verifier.memoryMb }),
        ...(body.verifier.oom ? { oomKills: body.verifier.oom } : {}),
      }
      if (refusals.has('budget') && Result.outcome(end.reward, end.failure) !== 'passed')
        end = {
          ...end,
          failure: {
            at: now,
            kind: 'budget',
            message: cut + (end.failure ? ': ' + end.failure.message : ''),
          },
          reward: null,
        }
      Ledger.update(this.sql, row.id, {
        timing: Ledger.mark(row.timing, 'verifier', { at: now, edge: 'finish' }),
      })
    } else if (body.failure) {
      const unpaid = refusals.has('plan') ? this.meta()!.refused : undefined
      const failure: Result.Failure = {
        ...Verdict.bounded({ at: now, ...body.failure }, ownSec),
        ...(body.failure.kind === 'agent' && refusals.has('spent')
          ? { kind: 'budget' as const }
          : {}),
        ...(body.failure.kind === 'agent' && refusals.has('budget')
          ? { kind: 'budget' as const, message: cut + ': ' + body.failure.message }
          : {}),
        ...(unpaid?.plan ? { kind: 'environment' as const, message: unpaid.message } : {}),
      }
      const requests = this.sql
        .all(
          "SELECT refusal FROM model_requests WHERE attempt = ? AND claim = ? AND status IS NOT NULL AND path NOT LIKE 'judge/%' ORDER BY id",
          row.id,
          row.claims,
        )
        .map((request) =>
          request['refusal'] === null ? {} : { refusal: request['refusal'] as Proxy.Refusal },
        )
      end = {
        failure:
          Retry.rejected({ failure, requests }) ?? Retry.unserved({ failure, requests }) ?? failure,
        reward: null,
      }
    } else throw new Refusal(400, 'finishing an attempt reports a verifier or a failure')
    if (row.session && row.phase === 'run' && this.submitted(row))
      for (const name of this.branchSessions(row)) await this.halt(name)
    const statuses = this.sql
      .all(
        'SELECT status FROM model_requests WHERE attempt = ? AND claim = ? AND status IS NOT NULL',
        row.id,
        row.claims,
      )
      .map((request) => request['status'] as number)
    const stall =
      (end.failure
        ? Retry.stalled({
            failure: end.failure,
            statuses,
            ...(end.oomKills === undefined ? {} : { oomKills: end.oomKills }),
          })
        : undefined) ??
      Retry.unanswered({ at: now, statuses, ...(end.failure ? { failure: end.failure } : {}) }) ??
      (end.failure && Result.outcome(end.reward, end.failure) !== 'passed'
        ? Retry.throttled({
            failure: end.failure,
            requests: this.sql
              .all(
                "SELECT again, status, wait FROM model_requests WHERE attempt = ? AND claim = ? AND status IS NOT NULL AND path NOT LIKE 'judge/%' ORDER BY id",
                row.id,
                row.claims,
              )
              .map((request) => ({
                ...(request['again'] === null ? {} : { again: true }),
                status: request['status'] as number,
                ...(request['wait'] === null ? {} : { waitMs: request['wait'] as number }),
              })),
          })
        : undefined)
    if (stall) end = { ...end, failure: stall, reward: null }
    const cause =
      end.failure && end.reward === null
        ? Retry.infrastructure({ failure: end.failure, statuses })
        : undefined
    if (cause && Ledger.retriable(this.sql, { id: row.id, limit: config.limits.claims })) {
      Ledger.explain(this.sql, { claim: row.claim!, error: cause + ': ' + end.failure!.message })
      Timeline.add(this.sql, { at: now, attempt: row.id, name: 'attempt.retried' })
      await this.lose(Ledger.get(this.sql, row.id)!, 'retried')
      return { evict: false }
    }
    await this.complete(Ledger.get(this.sql, row.id)!, end)

    const disk = (name: string) => {
      const environment = this.task(name).environment
      return environment.kind === 'disk' ? environment.disk.digest : environment.files.digest
    }
    const rows = this.rows()
    const needed = rows.some(
      (other) => other.phase !== 'done' && disk(other.task) === disk(row.task),
    )
    if (rows.every((other) => other.phase === 'done')) this.ctx.waitUntil(this.tick())
    return { evict: config.sandbox.disks === 'remove' && !needed }
  }

  private async complete(
    row: Ledger.Attempt,
    end: {
      collect?: boolean
      ending?: Ledger.Ending
      failure?: Result.Failure
      memoryMb?: number
      oomKills?: number
      reward: number | null
    },
  ): Promise<void> {
    const meta = this.meta()!
    const config = this.config()
    const task = this.task(row.task)
    const agent = config.agents.find((candidate) => candidate.id === row.agent)!
    const session = row.session ?? meta.id + '-' + row.id
    const submitted = end.collect !== false && this.submitted(row)
    const now = Date.now()
    const judges = this.judgeSessions(row)
    const judgeUsage: Atif.Usage[] = []
    for (const name of judges) {
      try {
        judgeUsage.push(Atif.usage(await Harness.events(this.env, name, judgeRequestId)))
      } catch (error) {
        this.putArtifact(row.id, 'verifier/judge-error.txt', message(error))
      }
      await this.remove(name)
    }

    let usage: Atif.Usage | null = null
    let reported: ReturnType<typeof Route.reported> = {}
    const sessions = row.session ? this.branchSessions(row) : [session]
    if (submitted) {
      try {
        const chosen = this.branchRecord(row)?.chosen ?? 0
        const usages: Atif.Usage[] = []
        for (const [index, name] of sessions.entries()) {
          const events = await Harness.events(this.env, name, requestId)
          usages.push(Atif.usage(events))
          const projected = Object.entries(this.projected(row, { events, session: name }))
          if (index !== chosen) {
            for (const [file, body] of projected)
              this.putArtifact(
                row.id,
                file.replace(/^agent\//, 'agent/branch-' + index + '/'),
                body,
              )
            continue
          }
          reported = Route.reported(events)
          const requested = Timeline.modelRequest(events)
          if (requested !== undefined)
            Timeline.add(this.sql, { at: requested, attempt: row.id, name: 'attempt.model' })
          for (const [file, body] of projected) this.putArtifact(row.id, file, body)
        }
        usage = usages.length === 1 ? usages[0]! : Atif.sum(usages)
      } catch (error) {
        this.putArtifact(row.id, 'agent/events-error.txt', message(error))
      }
    }
    const kind = this.installed(row)
    if (kind && end.collect !== false && ['judge', 'run', 'verify'].includes(row.phase)) {
      const stream = this.textArtifact(row.id, Installed.events) ?? ''
      const summary = Installed.summarize(kind, stream)
      const metered = this.metered(row)
      const requested = this.sql.all(
        'SELECT MIN(at) AS at FROM model_requests WHERE attempt = ? AND claim = ?',
        row.id,
        row.claims,
      )[0]?.['at']
      if (typeof requested === 'number')
        Timeline.add(this.sql, { at: requested, attempt: row.id, name: 'attempt.model' })
      usage = {
        ...metered,
        costUsd: metered.costUsd ?? summary.costUsd,
        toolCalls: summary.toolCalls,
      }
      const instruction = this.textArtifact(row.id, Installed.instruction)
      this.putArtifact(
        row.id,
        agentTrajectory,
        JSON.stringify(
          Installed.trajectory(
            kind,
            { ...(instruction === undefined ? {} : { instruction }), stream, usage },
            { model: agent.model, name: kind, session, version: Installed.releases[kind].version },
          ),
          null,
          2,
        ) + '\n',
      )
    }

    if (end.collect !== false) {
      const requests = this.sql.all(
        'SELECT claim, cost, listed, path, tools_usd FROM model_requests WHERE attempt = ? ORDER BY id',
        row.id,
      )
      const priced = requests.filter(
        (request) =>
          request['claim'] === row.claims &&
          request['cost'] !== null &&
          !(request['path'] as string).startsWith(judgePath),
      )
      const listed = requests
        .filter(
          (request) =>
            request['claim'] === row.claims &&
            request['cost'] === null &&
            request['tools_usd'] !== null &&
            !(request['path'] as string).startsWith(judgePath),
        )
        .reduce((sum, request) => sum + (request['tools_usd'] as number), 0)
      if (usage && !kind && priced.length)
        usage = {
          ...usage,
          ...(priced.some((request) => request['listed']) ? { costBy: 'list' as const } : {}),
          costUsd: priced.reduce((sum, request) => sum + (request['cost'] as number), 0),
        }
      else if (usage && !kind && usage.costUsd !== undefined && listed > 0)
        usage = { ...usage, costUsd: usage.costUsd + listed, toolsUsd: listed }
      const log = this.requestLog(row.id)
      if (log !== undefined) this.putArtifact(row.id, modelRequests, log)
    }

    const route = this.route(row, reported)
    const waits = this.sql.all(
      'SELECT COUNT(*) AS count, COALESCE(SUM(wait), 0) AS ms FROM model_requests WHERE attempt = ? AND claim = ? AND wait IS NOT NULL',
      row.id,
      row.claims,
    )[0]!
    const result: Result.Attempt = {
      agent,
      ...(config.limits.agentMaxSec === undefined
        ? {}
        : { agentMaxSec: config.limits.agentMaxSec }),
      ...(row.claims > 1 ? { claims: row.claims } : {}),
      ...(end.failure ? { failure: end.failure } : {}),
      finishedAt: now,
      id: row.id,
      index: row.n,
      ...(config.judge && judges.length
        ? {
            judge: {
              ...config.judge,
              requests: judges.length,
              usage: judgeUsage.length === judges.length ? Atif.sum(judgeUsage) : null,
            },
          }
        : {}),
      ...(waits['count']
        ? {
            modelWaits: {
              count: waits['count'] as number,
              sec: (waits['ms'] as number) / 1000,
            },
          }
        : {}),
      ...(end.oomKills ? { oomKills: end.oomKills } : {}),
      outcome: Result.outcome(end.reward, end.failure),
      ...(row.origin ? { retryOf: JSON.parse(row.origin) as Ledger.Origin } : {}),
      reward: end.reward,
      ...(route ? { route } : {}),
      sandbox:
        row.runner === null
          ? null
          : {
              backend: this.backend(row.runner),
              id: row.runner,
              ...(end.memoryMb === undefined ? {} : { memoryMb: end.memoryMb }),
              provider: config.sandbox.provider,
              slot: row.slot!,
            },
      session,
      startedAt: row.started_at ?? now,
      task: { checksum: task.checksum, name: task.name },
      timing: JSON.parse(Ledger.get(this.sql, row.id)!.timing),
      usage,
      ...(config.limits.verifierMaxSec === undefined
        ? {}
        : { verifierMaxSec: config.limits.verifierMaxSec }),
    }
    Ledger.finish(this.sql, {
      ...(end.ending ? { ending: end.ending } : {}),
      id: row.id,
      now,
      result,
    })
    if (row.phase !== 'unclaimed')
      Timeline.add(this.sql, { at: Date.now(), attempt: row.id, name: 'attempt.verdict' })
    for (const name of sessions) this.cursors.delete(name)
    this.wake(row.id)
    if (this.finished()) this.wake()
    if (row.session && row.phase !== 'unclaimed' && row.phase !== 'claimed' && !kind)
      for (const name of sessions) await this.remove(name)
  }
}
