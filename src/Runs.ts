import type * as Sql from './Sql.ts'

export type Counts = {
  active: number
  errored: number
  failed: number
  passed: number
  total: number
  unclaimed: number
}

export type Entry = {
  attempts: number
  createdAt: number
  eval: { name: string; version: string }
  id: string
  name: string
}

export type Ended = {
  errored: number
  failed: number
  finishedAt: number
  id: string
  passed: number
}

export type Listed = Omit<Entry, 'attempts'> & {
  counts: Counts | null
  finishedAt: number | null
  state: 'finished' | 'running'
}

export const tables = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    eval TEXT NOT NULL,
    version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    finished_at INTEGER,
    passed INTEGER,
    failed INTEGER,
    errored INTEGER
  )`,
]

export function created(sql: Sql.Sql, entry: Entry): void {
  sql.run(
    'INSERT OR IGNORE INTO runs (id, name, eval, version, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?)',
    entry.id,
    entry.name,
    entry.eval.name,
    entry.eval.version,
    entry.createdAt,
    entry.attempts,
  )
}

export function ended(sql: Sql.Sql, input: Ended): void {
  sql.run(
    'UPDATE runs SET finished_at = ?, passed = ?, failed = ?, errored = ? WHERE id = ?',
    input.finishedAt,
    input.passed,
    input.failed,
    input.errored,
    input.id,
  )
}

export function list(sql: Sql.Sql, limit?: number): Listed[] {
  const rows =
    limit === undefined
      ? sql.all('SELECT * FROM runs ORDER BY created_at DESC, id')
      : sql.all('SELECT * FROM runs ORDER BY created_at DESC, id LIMIT ?', limit)
  return rows.map((row) => {
    const finishedAt = row['finished_at'] as number | null
    return {
      counts:
        finishedAt === null
          ? null
          : {
              active: 0,
              errored: row['errored'] as number,
              failed: row['failed'] as number,
              passed: row['passed'] as number,
              total: row['attempts'] as number,
              unclaimed: 0,
            },
      createdAt: row['created_at'] as number,
      eval: { name: row['eval'] as string, version: row['version'] as string },
      finishedAt,
      id: row['id'] as string,
      name: row['name'] as string,
      state: finishedAt === null ? 'running' : 'finished',
    }
  })
}
