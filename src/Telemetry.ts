import type * as Atif from './Atif.ts'
import type * as Sql from './Sql.ts'

export type Row = { before: number | null; event: Atif.SessionEvent }

export const header = 'x-nanoeval-telemetry'

export const scope = 'owner'

export const tables = [
  `CREATE TABLE IF NOT EXISTS nanoeval_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    before INTEGER,
    body TEXT NOT NULL
  )`,
]

export function live(event: { seq: number }): boolean {
  return event.seq === 0
}

export function record(sql: Sql.Sql, input: record.Input): boolean {
  let open = input.open
  for (const event of input.events) {
    if (live(event)) {
      sql.run('INSERT INTO nanoeval_telemetry (body) VALUES (?)', JSON.stringify(event))
      open = true
      continue
    }
    if (open) sql.run('UPDATE nanoeval_telemetry SET before = ? WHERE before IS NULL', event.seq)
    open = false
  }
  return open
}

export declare namespace record {
  type Input = { events: readonly Atif.SessionEvent[]; open: boolean }
}

export function read(sql: Sql.Sql, input: read.Input): Row[] {
  return sql
    .all(
      `SELECT before, body FROM nanoeval_telemetry
        WHERE (before > ? AND before <= ?) OR (? = 1 AND (before IS NULL OR before > ?))
        ORDER BY id`,
      input.after,
      input.through,
      input.last ? 1 : 0,
      input.through,
    )
    .map((row) => ({
      before: row['before'] as number | null,
      event: JSON.parse(row['body'] as string) as Atif.SessionEvent,
    }))
}

export declare namespace read {
  type Input = { after: number; last: boolean; through: number }
}

export function merge(
  events: readonly Atif.SessionEvent[],
  telemetry: readonly Row[],
): Atif.SessionEvent[] {
  const merged: Atif.SessionEvent[] = []
  let next = 0
  for (const event of events) {
    for (; next < telemetry.length; next++) {
      const row = telemetry[next]!
      if (row.before === null || row.before > event.seq) break
      merged.push(row.event)
    }
    merged.push(event)
  }
  for (; next < telemetry.length; next++) merged.push(telemetry[next]!.event)
  return merged
}
