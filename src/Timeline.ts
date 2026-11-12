import type * as Atif from './Atif.ts'
import type * as Sql from './Sql.ts'

export type Mark = {
  at: number
  attempt?: string
  ms?: number
  name: string
  runner?: number
  sandbox?: number
}

export type Report = {
  marks: readonly { at: number; ms?: number; name: string }[]
  sentAt: number
}

export type Start = {
  agentMs?: number
  claimMs?: number
  environmentMs?: number
  modelMs?: number
  poolMs?: number
  runnerMs?: number
  sandboxMs?: number
  verdictMs?: number
}

export const tables = [
  `CREATE TABLE IF NOT EXISTS timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    name TEXT NOT NULL,
    attempt TEXT,
    runner INTEGER,
    sandbox INTEGER,
    ms INTEGER
  )`,
]

const firsts: [field: keyof Start, name: string][] = [
  ['agentMs', 'attempt.agent'],
  ['claimMs', 'attempt.claimed'],
  ['environmentMs', 'attempt.environment'],
  ['modelMs', 'attempt.model'],
  ['poolMs', 'sandbox.adopt'],
  ['runnerMs', 'runner.hello'],
  ['sandboxMs', 'sandbox.create'],
  ['verdictMs', 'attempt.verdict'],
]

export function add(sql: Sql.Sql, mark: Mark): void {
  sql.run(
    'INSERT INTO timeline (at, name, attempt, runner, sandbox, ms) VALUES (?, ?, ?, ?, ?, ?)',
    Math.round(mark.at),
    mark.name,
    mark.attempt ?? null,
    mark.runner ?? null,
    mark.sandbox ?? null,
    mark.ms === undefined ? null : Math.round(mark.ms),
  )
}

export function valid(value: unknown): value is Report {
  const report = value as Report | null
  return (
    typeof report === 'object' &&
    report !== null &&
    Number.isFinite(report.sentAt) &&
    Array.isArray(report.marks) &&
    report.marks.every(
      (mark) =>
        typeof mark?.name === 'string' &&
        /^[a-z][a-z0-9.]{0,63}$/.test(mark.name) &&
        Number.isFinite(mark.at) &&
        (mark.ms === undefined || (Number.isFinite(mark.ms) && mark.ms >= 0)),
    )
  )
}

export function report(sql: Sql.Sql, input: report.Input): void {
  const offset = input.receivedAt - input.report.sentAt
  for (const mark of input.report.marks)
    add(sql, {
      at: mark.at + offset,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(mark.ms === undefined ? {} : { ms: mark.ms }),
      name: mark.name,
      ...(input.runner === undefined ? {} : { runner: input.runner }),
    })
}

export declare namespace report {
  type Input = {
    attempt?: string
    receivedAt: number
    report: Report
    runner?: number
  }
}

export function all(sql: Sql.Sql): Mark[] {
  return sql
    .all('SELECT at, name, attempt, runner, sandbox, ms FROM timeline ORDER BY at, id')
    .map((row) => ({
      at: row['at'] as number,
      ...(row['attempt'] === null ? {} : { attempt: row['attempt'] as string }),
      ...(row['ms'] === null ? {} : { ms: row['ms'] as number }),
      name: row['name'] as string,
      ...(row['runner'] === null ? {} : { runner: row['runner'] as number }),
      ...(row['sandbox'] === null ? {} : { sandbox: row['sandbox'] as number }),
    }))
}

export function start(marks: readonly Mark[], createdAt: number): Start {
  const found: Start = {}
  for (const [field, name] of firsts) {
    const at = marks
      .filter((mark) => mark.name === name)
      .reduce<number | undefined>(
        (least, mark) => (least === undefined || mark.at < least ? mark.at : least),
        undefined,
      )
    if (at !== undefined) found[field] = at - createdAt
  }
  return found
}

export function modelRequest(events: readonly Atif.SessionEvent[]): number | undefined {
  for (const event of events) {
    const inner = event.event.event
    if (inner?.type !== 'model.call.completed') continue
    const duration = Number(inner.payload['duration_ns'])
    return event.created_at - (Number.isFinite(duration) ? duration / 1e6 : 0)
  }
  return undefined
}

export function summary(found: Start): string {
  const parts: [label: string, ms: number | undefined][] = [
    ['sandbox', found.sandboxMs],
    ['pool', found.poolMs],
    ['runner', found.runnerMs],
    ['claim', found.claimMs],
    ['environment', found.environmentMs],
    ['agent', found.agentMs],
    ['model request', found.modelMs],
    ['verdict', found.verdictMs],
  ]
  return parts
    .filter(([, ms]) => ms !== undefined)
    .map(([label, ms]) => label + ' +' + (ms! / 1000).toFixed(2) + ' s')
    .join(', ')
}

export function table(marks: readonly Mark[], createdAt: number): string {
  return marks
    .map((mark) =>
      [
        ('+' + ((mark.at - createdAt) / 1000).toFixed(3)).padStart(10),
        (mark.ms === undefined ? '' : mark.ms + ' ms').padStart(10),
        mark.name.padEnd(24),
        [
          mark.attempt,
          mark.runner === undefined ? undefined : 'runner ' + mark.runner,
          mark.sandbox === undefined ? undefined : 'sandbox ' + mark.sandbox,
        ]
          .filter(Boolean)
          .join(' '),
      ]
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
