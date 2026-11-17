import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Report from './Report.ts'
import * as Runner from './Runner.ts'
import * as Stats from './Stats.ts'

export class InvalidError extends Error {
  override name = 'Compare.InvalidError'
}

export type Row = {
  base: number | null
  clustered: 'prompt' | 'rep'
  concurrency: number
  head: number | null
  high: number | null
  low: number | null
  metric: string
  n: { base: number; head: number }
  phase: string
  ratio: number | null
  scenario: string
  target: string
  verdict: Stats.Verdict
}

export type Result = {
  base: string
  draws: number
  head: string
  level: number
  rows: Row[]
  runs: string[]
  seed: number
}

export const metrics = [
  'ttftMs',
  'firstByteMs',
  'turnMs',
  'tokS',
  'cellMs',
  'startupMs',
  'rssPeakKb',
  'rssSteadyKb',
  'pass',
  'aggTokS',
  'turnsPerMin',
] as const

export async function read(dir: string): Promise<Runner.Run> {
  const file = dir.endsWith('.json') ? dir : Path.join(dir, 'run.json')
  return JSON.parse(await Fs.readFile(file, 'utf8')) as Runner.Run
}

type Point = { cluster: string; rep: string; value: number }

function points(
  run: Runner.Run,
  build: string,
  target: string,
  scenario: string,
  concurrency: number,
  phase: string,
  metric: string,
): Point[] {
  if (metric === 'aggTokS' || metric === 'turnsPerMin')
    return run.batches
      .filter(
        (batch) =>
          batch.build === build &&
          batch.target === target &&
          batch.scenario === scenario &&
          batch.concurrency === concurrency &&
          (phase === 'batch' ? batch.phase === 'batch' : batch.phase === phase),
      )
      .flatMap((batch) => {
        const value = batch[metric]
        return value === null ? [] : [{ cluster: 'r' + batch.rep, rep: 'r' + batch.rep, value }]
      })
  return run.samples
    .filter(
      (sample) =>
        sample.build === build &&
        sample.target === target &&
        sample.scenario === scenario &&
        sample.concurrency === concurrency &&
        sample.phase === phase,
    )
    .flatMap((sample) => {
      const value = Runner.values(sample)[metric]
      return value === undefined
        ? []
        : [{ cluster: 't' + sample.turn, rep: 'r' + sample.rep, value }]
    })
}

export function compare(
  base: { build: string; run: Runner.Run },
  head: { build: string; run: Runner.Run },
  options: { draws: number; seed: number } = Stats.defaults,
): Result {
  const rows: Row[] = []
  const keys = new Map<
    string,
    { concurrency: number; phase: string; scenario: string; target: string }
  >()
  for (const group of base.run.groups)
    if (group.build === base.build)
      keys.set([group.target, group.scenario, group.concurrency, group.phase].join('|'), group)
  for (const key of keys.values()) {
    const twin = head.run.groups.find(
      (group) =>
        group.build === head.build &&
        group.target === key.target &&
        group.scenario === key.scenario &&
        group.concurrency === key.concurrency &&
        group.phase === key.phase,
    )
    if (!twin) continue
    for (const metric of metrics) {
      const left = points(
        base.run,
        base.build,
        key.target,
        key.scenario,
        key.concurrency,
        key.phase,
        metric,
      )
      const right = points(
        head.run,
        head.build,
        key.target,
        key.scenario,
        key.concurrency,
        key.phase,
        metric,
      )
      if (!left.length || !right.length) continue
      const prompts = new Set([...left, ...right].map((point) => point.cluster))
      const clustered = prompts.size >= 3 ? 'prompt' : 'rep'
      const by = (list: Point[]) => {
        const map = new Map<string, number[]>()
        for (const point of list) {
          const cluster = clustered === 'prompt' ? point.cluster : point.rep
          map.set(cluster, [...(map.get(cluster) ?? []), point.value])
        }
        return map
      }
      const leftBy = by(left)
      const rightBy = by(right)
      let shared = [...leftBy.keys()].filter((cluster) => rightBy.has(cluster)).sort()
      let baseArms = shared.map((cluster) => leftBy.get(cluster)!)
      let headArms = shared.map((cluster) => rightBy.get(cluster)!)
      if (!shared.length) {
        shared = ['all']
        baseArms = [left.map((point) => point.value)]
        headArms = [right.map((point) => point.value)]
      }
      const found = Stats.ratio(baseArms, headArms, options)
      rows.push({
        base: Stats.mean(left.map((point) => point.value)),
        clustered,
        concurrency: key.concurrency,
        head: Stats.mean(right.map((point) => point.value)),
        high: found.high,
        low: found.low,
        metric,
        n: { base: left.length, head: right.length },
        phase: key.phase,
        ratio: found.value,
        scenario: key.scenario,
        target: key.target,
        verdict: left.length < 2 || right.length < 2 ? 'NA' : Stats.verdict(metric, found),
      })
    }
  }
  return {
    base: base.build,
    draws: options.draws,
    head: head.build,
    level: 0.95,
    rows,
    runs: [...new Set([base.run.id, head.run.id])],
    seed: options.seed,
  }
}

export function arms(runs: readonly Runner.Run[], wanted: { base?: string; head?: string }) {
  const labels = runs.map((run) => [...new Set(run.samples.map((sample) => sample.build))])
  const all = [...new Set(labels.flat())]
  const owner = (label: string) => {
    const at = labels.findIndex((list) => list.includes(label))
    if (at < 0)
      throw new InvalidError('no run holds build ' + label + ' (builds: ' + all.join(', ') + ')')
    return runs[at]!
  }
  let base = wanted.base
  let head = wanted.head
  if (runs.length === 2 && labels[0]!.length === 1 && labels[1]!.length === 1) {
    base ??= labels[0]![0]!
    head ??= labels[1]![0]!
    return { base: { build: base, run: runs[0]! }, head: { build: head, run: runs[1]! } }
  }
  if (!base || !head) {
    const rest = all.filter((label) => label !== base && label !== head)
    base ??= rest.shift()
    head ??= rest.shift()
  }
  if (!base || !head || base === head)
    throw new InvalidError(
      'compare needs two builds (found ' + all.join(', ') + '): give --base and --head',
    )
  return { base: { build: base, run: owner(base) }, head: { build: head, run: owner(head) } }
}

const names: Record<string, string> = {
  aggTokS: 'aggregate tok/s',
  cellMs: 'cell time (ms)',
  firstByteMs: 'first byte (ms)',
  pass: 'pass rate',
  rssPeakKb: 'peak RSS (KB)',
  rssSteadyKb: 'steady RSS (KB)',
  startupMs: 'startup (ms)',
  tokS: 'tok/s',
  ttftMs: 'TTFT (ms)',
  turnMs: 'turn time (ms)',
  turnsPerMin: 'turns/min',
}

export function markdown(result: Result): string {
  const counts = { LOSS: 0, NA: 0, TIE: 0, WIN: 0 }
  for (const row of result.rows) counts[row.verdict]++
  return [
    '# Systems compare: ' + result.head + ' vs ' + result.base,
    '',
    'Ratio = mean(' +
      result.head +
      ') / mean(' +
      result.base +
      '). 95 % percentile interval of ' +
      result.draws +
      ' draws of a clustered bootstrap with seed ' +
      result.seed +
      ': a draw resamples the clusters (prompts when a group has 3 or more, else repetitions) with replacement, the same clusters for both builds, then the samples within each cluster for each build. WIN: the interval is wholly on the better side of 1 for ' +
      result.head +
      ' (below 1 for times and memory, above 1 for tok/s, pass rate and throughput), LOSS: wholly on the worse side, TIE: it holds 1, NA: a build has fewer than 2 samples. Runs: ' +
      result.runs.join(', ') +
      '.',
    '',
    'WIN ' +
      counts.WIN +
      ' · TIE ' +
      counts.TIE +
      ' · LOSS ' +
      counts.LOSS +
      (counts.NA ? ' · NA ' + counts.NA : ''),
    '',
    Report.table(
      ['scenario', 'c', 'phase', 'metric', result.base, result.head, 'ratio [95% CI]', 'verdict'],
      result.rows.map((row) => [
        row.scenario + (row.target === 'cli-local' ? '' : ' (' + row.target + ')'),
        String(row.concurrency),
        row.phase,
        names[row.metric] ?? row.metric,
        Report.number(row.base),
        Report.number(row.head),
        Report.number(row.ratio) +
          ' [' +
          Report.number(row.low) +
          ', ' +
          Report.number(row.high) +
          ']',
        '**' + row.verdict + '**',
      ]),
    ),
    '',
  ].join('\n')
}
