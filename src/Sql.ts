export type Value = number | string | null

export type Row = Record<string, Value>

export type Sql = {
  all(query: string, ...bindings: Value[]): Row[]
  run(query: string, ...bindings: Value[]): void
  transaction<T>(work: () => T): T
}

export function setup(sql: Sql, statements: readonly string[]): void {
  for (const statement of statements) sql.run(statement)
}
