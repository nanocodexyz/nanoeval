import type * as Sql from '../src/Sql.ts'

export function sql(ctx: DurableObjectState): Sql.Sql {
  return {
    all: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings).toArray() as Sql.Row[],
    run: (query, ...bindings) => {
      ctx.storage.sql.exec(query, ...bindings)
    },
    transaction: (work) => ctx.storage.transactionSync(work),
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

export function message(error: unknown): string {
  return error instanceof Error ? error.name + ': ' + error.message : String(error)
}
