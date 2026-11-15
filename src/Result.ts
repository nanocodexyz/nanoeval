import type * as Atif from './Atif.ts'
import type * as Installed from './Installed.ts'
import * as Route from './Route.ts'

export type FailureKind =
  | 'agent'
  | 'agent_out_of_memory'
  | 'agent_timeout'
  | 'budget'
  | 'cancelled'
  | 'environment'
  | 'internal'
  | 'unscheduled'
  | 'verifier'
  | 'verifier_limit'
  | 'verifier_timeout'

export type Failure = {
  at: number
  kind: FailureKind
  message: string
}

export type Phase = { finishedAt: number; startedAt: number }

export type Attempt = {
  agent: {
    api?: Installed.Api
    id: string
    model: string
    orchestration?: 'direct' | 'jobs'
    preflight?: true
    provider: 'claude' | 'codex' | 'oracle' | Installed.Kind
    thinking?: string
  }
  agentMaxSec?: number
  claims?: number
  failure?: Failure
  finishedAt: number
  id: string
  index: number
  judge?: {
    model: string
    provider: 'claude' | 'codex'
    requests: number
    thinking?: string
    usage: Atif.Usage | null
  }
  modelWaits?: { count: number; sec: number }
  oomKills?: number
  outcome: 'errored' | 'failed' | 'passed'
  retryOf?: { attempt: string; run: string }
  reward: number | null
  route?: Route.Route
  sandbox: {
    backend: string
    id: number
    memoryMb?: number
    provider: string
    slot: string
  } | null
  session: string
  startedAt: number
  task: { checksum: string; name: string }
  timing: {
    agentExecution?: Phase
    agentSetup?: Phase
    environmentSetup?: Phase
    judge?: Phase
    verifier?: Phase
  }
  usage: Atif.Usage | null
  verifierMaxSec?: number
}

export type AgentSummary = {
  attempts: number
  costUsd: number | null
  errored: number
  failed: number
  inputTokens: number
  cachedTokens: number
  judge: {
    attempts: number
    cachedTokens: number
    costUsd: number | null
    inputTokens: number
    outputTokens: number
  }
  listed: number
  meanReward: number | null
  modelWaits: { attempts: number; count: number; sec: number }
  outputTokens: number
  passAtK: Record<string, number>
  passed: number
  rated: Record<string, number>
  reasoningTokens: number | null
  routes: Route.Route[]
  scored: number
  tasks: number
  verifierLimited: number
}

export function outcome(reward: number | null, failure: Failure | undefined): Attempt['outcome'] {
  if (reward === null) return 'errored'
  if (failure && failure.kind !== 'agent_timeout') return 'errored'
  return reward === 1 ? 'passed' : 'failed'
}

export function error(attempt: Pick<Attempt, 'failure' | 'outcome'>): Failure | undefined {
  return attempt.outcome === 'errored' ? attempt.failure : undefined
}

export function unscheduled(attempt: Pick<Attempt, 'failure' | 'outcome'>): boolean {
  const failure = error(attempt)
  return (
    failure?.kind === 'unscheduled' ||
    (failure?.kind === 'environment' && failure.message.startsWith(unscheduledPrefix))
  )
}

export const unscheduledPrefix = 'no runner of the run could take the row for '

export function timeout(attempt: {
  failure?: Failure
  outcome?: Attempt['outcome']
}): Failure | undefined {
  return attempt.outcome !== 'errored' && attempt.failure?.kind === 'agent_timeout'
    ? attempt.failure
    : undefined
}

export const afterTimeout = 'after the agent timeout'

export const ownLimit = "the task's own"

export const verifierLimited = "verifier ended by the run's limit"

export function limit(maxSec: number | undefined): string {
  return maxSec === undefined ? ownLimit : maxSec + ' s'
}

export function limits(attempts: readonly Pick<Attempt, 'agentMaxSec'>[]): string[] {
  return [...new Set(attempts.map((attempt) => limit(attempt.agentMaxSec)))].sort()
}

export function verifierLimits(attempts: readonly Pick<Attempt, 'verifierMaxSec'>[]): string[] {
  return [...new Set(attempts.map((attempt) => limit(attempt.verifierMaxSec)))].sort()
}

export function late(state: string, failure: Failure): string {
  return state + ' ' + afterTimeout + ' (' + failure.message + ')'
}

export function uncosted(attempts: readonly Attempt[]): number {
  return attempts.filter(
    (attempt) =>
      attempt.usage && attempt.usage.modelCalls > 0 && attempt.usage.costUsd === undefined,
  ).length
}

export function summarize(attempts: readonly Attempt[]): Record<string, AgentSummary> {
  const agents: Record<string, AgentSummary> = {}
  const tasks: Record<string, Record<string, Attempt[]>> = {}
  for (const attempt of attempts) {
    const summary = (agents[attempt.agent.id] ??= {
      attempts: 0,
      costUsd: null,
      errored: 0,
      failed: 0,
      inputTokens: 0,
      cachedTokens: 0,
      judge: { attempts: 0, cachedTokens: 0, costUsd: null, inputTokens: 0, outputTokens: 0 },
      listed: 0,
      meanReward: null,
      modelWaits: { attempts: 0, count: 0, sec: 0 },
      outputTokens: 0,
      passAtK: {},
      passed: 0,
      rated: {},
      reasoningTokens: null,
      routes: [],
      scored: 0,
      tasks: 0,
      verifierLimited: 0,
    })
    summary.attempts++
    summary[attempt.outcome]++
    if (error(attempt)?.kind === 'verifier_limit') summary.verifierLimited++
    if (attempt.usage) {
      summary.inputTokens += attempt.usage.inputTokens
      summary.cachedTokens += attempt.usage.cachedTokens
      summary.outputTokens += attempt.usage.outputTokens
      if (typeof attempt.usage.reasoningTokens === 'number')
        summary.reasoningTokens = (summary.reasoningTokens ?? 0) + attempt.usage.reasoningTokens
      if (attempt.usage.costUsd !== undefined)
        summary.costUsd = (summary.costUsd ?? 0) + attempt.usage.costUsd
      if (attempt.usage.costBy === 'list') summary.listed++
    }
    if (attempt.modelWaits) {
      summary.modelWaits.attempts++
      summary.modelWaits.count += attempt.modelWaits.count
      summary.modelWaits.sec += attempt.modelWaits.sec
    }
    if (attempt.judge) {
      summary.judge.attempts++
      if (attempt.judge.usage) {
        summary.judge.cachedTokens += attempt.judge.usage.cachedTokens
        summary.judge.inputTokens += attempt.judge.usage.inputTokens
        summary.judge.outputTokens += attempt.judge.usage.outputTokens
        if (attempt.judge.usage.costUsd !== undefined)
          summary.judge.costUsd = (summary.judge.costUsd ?? 0) + attempt.judge.usage.costUsd
      }
    }
    ;((tasks[attempt.agent.id] ??= {})[attempt.task.name] ??= []).push(attempt)
  }

  for (const [agent, byTask] of Object.entries(tasks)) {
    const summary = agents[agent]!
    const groups = Object.values(byTask)
    const rewards = groups
      .flat()
      .flatMap((attempt) => (attempt.reward === null ? [] : [attempt.reward]))
    if (rewards.length)
      summary.meanReward = rewards.reduce((total, reward) => total + reward, 0) / rewards.length
    summary.routes = Route.distinct(groups.flat().map((attempt) => attempt.route))
    summary.scored = rewards.length
    summary.tasks = groups.length
    const scored = groups.map((group) => group.filter((attempt) => attempt.outcome !== 'errored'))
    const trials = Math.max(...scored.map((group) => group.length))
    for (let k = 1; k <= trials; k++) {
      const rated = scored.filter((group) => group.length >= k)
      summary.passAtK[String(k)] =
        rated.reduce(
          (total, group) =>
            total +
            passAt(
              {
                passed: group.filter((attempt) => attempt.outcome === 'passed').length,
                scored: group.length,
              },
              k,
            ),
          0,
        ) / rated.length
      summary.rated[String(k)] = rated.length
    }
  }
  return agents
}

export function passAt(counts: { passed: number; scored: number }, k: number): number {
  let none = 1
  for (let drawn = 0; drawn < k && none > 0; drawn++)
    none *= (counts.scored - counts.passed - drawn) / (counts.scored - drawn)
  return 1 - none
}
