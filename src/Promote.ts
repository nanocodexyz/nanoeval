import type * as Compare from './Compare.ts'
import type * as Price from './Price.ts'
import * as Scorecard from './Scorecard.ts'
import * as Site from './Site.ts'

export class InvalidError extends Error {
  override name = 'Promote.InvalidError'
}

export const repeats = 3

export type Side = { id: string; passed: number; passRate: number; usdPerPass: number | null }

export type Measured = {
  baseline: Side
  id: string
  lead: Scorecard.Estimate
  matched: number
  passed: number
  passRate: number
  ratio: Scorecard.Estimate | null
  repeats: number
  run: string
  tasks: number
  uncosted: { baseline: number; run: number }
  unmatched: { baseline: number; run: number }
  usdPerPass: number | null
}

export type Scored = Measured &
  (
    | { verdict: 'missing'; why: 'repeats' | 'unmatched' }
    | { verdict: 'loss' | 'none' | 'tie' | 'win' }
  )

export type Cell = { id: string; run: string; verdict: 'missing'; why: 'run' } | Scored

export function verdict(measured: Measured): 'loss' | 'none' | 'repeats' | 'tie' | 'unmatched' | 'win' {
  if (measured.unmatched.baseline || measured.unmatched.run) return 'unmatched'
  if (measured.repeats < repeats) return 'repeats'
  const { lead, ratio } = measured
  if (lead.low !== null && lead.low > 0) return 'win'
  if (lead.high !== null && lead.high < 0) return 'loss'
  if (ratio && ratio.high !== null && ratio.high < 1) return 'tie'
  return 'none'
}

export function cells(runs: readonly Compare.Run[], options: cells.Options): Cell[] {
  const repeated = runs.find((run, at) => runs.findIndex((same) => same.id === run.id) !== at)
  if (repeated) throw new InvalidError('run ' + repeated.id + ' is named twice')
  const holds = (run: Compare.Run) =>
    run.attempts.some((attempt) => attempt.agent.id === options.baseline)
  if (!runs.some(holds))
    throw new InvalidError('no run holds a row of the baseline arm ' + options.baseline)
  return runs.flatMap((run) => {
    const ids = [...new Set(run.attempts.map((attempt) => attempt.agent.id))]
      .filter((id) => id !== options.baseline)
      .sort(ordered)
    return holds(run)
      ? ids.map((id) => cell(run, { ...options, id }))
      : ids.map((id) => ({ id, run: run.id, verdict: 'missing' as const, why: 'run' as const }))
  })
}

export declare namespace cells {
  type Options = {
    baseline: string
    draws?: number | undefined
    exclude?: Scorecard.Exclusion | undefined
    prices?: Price.List | undefined
    seed?: number | undefined
  }
}

function ordered(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function cell(run: Compare.Run, options: cells.Options & { id: string }): Scored {
  const card = Scorecard.build(
    [Site.run(run, { arms: [options.baseline, options.id], name: 'run ' + run.id })],
    {
      command: 'nanoeval promote',
      draws: options.draws ?? Scorecard.defaults.draws,
      exclude: options.exclude,
      prices: options.prices,
      reference: options.baseline,
      seed: options.seed ?? Scorecard.defaults.seed,
    },
  )
  const reference = card.arms.find((arm) => arm.id === options.baseline)!
  const own = card.arms.find((arm) => arm.id === options.id)!
  const measured: Measured = {
    baseline: {
      id: options.baseline,
      passed: reference.passed,
      passRate: reference.passRate.value!,
      usdPerPass: reference.usdPerPass?.value ?? null,
    },
    id: options.id,
    lead: own.against!.passRateDifference,
    matched: own.matched,
    passed: own.passed,
    passRate: own.passRate.value!,
    ratio: own.against!.usdPerPassRatio,
    repeats: Math.min(...card.tasks.map((task) => task.attempts)),
    run: run.id,
    tasks: card.matched.tasks,
    uncosted: { baseline: reference.uncosted, run: own.uncosted },
    unmatched: { baseline: reference.unmatched, run: own.unmatched },
    usdPerPass: own.usdPerPass?.value ?? null,
  }
  const found = verdict(measured)
  return found === 'repeats' || found === 'unmatched'
    ? { ...measured, verdict: 'missing', why: found }
    : { ...measured, verdict: found }
}

function usd(value: number | null): number {
  return value ?? Infinity
}

export function rank(left: Measured, right: Measured): number {
  return (
    right.passRate - left.passRate ||
    (usd(left.usdPerPass) === usd(right.usdPerPass)
      ? ordered(left.id, right.id)
      : usd(left.usdPerPass) < usd(right.usdPerPass)
        ? -1
        : 1)
  )
}

export function dominates(left: Measured, right: Measured): boolean {
  const cheaper = usd(left.usdPerPass) < usd(right.usdPerPass)
  const same = usd(left.usdPerPass) === usd(right.usdPerPass)
  return (
    left.passRate >= right.passRate &&
    (cheaper || same) &&
    (left.passRate > right.passRate || cheaper)
  )
}

export function front<Each extends Measured>(given: readonly Each[]): Each[] {
  return given.filter((found) => !given.some((other) => dominates(other, found)))
}

export function select(given: readonly Cell[], options: select.Options): select.ReturnType {
  const scored = given.filter((found): found is Scored => 'lead' in found)
  if (options.stage === 'A') {
    if (!Number.isInteger(options.survivors) || options.survivors < 1)
      throw new InvalidError(
        'stage A keeps a whole number of survivors above zero, not ' + options.survivors,
      )
    const ranked = scored
      .filter((found) => !('why' in found) || found.why === 'repeats')
      .sort(rank)
    const best = front(ranked)
    const survivors = [...best, ...ranked.filter((found) => !best.includes(found))]
      .slice(0, options.survivors)
      .sort(rank)
    return { front: best, ranked, survivors }
  }
  const ranked = scored.sort(rank)
  return {
    front: front(ranked),
    ranked,
    survivors: ranked.filter((found) => found.verdict === 'win' || found.verdict === 'tie'),
  }
}

export declare namespace select {
  type Options = { stage: 'A'; survivors: number } | { stage: 'B' }
  type ReturnType = { front: Scored[]; ranked: Scored[]; survivors: Scored[] }
}

function shown(found: Scorecard.Estimate | null, format: (value: number) => string): string {
  const bound = (value: number | null) => (value === null ? 'inf' : format(value))
  return found ? bound(found.value) + ' [' + bound(found.low) + ', ' + bound(found.high) + ']' : 'n/a'
}

export function text(given: readonly Cell[]): string {
  const head = ['arm', 'run', 'verdict', 'pass', 'baseline', 'lead pp', '$/pass', 'ratio', 'tasks x N']
  const rows: string[][] = [
    head,
    ...given.map((found) =>
      'lead' in found
        ? [
            found.id,
            found.run,
            'why' in found ? 'missing (' + found.why + ')' : found.verdict,
            found.passed + '/' + found.matched + ' ' + Scorecard.percent(found.passRate),
            found.baseline.passed +
              '/' +
              found.matched +
              ' ' +
              Scorecard.percent(found.baseline.passRate),
            shown(found.lead, Scorecard.points),
            found.usdPerPass === null ? 'n/a' : Scorecard.usd(found.usdPerPass),
            shown(found.ratio, Scorecard.times),
            found.tasks + ' x ' + found.repeats,
          ]
        : [found.id, found.run, 'missing (run)', '', '', '', '', '', ''],
    ),
  ]
  const widths = head.map((_, at) => Math.max(...rows.map((row) => row[at]!.length)))
  return rows
    .map((row) => row.map((value, at) => value.padEnd(widths[at]!)).join('  ').trimEnd())
    .join('\n')
}
