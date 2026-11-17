import * as Scorecard from '../../src/Scorecard.ts'

export const defaults = { draws: 4000, seed: 1 }

export const higher = new Set(['aggTokS', 'pass', 'tokS', 'turnsPerMin'])

export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right)
  if (!sorted.length) return null
  const at = (sorted.length - 1) * p
  const low = Math.floor(at)
  const high = Math.ceil(at)
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low)
}

export function mean(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite)
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null
}

export type Summary = { mean: number | null; n: number; p50: number | null; p95: number | null }

export function summarize(values: readonly number[]): Summary {
  const finite = values.filter(Number.isFinite)
  return {
    mean: mean(finite),
    n: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
  }
}

export type Ratio = { high: number | null; low: number | null; value: number | null }

export type Verdict = 'LOSS' | 'NA' | 'TIE' | 'WIN'

export function ratio(
  base: readonly (readonly number[])[],
  head: readonly (readonly number[])[],
  options: { draws: number; seed: number } = defaults,
): Ratio {
  const clusters = base.length
  if (clusters !== head.length) throw new Error('both arms have the same clusters')
  const of = (arms: readonly (readonly number[])[]) => mean(arms.flat())
  const top = of(head)
  const bottom = of(base)
  const value = top !== null && bottom ? top / bottom : null
  if (!clusters) return { high: null, low: null, value }
  const random = Scorecard.mulberry32(options.seed)
  const pick = (count: number) => Math.floor(random() * count)
  const drawn = Array.from({ length: options.draws }, () => {
    let headSum = 0
    let headCount = 0
    let baseSum = 0
    let baseCount = 0
    for (let index = 0; index < clusters; index++) {
      const cluster = pick(clusters)
      for (const _ of base[cluster]!) {
        baseSum += base[cluster]![pick(base[cluster]!.length)]!
        baseCount++
      }
      for (const _ of head[cluster]!) {
        headSum += head[cluster]![pick(head[cluster]!.length)]!
        headCount++
      }
    }
    return baseCount && headCount && baseSum
      ? headSum / headCount / (baseSum / baseCount)
      : Infinity
  })
  return { ...Scorecard.interval(drawn), value }
}

export function verdict(metric: string, found: Ratio): Verdict {
  if (found.low === null || found.high === null || found.value === null) return 'NA'
  const better = higher.has(metric)
  if (found.high < 1) return better ? 'LOSS' : 'WIN'
  if (found.low > 1) return better ? 'WIN' : 'LOSS'
  return 'TIE'
}
