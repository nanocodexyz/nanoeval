import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Stats from './Stats.ts'
import type * as Suite from './Suite.ts'
import * as Target from './Target.ts'

export type Sample = {
  build: string
  cellMs: number | null
  cells: number
  concurrency: number
  error?: string
  failures: string[]
  firstByteMs: number | null
  metrics: Record<string, number>
  ok: boolean
  outputTokens: number | null
  pass: boolean
  phase: string
  rep: number
  scenario: string
  session: number
  stalled: boolean
  target: string
  text: string
  timedOut: boolean
  tokS: number | null
  ttftMs: number | null
  turn: number
  turnMs: number
}

export type Batch = {
  aggTokS: number | null
  build: string
  concurrency: number
  endMs: number
  outputTokens: number
  phase: string
  rep: number
  scenario: string
  startMs: number
  target: string
  turns: number
  turnsPerMin: number | null
}

export type Group = {
  build: string
  concurrency: number
  metrics: Record<string, Stats.Summary>
  phase: string
  scenario: string
  target: string
}

export type Check = {
  actual: number | null
  build: string
  concurrency: number
  metric: string
  passed: boolean
  scenario: string
  slo: Suite.Slo
  target: string
}

export type Verdict = {
  build: string
  checks: Check[]
  passed: boolean
  scenario: string
  target: string
}

export type Run = {
  batches: Batch[]
  builds: { build: Target.Build; description: Target.Description | { error: string } }[]
  command: string
  finished: string
  groups: Group[]
  id: string
  samples: Sample[]
  started: string
  suite: { digest: string; name: string; version: string }
  targets: string[]
  verdicts: Verdict[]
}

export type Options = {
  builds: readonly Target.Build[]
  command?: string
  log?: (line: string) => void
  out?: string
  suite: Suite.Suite
  targets: readonly Target.Target[]
}

export function stamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

function phaseOf(scenario: Suite.Scenario, turn: number): string {
  if (scenario.kind === 'coldwarm') return turn === 0 ? 'cold' : 'warm'
  return scenario.kind === 'sustained' ? 'sustained' : 'turn'
}

export function judge(expect: Suite.Expect | undefined, found: Target.TurnSample): string[] {
  const failures: string[] = []
  const wanted = expect ?? {}
  if (wanted.timedOut !== undefined && !!found.timedOut !== wanted.timedOut)
    failures.push(wanted.timedOut ? 'expected a timeout' : 'timed out')
  if (wanted.stalled !== undefined && !!found.stalled !== wanted.stalled)
    failures.push(wanted.stalled ? 'expected a stall' : 'stalled')
  const ok = wanted.ok ?? (wanted.timedOut || wanted.stalled ? undefined : true)
  if (ok !== undefined && found.ok !== ok)
    failures.push(
      ok
        ? 'failed: ' + (found.error ?? (found.timedOut ? 'timed out' : 'not ok'))
        : 'expected a failure',
    )
  if (wanted.text !== undefined && ok !== false && !new RegExp(wanted.text, 'i').test(found.text))
    failures.push(
      'reply does not match /' + wanted.text + '/: ' + JSON.stringify(found.text.slice(0, 120)),
    )
  if (wanted.cells !== undefined && found.cells.length < wanted.cells)
    failures.push('ran ' + found.cells.length + ' cells, expected at least ' + wanted.cells)
  return failures
}

export type Where = Pick<
  Sample,
  'build' | 'concurrency' | 'phase' | 'rep' | 'scenario' | 'session' | 'target' | 'turn'
>

export function measure(
  where: Where,
  expect: Suite.Expect | undefined,
  found: Target.TurnSample,
): Sample {
  const failures = judge(expect, found)
  return {
    ...where,
    ...figures(found),
    ...(found.error ? { error: found.error } : {}),
    failures,
    ok: found.ok,
    pass: !failures.length,
    stalled: !!found.stalled,
    text: found.text,
    timedOut: !!found.timedOut,
  }
}

function figures(found: Target.TurnSample) {
  const { tokS, ...metrics } = found.metrics ?? {}
  const since = (at: number | undefined) =>
    at === undefined ? null : Math.max(0, at - found.sendMs)
  const streaming = found.firstTokenMs !== undefined ? found.doneMs - found.firstTokenMs : 0
  return {
    cellMs: found.cells.length
      ? found.cells.reduce((sum, cell) => sum + (cell.endMs - cell.startMs), 0)
      : null,
    cells: found.cells.length,
    firstByteMs: since(found.firstByteMs),
    metrics,
    outputTokens: found.outputTokens ?? null,
    tokS:
      tokS ??
      (found.ok && found.outputTokens && streaming > 0
        ? found.outputTokens / (streaming / 1000)
        : null),
    ttftMs: since(found.firstTokenMs),
    turnMs: Math.max(0, found.doneMs - found.sendMs),
  }
}

async function guarded(
  session: Target.Session,
  prompt: string,
  scenario: Suite.Scenario,
): Promise<Target.TurnSample> {
  const sendMs = Target.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<Target.TurnSample>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          cells: [],
          doneMs: Target.now(),
          error: 'no answer within the deadline plus the stall window (runner guard)',
          ok: false,
          sendMs,
          text: '',
          timedOut: true,
        }),
      scenario.deadlineMs + scenario.stallMs,
    )
  })
  try {
    return await Promise.race([
      session.turn(prompt).catch(
        (error: unknown): Target.TurnSample => ({
          cells: [],
          doneMs: Target.now(),
          error: error instanceof Error ? error.message : String(error),
          ok: false,
          sendMs,
          text: '',
        }),
      ),
      guard,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function run(options: Options): Promise<{ dir: string; run: Run }> {
  const started = new Date()
  const id = stamp(started)
  const dir = Path.resolve(options.out ?? Path.join('output', 'systems', id))
  await Fs.mkdir(Path.join(dir, 'samples'), { recursive: true })
  const log = options.log ?? (() => {})
  const labels = new Set<string>()
  for (const build of options.builds) {
    if (labels.has(build.label))
      throw new Target.InvalidError('build ' + build.label + ' is named twice')
    labels.add(build.label)
  }
  const builds: Run['builds'] = []
  for (const build of options.builds)
    for (const target of options.targets)
      builds.push({
        build: { ...build, label: build.label },
        description: await target.describe(build).catch((error: unknown) => ({
          error: target.name + ': ' + (error instanceof Error ? error.message : String(error)),
        })),
      })
  const samples: Sample[] = []
  const batches: Batch[] = []
  const write = async (sample: Sample) => {
    samples.push(sample)
    const at = Path.join(
      dir,
      'samples',
      sample.target,
      sample.build,
      sample.scenario,
      'c' + sample.concurrency,
    )
    await Fs.mkdir(at, { recursive: true })
    await Fs.writeFile(
      Path.join(at, 'r' + sample.rep + '-s' + sample.session + '-t' + sample.turn + '.json'),
      JSON.stringify(sample, null, 2) + '\n',
    )
  }
  for (const scenario of options.suite.scenarios)
    for (const concurrency of scenario.concurrency)
      for (let rep = 0; rep < scenario.reps; rep++) {
        const order = rep % 2 ? options.builds.toReversed() : options.builds
        for (const target of options.targets)
          for (const build of order) {
            const context: Target.Context = {
              ...(scenario.kind === 'coldwarm' ? { cold: true } : {}),
              deadlineMs: scenario.deadlineMs,
              ...(scenario.model ? { model: scenario.model } : {}),
              stallMs: scenario.stallMs,
              ...(scenario.thinking ? { thinking: scenario.thinking } : {}),
            }
            const startMs = Target.now()
            const until = scenario.kind === 'sustained' ? startMs + scenario.durationS! * 1000 : 0
            let made = 0
            const before = samples.length
            const worker = async (slot: number) => {
              do {
                const session = made++
                const opened = await target
                  .open(build, context)
                  .catch((error: unknown) => error as Error)
                for (let turn = 0; turn < scenario.turns.length; turn++) {
                  const spec = scenario.turns[turn]!
                  const where = {
                    build: build.label,
                    concurrency,
                    phase: phaseOf(scenario, turn),
                    rep,
                    scenario: scenario.id,
                    session,
                    target: target.name,
                    turn,
                  }
                  const found: Target.TurnSample =
                    opened instanceof Error
                      ? {
                          cells: [],
                          doneMs: Target.now(),
                          error: 'open: ' + opened.message,
                          ok: false,
                          sendMs: Target.now(),
                          text: '',
                        }
                      : await guarded(opened, spec.prompt, scenario)
                  const sample = measure(where, spec.expect, found)
                  await write(sample)
                  log(
                    [
                      target.name,
                      build.label,
                      scenario.id,
                      'c' + concurrency,
                      'r' + rep,
                      's' + session,
                      't' + turn,
                    ].join(' ') +
                      (sample.pass ? ' pass' : ' FAIL ' + sample.failures.join('; ')) +
                      ' turn ' +
                      Math.round(sample.turnMs) +
                      'ms' +
                      (sample.ttftMs === null ? '' : ' ttft ' + Math.round(sample.ttftMs) + 'ms'),
                  )
                }
                if (!(opened instanceof Error)) await opened.close().catch(() => {})
                void slot
              } while (Target.now() < until)
            }
            await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)))
            const endMs = Target.now()
            const mine = samples.slice(before)
            const outputTokens = mine.reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0)
            const span = (endMs - startMs) / 1000
            batches.push({
              aggTokS: outputTokens && span > 0 ? outputTokens / span : null,
              build: build.label,
              concurrency,
              endMs,
              outputTokens,
              phase: scenario.kind === 'sustained' ? 'sustained' : 'batch',
              rep,
              scenario: scenario.id,
              startMs,
              target: target.name,
              turns: mine.length,
              turnsPerMin:
                span > 0 ? (mine.filter((sample) => sample.ok).length / span) * 60 : null,
            })
          }
      }
  const groups = group(samples, batches)
  const verdicts = judgeAll(
    options.suite,
    groups,
    options.targets.map((target) => target.name),
    options.builds,
  )
  const result: Run = {
    batches,
    builds,
    command: options.command ?? '',
    finished: new Date().toISOString(),
    groups,
    id,
    samples,
    started: started.toISOString(),
    suite: {
      digest: options.suite.digest,
      name: options.suite.name,
      version: options.suite.version,
    },
    targets: options.targets.map((target) => target.name),
    verdicts,
  }
  await Fs.writeFile(Path.join(dir, 'run.json'), JSON.stringify(result, null, 2) + '\n')
  const { summary } = await import('./Report.ts')
  await Fs.writeFile(Path.join(dir, 'summary.md'), summary(result, options.suite))
  return { dir, run: result }
}

export const core = [
  'ttftMs',
  'firstByteMs',
  'turnMs',
  'tokS',
  'cells',
  'cellMs',
  'outputTokens',
] as const

export function values(sample: Sample): Record<string, number> {
  const found: Record<string, number> = {
    pass: sample.pass ? 1 : 0,
    stalled: sample.stalled ? 1 : 0,
    timedOut: sample.timedOut ? 1 : 0,
  }
  for (const name of core) {
    const value = sample[name]
    if (typeof value === 'number' && Number.isFinite(value)) found[name] = value
  }
  for (const [name, value] of Object.entries(sample.metrics))
    if (Number.isFinite(value)) found[name] = value
  return found
}

export function group(samples: readonly Sample[], batches: readonly Batch[]): Group[] {
  const groups = new Map<
    string,
    { group: Omit<Group, 'metrics'>; values: Record<string, number[]> }
  >()
  const add = (head: Omit<Group, 'metrics'>, found: Record<string, number>) => {
    const key = [head.target, head.build, head.scenario, head.concurrency, head.phase].join('|')
    const entry = groups.get(key) ?? { group: head, values: {} }
    groups.set(key, entry)
    for (const [name, value] of Object.entries(found)) (entry.values[name] ??= []).push(value)
  }
  for (const sample of samples)
    add(
      {
        build: sample.build,
        concurrency: sample.concurrency,
        phase: sample.phase,
        scenario: sample.scenario,
        target: sample.target,
      },
      values(sample),
    )
  for (const batch of batches) {
    const found: Record<string, number> = {}
    if (batch.aggTokS !== null) found['aggTokS'] = batch.aggTokS
    if (batch.turnsPerMin !== null) found['turnsPerMin'] = batch.turnsPerMin
    add(
      {
        build: batch.build,
        concurrency: batch.concurrency,
        phase: batch.phase,
        scenario: batch.scenario,
        target: batch.target,
      },
      found,
    )
  }
  return [...groups.values()].map(({ group, values }) => ({
    ...group,
    metrics: Object.fromEntries(
      Object.entries(values).map(([name, list]) => [name, Stats.summarize(list)]),
    ),
  }))
}

export function judgeAll(
  suite: Suite.Suite,
  groups: readonly Group[],
  targets: readonly string[],
  builds: readonly Target.Build[],
): Verdict[] {
  const verdicts: Verdict[] = []
  for (const target of targets)
    for (const build of builds)
      for (const scenario of suite.scenarios) {
        const checks: Check[] = []
        for (const concurrency of scenario.concurrency)
          for (const slo of scenario.slo) {
            const dot = slo.metric.indexOf('.')
            const phase = dot < 0 ? undefined : slo.metric.slice(0, dot)
            const metric = dot < 0 ? slo.metric : slo.metric.slice(dot + 1)
            const mine = groups.filter(
              (entry) =>
                entry.target === target &&
                entry.build === build.label &&
                entry.scenario === scenario.id &&
                entry.concurrency === concurrency &&
                (phase === undefined
                  ? entry.phase !== 'batch' || metric === 'aggTokS' || metric === 'turnsPerMin'
                  : entry.phase === phase),
            )
            const found = mine
              .map((entry) => entry.metrics[metric])
              .find((summary) => summary && summary.n)
            const actual = found ? found[slo.stat] : null
            const passed =
              actual !== null &&
              (slo.max === undefined || actual <= slo.max) &&
              (slo.min === undefined || actual >= slo.min)
            checks.push({
              actual,
              build: build.label,
              concurrency,
              metric: slo.metric,
              passed,
              scenario: scenario.id,
              slo,
              target,
            })
          }
        verdicts.push({
          build: build.label,
          checks,
          passed: checks.every((check) => check.passed),
          scenario: scenario.id,
          target,
        })
      }
  return verdicts
}
