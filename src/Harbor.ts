import type * as Atif from './Atif.ts'
import * as Installed from './Installed.ts'
import * as Result from './Result.ts'

export type Job = {
  id: string
  name: string
  startedAt: number
  finishedAt: number | null
}

const exceptions: Record<Result.FailureKind, string> = {
  agent: 'AgentError',
  agent_timeout: 'AgentTimeoutError',
  budget: 'BudgetExceededError',
  cancelled: 'CancelledError',
  environment: 'EnvironmentError',
  internal: 'InternalError',
  verifier: 'VerifierError',
  verifier_timeout: 'VerifierTimeoutError',
}

function harness(attempt: Result.Attempt): string {
  const provider = attempt.agent.provider
  return provider === 'oracle' || Installed.is(provider) ? provider : 'nanocode'
}

export function trialName(attempt: Result.Attempt): string {
  const task = attempt.task.name.split('/').at(-1)!
  return task + '__' + attempt.agent.id + '__' + attempt.index
}

export function trialId(job: Job, attempt: Result.Attempt): string {
  return job.id.slice(0, 24) + attempt.id.replace(/\D/g, '').padStart(12, '0')
}

export function trialConfig(
  attempt: Result.Attempt,
  options: { job: Job; source: string },
): Record<string, unknown> {
  const sandbox = attempt.sandbox
  const type = sandbox?.provider === 'e2b' ? 'e2b' : undefined
  return {
    task: { path: attempt.task.name, source: options.source },
    trial_name: trialName(attempt),
    agent: {
      name: harness(attempt),
      model_name: attempt.agent.model,
      kwargs: {
        id: attempt.agent.id,
        provider: attempt.agent.provider,
        ...(attempt.agent.thinking ? { reasoning_effort: attempt.agent.thinking } : {}),
      },
    },
    environment: { ...(type ? { type } : {}), kwargs: sandbox ?? {} },
    job_id: options.job.id,
  }
}

export function jobConfig(input: {
  attempts: readonly Result.Attempt[]
  job: Job
  source: string
}): Record<string, unknown> {
  const agents = new Map<string, unknown>()
  const tasks = new Set<string>()
  const types = new Set<unknown>()
  for (const attempt of input.attempts) {
    const config = trialConfig(attempt, input)
    agents.set(attempt.agent.id, config['agent'])
    tasks.add(attempt.task.name)
    types.add((config['environment'] as { type?: string }).type)
  }
  const [type] = types
  return {
    job_name: input.job.name,
    n_attempts: Math.max(1, ...input.attempts.map((attempt) => attempt.index)),
    ...(types.size === 1 && type ? { environment: { type } } : {}),
    agents: [...agents.values()],
    tasks: [...tasks].sort().map((path) => ({ path, source: input.source })),
  }
}

export function trial(attempt: Result.Attempt, options: trial.Options): Record<string, unknown> {
  const phase = (value: Result.Phase | undefined) =>
    value ? { started_at: iso(value.startedAt), finished_at: iso(value.finishedAt) } : null
  const usage = attempt.usage
  const oracle = attempt.agent.provider === 'oracle'
  const installed = Installed.is(attempt.agent.provider)
    ? Installed.releases[attempt.agent.provider]
    : undefined

  return {
    id: trialId(options.job, attempt),
    task_name: attempt.task.name,
    trial_name: trialName(attempt),
    trial_uri: options.uri,
    task_id: { path: attempt.task.name },
    source: options.source,
    task_checksum: attempt.task.checksum,
    config: trialConfig(attempt, options),
    agent_info: {
      name: harness(attempt),
      version: installed ? installed.version : options.version,
      model_info: oracle
        ? null
        : {
            name: attempt.agent.model,
            provider:
              (installed?.provider ?? attempt.agent.provider) === 'claude' ? 'anthropic' : 'openai',
          },
    },
    agent_result: usage
      ? {
          n_input_tokens: usage.inputTokens,
          n_cache_tokens: usage.cachedTokens,
          n_output_tokens: usage.outputTokens,
          cost_usd: usage.costUsd ?? null,
          rollout_details: null,
          metadata: {
            cache_write_input_tokens: usage.cacheWriteTokens,
            model_calls: usage.modelCalls,
            session: attempt.session,
            tool_calls: usage.toolCalls,
          },
        }
      : null,
    verifier_result: attempt.reward === null ? null : { rewards: { reward: attempt.reward } },
    started_at: iso(attempt.startedAt),
    finished_at: iso(attempt.finishedAt),
    environment_setup: phase(attempt.timing.environmentSetup),
    agent_setup: phase(attempt.timing.agentSetup),
    agent_execution: phase(attempt.timing.agentExecution),
    verifier: phase(attempt.timing.verifier),
    exception_info: attempt.failure
      ? {
          exception_type: exceptions[attempt.failure.kind],
          exception_message: attempt.failure.message,
          exception_traceback: '',
          occurred_at: iso(attempt.failure.at),
        }
      : null,
    step_results: null,
  }
}

export declare namespace trial {
  type Options = {
    job: Job
    source: string
    uri: string
    version: string
  }
}

export function job(
  attempts: readonly Result.Attempt[],
  options: job.Options,
): Record<string, unknown> {
  const summaries = Result.summarize(attempts)
  const evals: Record<string, unknown> = {}
  let cost: number | null = null
  let input = 0
  let cached = 0
  let output = 0

  for (const [agent, summary] of Object.entries(summaries)) {
    const own = attempts.filter((attempt) => attempt.agent.id === agent)
    const scored = own.filter((attempt) => attempt.reward !== null)
    const rewards: Record<string, string[]> = {}
    const errors: Record<string, string[]> = {}
    for (const attempt of own) {
      if (attempt.reward !== null) (rewards[String(attempt.reward)] ??= []).push(trialName(attempt))
      if (attempt.failure)
        (errors[exceptions[attempt.failure.kind]] ??= []).push(trialName(attempt))
    }
    evals[agent + '__' + options.source] = {
      n_trials: scored.length,
      n_errors: own.filter((attempt) => attempt.failure).length,
      metrics: [
        {
          mean: own.length
            ? own.reduce((total, attempt) => total + (attempt.reward ?? 0), 0) / own.length
            : 0,
        },
      ],
      pass_at_k: summary.passAtK,
      reward_stats: { reward: rewards },
      exception_stats: errors,
    }
    input += summary.inputTokens
    cached += summary.cachedTokens
    output += summary.outputTokens
    if (summary.costUsd !== null) cost = (cost ?? 0) + summary.costUsd
  }

  return {
    id: options.job.id,
    started_at: iso(options.job.startedAt),
    finished_at: options.job.finishedAt === null ? null : iso(options.job.finishedAt),
    n_total_trials: options.total,
    stats: {
      n_completed_trials: attempts.length,
      n_errored_trials: attempts.filter((attempt) => attempt.failure).length,
      n_running_trials: options.running,
      n_pending_trials: options.total - attempts.length - options.running,
      n_cancelled_trials: attempts.filter((attempt) => attempt.failure?.kind === 'cancelled')
        .length,
      n_retries: 0,
      evals,
      n_input_tokens: input,
      n_cache_tokens: cached,
      n_output_tokens: output,
      cost_usd: cost,
    },
  }
}

export declare namespace job {
  type Options = {
    job: Job
    running: number
    source: string
    total: number
  }
}

export function files(input: files.Input): Record<string, string> {
  const out: Record<string, string> = {
    'config.json': pretty(jobConfig(input)),
    'result.json': pretty(
      job(input.attempts, {
        job: input.job,
        running: input.running,
        source: input.source,
        total: input.total,
      }),
    ),
  }
  for (const attempt of input.attempts) {
    const name = trialName(attempt)
    out[name + '/config.json'] = pretty(trialConfig(attempt, input))
    out[name + '/result.json'] = pretty(
      trial(attempt, {
        job: input.job,
        source: input.source,
        uri: name,
        version: input.version,
      }),
    )
    for (const [artifact, body] of Object.entries(input.artifacts[attempt.id] ?? {}))
      out[name + '/' + artifact] = body
  }
  return out
}

export declare namespace files {
  type Input = {
    artifacts: Record<string, Record<string, string>>
    attempts: readonly Result.Attempt[]
    job: Job
    running: number
    source: string
    total: number
    version: string
  }
}

export type Trajectory = Atif.Trajectory

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}
