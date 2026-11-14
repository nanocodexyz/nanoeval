import * as Installed from './Installed.ts'
import * as Pins from './Pins.ts'
import * as Result from './Result.ts'

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

export type Change = {
  agent: string
  baseline: Result.AgentSummary | undefined
  gained: string[]
  lost: string[]
  neither: string[]
  onlyBaseline: string[]
  onlyRun: string[]
  run: Result.AgentSummary
  solved: string[]
  tasks: Record<string, { baseline: string; run: string }>
}

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

export function arms(given: readonly Run[]): Arm[] {
  const runs = standing(given)
  const found = new Map<string, Arm>()
  const tasks = new Map<string, Set<string>>()
  for (const run of runs)
    for (const attempt of run.attempts) {
      const id = key(attempt.agent, run.nanocode)
      let arm = found.get(id)
      if (!arm) {
        arm = {
          agent: attempt.agent.id,
          agentSec: 0,
          attempts: 0,
          cachedTokens: 0,
          costUsd: null,
          errored: 0,
          failed: 0,
          harness: harness(attempt.agent, run.nanocode),
          inputTokens: 0,
          key: id,
          metered: 0,
          model: model(attempt.agent),
          outputTokens: 0,
          passed: 0,
          priced: 0,
          runs: [],
          tasks: 0,
          totalSec: 0,
        }
        found.set(id, arm)
        tasks.set(id, new Set())
      }
      arm.attempts++
      arm[attempt.outcome]++
      arm.agentSec += seconds(attempt.timing.agentExecution)
      arm.totalSec += (attempt.finishedAt - attempt.startedAt) / 1000
      if (!arm.runs.includes(run.id)) arm.runs.push(run.id)
      tasks.get(id)!.add(attempt.task.name)
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
  for (const arm of found.values()) arm.tasks = tasks.get(arm.key)!.size
  return [...found.values()]
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
          (attempt) => attempt.task.name === task && key(attempt.agent, run.nanocode) === arm.key,
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

export function changes(baseline: Run, run: Run): Change[] {
  const before = Result.summarize(baseline.attempts)
  const after = Result.summarize(run.attempts)
  const score = (attempts: readonly Result.Attempt[], agent: string) => {
    const tasks = new Map<string, { attempts: number; passed: number }>()
    for (const attempt of attempts) {
      if (attempt.agent.id !== agent) continue
      const task = tasks.get(attempt.task.name) ?? { attempts: 0, passed: 0 }
      task.attempts++
      if (attempt.outcome === 'passed') task.passed++
      tasks.set(attempt.task.name, task)
    }
    return tasks
  }
  return Object.entries(after).map(([agent, summary]) => {
    const old = score(baseline.attempts, agent)
    const now = score(run.attempts, agent)
    const change: Change = {
      agent,
      baseline: before[agent],
      gained: [],
      lost: [],
      neither: [],
      onlyBaseline: [],
      onlyRun: [],
      run: summary,
      solved: [],
      tasks: {},
    }
    for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const left = old.get(name)
      const right = now.get(name)
      const short = name.split('/').at(-1)!
      change.tasks[short] = {
        baseline: left ? left.passed + '/' + left.attempts : 'not run',
        run: right ? right.passed + '/' + right.attempts : 'not run',
      }
      if (!left) change.onlyRun.push(short)
      else if (!right) change.onlyBaseline.push(short)
      else if (left.passed && right.passed) change.solved.push(short)
      else if (right.passed) change.gained.push(short)
      else if (left.passed) change.lost.push(short)
      else change.neither.push(short)
    }
    return change
  })
}

export function against(baseline: Run, run: Run): string {
  const rate = (summary: Result.AgentSummary | undefined, k: string) => {
    const value = summary?.passAtK[k]
    if (summary === undefined) return 'not run'
    if (value === undefined) return 'not rated'
    const rated = summary.rated[k]
    return (
      (value * 100).toFixed(1) +
      '%' +
      (rated === undefined || rated === summary.tasks
        ? ''
        : ' of ' + rated + (rated === 1 ? ' task' : ' tasks'))
    )
  }
  const tokens = (summary: Result.AgentSummary | undefined) =>
    summary ? number(summary.inputTokens) + ' (' + number(summary.cachedTokens) + ')' : 'not run'
  return (
    changes(baseline, run)
      .map((change) => {
        const before = change.baseline
        const after = change.run
        const count = (name: 'attempts' | 'errored' | 'failed' | 'passed' | 'tasks') => [
          name[0]!.toUpperCase() + name.slice(1),
          before ? String(before[name]) : 'not run',
          String(after[name]),
        ]
        const ks = [
          ...new Set([...Object.keys(before?.passAtK ?? {}), ...Object.keys(after.passAtK)]),
        ].sort((left, right) => Number(left) - Number(right))
        const listed = (names: readonly string[]) =>
          names
            .map(
              (name) =>
                name + ' (' + change.tasks[name]!.baseline + ' to ' + change.tasks[name]!.run + ')',
            )
            .join(', ') || 'none'
        return [
          change.agent + ': run ' + run.id + ' against the baseline ' + baseline.id,
          '',
          cells([
            ['', 'Baseline', 'Run'],
            [
              'nanocode',
              baseline.nanocode ? Pins.text(baseline.nanocode) : 'not recorded',
              run.nanocode ? Pins.text(run.nanocode) : 'not recorded',
            ],
            count('tasks'),
            count('attempts'),
            count('passed'),
            count('failed'),
            count('errored'),
            ...ks.map((k) => ['pass@' + k, rate(before, k), rate(after, k)]),
            ['Input tokens (cached)', tokens(before), tokens(after)],
            [
              'Output tokens',
              before ? number(before.outputTokens) : 'not run',
              number(after.outputTokens),
            ],
            ['Cost', before ? cost(before.costUsd) : 'not run', cost(after.costUsd)],
          ]),
          '',
          'gained: ' + listed(change.gained),
          'lost: ' + listed(change.lost),
          'solved in both: ' + change.solved.length + ', in neither: ' + change.neither.length,
          ...(change.onlyRun.length ? ['not in the baseline: ' + change.onlyRun.join(', ')] : []),
          ...(change.onlyBaseline.length
            ? ['only in the baseline: ' + change.onlyBaseline.join(', ')]
            : []),
        ].join('\n')
      })
      .join('\n\n') + '\n'
  )
}
