export class InvalidError extends Error {
  override name = 'Pace.InvalidError'
}

export type List = Readonly<Record<string, number>>

export type Row = { busyMs: number; requests: number }

export const form = '[MODEL=]REQUESTS'

export const minuteMs = 60_000

export function valid(perMin: unknown): perMin is number {
  return typeof perMin === 'number' && Number.isFinite(perMin) && perMin > 0
}

export function list(texts: readonly string[], models: readonly string[]): List {
  const found: Record<string, number> = {}
  for (const text of texts) {
    const at = text.lastIndexOf('=')
    const amount = text.slice(at + 1).trim()
    const perMin = amount === '' ? Number.NaN : Number(amount)
    if (at === 0 || !valid(perMin))
      throw new InvalidError(
        'a model pace is ' +
          form +
          ', the requests a minute its endpoint answers for the model, or for every model of the run where none is named, not ' +
          text,
      )
    for (const model of at < 0 ? new Set(models) : [text.slice(0, at)]) {
      if (found[model] !== undefined)
        throw new InvalidError('the model ' + model + ' is given two paces')
      found[model] = perMin
    }
  }
  return found
}

export function interval(perMin: number): number {
  return minuteMs / perMin
}

export function reserve(input: reserve.Input): { nextAt: number; waitMs: number } {
  const at = Math.max(input.now, input.nextAt ?? input.now)
  return { nextAt: at + interval(input.perMin), waitMs: at - input.now }
}

export declare namespace reserve {
  type Input = { nextAt: number | undefined; now: number; perMin: number }
}

export function waiting(input: reserve.Input): boolean {
  return (input.nextAt ?? input.now) - input.now > 2 * interval(input.perMin)
}

export function demand(rows: readonly Row[]): number | undefined {
  const asked = rows.filter((row) => row.requests > 0)
  if (!asked.length) return undefined
  return (
    (asked.reduce((sum, row) => sum + row.requests, 0) * minuteMs) /
    asked.reduce((sum, row) => sum + Math.max(0, row.busyMs), 0)
  )
}

export function room(input: { demand: number | undefined; perMin: number; rows: number }): number {
  const fed = input.demand === undefined ? 1 : Math.ceil(input.perMin / input.demand)
  return Math.max(0, Math.max(1, fed) - input.rows)
}
