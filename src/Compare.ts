import * as Installed from './Installed.ts'
import * as Pins from './Pins.ts'
import * as Result from './Result.ts'
import * as Stats from './Stats.ts'

export type Run = {
  attempts: readonly Result.Attempt[]
  eval: { name: string; version: string }
  id: string
  name: string
  nanocode?: Pins.Pins
  state: 'finished' | 'running'
}

export type Arm = {
  agent: string
  agentSec: number
  attempts: number
  cachedTokens: number
  costUsd: number | null
  errored: number
  failed: number
  harness: string
  inputTokens: number
  key: string
  metered: number
  model: string
  outputTokens: number
  passed: number
  priced: number
  runs: string[]
  tasks: number
  totalSec: number
}

export type Score = { errored: number; passed: number; scored: number }

export type Moved =
  | 'down'
  | 'gained'
  | 'lost'
  | 'only-baseline'
  | 'only-run'
  | 'same'
  | 'unscored'
  | 'up'

export type TaskChange = {
  baseline: Score | undefined
  chance?: number
  moved: Moved
  name: string
  run: Score | undefined
}

export type Change = {
  agent: string
  baseline: Result.AgentSummary | undefined
  common: {
    baseline: Record<string, number>
    rated: Record<string, number>
    run: Record<string, number>
  }
  overall: {
    better: number
    down: number
    floor: number
    same: number
    tasks: number
    up: number
    verdict: 'improvement' | 'none' | 'regression'
    worse: number
  }
  run: Result.AgentSummary
  tasks: TaskChange[]
}

export type Side = Run | readonly Run[]

export function harness(agent: Result.Attempt['agent'], nanocode?: Pins.Pins): string {
  if (agent.provider === 'oracle') return 'oracle'
  if (Installed.is(agent.provider))
    return agent.provider + ' ' + Installed.releases[agent.provider].version
  return nanocode ? Pins.text(nanocode) : 'nanocode'
}

export function model(agent: Result.Attempt['agent']): string {
  if (agent.provider === 'oracle') return 'the task solution'
  const provider = Installed.is(agent.provider)
    ? Installed.releases[agent.provider].provider
    : agent.provider + (agent.orchestration ? '-' + agent.orchestration : '')
  return provider + ':' + agent.model + (agent.thinking ? ':' + agent.thinking : '')
}

function key(agent: Result.Attempt['agent'], nanocode?: Pins.Pins): string {
  return [
    agent.id,
    agent.provider,
    agent.model,
    agent.thinking ?? '',
    agent.orchestration ?? '',
    harness(agent, nanocode),
  ].join(' ')
}

function seconds(phase: Result.Phase | undefined): number {
  return phase ? (phase.finishedAt - phase.startedAt) / 1000 : 0
}

export function standing(given: readonly Run[]): Run[] {
  const runs = given.filter((run, at) => given.findIndex((other) => other.id === run.id) === at)
  const retried = new Set(
    runs.flatMap((run) =>
      run.attempts.flatMap((attempt) =>
        attempt.retryOf ? [attempt.retryOf.run + ' ' + attempt.retryOf.attempt] : [],
      ),
    ),
  )
  return runs.map((run) => ({
    ...run,
    attempts: run.attempts.filter((attempt) => !retried.has(run.id + ' ' + attempt.id)),
  }))
}

function row(attempt: Result.Attempt): string {
  return attempt.task.name + ' #' + attempt.index
}

export function arms(given: readonly Run[]): Arm[] {
  const runs = standing(given)
  const found: { arm: Arm; rows: Set<string>; tasks: Set<string> }[] = []
  for (const run of runs) {
    const own = new Map<string, Result.Attempt[]>()
    for (const attempt of run.attempts) {
      const id = key(attempt.agent, run.nanocode)
      own.set(id, [...(own.get(id) ?? []), attempt])
    }
    for (const [id, attempts] of own) {
      let entry = found.find(
        (each) => each.arm.key === id && !attempts.some((attempt) => each.rows.has(row(attempt))),
      )
      if (!entry) {
        const agent = attempts[0]!.agent
        entry = {
          arm: {
            agent: agent.id,
            agentSec: 0,
            attempts: 0,
            cachedTokens: 0,
            costUsd: null,
            errored: 0,
            failed: 0,
            harness: harness(agent, run.nanocode),
            inputTokens: 0,
            key: id,
            metered: 0,
            model: model(agent),
            outputTokens: 0,
            passed: 0,
            priced: 0,
            runs: [],
            tasks: 0,
            totalSec: 0,
          },
          rows: new Set(),
          tasks: new Set(),
        }
        found.push(entry)
      }
      const arm = entry.arm
      arm.runs.push(run.id)
      for (const attempt of attempts) {
        arm.attempts++
        arm[attempt.outcome]++
        arm.agentSec += seconds(attempt.timing.agentExecution)
        arm.totalSec += (attempt.finishedAt - attempt.startedAt) / 1000
        entry.rows.add(row(attempt))
        entry.tasks.add(attempt.task.name)
        if (attempt.usage) {
          arm.metered++
          arm.cachedTokens += attempt.usage.cachedTokens
          arm.inputTokens += attempt.usage.inputTokens
          arm.outputTokens += attempt.usage.outputTokens
          if (attempt.usage.costUsd !== undefined) {
            arm.priced++
            arm.costUsd = (arm.costUsd ?? 0) + attempt.usage.costUsd
          }
        }
      }
    }
  }
  for (const entry of found) entry.arm.tasks = entry.tasks.size
  return found.map((entry) => entry.arm)
}

function duration(value: number): string {
  const whole = Math.round(value)
  if (whole < 60) return whole + ' s'
  const minutes = Math.floor(whole / 60)
  return minutes < 60
    ? minutes + ' min ' + (whole % 60) + ' s'
    : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min'
}

function cells(rows: readonly (readonly string[])[]): string {
  const [head, ...body] = rows
  return [head!, head!.map(() => '---'), ...body]
    .map((row) => '| ' + row.join(' | ') + ' |')
    .join('\n')
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function cost(value: number | null): string {
  return value === null ? 'not known' : '$' + value.toFixed(4)
}

function line(run: Run, ended: number): string {
  return (
    'run ' +
    run.id +
    ' (' +
    run.name +
    '): ' +
    run.state +
    ', ' +
    run.eval.name +
    '@' +
    run.eval.version.slice(0, 12) +
    ', ' +
    ended +
    ' attempts ended' +
    (run.attempts.length === ended
      ? ''
      : ', ' +
        (ended - run.attempts.length) +
        ' of them retried by a run of this table and left out') +
    (run.nanocode ? ', ' + Pins.text(run.nanocode) : '')
  )
}

export function table(given: readonly Run[]): string {
  const runs = standing(given)
  const ended = new Map(given.map((run) => [run.id, run.attempts.length]))
  const all = arms(runs)
  const title = (arm: Arm) =>
    all.filter((other) => other.agent === arm.agent).length === 1
      ? arm.agent
      : arm.agent + ' of ' + arm.runs.map((id) => id.slice(0, 8)).join(' and ')
  const summary = cells([
    [
      'Arm',
      'Harness',
      'Model',
      'Attempts',
      'Passed',
      'Failed',
      'Errored',
      'Agent time',
      'Attempt time',
      'Input tokens (cached)',
      'Output tokens',
      'Estimated cost',
    ],
    ...all.map((arm) => [
      title(arm),
      arm.harness,
      arm.model,
      String(arm.attempts),
      String(arm.passed),
      String(arm.failed),
      String(arm.errored),
      duration(arm.agentSec),
      duration(arm.totalSec),
      arm.metered
        ? number(arm.inputTokens) + ' (' + number(arm.cachedTokens) + ')'
        : 'not recorded',
      arm.metered ? number(arm.outputTokens) : 'not recorded',
      cost(arm.costUsd) +
        (arm.costUsd === null || arm.priced === arm.attempts
          ? ''
          : ' for ' + arm.priced + ' of ' + arm.attempts),
    ]),
  ])

  const names = [
    ...new Set(runs.flatMap((run) => run.attempts.map((attempt) => attempt.task.name))),
  ].sort()
  const outcome = (task: string, arm: Arm) => {
    const own = runs
      .flatMap((run) =>
        run.attempts.filter(
          (attempt) =>
            attempt.task.name === task &&
            arm.runs.includes(run.id) &&
            key(attempt.agent, run.nanocode) === arm.key,
        ),
      )
      .sort((left, right) => left.index - right.index)
    return own.length
      ? own
          .map(
            (attempt) =>
              attempt.outcome +
              (attempt.failure ? ' (' + attempt.failure.kind + ')' : '') +
              ' ' +
              duration(seconds(attempt.timing.agentExecution)),
          )
          .join(', ')
      : 'not run'
  }
  const tasks = cells([
    ['Task', ...all.map(title)],
    ...names.map((task) => [task.split('/').at(-1)!, ...all.map((arm) => outcome(task, arm))]),
  ])

  return (
    [...runs.map((run) => line(run, ended.get(run.id)!)), '', summary, '', tasks].join('\n') + '\n'
  )
}

export function lineages(given: readonly Run[]): Run[][] {
  const runs = given.filter((run, at) => given.findIndex((other) => other.id === run.id) === at)
  const sides: Run[][] = []
  for (const run of runs) {
    const parents = new Set(run.attempts.flatMap((attempt) => attempt.retryOf?.run ?? []))
    const children = new Set(
      runs.flatMap((other) =>
        other.attempts.some((attempt) => attempt.retryOf?.run === run.id) ? [other.id] : [],
      ),
    )
    const joined = sides.filter((side) =>
      side.some((other) => parents.has(other.id) || children.has(other.id)),
    )
    const side = [...joined.flat(), run]
    for (const each of joined) sides.splice(sides.indexOf(each), 1)
    sides.push(side)
  }
  return sides.sort((left, right) => runs.indexOf(left[0]!) - runs.indexOf(right[0]!))
}

function side(given: Side): Run[] {
  return standing(Array.isArray(given) ? (given as readonly Run[]) : [given as Run])
}

function scores(runs: readonly Run[], agent: string): Map<string, Score> {
  const tasks = new Map<string, Score>()
  for (const attempt of runs.flatMap((run) => run.attempts)) {
    if (attempt.agent.id !== agent) continue
    const task = tasks.get(attempt.task.name) ?? { errored: 0, passed: 0, scored: 0 }
    if (attempt.outcome === 'errored') task.errored++
    else task.scored++
    if (attempt.outcome === 'passed') task.passed++
    tasks.set(attempt.task.name, task)
  }
  return tasks
}

export function changes(baseline: Side, run: Side): Change[] {
  const left = side(baseline)
  const right = side(run)
  const before = Result.summarize(left.flatMap((each) => each.attempts))
  const after = Result.summarize(right.flatMap((each) => each.attempts))
  return Object.entries(after).map(([agent, summary]) => {
    const old = scores(left, agent)
    const now = scores(right, agent)
    const tasks: TaskChange[] = []
    const both: { baseline: Score; run: Score }[] = []
    for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const was = old.get(name)
      const is = now.get(name)
      const change: TaskChange = {
        baseline: was,
        moved: 'same',
        name: name.split('/').at(-1)!,
        run: is,
      }
      if (!was) change.moved = 'only-run'
      else if (!is) change.moved = 'only-baseline'
      else if (!was.scored || !is.scored) change.moved = 'unscored'
      else {
        both.push({ baseline: was, run: is })
        const tails = Stats.task(was, is)
        const moved = is.passed * was.scored - was.passed * is.scored
        if (moved < 0) {
          change.chance = tails.worse
          change.moved = tails.worse <= Stats.alpha ? 'lost' : 'down'
        } else if (moved > 0) {
          change.chance = tails.better
          change.moved = tails.better <= Stats.alpha ? 'gained' : 'up'
        }
      }
      tasks.push(change)
    }
    const common: Change['common'] = { baseline: {}, rated: {}, run: {} }
    for (let k = 1; ; k++) {
      const rated = both.filter((each) => each.baseline.scored >= k && each.run.scored >= k)
      if (!rated.length) break
      const mean = (name: 'baseline' | 'run') =>
        rated.reduce((total, each) => total + Result.passAt(each[name], k), 0) / rated.length
      common.baseline[String(k)] = mean('baseline')
      common.rated[String(k)] = rated.length
      common.run[String(k)] = mean('run')
    }
    const earlier = before[agent]
    const tails = Stats.overall(both)
    const count = (...moved: Moved[]) => tasks.filter((task) => moved.includes(task.moved)).length
    return {
      agent,
      baseline: earlier,
      common,
      overall: {
        better: tails.better,
        down: count('down', 'lost'),
        floor: Stats.floor(
          Math.max(0, ...both.map((each) => each.baseline.scored)),
          Math.max(0, ...both.map((each) => each.run.scored)),
        ),
        same: count('same'),
        tasks: both.length,
        up: count('up', 'gained'),
        verdict:
          tails.worse <= Stats.alpha
            ? 'regression'
            : tails.better <= Stats.alpha
              ? 'improvement'
              : 'none',
        worse: tails.worse,
      },
      run: summary,
      tasks,
    }
  })
}

function count(score: Score): string {
  return score.scored
    ? score.passed + '/' + score.scored + (score.errored ? ' +' + score.errored + ' errored' : '')
    : score.errored + ' errored'
}

function chance(value: number): string {
  return value < 0.001 ? 'p < 0.001' : 'p = ' + value.toFixed(3)
}

function named(runs: readonly Run[]): string {
  return runs.length === 1
    ? runs[0]!.id
    : runs[0]!.id +
        ' with ' +
        runs
          .slice(1)
          .map((run) => run.id.slice(0, 8))
          .join(', ')
}

function pins(runs: readonly Run[]): string {
  return (
    [...new Set(runs.map((run) => (run.nanocode ? Pins.text(run.nanocode) : 'not recorded')))].join(
      ' and ',
    ) || 'not recorded'
  )
}

export function regressed(changes: readonly Change[], level: 'lost' | 'regression'): boolean {
  return changes.some(
    (change) =>
      change.overall.verdict === 'regression' ||
      (level === 'lost' && change.tasks.some((task) => task.moved === 'lost')),
  )
}

export function against(baseline: Side, run: Side): string {
  const left = side(baseline)
  const right = side(run)
  const tokens = (summary: Result.AgentSummary | undefined) =>
    summary ? number(summary.inputTokens) + ' (' + number(summary.cachedTokens) + ')' : 'not run'
  const percent = (value: number) => (value * 100).toFixed(1) + '%'
  const some = (value: number) => value + (value === 1 ? ' task' : ' tasks')
  const rate = (summary: Result.AgentSummary | undefined, k: string) => {
    const value = summary?.passAtK[k]
    if (summary === undefined) return 'not run'
    if (value === undefined) return 'not rated'
    const rated = summary.rated[k]
    return (
      percent(value) + (rated === undefined || rated === summary.tasks ? '' : ' of ' + some(rated))
    )
  }
  return (
    changes(left, right)
      .map((change) => {
        const before = change.baseline
        const after = change.run
        const row = (name: 'attempts' | 'errored' | 'failed' | 'passed' | 'tasks') => [
          name[0]!.toUpperCase() + name.slice(1),
          before ? String(before[name]) : 'not run',
          String(after[name]),
        ]
        const ks = [
          ...new Set([...Object.keys(before?.passAtK ?? {}), ...Object.keys(after.passAtK)]),
        ].sort((one, other) => Number(one) - Number(other))
        const listed = (...moved: Moved[]) =>
          change.tasks
            .filter((task) => moved.includes(task.moved))
            .map(
              (task) =>
                task.name +
                ' (' +
                (task.baseline ? count(task.baseline) : 'not run') +
                ' to ' +
                (task.run ? count(task.run) : 'not run') +
                (task.chance === undefined ? '' : ', ' + chance(task.chance)) +
                ')',
            )
            .join(', ') || 'none'
        const names = (moved: Moved) =>
          change.tasks.filter((task) => task.moved === moved).map((task) => task.name)
        const scored = change.tasks.filter((task) => task.baseline?.scored && task.run?.scored)
        const overall = change.overall
        return [
          change.agent + ': run ' + named(right) + ' against the baseline ' + named(left),
          '',
          cells([
            ['', 'Baseline', 'Run'],
            ['nanocode', pins(left), pins(right)],
            row('tasks'),
            row('attempts'),
            row('passed'),
            row('failed'),
            row('errored'),
            ...ks.map((k) => ['pass@' + k, rate(before, k), rate(after, k)]),
            ...Object.keys(change.common.rated)
              .filter(
                (k) =>
                  before !== undefined &&
                  (before.rated[k] !== change.common.rated[k] ||
                    after.rated[k] !== change.common.rated[k]),
              )
              .map((k) => [
                'pass@' + k + ' on the ' + some(change.common.rated[k]!) + ' both sides rate',
                percent(change.common.baseline[k]!),
                percent(change.common.run[k]!),
              ]),
            ['Input tokens (cached)', tokens(before), tokens(after)],
            [
              'Output tokens',
              before ? number(before.outputTokens) : 'not run',
              number(after.outputTokens),
            ],
            ['Cost', before ? cost(before.costUsd) : 'not run', cost(after.costUsd)],
          ]),
          '',
          ...(before
            ? [
                'lost: ' + listed('lost'),
                'gained: ' + listed('gained'),
                'moved, within noise: ' + listed('down', 'up'),
                ...(names('unscored').length
                  ? ['no verdict on a side, so not compared: ' + listed('unscored')]
                  : []),
                'same on both sides: ' +
                  some(overall.same) +
                  '; solved on both sides: ' +
                  scored.filter((task) => task.baseline!.passed && task.run!.passed).length +
                  ', on neither: ' +
                  scored.filter((task) => !task.baseline!.passed && !task.run!.passed).length,
                ...(names('only-run').length
                  ? ['not in the baseline: ' + names('only-run').join(', ')]
                  : []),
                ...(names('only-baseline').length
                  ? ['only in the baseline: ' + names('only-baseline').join(', ')]
                  : []),
                'verdict: ' +
                  (overall.verdict === 'none' ? 'no change beyond noise' : overall.verdict) +
                  ': of the ' +
                  some(overall.tasks) +
                  ' scored on both sides ' +
                  overall.down +
                  ' moved down and ' +
                  overall.up +
                  ' up (' +
                  chance(overall.worse) +
                  ' for worse, ' +
                  chance(overall.better) +
                  ' for better)',
                'rule: lost, gained, regression and improvement are called when pass counts this far apart have a chance of ' +
                  Stats.alpha +
                  ' or less under no change (exact one-sided test, the verdict over all tasks together), so each is wrong for an unchanged agent at most 1 time in 20',
                ...(overall.tasks && overall.floor > Stats.alpha
                  ? [
                      'with these attempts no single task can be called, its chance cannot fall under ' +
                        overall.floor.toFixed(3) +
                        ': one task that flips is not evidence',
                    ]
                  : []),
              ]
            : ['the baseline has no agent ' + change.agent]),
        ].join('\n')
      })
      .join('\n\n') + '\n'
  )
}
