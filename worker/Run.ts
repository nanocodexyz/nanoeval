import { DurableObject } from 'cloudflare:workers'
import { privateKeyToAccount } from 'viem/accounts'
import * as Atif from '../src/Atif.ts'
import * as Bootstrap from '../src/Bootstrap.ts'
import * as Budget from '../src/Budget.ts'
import * as Config from '../src/Config.ts'
import * as E2b from '../src/E2b.ts'
import * as Eval from '../src/Eval.ts'
import * as Gateway from '../src/Gateway.ts'
import * as Harbor from '../src/Harbor.ts'
import * as Installed from '../src/Installed.ts'
import * as Judge from '../src/Judge.ts'
import * as Ledger from '../src/Ledger.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Payment from '../src/Payment.ts'
import * as Protocol from '../src/Protocol.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Result from '../src/Result.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as SqlSetup from '../src/Sql.ts'
import * as Verdict from '../src/Verdict.ts'
import * as Blobs from './Blobs.ts'
import type { Env } from './Env.ts'
import * as Evals from './Evals.ts'
import * as Harness from './Harness.ts'
import * as Model from './Model.ts'
import * as Storage from './Storage.ts'

type SandboxRow = {
  capabilities: string | null
  created_at: number
  error: string | null
  expires_at: number | null
  handle: string | null
  id: number
  paid_until: number | null
  runner: number | null
  state: 'closed' | 'creating' | 'failed' | 'ready' | 'starting' | 'unknown'
}

type RunnerRow = {
  capabilities: string | null
  error: string | null
  id: number
  registered_at: number
  report: string | null
  sandbox: number | null
  seen_at: number
  state: 'left' | 'lost' | 'ready' | 'refused' | 'starting'
}

type Meta = {
  cancelled: boolean
  createdAt: number
  eval: { name: string; version: string }
  finishedAt: number | null
  id: string
  publicUrl: string
  reruns: string[]
  runnerToken: string
  sandboxFailures: number
  starvedAt?: number
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
    paid_until INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sandbox INTEGER,
    state TEXT NOT NULL,
    capabilities TEXT,
    registered_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    report TEXT,
    error TEXT
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
    usage TEXT
  )`,
  ...Ledger.tables,
]

const json = Storage.json
const message = Storage.message

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
      if (parts[0] === 'runner') {
        const header = request.headers.get('authorization') ?? ''
        if (!(await same(header, 'Bearer ' + meta.runnerToken)))
          return json({ error: 'unauthorized' }, 401)
        return await this.runner(request, parts.slice(1))
      }
      if (request.method === 'GET' && parts[0] === 'status') return json(this.status())
      if (request.method === 'GET' && parts[0] === 'harbor') return json(this.harbor())
      if (request.method === 'GET' && parts[0] === 'config') return json(this.config())
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
      if (request.method === 'POST' && parts[0] === 'runners') return json(this.attach(), 201)
      if (request.method === 'POST' && parts[0] === 'cancel') {
        this.setMeta({ ...meta, cancelled: true })
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
    const timeoutSec =
      config.sandbox.timeoutSec ??
      Config.lifetimeSec(
        config,
        seeds.map((seed) => byName.get(seed.task)!),
      )
    const longest =
      config.sandbox.provider === 'e2b'
        ? E2b.maxTimeoutSec
        : config.sandbox.provider === 'gateway'
          ? Gateway.maxTimeoutSec
          : undefined
    if (config.sandbox.max > 0 && longest !== undefined && timeoutSec > longest)
      return json(
        {
          error:
            'the rows of this run could keep a sandbox for ' +
            timeoutSec +
            ' s, and the ' +
            config.sandbox.provider +
            ' provider keeps one for at most ' +
            longest +
            ' s: open more sandboxes or slots, or name the lifetime',
        },
        400,
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
      this.setMeta({
        cancelled: false,
        createdAt: Date.now(),
        eval: { name: config.eval.name, version: snapshot.version.digest },
        finishedAt: null,
        id,
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
    let total = 0
    for (const row of this.rows())
      if (row.result) {
        const result = JSON.parse(row.result) as Result.Attempt
        total += (result.usage?.costUsd ?? 0) + (result.judge?.usage?.costUsd ?? 0)
      }
    for (const usage of Ledger.lostUsage(this.sql))
      total += (JSON.parse(usage) as Atif.Usage).costUsd ?? 0
    return total
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
    const count = (outcome: Result.Attempt['outcome']) =>
      results.filter((result) => result.outcome === outcome).length
    return {
      agents: Result.summarize(results),
      attempts: rows.map((row) => this.view(row)),
      cancelled: meta.cancelled,
      counts: {
        active: rows.filter(Ledger.active).length,
        errored: count('errored'),
        failed: count('failed'),
        passed: count('passed'),
        total: rows.length,
        unclaimed: rows.filter((row) => row.phase === 'unclaimed').length,
      },
      createdAt: meta.createdAt,
      eval: meta.eval,
      finishedAt: meta.finishedAt,
      id: meta.id,
      lostClaims: Ledger.claims(this.sql).filter(
        (claim) => claim.ending === 'expired' || claim.ending === 'released',
      ).length,
      name: config.name,
      payments: this.sql.all('SELECT at, usd, detail FROM payments ORDER BY id'),
      rerunOf: config.rerun ?? null,
      reruns: meta.reruns,
      runners: this.runners().map((row) => ({
        capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
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
        id: row.id,
        paidUntil: row.paid_until,
        provider: config.sandbox.provider,
        runner: row.runner,
        state: row.state,
      })),
      spend: { modelUsd: this.modelSpent(), sandboxUsd: this.spent() },
      state: meta.finishedAt === null ? 'running' : 'finished',
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
      files: Harbor.files({
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
      this.watch()
      if (provider) await this.advanceSandboxes(provider)
      if (!this.meta()!.cancelled) {
        await this.enforce()
        if (provider) await this.grow(provider)
      }
      if (provider) await this.closeIdle(provider)
      if (provider) await this.renew(provider)
    } catch (error) {
      console.error('nanoeval tick failed', message(error))
    }

    const current = this.meta()!
    const open = this.sandboxes().some((row) =>
      ['creating', 'ready', 'starting'].includes(row.state),
    )
    if (this.rows().every((row) => row.phase === 'done') && !open) {
      this.setMeta({ ...current, finishedAt: Date.now() })
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
    const at = Date.now()
    this.sql.run(
      'INSERT INTO model_requests (attempt, claim, at, path) VALUES (?, ?, ?, ?)',
      row.id,
      row.claims,
      at,
      path,
    )
    const entry = this.sql.all('SELECT MAX(id) AS id FROM model_requests')[0]!['id'] as number
    return Model.forward(this.env, {
      path,
      provider,
      request,
      search,
      settle: (outcome) => {
        this.sql.run(
          'UPDATE model_requests SET ms = ?, status = ?, usage = ? WHERE id = ?',
          Date.now() - at,
          outcome.status,
          outcome.usage ? JSON.stringify(outcome.usage) : null,
          entry,
        )
      },
    })
  }

  private async halt(session: string): Promise<void> {
    const cancelled = Harness.cancel(this.env, session, requestId).catch(() => {})
    this.ctx.waitUntil(cancelled)
    await Promise.race([
      cancelled,
      new Promise((resolve) => setTimeout(resolve, Number(this.env.TICK_MS))),
    ])
  }

  private judgeSessions(row: Ledger.Attempt): string[] {
    const request = this.textArtifact(row.id, judgeRequest)
    return request && row.session
      ? Judge.parse(request).map((_, index) => row.session + '-judge-' + index)
      : []
  }

  private async lose(row: Ledger.Attempt, ending: 'expired' | 'released'): Promise<void> {
    const config = this.config()
    const submitted = this.submitted(row)
    let usage: string | undefined
    if (row.session) {
      if (submitted && row.phase === 'run') await this.halt(row.session)
      if (submitted)
        usage = await Harness.events(this.env, row.session).then(
          (events) => JSON.stringify(Atif.usage(events)),
          () => undefined,
        )
      const installed = this.installed(row) !== undefined
      if (installed && ['judge', 'run', 'verify'].includes(row.phase))
        usage = JSON.stringify(this.metered(row))
      for (const name of this.judgeSessions(row))
        await Harness.remove(this.env, name).catch(() => {})
      if (row.phase !== 'claimed' && !installed)
        await Harness.remove(this.env, row.session).catch(() => {})
    }
    const requeued = Ledger.requeue(this.sql, {
      ending,
      id: row.id,
      limit: config.limits.claims,
      now: Date.now(),
      ...(usage ? { usage } : {}),
    })
    if (requeued) {
      this.sql.run('DELETE FROM artifacts WHERE attempt = ?', row.id)
      this.sql.run('DELETE FROM binary_artifacts WHERE attempt = ?', row.id)
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

  private watch(): void {
    const config = this.config()
    const now = Date.now()
    for (const runner of this.runners()) {
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
      if (row.state !== 'starting' && row.state !== 'ready') continue
      const runner = this.runners().find((candidate) => candidate.id === row.runner)
      try {
        if (!runner) throw new Error('the sandbox has no runner')
        if (runner.state === 'refused' || runner.state === 'lost')
          throw new Error(runner.error ?? 'the runner of the sandbox stopped')
        if (row.state !== 'starting') continue
        if (runner.state === 'ready') {
          this.update('sandboxes', row.id, { capabilities: runner.capabilities, state: 'ready' })
          this.setMeta({ ...this.meta()!, sandboxFailures: 0 })
        } else if (Date.now() - row.created_at > config.limits.setupSec * 1000) {
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
  }

  private runnerConfig(runner: number): Config.Runner {
    const meta = this.meta()!
    const config = this.config()
    return {
      backend: config.sandbox.backend,
      disks: config.sandbox.disks,
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

  private attach(): Config.Runner {
    return this.runnerConfig(this.register(null))
  }

  private async open(provider: Sandbox.Provider): Promise<void> {
    const meta = this.meta()!
    const config = this.config()
    this.sql.run('INSERT INTO sandboxes (state, created_at) VALUES (?, ?)', 'creating', Date.now())
    const id = this.sql.all('SELECT MAX(id) AS id FROM sandboxes')[0]!['id'] as number
    this.creating.add(id)
    try {
      const created = await provider.create({
        ...(config.sandbox.leaseSec === undefined ? {} : { leaseSec: config.sandbox.leaseSec }),
        metadata: { nanoeval_run: meta.id, nanoeval_sandbox: String(id) },
        template: config.sandbox.template,
        timeoutSec: config.sandbox.timeoutSec!,
      })
      const handle = created.handle
      const runner = this.register(id)
      this.update('sandboxes', id, {
        expires_at: created.expiresAt,
        handle: JSON.stringify(handle),
        paid_until: created.paidUntil ?? null,
        runner,
      })
      const sandbox = provider.connect(handle)
      const file = handle.home + '/runner.json'
      await sandbox.write(file, Bytes.fromText(JSON.stringify(this.runnerConfig(runner))))
      if (config.sandbox.runtime) {
        const script = handle.home + '/' + Bootstrap.files.script
        await sandbox.write(
          script,
          Bytes.fromText(
            Bootstrap.script({
              home: handle.home,
              run: meta.id,
              runtime: config.sandbox.runtime,
              token: meta.runnerToken,
              url: meta.publicUrl,
            }),
          ),
        )
        await Sandbox.run(sandbox, 'bash ' + Sandbox.quote(script))
      } else await Sandbox.run(sandbox, 'nanoeval runner --detach --config ' + Sandbox.quote(file))
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
    const unclaimed = this.rows().filter((row) => row.phase === 'unclaimed')
    if (!unclaimed.length) return
    if (await this.overBudget()) return
    if (config.sandbox.freeDiskMb === undefined) return

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

  private async overBudget(): Promise<boolean> {
    const config = this.config()
    if (config.budget.modelUsd === undefined || this.modelSpent() < config.budget.modelUsd)
      return false
    for (const row of this.rows().filter((candidate) => candidate.phase === 'unclaimed'))
      await this.complete(row, {
        failure: {
          at: Date.now(),
          kind: 'budget',
          message: 'the model budget of $' + config.budget.modelUsd + ' is spent',
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
    const ready = this.runners().filter((runner) => runner.state === 'ready')
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
    if (live.length < config.sandbox.max) await this.open(provider)
  }

  private async closeIdle(provider: Sandbox.Provider): Promise<void> {
    const rows = this.rows()
    if (rows.some((row) => row.phase === 'unclaimed')) return
    for (const record of this.sandboxes()) {
      if (record.state !== 'ready') continue
      if (rows.some((row) => Ledger.active(row) && row.runner === record.runner)) continue
      const handle = JSON.parse(record.handle!) as Sandbox.Handle
      try {
        await provider.kill(handle)
        this.update('sandboxes', record.id, { state: 'closed' })
      } catch (error) {
        this.update('sandboxes', record.id, { error: message(error), state: 'failed' })
      }
      if (record.runner !== null) this.update('runners', record.runner, { state: 'left' })
    }
  }

  private async renew(provider: Sandbox.Provider): Promise<void> {
    if (!provider.renew) return
    const config = this.config()
    for (const record of this.sandboxes()) {
      if (record.state !== 'ready' && record.state !== 'starting') continue
      if (record.paid_until === null || record.expires_at === null) continue
      if (record.paid_until - Date.now() > config.limits.leaseSec * 1000) continue
      const seconds = Math.min(
        config.sandbox.leaseSec ?? Gateway.leaseSec,
        Math.floor((record.expires_at - record.paid_until) / 1000),
      )
      if (seconds < 1) continue
      try {
        const renewed = await provider.renew(JSON.parse(record.handle!) as Sandbox.Handle, seconds)
        this.update('sandboxes', record.id, { paid_until: renewed.paidUntil })
      } catch (error) {
        await this.failSandbox(provider, record, message(error))
      }
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
    if (resource === 'leave') return json(await this.leave(body as Protocol.Leave))
    if (resource === 'rows' && id && action) {
      const row = this.fenced(id, String(body['claim'] ?? ''))
      if (action === 'session') return json(await this.session(row))
      if (action === 'endpoint') return json(await this.endpoint(row))
      if (action === 'agent') return json(await this.agent(row, body as { instruction?: string }))
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
    this.update('runners', runner.id, {
      capabilities: JSON.stringify(capabilities),
      error: null,
      seen_at: Date.now(),
      state: 'ready',
    })
    const held = new Set((body.held ?? []).map((entry) => entry.id + ' ' + entry.claim))
    for (const row of this.rows())
      if (row.runner === runner.id && Ledger.active(row) && !held.has(row.id + ' ' + row.claim))
        await this.lose(row, 'released')
    return this.runnerConfig(runner.id)
  }

  private finished(): boolean {
    return this.rows().every((row) => row.phase === 'done')
  }

  private async claim(body: Protocol.ClaimRequest): Promise<Protocol.ClaimResponse> {
    const meta = this.meta()!
    const config = this.config()
    const runner = this.known(body.runner)
    if (runner.state !== 'ready') throw new Refusal(409, 'the runner is ' + runner.state)
    const now = Date.now()
    const idle = (unfit: boolean): Protocol.ClaimResponse => {
      this.update('runners', runner.id, {
        report: JSON.stringify({ ...body.report, offer: body.offer, unfit }),
        seen_at: now,
      })
      return { finished: this.finished(), rows: [] }
    }
    if (meta.cancelled || (await this.overBudget())) return idle(false)
    const claimed = Ledger.claim(this.sql, {
      leaseMs: config.limits.leaseSec * 1000,
      memoryOf: (task) => this.task(task).resources.memoryMb,
      now,
      offer: body.offer,
      run: meta.id,
      runner: runner.id,
      token: secret,
    })
    const waiting = this.rows().some((row) => row.phase === 'unclaimed')
    const response = idle(!claimed.length && body.offer.slots > 0 && waiting)
    return {
      ...response,
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
    return {
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
    for (const entry of body.held) {
      const row = Ledger.held(this.sql, entry)
      if (row && row.runner === runner.id) await this.lose(row, 'released')
    }
    this.update('runners', runner.id, { seen_at: Date.now(), state: 'left' })
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

  private async session(row: Ledger.Attempt): Promise<Protocol.Session> {
    if (this.installed(row))
      throw new Refusal(409, 'the agent of the attempt is an installed command, not a session')
    const token = await Harness.token(this.env, row.session!)
    this.attaching(row)
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
    if (row.phase === 'claimed')
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

  private async agent(
    row: Ledger.Attempt,
    body: { instruction?: string },
  ): Promise<Protocol.Agent> {
    const config = this.config()
    const task = this.task(row.task)
    const agent = config.agents.find((candidate) => candidate.id === row.agent)!
    const harness = Config.harness(agent)
    const session = row.session!
    const now = Date.now()
    if (row.phase === 'attach') {
      if (
        harness !== 'installed' &&
        !(await Harness.hands(this.env, session)).includes(Protocol.handName)
      )
        return { state: 'waiting' }
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
        await Harness.submit(this.env, session, {
          hand: Protocol.handName,
          model: agent.model,
          prompt: body.instruction!,
          provider: agent.provider,
          requestId,
          ...(agent.thinking ? { thinking: agent.thinking } : {}),
        })
      }
      Ledger.update(this.sql, row.id, {
        deadline_at: now + task.agent.timeoutSec * 1000,
        phase: 'run',
        phase_at: now,
        timing: Ledger.mark(
          Ledger.mark(row.timing, 'agentSetup', { at: now, edge: 'finish' }),
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
    const earlier = row.failure ? (JSON.parse(row.failure) as Result.Failure) : undefined
    if (earlier?.kind === 'agent_timeout') return { state: 'timeout' }

    const report = await Harness.turn(this.env, session, requestId)
    if (report.status === 'completed')
      return { message: report.ok?.message ?? '', state: 'completed' }
    if (report.status === 'failed' || report.status === 'cancelled')
      return { error: report.error ?? 'the turn ended as ' + report.status, state: 'failed' }
    if (now > row.deadline_at!) {
      await Harness.cancel(this.env, session, requestId)
      Ledger.update(this.sql, row.id, {
        failure: JSON.stringify({
          at: now,
          kind: 'agent_timeout',
          message: 'the agent did not finish within ' + task.agent.timeoutSec + ' s',
        } satisfies Result.Failure),
      })
      return { state: 'timeout' }
    }
    return { detached: report.kind === 'detached', state: 'running' }
  }

  private verify(row: Ledger.Attempt, body: { solve?: { code: number } }): { ok: true } {
    if (row.phase === 'verify') return { ok: true }
    if (row.phase !== 'run') throw new Refusal(409, 'the attempt is in the ' + row.phase + ' phase')
    const task = this.task(row.task)
    const now = Date.now()
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
      for (const [index, entry] of requests.entries())
        await Harness.submit(this.env, row.session + '-judge-' + index, {
          model: config.judge.model,
          prompt: entry.prompt,
          provider: config.judge.provider,
          requestId: judgeRequestId,
          ...(config.judge.thinking ? { thinking: config.judge.thinking } : {}),
        })
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
    const reports = await Promise.all(
      this.judgeSessions(row).map((name) => Harness.turn(this.env, name, judgeRequestId)),
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
      end = { failure: { at: now, ...body.failure }, reward: null }
    } else throw new Refusal(400, 'finishing an attempt reports a verifier or a failure')
    if (row.session && row.phase === 'run' && this.submitted(row)) await this.halt(row.session)
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
        judgeUsage.push(Atif.usage(await Harness.events(this.env, name)))
      } catch (error) {
        this.putArtifact(row.id, 'verifier/judge-error.txt', message(error))
      }
      await Harness.remove(this.env, name).catch(() => {})
    }

    let usage: Atif.Usage | null = null
    if (submitted) {
      try {
        const events = await Harness.events(this.env, session)
        usage = Atif.usage(events)
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
      usage = {
        ...metered,
        costUsd: metered.costUsd ?? summary.costUsd,
        toolCalls: summary.toolCalls,
      }
      this.putArtifact(
        row.id,
        modelRequests,
        this.sql
          .all(
            'SELECT claim, at, path, ms, status, usage FROM model_requests WHERE attempt = ? ORDER BY id',
            row.id,
          )
          .map(
            (request) =>
              JSON.stringify({
                ...request,
                usage: request['usage'] ? JSON.parse(request['usage'] as string) : null,
              }) + '\n',
          )
          .join(''),
      )
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
    if (row.session && row.phase !== 'unclaimed' && row.phase !== 'claimed' && !kind)
      await Harness.remove(this.env, session).catch(() => {})
  }
}
