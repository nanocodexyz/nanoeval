import { DurableObject } from 'cloudflare:workers'
import { privateKeyToAccount } from 'viem/accounts'
import slotScript from '../sandbox/slot.sh'
import * as Admission from '../src/Admission.ts'
import * as Atif from '../src/Atif.ts'
import * as Budget from '../src/Budget.ts'
import * as Config from '../src/Config.ts'
import * as E2b from '../src/E2b.ts'
import * as Harbor from '../src/Harbor.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Payment from '../src/Payment.ts'
import * as Result from '../src/Result.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Tar from '../src/Tar.ts'
import type * as Task from '../src/Task.ts'
import type { Env } from './Env.ts'
import * as Harness from './Harness.ts'

type Phase = 'attach' | 'done' | 'pending' | 'run' | 'up' | 'verify'

type AttemptRow = {
  agent: string
  deadline_at: number | null
  errors: number
  failure: string | null
  id: string
  n: number
  phase: Phase
  phase_at: number | null
  result: string | null
  sandbox: number | null
  slot: string | null
  started_at: number | null
  task: string
  timing: string
}

type SandboxRow = {
  capabilities: string | null
  created_at: number
  error: string | null
  expires_at: number | null
  handle: string | null
  id: number
  state: 'closed' | 'creating' | 'failed' | 'ready' | 'setup' | 'unknown'
}

type Spec = Omit<Task.Task, 'files'>

type Meta = {
  cancelled: boolean
  createdAt: number
  finishedAt: number | null
  id: string
  publicUrl: string
  sandboxFailures: number
}

const handName = 'slot'
const hostUtilization = 0.8
const logBytes = 65_536
const partCharacters = 524_288
const requestId = 'attempt'
const sandboxAttempts = 2
const version = '0.1.0'

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (name TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_files (
  task TEXT NOT NULL,
  path TEXT NOT NULL,
  part INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (task, path, part)
);
CREATE TABLE IF NOT EXISTS sandboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  handle TEXT,
  capabilities TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  agent TEXT NOT NULL,
  n INTEGER NOT NULL,
  phase TEXT NOT NULL,
  sandbox INTEGER,
  slot TEXT,
  started_at INTEGER,
  phase_at INTEGER,
  deadline_at INTEGER,
  timing TEXT NOT NULL DEFAULT '{}',
  failure TEXT,
  result TEXT,
  errors INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  usd REAL NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  attempt TEXT NOT NULL,
  name TEXT NOT NULL,
  part INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (attempt, name, part)
);
`

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function oracleAgent(config: { agents: readonly Config.Agent[] }): Config.Agent | undefined {
  return config.agents.find((agent) => agent.provider === 'oracle')
}

function message(error: unknown): string {
  return error instanceof Error ? error.name + ': ' + error.message : String(error)
}

export class Run extends DurableObject<Env> {
  private readonly creating = new Set<number>()
  private readonly specs = new Map<string, Spec>()
  private readonly sql: SqlStorage
  private ticking: Promise<void> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(schema)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    try {
      if (request.method === 'POST' && parts[0] === 'create')
        return await this.create(request, url.searchParams)
      if (!this.meta()) return json({ error: 'run not found' }, 404)
      if (request.method === 'GET' && parts[0] === 'status') return json(this.status())
      if (request.method === 'GET' && parts[0] === 'harbor') return json({ files: this.harbor() })
      if (request.method === 'POST' && parts[0] === 'cancel') {
        this.setMeta({ ...this.meta()!, cancelled: true })
        this.ctx.waitUntil(this.tick())
        return json({ cancelled: true })
      }
      if (request.method === 'GET' && parts[0] === 'attempts' && parts[1]) {
        const row = this.attempt(decodeURIComponent(parts[1]))
        if (!row) return json({ error: 'attempt not found' }, 404)
        if (parts[2] === 'artifacts' && parts[3]) {
          const body = this.artifact(row.id, decodeURIComponent(parts[3]))
          return body === undefined
            ? json({ error: 'artifact not found' }, 404)
            : new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
        }
        return json({
          artifacts: this.artifactNames(row.id),
          attempt: this.view(row),
          result: row.result ? JSON.parse(row.result) : null,
        })
      }
      return json({ error: 'route not found' }, 404)
    } catch (error) {
      if (error instanceof Config.InvalidError || (error as Error).name?.startsWith('Task.'))
        return json({ error: (error as Error).message }, 400)
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

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO meta (key, value) VALUES (?, ?)',
        'config',
        JSON.stringify({ ...config, tasks: config.tasks.map((task) => task.name) }),
      )
      for (const { files, ...spec } of config.tasks) {
        this.sql.exec(
          'INSERT INTO tasks (name, body) VALUES (?, ?)',
          spec.name,
          JSON.stringify(spec),
        )
        for (const [path, body] of Object.entries(files))
          for (let part = 0; part * partCharacters < Math.max(body.length, 1); part++)
            this.sql.exec(
              'INSERT INTO task_files (task, path, part, body) VALUES (?, ?, ?, ?)',
              spec.name,
              path,
              part,
              body.slice(part * partCharacters, (part + 1) * partCharacters),
            )
      }
      let counter = 0
      for (let n = 1; n <= config.attempts; n++)
        for (const task of config.tasks)
          for (const agent of config.agents)
            this.sql.exec(
              'INSERT INTO attempts (id, task, agent, n, phase) VALUES (?, ?, ?, ?, ?)',
              'a' + String(++counter).padStart(5, '0'),
              task.name,
              agent.id,
              n,
              'pending',
            )
      this.setMeta({
        cancelled: false,
        createdAt: Date.now(),
        finishedAt: null,
        id,
        publicUrl: params.get('url')!,
        sandboxFailures: 0,
      })
    })
    this.ctx.waitUntil(this.tick())
    return json({ attempts: this.rows().length, id }, 201)
  }

  private meta(): Meta | undefined {
    const row = this.sql.exec('SELECT value FROM meta WHERE key = ?', 'run').toArray()[0]
    return row ? (JSON.parse(row['value'] as string) as Meta) : undefined
  }

  private setMeta(meta: Meta): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
      'run',
      JSON.stringify(meta),
    )
  }

  private config(): Omit<Config.Config, 'tasks'> & { tasks: readonly string[] } {
    const row = this.sql.exec('SELECT value FROM meta WHERE key = ?', 'config').one()
    return JSON.parse(row['value'] as string)
  }

  private task(name: string): Spec {
    let spec = this.specs.get(name)
    if (!spec) {
      const row = this.sql.exec('SELECT body FROM tasks WHERE name = ?', name).one()
      spec = JSON.parse(row['body'] as string) as Spec
      this.specs.set(name, spec)
    }
    return spec
  }

  private taskFiles(name: string): Tar.Entry[] {
    const executable = this.task(name).executable
    const files = new Map<string, string[]>()
    for (const row of this.sql.exec(
      'SELECT path, body FROM task_files WHERE task = ? ORDER BY path, part',
      name,
    ))
      files.set(row['path'] as string, [
        ...(files.get(row['path'] as string) ?? []),
        row['body'] as string,
      ])
    return [...files].map(([path, parts]) => ({
      data: Bytes.fromBase64(parts.join('')),
      executable: executable.includes(path),
      path,
    }))
  }

  private rows(): AttemptRow[] {
    return this.sql.exec('SELECT * FROM attempts ORDER BY id').toArray() as unknown as AttemptRow[]
  }

  private attempt(id: string): AttemptRow | undefined {
    return this.sql.exec('SELECT * FROM attempts WHERE id = ?', id).toArray()[0] as unknown as
      | AttemptRow
      | undefined
  }

  private sandboxes(): SandboxRow[] {
    return this.sql.exec('SELECT * FROM sandboxes ORDER BY id').toArray() as unknown as SandboxRow[]
  }

  private update(
    table: 'attempts' | 'sandboxes',
    id: number | string,
    fields: Record<string, unknown>,
  ): void {
    const names = Object.keys(fields)
    this.sql.exec(
      'UPDATE ' + table + ' SET ' + names.map((name) => name + ' = ?').join(', ') + ' WHERE id = ?',
      ...names.map((name) => fields[name]),
      id,
    )
  }

  private spent(): number {
    return (
      (this.sql.exec('SELECT COALESCE(SUM(usd), 0) AS usd FROM payments').one()['usd'] as number) ??
      0
    )
  }

  private modelSpent(): number {
    let total = 0
    for (const row of this.rows())
      if (row.result) total += (JSON.parse(row.result) as Result.Attempt).usage?.costUsd ?? 0
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
    return E2b.create({
      pay: Payment.payer({
        account: privateKeyToAccount(this.env.TEMPO_PRIVATE_KEY as `0x${string}`),
        budget,
        onCharge: (charge) => {
          this.sql.exec(
            'INSERT INTO payments (at, usd, detail) VALUES (?, ?, ?)',
            Date.now(),
            charge.usd,
            JSON.stringify(charge),
          )
        },
      }),
    })
  }

  private putArtifact(attempt: string, name: string, body: string): void {
    this.sql.exec('DELETE FROM artifacts WHERE attempt = ? AND name = ?', attempt, name)
    for (let part = 0; part * partCharacters < Math.max(body.length, 1); part++)
      this.sql.exec(
        'INSERT INTO artifacts (attempt, name, part, body) VALUES (?, ?, ?, ?)',
        attempt,
        name,
        part,
        body.slice(part * partCharacters, (part + 1) * partCharacters),
      )
  }

  private artifact(attempt: string, name: string): string | undefined {
    const parts = this.sql
      .exec(
        'SELECT body FROM artifacts WHERE attempt = ? AND name = ? ORDER BY part',
        attempt,
        name,
      )
      .toArray()
    return parts.length ? parts.map((part) => part['body'] as string).join('') : undefined
  }

  private artifactNames(attempt: string): string[] {
    return this.sql
      .exec('SELECT DISTINCT name FROM artifacts WHERE attempt = ? ORDER BY name', attempt)
      .toArray()
      .map((row) => row['name'] as string)
  }

  private view(row: AttemptRow) {
    const result = row.result ? (JSON.parse(row.result) as Result.Attempt) : undefined
    return {
      agent: row.agent,
      failure: result?.failure ?? (row.failure ? JSON.parse(row.failure) : undefined),
      id: row.id,
      n: row.n,
      outcome: result?.outcome,
      phase: row.phase,
      reward: result?.reward,
      sandbox: row.sandbox,
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
        active: rows.filter((row) => row.phase !== 'pending' && row.phase !== 'done').length,
        errored: count('errored'),
        failed: count('failed'),
        passed: count('passed'),
        pending: rows.filter((row) => row.phase === 'pending').length,
        total: rows.length,
      },
      createdAt: meta.createdAt,
      finishedAt: meta.finishedAt,
      id: meta.id,
      name: config.name,
      payments: this.sql.exec('SELECT at, usd, detail FROM payments ORDER BY id').toArray(),
      sandboxes: this.sandboxes().map((row) => ({
        capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
        error: row.error,
        expiresAt: row.expires_at,
        id: row.id,
        provider: config.sandbox.provider,
        state: row.state,
      })),
      spend: { modelUsd: this.modelSpent(), sandboxUsd: this.spent() },
      state: meta.finishedAt === null ? 'running' : 'finished',
    }
  }

  private harbor(): Record<string, string> {
    const meta = this.meta()!
    const config = this.config()
    const rows = this.rows()
    const artifacts: Record<string, Record<string, string>> = {}
    for (const row of rows) {
      if (!row.result) continue
      const own: Record<string, string> = {}
      for (const name of this.artifactNames(row.id)) own[name] = this.artifact(row.id, name)!
      artifacts[row.id] = own
    }
    return Harbor.files({
      artifacts,
      attempts: this.results(),
      job: {
        finishedAt: meta.finishedAt,
        id: meta.id,
        name: config.name,
        startedAt: meta.createdAt,
      },
      running: rows.filter((row) => row.phase !== 'pending' && row.phase !== 'done').length,
      source: config.name,
      total: rows.length,
      version,
    })
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
      const provider = this.provider()
      await this.advanceSandboxes(provider)
      await this.advanceAttempts(provider)
      if (!meta.cancelled) await this.admit(provider)
      await this.closeIdle(provider)
    } catch (error) {
      console.error('nanoeval tick failed', message(error))
    }

    const current = this.meta()!
    const rows = this.rows()
    const open = this.sandboxes().some((row) => ['creating', 'ready', 'setup'].includes(row.state))
    if (rows.every((row) => row.phase === 'done') && !open) {
      this.setMeta({ ...current, finishedAt: Date.now() })
      return
    }
    await this.ctx.storage.setAlarm(Date.now() + Number(this.env.TICK_MS))
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
      if (row.state !== 'setup') continue

      const handle = JSON.parse(row.handle!) as Sandbox.Handle
      const sandbox = provider.connect(handle)
      const slots = Slot.create({ home: handle.home })
      try {
        const status = Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
        const code = Slot.exit(status.setup)
        if (code === 0) {
          const capabilities = JSON.parse(
            await Sandbox.run(sandbox, slots.probe()),
          ) as Sandbox.Capabilities
          if (config.sandbox.backend === 'docker' && !capabilities.docker)
            throw new Error('the sandbox has no working Docker daemon for the docker backend')
          this.update('sandboxes', row.id, {
            capabilities: JSON.stringify(capabilities),
            state: 'ready',
          })
          this.setMeta({ ...this.meta()!, sandboxFailures: 0 })
        } else if (code !== undefined) {
          const log = await Sandbox.run(sandbox, slots.log('-', 'setup', logBytes))
          throw new Error('sandbox setup exited with ' + code + ': ' + log.slice(-2000))
        } else if (Date.now() - row.created_at > config.limits.setupSec * 1000) {
          throw new Error('sandbox setup did not finish within ' + config.limits.setupSec + ' s')
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
    this.setMeta({ ...this.meta()!, sandboxFailures: this.meta()!.sandboxFailures + 1 })
    if (row.handle) await provider.kill(JSON.parse(row.handle) as Sandbox.Handle).catch(() => {})
  }

  private async open(provider: Sandbox.Provider): Promise<void> {
    const meta = this.meta()!
    const config = this.config()
    const id = this.sql
      .exec(
        'INSERT INTO sandboxes (state, created_at) VALUES (?, ?) RETURNING id',
        'creating',
        Date.now(),
      )
      .one()['id'] as number
    this.creating.add(id)
    let handle: Sandbox.Handle | undefined
    try {
      const created = await provider.create({
        metadata: { nanoeval_run: meta.id, nanoeval_sandbox: String(id) },
        template: config.sandbox.template,
        timeoutSec: config.sandbox.timeoutSec,
      })
      handle = created.handle
      this.update('sandboxes', id, {
        expires_at: created.expiresAt,
        handle: JSON.stringify(handle),
      })

      const sandbox = provider.connect(handle)
      const slots = Slot.create({ home: handle.home })
      await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(handle.home + '/slots'))
      await sandbox.write(slots.script, Bytes.fromText(slotScript))
      await Sandbox.run(
        sandbox,
        slots.setup({ docker: config.sandbox.docker, runtime: Slot.runtime }),
      )
      this.update('sandboxes', id, { state: 'setup' })
    } catch (error) {
      const row = this.sandboxes().find((candidate) => candidate.id === id)!
      await this.failSandbox(provider, row, message(error))
    } finally {
      this.creating.delete(id)
    }
  }

  private load(sandbox: number): Admission.Load {
    let memoryMb = 0
    let running = 0
    for (const row of this.rows()) {
      if (row.sandbox !== sandbox || row.phase === 'done' || row.phase === 'pending') continue
      running++
      memoryMb += this.task(row.task).environment.memoryMb
    }
    return { memoryMb, running }
  }

  private capacity(row: SandboxRow): Admission.Capacity {
    const config = this.config()
    const capabilities = JSON.parse(row.capabilities!) as Sandbox.Capabilities
    return {
      memoryMb: config.sandbox.memoryMb ?? Math.floor(capabilities.memory_mb * hostUtilization),
      slots: config.sandbox.slots,
    }
  }

  private async admit(provider: Sandbox.Provider): Promise<void> {
    const config = this.config()
    const pending = this.rows()
      .filter((row) => row.phase === 'pending')
      .sort((left, right) => left.n - right.n || (left.id < right.id ? -1 : 1))

    for (const row of pending) {
      if (config.budget.modelUsd !== undefined && this.modelSpent() >= config.budget.modelUsd) {
        await this.finish(provider, row, {
          failure: {
            at: Date.now(),
            kind: 'budget',
            message: 'the model budget of $' + config.budget.modelUsd + ' is spent',
          },
          reward: null,
        })
        continue
      }

      const task = this.task(row.task)
      const lifetime =
        (task.agent.timeoutSec +
          task.verifier.timeoutSec +
          (task.environment.buildTimeoutSec ?? config.limits.setupSec) +
          config.limits.attachSec) *
        1000
      const ready = this.sandboxes()
        .filter(
          (sandbox) =>
            sandbox.state === 'ready' &&
            (sandbox.expires_at === null || sandbox.expires_at - Date.now() > lifetime),
        )
        .map((sandbox) => ({
          capacity: this.capacity(sandbox),
          load: this.load(sandbox.id),
          row: sandbox,
        }))
      const target = Admission.place(ready, task.environment.memoryMb)
      if (target) {
        await this.assign(provider, row, task, target.row)
        continue
      }

      const sandboxes = this.sandboxes()
      const opening = sandboxes.some(
        (sandbox) => sandbox.state === 'creating' || sandbox.state === 'setup',
      )
      const live = sandboxes.filter((sandbox) =>
        ['creating', 'ready', 'setup'].includes(sandbox.state),
      )
      if (opening) return
      if (this.meta()!.sandboxFailures >= sandboxAttempts) {
        if (live.length) return
        const last =
          sandboxes.filter((sandbox) => sandbox.error).at(-1)?.error ?? 'no sandbox could be opened'
        await this.finish(provider, row, {
          failure: {
            at: Date.now(),
            kind: last.startsWith('Budget.ExceededError') ? 'budget' : 'environment',
            message: last,
          },
          reward: null,
        })
        continue
      }
      if (live.length < config.sandbox.max) await this.open(provider)
      return
    }
  }

  private async assign(
    provider: Sandbox.Provider,
    row: AttemptRow,
    task: Spec,
    target: SandboxRow,
  ): Promise<void> {
    const meta = this.meta()!
    const handle = JSON.parse(target.handle!) as Sandbox.Handle
    const sandbox = provider.connect(handle)
    const slots = Slot.create({ home: handle.home })
    const slot = meta.id.slice(0, 8) + '-' + row.id
    const now = Date.now()
    this.update('attempts', row.id, {
      phase: 'up',
      phase_at: now,
      sandbox: target.id,
      slot,
      started_at: now,
      timing: JSON.stringify({ environmentSetup: { finishedAt: now, startedAt: now } }),
    })

    try {
      await this.startSlot(sandbox, slots, slot, task)
    } catch (error) {
      await this.finish(provider, this.attempt(row.id)!, {
        failure: { at: Date.now(), kind: 'environment', message: message(error) },
        reward: null,
      })
    }
  }

  private async startSlot(
    sandbox: Sandbox.Sandbox,
    slots: ReturnType<typeof Slot.create>,
    slot: string,
    task: Spec,
  ): Promise<void> {
    const config = this.config()
    await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(slots.home + '/slots/' + slot))
    await sandbox.write(slots.taskFile(slot), Tar.pack(this.taskFiles(task.name)))
    if (Object.keys(task.environment.env).length)
      await sandbox.write(
        slots.envFile(slot, 'env'),
        Bytes.fromText(Slot.envFile(task.environment.env)),
      )
    if (Object.keys(task.verifier.env).length)
      await sandbox.write(
        slots.envFile(slot, 'verifier.env'),
        Bytes.fromText(Slot.envFile(task.verifier.env)),
      )
    if (task.solution && Object.keys(task.solution.env).length)
      await sandbox.write(
        slots.envFile(slot, 'solution.env'),
        Bytes.fromText(Slot.envFile(task.solution.env)),
      )
    await Sandbox.run(
      sandbox,
      slots.up(slot, {
        backend: config.sandbox.backend,
        cpus: task.environment.cpus,
        image: task.environment.dockerImage,
        limits: config.sandbox.limits,
        memoryMb: task.environment.memoryMb,
        network: config.sandbox.network,
      }),
    )
  }

  private async advanceAttempts(provider: Sandbox.Provider): Promise<void> {
    const meta = this.meta()!
    const config = this.config()
    const active = this.rows().filter((row) => row.phase !== 'pending' && row.phase !== 'done')
    const bySandbox = new Map<number, AttemptRow[]>()
    for (const row of active)
      bySandbox.set(row.sandbox!, [...(bySandbox.get(row.sandbox!) ?? []), row])

    if (meta.cancelled)
      for (const row of this.rows().filter((candidate) => candidate.phase === 'pending'))
        await this.finish(provider, row, {
          failure: { at: Date.now(), kind: 'cancelled', message: 'the run was cancelled' },
          reward: null,
        })

    for (const [id, rows] of bySandbox) {
      const record = this.sandboxes().find((candidate) => candidate.id === id)!
      const handle = JSON.parse(record.handle!) as Sandbox.Handle
      const sandbox = provider.connect(handle)
      const slots = Slot.create({ home: handle.home })

      let status: Slot.Status
      try {
        status = Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
      } catch (error) {
        for (const row of rows) await this.stumble(provider, row, error)
        continue
      }

      await Promise.all(
        rows.map(async (row) => {
          try {
            if (meta.cancelled) {
              if (row.phase === 'run' && row.agent !== oracleAgent(config)?.id)
                await Harness.cancel(this.env, this.session(row), requestId)
              await this.finish(provider, row, {
                failure: { at: Date.now(), kind: 'cancelled', message: 'the run was cancelled' },
                reward: null,
              })
              return
            }
            const state = status.slots[row.slot!]
            if (row.phase === 'up' && (!state || state.up === 'none')) {
              await this.startSlot(sandbox, slots, row.slot!, this.task(row.task))
              return
            }
            if (!state) throw new Error('the sandbox reports no slot ' + row.slot)
            await this.advance(provider, row, { config, sandbox, slots, state })
            if (row.errors) this.update('attempts', row.id, { errors: 0 })
          } catch (error) {
            await this.stumble(provider, row, error)
          }
        }),
      )
    }
  }

  private async stumble(
    provider: Sandbox.Provider,
    row: AttemptRow,
    error: unknown,
  ): Promise<void> {
    const config = this.config()
    if (row.errors < config.limits.stepRetries) {
      this.update('attempts', row.id, { errors: row.errors + 1 })
      return
    }
    await this.finish(provider, row, {
      failure: { at: Date.now(), kind: 'environment', message: message(error) },
      reward: null,
    }).catch((failure) =>
      console.error('nanoeval could not finish attempt', row.id, message(failure)),
    )
  }

  private session(row: AttemptRow): string {
    return this.meta()!.id + '-' + row.id
  }

  private timing(
    row: AttemptRow,
    phase: keyof Result.Attempt['timing'],
    mark: 'finish' | 'start',
  ): string {
    const timing = JSON.parse(this.attempt(row.id)!.timing) as Result.Attempt['timing']
    const now = Date.now()
    timing[phase] =
      mark === 'start'
        ? { finishedAt: now, startedAt: now }
        : { ...timing[phase]!, finishedAt: now }
    return JSON.stringify(timing)
  }

  private async advance(
    provider: Sandbox.Provider,
    row: AttemptRow,
    context: {
      config: ReturnType<Run['config']>
      sandbox: Sandbox.Sandbox
      slots: ReturnType<typeof Slot.create>
      state: Slot.Status['slots'][string]
    },
  ): Promise<void> {
    const { config, sandbox, slots, state } = context
    const slot = row.slot!
    const task = this.task(row.task)
    const agent = config.agents.find((candidate) => candidate.id === row.agent)!
    const session = this.session(row)
    const now = Date.now()
    const elapsed = now - (row.phase_at ?? now)
    const fail = (kind: Result.FailureKind, text: string) =>
      this.finish(provider, row, { failure: { at: Date.now(), kind, message: text }, reward: null })

    switch (row.phase) {
      case 'up': {
        const code = Slot.exit(state.up)
        if (code === undefined) {
          const setupSec = task.environment.buildTimeoutSec ?? config.limits.setupSec
          if (elapsed > setupSec * 1000)
            await fail(
              'environment',
              'the task environment was not ready within ' + setupSec + ' s',
            )
          return
        }
        if (code !== 0) {
          const log = await Sandbox.run(sandbox, slots.log(slot, 'up', logBytes))
          this.putArtifact(row.id, 'environment.log', log)
          await fail(
            'environment',
            'the task environment failed with exit code ' + code + ': ' + log.slice(-2000),
          )
          return
        }

        const token = await Harness.token(this.env, session)
        const file = slots.home + '/slots/' + slot + '/token'
        await sandbox.write(file, Bytes.fromText(token + '\n'))
        const url =
          this.meta()!.publicUrl.replace(/^http/, 'ws') +
          '/sessions/' +
          encodeURIComponent(session) +
          '/hands'
        await Sandbox.run(
          sandbox,
          slots.hand(slot, { name: handName, url }) +
            ' < ' +
            Sandbox.quote(file) +
            '; code=$?; rm -f ' +
            Sandbox.quote(file) +
            '; exit $code',
        )
        this.update('attempts', row.id, {
          phase: 'attach',
          phase_at: Date.now(),
          timing: this.timing(row, 'environmentSetup', 'finish'),
        })
        this.update('attempts', row.id, { timing: this.timing(row, 'agentSetup', 'start') })
        return
      }
      case 'attach': {
        if ((await Harness.hands(this.env, session)).includes(handName)) {
          if (agent.provider === 'oracle')
            await Sandbox.run(sandbox, slots.solve(slot, task.agent.timeoutSec))
          else
            await Harness.submit(this.env, session, {
              hand: handName,
              model: agent.model,
              prompt: task.instruction,
              provider: agent.provider,
              requestId,
              ...(agent.thinking ? { thinking: agent.thinking } : {}),
            })
          this.update('attempts', row.id, {
            deadline_at: Date.now() + task.agent.timeoutSec * 1000,
            phase: 'run',
            phase_at: Date.now(),
            timing: this.timing(row, 'agentSetup', 'finish'),
          })
          this.update('attempts', row.id, { timing: this.timing(row, 'agentExecution', 'start') })
          return
        }
        const code = Slot.exit(state.hand)
        if (code !== undefined || elapsed > config.limits.attachSec * 1000) {
          const log = await Sandbox.run(sandbox, slots.log(slot, 'hand', logBytes))
          this.putArtifact(row.id, 'hand.log', log)
          await fail(
            'environment',
            (code === undefined
              ? 'the hand did not attach within ' + config.limits.attachSec + ' s'
              : 'the hand exited with ' + code) +
              ': ' +
              log.slice(-2000),
          )
        }
        return
      }
      case 'run': {
        if (agent.provider === 'oracle') {
          const code = Slot.exit(state.solve)
          if (code === undefined) {
            if (now > row.deadline_at! + config.limits.attachSec * 1000)
              await fail('environment', 'the solution did not report within its deadline')
            return
          }
          const log = await Sandbox.run(sandbox, slots.log(slot, 'solve', logBytes))
          this.putArtifact(
            row.id,
            'agent/oracle.txt',
            log + '\nsolve.sh exited with ' + code + '\n',
          )
          if (code === 124 || code === 137)
            this.update('attempts', row.id, {
              failure: JSON.stringify({
                at: now,
                kind: 'agent_timeout',
                message: 'the solution did not finish within ' + task.agent.timeoutSec + ' s',
              } satisfies Result.Failure),
            })
          await this.verify(row, sandbox, slots, task)
          return
        }
        const report = await Harness.turn(this.env, session, requestId)
        if (report.status === 'completed') {
          await this.verify(row, sandbox, slots, task)
          return
        }
        if (report.status === 'failed' || report.status === 'cancelled') {
          await fail('agent', report.error ?? 'the turn ended as ' + report.status)
          return
        }
        if (now > row.deadline_at!) {
          await Harness.cancel(this.env, session, requestId)
          this.update('attempts', row.id, {
            failure: JSON.stringify({
              at: now,
              kind: 'agent_timeout',
              message: 'the agent did not finish within ' + task.agent.timeoutSec + ' s',
            } satisfies Result.Failure),
          })
          await this.verify(row, sandbox, slots, task)
          return
        }
        if (report.kind === 'detached' && Slot.exit(state.hand) !== undefined) {
          await Harness.cancel(this.env, session, requestId)
          const log = await Sandbox.run(sandbox, slots.log(slot, 'hand', logBytes))
          this.putArtifact(row.id, 'hand.log', log)
          await fail('environment', 'the hand left during the turn: ' + log.slice(-2000))
        }
        return
      }
      case 'verify': {
        const code = Slot.exit(state.verify)
        if (code === undefined) {
          if (elapsed > (task.verifier.timeoutSec + config.limits.setupSec) * 1000)
            await fail('verifier_timeout', 'the verifier did not report within its deadline')
          return
        }
        const log = await Sandbox.run(sandbox, slots.log(slot, 'verify', logBytes))
        this.putArtifact(row.id, 'verifier/test-stdout.txt', log)
        const ctrf = await Sandbox.run(sandbox, slots.log(slot, 'ctrf', 4 * 1024 * 1024))
        if (ctrf) this.putArtifact(row.id, 'verifier/ctrf.json', ctrf)

        const earlier = this.attempt(row.id)!.failure
        const failure: Result.Failure | undefined = earlier
          ? (JSON.parse(earlier) as Result.Failure)
          : code === 124 || code === 137
            ? {
                at: Date.now(),
                kind: 'verifier_timeout',
                message: 'the verifier did not finish within ' + task.verifier.timeoutSec + ' s',
              }
            : state.reward === null
              ? {
                  at: Date.now(),
                  kind: 'verifier',
                  message:
                    'the verifier exited with ' +
                    code +
                    ' and wrote no reward: ' +
                    log.slice(-2000),
                }
              : undefined
        this.update('attempts', row.id, { timing: this.timing(row, 'verifier', 'finish') })
        await this.finish(provider, this.attempt(row.id)!, {
          ...(failure ? { failure } : {}),
          reward: failure && failure.kind !== 'agent_timeout' ? null : state.reward,
        })
        return
      }
    }
  }

  private async verify(
    row: AttemptRow,
    sandbox: Sandbox.Sandbox,
    slots: ReturnType<typeof Slot.create>,
    task: Spec,
  ): Promise<void> {
    this.update('attempts', row.id, { timing: this.timing(row, 'agentExecution', 'finish') })
    await Sandbox.run(sandbox, slots.verify(row.slot!, task.verifier.timeoutSec))
    this.update('attempts', row.id, {
      phase: 'verify',
      phase_at: Date.now(),
      timing: this.timing(row, 'verifier', 'start'),
    })
  }

  private async finish(
    provider: Sandbox.Provider,
    row: AttemptRow,
    end: { failure?: Result.Failure; reward: number | null },
  ): Promise<void> {
    const config = this.config()
    const task = this.task(row.task)
    const agent = config.agents.find((candidate) => candidate.id === row.agent)!
    const session = this.session(row)
    const submitted = agent.provider !== 'oracle' && (row.phase === 'run' || row.phase === 'verify')
    const now = Date.now()

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

    const result: Result.Attempt = {
      agent,
      ...(end.failure ? { failure: end.failure } : {}),
      finishedAt: now,
      id: row.id,
      index: row.n,
      outcome: Result.outcome(end.reward, end.failure),
      reward: end.reward,
      sandbox:
        row.sandbox === null
          ? null
          : {
              backend: config.sandbox.backend,
              id: row.sandbox,
              provider: config.sandbox.provider,
              slot: row.slot!,
            },
      session,
      startedAt: row.started_at ?? now,
      task: { checksum: task.checksum, name: task.name },
      timing: JSON.parse(this.attempt(row.id)!.timing),
      usage,
    }
    this.update('attempts', row.id, {
      phase: 'done',
      phase_at: now,
      result: JSON.stringify(result),
    })

    const record =
      row.sandbox === null
        ? undefined
        : this.sandboxes().find((candidate) => candidate.id === row.sandbox)
    if (record?.handle && row.slot) {
      const handle = JSON.parse(record.handle) as Sandbox.Handle
      await provider
        .connect(handle)
        .exec(Slot.create({ home: handle.home }).down(row.slot))
        .catch(() => {})
    }
    if (row.phase !== 'pending' && row.phase !== 'up')
      await Harness.remove(this.env, session).catch(() => {})
  }

  private async closeIdle(provider: Sandbox.Provider): Promise<void> {
    const rows = this.rows()
    const pending = rows.some((row) => row.phase === 'pending')
    for (const record of this.sandboxes()) {
      if (record.state !== 'ready') continue
      const busy = rows.some((row) => row.sandbox === record.id && row.phase !== 'done')
      if (busy || pending) continue

      const handle = JSON.parse(record.handle!) as Sandbox.Handle
      try {
        await provider.kill(handle)
        this.update('sandboxes', record.id, { state: 'closed' })
      } catch (error) {
        this.update('sandboxes', record.id, { error: message(error), state: 'failed' })
      }
    }
  }
}
