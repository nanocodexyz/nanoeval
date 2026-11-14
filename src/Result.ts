import type * as Atif from './Atif.ts'
import type * as Installed from './Installed.ts'

export type FailureKind =
  | 'agent'
  | 'agent_timeout'
  | 'budget'
  | 'cancelled'
  | 'environment'
  | 'internal'
  | 'verifier'
  | 'verifier_timeout'

export type Failure = {
  at: number
  kind: FailureKind
  message: string
}

export type Phase = { finishedAt: number; startedAt: number }

export type Attempt = {
  agent: {
    id: string
    model: string
    orchestration?: 'direct'
    provider: 'claude' | 'codex' | 'oracle' | Installed.Kind
    thinking?: string
  }
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
  oomKills?: number
  outcome: 'errored' | 'failed' | 'passed'
  retryOf?: { attempt: string; run: string }
  reward: number | null
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
}

export type AgentSummary = {
  attempts: number
  costUsd: number | null
  errored: number
  failed: number
  inputTokens: number
  cachedTokens: number
  meanReward: number | null
  outputTokens: number
  passAtK: Record<string, number>
  passed: number
  rated: Record<string, number>
  tasks: number
}

export function outcome(reward: number | null, failure: Failure | undefined): Attempt['outcome'] {
  if (reward === null) return 'errored'
  if (failure && failure.kind !== 'agent_timeout') return 'errored'
  return reward === 1 ? 'passed' : 'failed'
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
      meanReward: null,
      outputTokens: 0,
      passAtK: {},
      passed: 0,
      rated: {},
      tasks: 0,
    })
    summary.attempts++
    summary[attempt.outcome]++
    if (attempt.usage) {
      summary.inputTokens += attempt.usage.inputTokens
      summary.cachedTokens += attempt.usage.cachedTokens
      summary.outputTokens += attempt.usage.outputTokens
      if (attempt.usage.costUsd !== undefined)
        summary.costUsd = (summary.costUsd ?? 0) + attempt.usage.costUsd
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
