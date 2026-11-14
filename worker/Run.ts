import { DurableObject } from 'cloudflare:workers'
import { privateKeyToAccount } from 'viem/accounts'
import * as Admission from '../src/Admission.ts'
import * as Atif from '../src/Atif.ts'
import * as Bootstrap from '../src/Bootstrap.ts'
import * as Budget from '../src/Budget.ts'
import * as Config from '../src/Config.ts'
import * as E2b from '../src/E2b.ts'
import * as Eval from '../src/Eval.ts'
import * as Gateway from '../src/Gateway.ts'
import * as Harbor from '../src/Harbor.ts'
import * as Hold from '../src/Hold.ts'
import * as Installed from '../src/Installed.ts'
import * as Judge from '../src/Judge.ts'
import * as Ledger from '../src/Ledger.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Payment from '../src/Payment.ts'
import * as Members from '../src/Pool.ts'
import * as Protocol from '../src/Protocol.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Result from '../src/Result.ts'
import * as Retry from '../src/Retry.ts'
import type * as Runs from '../src/Runs.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as SqlSetup from '../src/Sql.ts'
import * as Timeline from '../src/Timeline.ts'
import * as Verdict from '../src/Verdict.ts'
import * as Blobs from './Blobs.ts'
import type { Env } from './Env.ts'
import * as Evals from './Evals.ts'
import * as Harness from './Harness.ts'
import type * as Meter from './Meter.ts'
import * as Model from './Model.ts'
import * as PoolObject from './Pool.ts'
import { plan } from './Sessions.ts'
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
  publicUrl: string
  refused?: { at: number; message: string; plan?: true }
  reruns: string[]
  restranded?: true
  runnerToken: string
  sandboxFailures: number
  starvedAt?: number
  strandedAt?: number
}

type Lineage = {
  attempts: Ledger.retries.Parent[]
  eval: { name: string; version: string }
  id: string
}

const judgeRequest = 'verifier/' + Judge.requestFile
const judgeResponse = 'verifier/' + Judge.responseFile
const judgeRequestId = 'judge'
const modelRequests = 'agent/model-requests.jsonl'
const partCharacters = 524_288
const requestId = 'attempt'
const sandboxAttempts = 2
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
    searches INTEGER
  )`,
  ...Ledger.tables,
  ...Timeline.tables,
]

const json = Storage.json
const message = Storage.message

type Settled = Proxy.Session & { outcome?: Meter.Outcome; path?: string; refused?: Meter.Refused }

function detail(text: string): string {
  let found: unknown
  try {
    found = (JSON.parse(text) as { detail?: unknown } | null)?.detail
  } catch {
    found = undefined
  }
  return (typeof found === 'string' && found ? found : text).slice(0, 500)
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
  private readonly creating = new Set<number>()
  private readonly cursors = new Map<string, number>()
  private readonly holds = Hold.create()
  private readonly specs = new Map<string, Eval.Task>()
  private readonly sql: SqlSetup.Sql
  private ticking: Promise<void> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = Storage.sql(ctx)
    SqlSetup.setup(this.sql, tables)
    const columns = this.sql.all('PRAGMA table_info(sandboxes)')
    if (!columns.some((column) => column['name'] === 'paid_until'))
      this.sql.run('ALTER TABLE sandboxes ADD COLUMN paid_until INTEGER')
    if (!columns.some((column) => column['name'] === 'member'))
      this.sql.run('ALTER TABLE sandboxes ADD COLUMN member INTEGER')
    const added: [table: string, column: string, type: string][] = [
      ['claims', 'error', 'TEXT'],
      ['model_requests', 'cost', 'REAL'],
      ['model_requests', 'refusal', 'TEXT'],
      ['model_requests', 'searches', 'INTEGER'],
      ['runners', 'drained', 'TEXT'],
      ['runners', 'ends_at', 'INTEGER'],
    ]
    for (const [table, column, type] of added)
      if (!this.sql.all('PRAGMA table_info(' + table + ')').some((row) => row['name'] === column))
        this.sql.run('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type)
  }

  override async fetch(request: Request): Promise<Response> {
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
        if (!row) return json({ error: 'attempt not found' }, 404)
        if (parts[2] === 'artifacts' && parts[3]) {
          const body = this.artifact(row.id, decodeURIComponent(parts[3]))
          return body === undefined
            ? json({ error: 'artifact not found' }, 404)
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
          artifacts: this.artifactNames(row.id),
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
            ((await found.json()) as { error: string }).error,
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

    const byName = new Map(tasks.map((task) => [task.name, task]))
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
        id,
        ...(params.get('location') ? { location: params.get('location')! } : {}),
        publicUrl: params.get('url')!,
        reruns: [],
        runnerToken: secret(),
        sandboxFailures: 0,
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
      const row = this.sql.all('SELECT body FROM tasks WHERE name = ?', name)[0]!
      spec = JSON.parse(row['body'] as string) as Eval.Task
      this.specs.set(name, spec)
    }
    return spec
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
      'SELECT attempt, SUM(cost) AS usd FROM model_requests WHERE cost IS NOT NULL GROUP BY attempt',
    )) {
      priced.add(row['attempt'] as string)
      total += row['usd'] as number
    }
    for (const row of this.rows())
      if (row.result && !priced.has(row.id)) {
        const result = JSON.parse(row.result) as Result.Attempt
        total += (result.usage?.costUsd ?? 0) + (result.judge?.usage?.costUsd ?? 0)
      }
    for (const lost of Ledger.lostUsage(this.sql))
      if (!priced.has(lost.attempt)) total += (JSON.parse(lost.usage) as Atif.Usage).costUsd ?? 0
    return total
  }

  private payer(provider: 'claude' | 'codex'): Config.Payer | undefined {
    if (this.config().payer === 'plan') return 'plan'
    return plan(this.env, provider) ? undefined : 'deployment'
  }

  private keyed(): boolean {
    const config = this.config()
    if (!this.env.TEMPO_KEY) return false
    if (config.sandbox.provider === 'gateway' && config.sandbox.max > 0) return true
    if (config.payer === 'plan') return false
    return [...config.agents, ...(config.judge ? [config.judge] : [])].some((agent) => {
      if (agent.provider === 'oracle') return false
      const held = Model.credential(
        this.env,
        Installed.is(agent.provider) ? Installed.releases[agent.provider].provider : agent.provider,
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
    outcome: Meter.Outcome
    path: string
  }): void {
    const { outcome } = input
    const usage = outcome.usage
    this.sql.run(
      'INSERT INTO model_requests (attempt, claim, at, path, ms, status, usage, cost, refusal, searches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.attempt,
      input.claim,
      outcome.at,
      input.path,
      outcome.ms,
      outcome.status,
      usage ? JSON.stringify(usage) : null,
      usage?.costUsd ?? null,
      outcome.refusal ?? null,
      usage ? (usage.webFetches ?? 0) + (usage.webSearches ?? 0) : null,
    )
    const { refused, ...rest } = this.meta()!
    if (refused && outcome.status < 400) {
      this.setMeta(rest)
      Timeline.add(this.sql, { at: outcome.at, name: 'model.paid' })
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

  private settled(body: Settled): { pauseMs?: number } {
    if (typeof body?.attempt !== 'string' || !Ledger.get(this.sql, body.attempt))
      throw new Refusal(404, 'the run has no such attempt')
    if (body.refused) {
      const pauseMs = this.refuse(body.refused)
      return pauseMs === undefined ? {} : { pauseMs }
    }
    if (body.outcome && typeof body.path === 'string')
      this.record({
        attempt: body.attempt,
        claim: Number(body.claim),
        outcome: body.outcome,
        path: body.path,
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
        onCharge,
      }),
    })
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

  private view(row: Ledger.Attempt) {
    const result = row.result ? (JSON.parse(row.result) as Result.Attempt) : undefined
    return {
      agent: row.agent,
      claims: row.claims,
      failure: result?.failure ?? (row.failure ? JSON.parse(row.failure) : undefined),
      id: row.id,
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
    const searches = this.sql.all('SELECT COALESCE(SUM(searches), 0) AS n FROM model_requests')[0]![
      'n'
    ] as number
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
      lostClaims: Ledger.claims(this.sql).filter(Ledger.lost).length,
      name: config.name,
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
        modelUsd: this.modelSpent(),
        sandboxUsd: this.spent(),
        unpricedResponses: unpriced['responses'] as number,
        webSearches: searches,
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
        trial: Harbor.trialName(attempt),
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
      for (const row of Ledger.expired(this.sql, Date.now())) await this.lose(row, 'expired')
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
    const kind = this.installed(row)!
    const provider = Installed.releases[kind].provider
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
    const provider = Installed.releases[kind].provider
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
    return Model.forward(this.env, {
      hooks: {
        refused: async (refused) => this.refuse(refused),
        settle: (outcome) => this.record({ attempt: row.id, claim: row.claims, outcome, path }),
      },
      path,
      provider,
      request,
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
    if (row.session) {
      if (submitted && row.phase === 'run') await this.halt(row.session)
      if (submitted)
        usage = await Harness.events(this.env, row.session, requestId).then(
          (events) => {
            const requested = Timeline.modelRequest(events)
            if (requested !== undefined)
              Timeline.add(this.sql, { at: requested, attempt: row.id, name: 'attempt.model' })
            return JSON.stringify(Atif.usage(events))
          },
          () => undefined,
        )
      const installed = this.installed(row) !== undefined
      if (installed && ['judge', 'run', 'verify'].includes(row.phase))
        usage = JSON.stringify(this.metered(row))
      for (const name of this.judgeSessions(row)) await this.remove(name)
      if (row.phase !== 'claimed' && !installed) await this.remove(row.session)
    }
    const requeued = Ledger.requeue(this.sql, {
      ending,
      id: row.id,
      limit: final !== undefined ? 0 : ending === 'retried' ? row.claims + 1 : config.limits.claims,
      now: Date.now(),
      ...(usage ? { usage } : {}),
    })
    this.wake(row.id)
    if (requeued) {
      this.sql.run('DELETE FROM artifacts WHERE attempt = ?', row.id)
      this.sql.run('DELETE FROM binary_artifacts WHERE attempt = ?', row.id)
      this.wake()
      return
    }
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
      if (row.session && row.phase === 'run' && this.submitted(row)) await this.halt(row.session)
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
    for (const row of this.sandboxes()) {
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
      try {
        if (!runner) throw new Error('the sandbox has no runner')
        const started =
          row.state === 'starting' &&
          runner.capabilities !== null &&
          (runner.state === 'ready' || runner.state === 'refused')
        if (started) {
          this.update('sandboxes', row.id, { capabilities: runner.capabilities, state: 'ready' })
          this.setMeta({ ...this.meta()!, sandboxFailures: 0 })
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
        await this.failSandbox(provider, row, message(error))
      }
    }
  }

  private async failSandbox(
    provider: Sandbox.Provider,
    row: SandboxRow,
    error: string,
  ): Promise<void> {
    this.update('sandboxes', row.id, { error, state: 'failed' })
    if (row.runner !== null) {
      const runner = this.runners().find((candidate) => candidate.id === row.runner)
      if (runner && (runner.state === 'ready' || runner.state === 'starting'))
        this.update('runners', runner.id, { error, state: 'lost' })
    }
    this.setMeta({ ...this.meta()!, sandboxFailures: this.meta()!.sandboxFailures + 1 })
    if (row.handle) await provider.kill(JSON.parse(row.handle) as Sandbox.Handle).catch(() => {})
    await this.forget(row, error)
  }

  private async forget(row: Pick<SandboxRow, 'member'>, error?: string): Promise<void> {
    if (row.member === null) return
    await PoolObject.call(this.env, {
      action: 'drop',
      body: { ...(error === undefined ? {} : { error }), id: row.member, run: this.meta()!.id },
      location: this.meta()!.location,
    }).catch(() => {})
  }

  private ahead(): Protocol.Ahead[] {
    const found = new Map<string, Protocol.Ahead>()
    const config = this.config()
    for (const row of Ledger.queue(this.sql, (task) =>
      Config.rowSec(config.limits, this.task(task)),
    )) {
      if (found.size >= config.sandbox.slots) break
      const environment = this.task(row.task).environment
      if (environment.kind === 'disk') found.set(environment.disk.digest, environment)
    }
    return [...found.values()]
  }

  private runnerConfig(runner: number, pool?: Protocol.Standing): Config.Runner {
    const meta = this.meta()!
    const config = this.config()
    const ahead = this.ahead()
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
      slots: config.sandbox.slots,
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
    this.sql.run('INSERT INTO sandboxes (state, created_at) VALUES (?, ?)', 'creating', Date.now())
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
      const runner = this.register(id)
      this.update('sandboxes', id, {
        expires_at: created.expiresAt,
        handle: JSON.stringify(handle),
        paid_until: created.paidUntil ?? null,
        runner,
      })
      const pool = config.sandbox.warm
        ? await PoolObject.call<Protocol.Standing>(this.env, {
            action: 'enroll',
            body: {
              expiresAt: created.expiresAt,
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
      this.update('sandboxes', id, { state: 'starting' })
    } catch (error) {
      const row = this.sandboxes().find((candidate) => candidate.id === id)!
      await this.failSandbox(provider, row, message(error))
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
    const { starvedAt, strandedAt, ...rest } = this.meta()!
    if (starvedAt !== undefined || strandedAt !== undefined) this.setMeta(rest)
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
    if (!unclaimed.length) return
    const sandboxes = this.sandboxes()
    const live = sandboxes.filter((sandbox) =>
      ['creating', 'ready', 'starting'].includes(sandbox.state),
    )
    if (live.some((sandbox) => sandbox.state !== 'ready')) return
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
    const room = ready.some((runner) => {
      const report = runner.report ? (JSON.parse(runner.report) as Protocol.Report) : undefined
      return !report?.offer || (report.offer.slots > 0 && !report.unfit)
    })
    if (room) return
    if (this.meta()!.sandboxFailures >= sandboxAttempts) {
      if (live.length || ready.length) return
      const last =
        sandboxes.filter((sandbox) => sandbox.error).at(-1)?.error ?? 'no sandbox could be opened'
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
    if (assigned) return true
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
    for (const record of this.sandboxes()) {
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
      try {
        await provider.kill(handle)
        this.update('sandboxes', record.id, { state: 'closed' })
      } catch (error) {
        this.update('sandboxes', record.id, { error: message(error), state: 'failed' })
      }
      await this.forget(record)
      if (record.runner !== null) this.update('runners', record.runner, { state: 'left' })
    }
  }

  private async renew(provider: Sandbox.Provider): Promise<void> {
    if (!provider.renew) return
    const config = this.config()
    for (const record of this.sandboxes()) {
      if (!['ending', 'ready', 'starting'].includes(record.state)) continue
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
        const runner = this.runners().find((candidate) => candidate.id === record.runner)
        this.update('sandboxes', record.id, {
          error: null,
          paid_until: renewed.paidUntil,
          state:
            record.state !== 'ending'
              ? record.state
              : runner?.state === 'ready'
                ? 'ready'
                : 'starting',
        })
      } catch (error) {
        const unsold =
          error instanceof Budget.ExceededError ||
          (error instanceof Gateway.RefusedError && error.status !== 404) ||
          error instanceof Gateway.UnpricedError
        const passing =
          error instanceof Gateway.RefusedError && (error.status === 429 || error.status >= 500)
        if (unsold)
          this.update('sandboxes', record.id, {
            error: message(error),
            ...(passing ? {} : { state: 'ending' }),
          })
        else await this.failSandbox(provider, record, message(error))
      }
    }
  }

  private async lapse(provider: Sandbox.Provider): Promise<void> {
    for (const record of this.sandboxes()) {
      if (!['ending', 'ready', 'starting'].includes(record.state)) continue
      const paid = record.paid_until ?? Infinity
      const lifetime = record.expires_at ?? Infinity
      if (Math.min(paid, lifetime) > Date.now()) continue
      const reason = paid <= lifetime ? 'the lease of its sandbox ended' : 'its sandbox ended'
      for (const row of this.rows())
        if (Ledger.active(row) && row.runner === record.runner) await this.lose(row, 'expired')
      this.update('sandboxes', record.id, {
        error: record.error ?? (paid <= lifetime ? 'its lease ended' : 'its lifetime ended'),
        state: 'closed',
      })
      if (record.runner !== null)
        this.update('runners', record.runner, { error: reason, state: 'left' })
      if (record.handle)
        await provider.kill(JSON.parse(record.handle) as Sandbox.Handle).catch(() => {})
      await this.forget(record, reason)
    }
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
      if (action === 'session') return json(await this.handSession(row))
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
    if (meta.cancelled || (await this.overBudget())) return idle(false)
    const record = this.known(runner)
    if (this.sandboxes().some((row) => row.id === record.sandbox && row.state === 'ending'))
      return idle(true)
    const drained = record.drained ?? this.drain(record, now)
    if (drained) return { ...idle(false), drained }
    const fits = this.fitting(record, now)
    const claimed = Ledger.claim(this.sql, {
      accepts: (row) => fits(row.task),
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
      !claimed.length && body.offer.slots > 0 && waiting,
      claimed.reduce((sum, row) => sum + this.task(row.task).resources.memoryMb, 0),
      claimed.length,
    )
    const ahead = waiting ? this.ahead() : []
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
    const ahead = this.ahead()
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
              kind: agent.provider,
              model: agent.model,
              ...(agent.thinking ? { thinking: agent.thinking } : {}),
            },
          }
        : {}),
      id: agent.id,
      oracle: agent.provider === 'oracle',
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

  private async handSession(row: Ledger.Attempt): Promise<Protocol.Session> {
    if (this.installed(row))
      throw new Refusal(409, 'the agent of the attempt is an installed command, not a session')
    const token = await Harness.token(this.env, row.session!)
    return {
      name: Protocol.handName,
      token,
      url:
        this.meta()!.publicUrl.replace(/^http/, 'ws') +
        '/sessions/' +
        encodeURIComponent(row.session!) +
        '/hands',
    }
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

  private async listed(row: Ledger.Attempt, waitMs: number): Promise<boolean> {
    const until = Date.now() + waitMs
    for (;;) {
      if ((await Harness.hands(this.env, row.session!)).includes(Protocol.handName)) return true
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
      if (harness !== 'installed' && !(await this.listed(row, waitMs))) return { state: 'waiting' }
      if (harness !== 'oracle') {
        if (
          typeof body.instruction !== 'string' ||
          (await Bytes.sha256(Bytes.fromText(body.instruction))) !== task.instruction.digest
        )
          throw new Refusal(400, 'the instruction does not match the digest of the task')
      }
      if (harness === 'installed')
        this.putArtifact(row.id, Installed.instruction, body.instruction!)
      if (agent.provider === 'claude' || agent.provider === 'codex') {
        try {
          await Harness.submit(this.env, session, {
            hand: Protocol.handName,
            model: agent.model,
            payer: this.payer(agent.provider),
            prompt: body.instruction!,
            provider: agent.provider,
            requestId,
            ...(agent.thinking ? { thinking: agent.thinking } : {}),
          })
        } catch (error) {
          throw await this.unpaid(row, error)
        }
      }
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

    const read = async (): Promise<Protocol.Agent> => {
      const current = Ledger.held(this.sql, { claim: row.claim!, id: row.id })
      if (!current) throw new Refusal(410, 'the attempt is not claimed by this runner any more')
      const earlier = current.failure ? (JSON.parse(current.failure) as Result.Failure) : undefined
      if (earlier?.kind === 'agent_timeout' || earlier?.kind === 'environment')
        return { state: 'timeout' }
      const report = await this.kept(current, Harness.turn(this.env, session, requestId))
      if (report.status === 'completed')
        return { message: report.ok?.message ?? '', state: 'completed' }
      if (report.status === 'failed' || report.status === 'cancelled')
        return { error: report.error ?? 'the turn ended as ' + report.status, state: 'failed' }
      const now = Date.now()
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
    const now = Date.now()
    let end: {
      failure?: Result.Failure
      memoryMb?: number
      oomKills?: number
      reward: number | null
    }
    if (body.verifier) {
      end = {
        ...Verdict.verifier({
          ctrf: task.verifier.ctrf === true,
          ...(row.failure ? { earlier: JSON.parse(row.failure) as Result.Failure } : {}),
          facts: body.verifier,
          log: this.textArtifact(row.id, verifierLog) ?? '',
          memoryMb: task.resources.memoryMb,
          now,
          timeoutSec: task.verifier.timeoutSec,
        }),
        ...(body.verifier.memoryMb === undefined ? {} : { memoryMb: body.verifier.memoryMb }),
        ...(body.verifier.oom ? { oomKills: body.verifier.oom } : {}),
      }
      Ledger.update(this.sql, row.id, {
        timing: Ledger.mark(row.timing, 'verifier', { at: now, edge: 'finish' }),
      })
    } else if (body.failure) {
      const refusals = new Set(
        this.sql
          .all(
            'SELECT DISTINCT refusal FROM model_requests WHERE attempt = ? AND claim = ? AND refusal IS NOT NULL',
            row.id,
            row.claims,
          )
          .map((request) => request['refusal'] as Proxy.Refusal),
      )
      const unpaid = refusals.has('plan') ? this.meta()!.refused : undefined
      end = {
        failure: {
          at: now,
          ...body.failure,
          ...(body.failure.kind === 'agent' && refusals.has('spent')
            ? { kind: 'budget' as const }
            : {}),
          ...(unpaid?.plan ? { kind: 'environment' as const, message: unpaid.message } : {}),
        },
        reward: null,
      }
    } else throw new Refusal(400, 'finishing an attempt reports a verifier or a failure')
    if (row.session && row.phase === 'run' && this.submitted(row)) await this.halt(row.session)
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
      Retry.unanswered({ at: now, statuses, ...(end.failure ? { failure: end.failure } : {}) })
    if (stall) end = { ...end, failure: stall, reward: null }
    const cause =
      end.failure && end.reward === null
        ? Retry.infrastructure({ failure: end.failure, statuses })
        : undefined
    if (cause && !Ledger.retried(this.sql, row.id)) {
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
    if (submitted) {
      try {
        const events = await Harness.events(this.env, session, requestId)
        usage = Atif.usage(events)
        const requested = Timeline.modelRequest(events)
        if (requested !== undefined)
          Timeline.add(this.sql, { at: requested, attempt: row.id, name: 'attempt.model' })
        this.putArtifact(
          row.id,
          'agent/events.jsonl',
          events.map((event) => JSON.stringify(event) + '\n').join(''),
        )
        this.putArtifact(
          row.id,
          'agent/trajectory.json',
          JSON.stringify(
            Atif.fromEvents(events, {
              model: agent.model,
              name: 'nanocode',
              session,
              version: Slot.runtime.sha256.slice(0, 12),
            }),
            null,
            2,
          ) + '\n',
        )
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
        'agent/trajectory.json',
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
        'SELECT claim, at, path, ms, status, usage, cost, refusal FROM model_requests WHERE attempt = ? ORDER BY id',
        row.id,
      )
      const priced = requests.filter(
        (request) =>
          request['claim'] === row.claims &&
          request['cost'] !== null &&
          !(request['path'] as string).startsWith('judge/'),
      )
      if (usage && !kind && priced.length)
        usage = {
          ...usage,
          costUsd: priced.reduce((sum, request) => sum + (request['cost'] as number), 0),
        }
      if (requests.length)
        this.putArtifact(
          row.id,
          modelRequests,
          requests
            .map(
              ({ cost: _, refusal, ...request }) =>
                JSON.stringify({
                  ...request,
                  ...(refusal === null ? {} : { refusal }),
                  usage: request['usage'] ? JSON.parse(request['usage'] as string) : null,
                }) + '\n',
            )
            .join(''),
        )
    }

    const result: Result.Attempt = {
      agent,
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
      ...(end.oomKills ? { oomKills: end.oomKills } : {}),
      outcome: Result.outcome(end.reward, end.failure),
      ...(row.origin ? { retryOf: JSON.parse(row.origin) as Ledger.Origin } : {}),
      reward: end.reward,
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
    }
    Ledger.finish(this.sql, {
      ...(end.ending ? { ending: end.ending } : {}),
      id: row.id,
      now,
      result,
    })
    if (row.phase !== 'unclaimed')
      Timeline.add(this.sql, { at: Date.now(), attempt: row.id, name: 'attempt.verdict' })
    this.cursors.delete(session)
    this.wake(row.id)
    if (this.finished()) this.wake()
    if (row.session && row.phase !== 'unclaimed' && row.phase !== 'claimed' && !kind)
      await this.remove(session)
  }
}
