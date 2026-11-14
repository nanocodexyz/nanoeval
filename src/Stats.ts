export type Counts = { passed: number; scored: number }

export type Tails = { better: number; worse: number }

export const alpha = 0.05

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let value = 1
  for (let at = 1; at <= Math.min(k, n - k); at++)
    value = (value * (n - Math.min(k, n - k) + at)) / at
  return value
}

export function passes(baseline: Counts, run: Counts): { from: number; odds: number[] } {
  const all = baseline.scored + run.scored
  const passed = baseline.passed + run.passed
  const from = Math.max(0, run.scored - (all - passed))
  const to = Math.min(run.scored, passed)
  const total = choose(all, run.scored)
  const odds: number[] = []
  for (let own = from; own <= to; own++)
    odds.push((choose(passed, own) * choose(all - passed, run.scored - own)) / total)
  return { from, odds }
}

function tails(spread: { from: number; odds: readonly number[] }, seen: number): Tails {
  let better = 0
  let worse = 0
  spread.odds.forEach((chance, at) => {
    if (spread.from + at <= seen) worse += chance
    if (spread.from + at >= seen) better += chance
  })
  return { better: Math.min(1, better), worse: Math.min(1, worse) }
}

export function task(baseline: Counts, run: Counts): Tails {
  return tails(passes(baseline, run), run.passed)
}

export function overall(tasks: readonly { baseline: Counts; run: Counts }[]): Tails {
  let from = 0
  let odds = [1]
  let seen = 0
  for (const each of tasks) {
    const own = passes(each.baseline, each.run)
    const next: number[] = Array.from({ length: odds.length + own.odds.length - 1 }, () => 0)
    odds.forEach((left, at) =>
      own.odds.forEach((right, other) => {
        next[at + other]! += left * right
      }),
    )
    odds = next
    from += own.from
    seen += each.run.passed
  }
  return tails({ from, odds }, seen)
}

export function floor(baseline: number, run: number): number {
  return baseline && run ? 1 / choose(baseline + run, run) : 1
}
