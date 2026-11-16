import type * as Sql from './Sql.ts'

/** The model spend a run has recorded, read from its model requests a new request at a time. */
export class Tally {
  private readonly attempts = new Map<string, boolean>()
  private largestUsd: number | undefined
  private seen = 0
  private readonly sql: Sql.Sql
  private totalUsd = 0

  constructor(sql: Sql.Sql) {
    this.sql = sql
  }

  /**
   * Model requests are only ever inserted, so each read takes the requests recorded since the
   * last one by their id, and a run of many requests costs one pass over them in all instead of
   * one pass for every request it admits.
   */
  read(): Tally.Read {
    for (const request of this.sql.all(
      'SELECT id, attempt, COALESCE(cost, tools_usd, 0) AS usd, cost IS NOT NULL AS priced, usage IS NOT NULL AS answered FROM model_requests WHERE id > ? ORDER BY id',
      this.seen,
    )) {
      const usd = request['usd'] as number
      const attempt = request['attempt'] as string
      this.seen = request['id'] as number
      this.totalUsd += usd
      this.attempts.set(attempt, this.attempts.get(attempt) === true || request['priced'] === 1)
      if (request['answered'] === 1) this.largestUsd = Math.max(this.largestUsd ?? usd, usd)
    }
    return {
      largestUsd: this.largestUsd,
      priced: (attempt) => this.attempts.get(attempt) === true,
      usd: this.totalUsd,
    }
  }
}

export declare namespace Tally {
  type Read = {
    largestUsd: number | undefined
    priced(attempt: string): boolean
    usd: number
  }
}
