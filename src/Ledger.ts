import * as Admission from './Admission.ts'
import type * as Result from './Result.ts'
import type * as Sql from './Sql.ts'

export type Phase = 'attach' | 'claimed' | 'done' | 'judge' | 'run' | 'unclaimed' | 'verify'

export type Ending = 'cancelled' | 'expired' | 'finished' | 'released'

export type Origin = { attempt: string; run: string }

export type Attempt = {
  agent: string
  claim: string | null
  claims: number
  deadline_at: number | null
  failure: string | null
  id: string
  lease_until: number | null
  n: number
  origin: string | null
  phase: Phase
  phase_at: number | null
  result: string | null
  runner: number | null
  session: string | null
  slot: string | null
  started_at: number | null
  task: string
  timing: string
}

export type Claim = {
  attempt: string
  claimed_at: number
  ended_at: number | null
  ending: Ending | null
  id: number
  n: number
  phase: Phase | null
  runner: number
  session: string
  token: string
  usage: string | null
}

export type Seed = { agent: string; n: number; origin?: Origin; task: string }

export type Selection = 'errored' | 'failed' | 'unpassed'

export const tables = [
  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    agent TEXT NOT NULL,
    n INTEGER NOT NULL,
    phase TEXT NOT NULL,
    runner INTEGER,
    claim TEXT,
    claims INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    slot TEXT,
    session TEXT,
    started_at INTEGER,
    phase_at INTEGER,
    deadline_at INTEGER,
    timing TEXT NOT NULL DEFAULT '{}',
    failure TEXT,
    result TEXT,
    origin TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    runner INTEGER NOT NULL,
    n INTEGER NOT NULL,
    session TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    ended_at INTEGER,
    ending TEXT,
    phase TEXT,
    usage TEXT
  )`,
]

export function create(sql: Sql.Sql, seeds: readonly Seed[]): number {
  let counter = sql.all('SELECT COUNT(*) AS n FROM attempts')[0]!['n'] as number
  for (const seed of seeds)
    sql.run(
      'INSERT INTO attempts (id, task, agent, n, phase, origin) VALUES (?, ?, ?, ?, ?, ?)',
      'a' + String(++counter).padStart(5, '0'),
      seed.task,
      seed.agent,
      seed.n,
      'unclaimed',
      seed.origin ? JSON.stringify(seed.origin) : null,
    )
  return counter
}

export function all(sql: Sql.Sql): Attempt[] {
  return sql.all('SELECT * FROM attempts ORDER BY id') as unknown as Attempt[]
}

export function get(sql: Sql.Sql, id: string): Attempt | undefined {
  return sql.all('SELECT * FROM attempts WHERE id = ?', id)[0] as unknown as Attempt | undefined
}

export function update(sql: Sql.Sql, id: string, fields: Record<string, Sql.Value>): void {
  const names = Object.keys(fields)
  sql.run(
    'UPDATE attempts SET ' + names.map((name) => name + ' = ?').join(', ') + ' WHERE id = ?',
    ...names.map((name) => fields[name]!),
    id,
  )
}

export function active(row: Pick<Attempt, 'phase'>): boolean {
  return row.phase !== 'unclaimed' && row.phase !== 'done'
}

export function held(sql: Sql.Sql, input: { claim: string; id: string }): Attempt | undefined {
  const row = get(sql, input.id)
  return row && active(row) && row.claim === input.claim ? row : undefined
}

export function mark(
  timing: string,
  phase: keyof Result.Attempt['timing'],
  input: { at: number; edge: 'finish' | 'start' },
): string {
  const spans = JSON.parse(timing) as Result.Attempt['timing']
  spans[phase] =
    input.edge === 'start'
      ? { finishedAt: input.at, startedAt: input.at }
      : { ...(spans[phase] ?? { startedAt: input.at }), finishedAt: input.at }
  return JSON.stringify(spans)
}

export function claim(sql: Sql.Sql, input: claim.Input): Attempt[] {
  const candidates = (
    sql.all(
      "SELECT * FROM attempts WHERE phase = 'unclaimed' ORDER BY n, id",
    ) as unknown as Attempt[]
  ).filter((row) => input.accepts?.(row) ?? true)
  const chosen = Admission.fill(
    candidates.map((row) => ({ item: row, memoryMb: input.memoryOf(row.task) })),
    input.offer,
  )
  return sql.transaction(() =>
    chosen.map((row) => {
      const n = row.claims + 1
      const token = input.token()
      const session = input.run + '-' + row.id + '-' + n
      update(sql, row.id, {
        claim: token,
        claims: n,
        deadline_at: null,
        failure: null,
        lease_until: input.now + input.leaseMs,
        phase: 'claimed',
        phase_at: input.now,
        runner: input.runner,
        session,
        slot: input.run.slice(0, 8) + '-' + row.id + '-' + n,
        started_at: input.now,
        timing: mark('{}', 'environmentSetup', { at: input.now, edge: 'start' }),
      })
      sql.run(
        'INSERT INTO claims (attempt, token, runner, n, session, claimed_at) VALUES (?, ?, ?, ?, ?, ?)',
        row.id,
        token,
        input.runner,
        n,
        session,
        input.now,
      )
      return get(sql, row.id)!
    }),
  )
}

export declare namespace claim {
  type Input = {
    accepts?(row: Attempt): boolean
    leaseMs: number
    memoryOf(task: string): number
    now: number
    offer: Admission.Offer
    run: string
    runner: number
    token(): string
  }
}

export function heartbeat(sql: Sql.Sql, input: heartbeat.Input): string[] {
  const lost: string[] = []
  for (const entry of input.held) {
    const row = held(sql, entry)
    if (!row || row.runner !== input.runner) lost.push(entry.id)
    else update(sql, row.id, { lease_until: input.now + input.leaseMs })
  }
  return lost
}

export declare namespace heartbeat {
  type Input = {
    held: readonly { claim: string; id: string }[]
    leaseMs: number
    now: number
    runner: number
  }
}

export function expired(sql: Sql.Sql, now: number): Attempt[] {
  return sql.all(
    "SELECT * FROM attempts WHERE phase NOT IN ('unclaimed', 'done') AND lease_until < ? ORDER BY id",
    now,
  ) as unknown as Attempt[]
}

function end(sql: Sql.Sql, row: Attempt, input: { ending: Ending; now: number; usage?: string }) {
  if (!row.claim) return
  sql.run(
    'UPDATE claims SET ended_at = ?, ending = ?, phase = ?, usage = ? WHERE token = ? AND ended_at IS NULL',
    input.now,
    input.ending,
    row.phase,
    input.usage ?? null,
    row.claim,
  )
}

export function requeue(sql: Sql.Sql, input: requeue.Input): boolean {
  return sql.transaction(() => {
    const row = get(sql, input.id)
    if (!row || !active(row)) return false
    end(sql, row, input)
    if (row.claims >= input.limit) return false
    update(sql, row.id, {
      claim: null,
      deadline_at: null,
      failure: null,
      lease_until: null,
      phase: 'unclaimed',
      phase_at: input.now,
      runner: null,
      session: null,
      slot: null,
      started_at: null,
      timing: '{}',
    })
    return true
  })
}

export declare namespace requeue {
  type Input = {
    ending: 'expired' | 'released'
    id: string
    limit: number
    now: number
    usage?: string
  }
}

export function finish(sql: Sql.Sql, input: finish.Input): boolean {
  return sql.transaction(() => {
    const row = get(sql, input.id)
    if (!row || row.phase === 'done') return false
    end(sql, row, { ending: input.ending ?? 'finished', now: input.now })
    update(sql, row.id, {
      lease_until: null,
      phase: 'done',
      phase_at: input.now,
      result: JSON.stringify(input.result),
    })
    return true
  })
}

export declare namespace finish {
  type Input = {
    ending?: Ending
    id: string
    now: number
    result: Result.Attempt
  }
}

export function claims(sql: Sql.Sql, attempt?: string): Claim[] {
  return (attempt === undefined
    ? sql.all('SELECT * FROM claims ORDER BY id')
    : sql.all('SELECT * FROM claims WHERE attempt = ? ORDER BY id', attempt)) as unknown as Claim[]
}

export function lostUsage(sql: Sql.Sql): string[] {
  return sql
    .all("SELECT usage FROM claims WHERE usage IS NOT NULL AND ending != 'finished'")
    .map((row) => row['usage'] as string)
}

export function retries(
  parent: { attempts: readonly retries.Parent[]; run: string },
  selection: Selection,
): Seed[] {
  return parent.attempts
    .filter(
      (attempt) =>
        attempt.outcome !== undefined &&
        (selection === 'unpassed' ? attempt.outcome !== 'passed' : attempt.outcome === selection),
    )
    .map((attempt) => ({
      agent: attempt.agent,
      n: attempt.n,
      origin: { attempt: attempt.id, run: parent.run },
      task: attempt.task,
    }))
}

export declare namespace retries {
  type Parent = {
    agent: string
    id: string
    n: number
    outcome?: Result.Attempt['outcome']
    task: string
  }
}
