import * as Installed from './Installed.ts'
import type * as Result from './Result.ts'

export type Run = {
  attempts: readonly Result.Attempt[]
  eval: { name: string; version: string }
  id: string
  name: string
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

export function harness(agent: Result.Attempt['agent']): string {
  if (agent.provider === 'oracle') return 'oracle'
  return Installed.is(agent.provider)
    ? agent.provider + ' ' + Installed.releases[agent.provider].version
    : 'nanocode'
}

export function model(agent: Result.Attempt['agent']): string {
  if (agent.provider === 'oracle') return 'the task solution'
  const provider = Installed.is(agent.provider)
    ? Installed.releases[agent.provider].provider
    : agent.provider
  return provider + ':' + agent.model + (agent.thinking ? ':' + agent.thinking : '')
}

function key(agent: Result.Attempt['agent']): string {
  return [agent.id, agent.provider, agent.model, agent.thinking ?? ''].join(' ')
}

function seconds(phase: Result.Phase | undefined): number {
  return phase ? (phase.finishedAt - phase.startedAt) / 1000 : 0
}

export function arms(runs: readonly Run[]): Arm[] {
  const found = new Map<string, Arm>()
  const tasks = new Map<string, Set<string>>()
  for (const run of runs)
    for (const attempt of run.attempts) {
      const id = key(attempt.agent)
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
          harness: harness(attempt.agent),
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

export function table(runs: readonly Run[]): string {
  const all = arms(runs)
  const number = (value: number) => value.toLocaleString('en-US')
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
      arm.agent,
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
      arm.costUsd === null
        ? 'not known'
        : '$' +
          arm.costUsd.toFixed(4) +
          (arm.priced === arm.attempts ? '' : ' for ' + arm.priced + ' of ' + arm.attempts),
    ]),
  ])

  const names = [
    ...new Set(runs.flatMap((run) => run.attempts.map((attempt) => attempt.task.name))),
  ].sort()
  const outcome = (task: string, arm: Arm) => {
    const own = runs
      .flatMap((run) => run.attempts)
      .filter((attempt) => attempt.task.name === task && key(attempt.agent) === arm.key)
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
    ['Task', ...all.map((arm) => arm.agent)],
    ...names.map((task) => [task.split('/').at(-1)!, ...all.map((arm) => outcome(task, arm))]),
  ])

  return (
    [
      ...runs.map(
        (run) =>
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
          run.attempts.length +
          ' attempts ended',
      ),
      '',
      summary,
      '',
      tasks,
    ].join('\n') + '\n'
  )
}
