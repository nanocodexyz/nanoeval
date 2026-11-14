import type * as Result from './Result.ts'

export const queued = 'the turn never started'

export const stalledPrefix = 'the agent never reached its model'

export const unansweredPrefix = 'the model endpoint never answered the agent'

export const unreached: readonly number[] = [502, 530]

export function stalled(input: {
  failure: Result.Failure
  oomKills?: number
  statuses: readonly number[]
}): Result.Failure | undefined {
  if (input.failure.kind !== 'agent_timeout' || input.statuses.length || !input.oomKills)
    return undefined
  return {
    at: input.failure.at,
    kind: 'environment',
    message:
      stalledPrefix +
      ' and its slot had ' +
      input.oomKills +
      ' OOM kills: ' +
      input.failure.message,
  }
}

export function unanswered(input: {
  at: number
  failure?: Result.Failure
  statuses: readonly number[]
}): Result.Failure | undefined {
  const { failure, statuses } = input
  if (failure?.kind === 'budget' || failure?.kind === 'cancelled') return undefined
  if (!statuses.length || !statuses.every((status) => unreached.includes(status))) return undefined
  return {
    at: failure?.at ?? input.at,
    kind: 'environment',
    message:
      unansweredPrefix +
      ': its ' +
      statuses.length +
      ' model requests were answered ' +
      [...new Set(statuses)].join(', ') +
      (failure ? ': ' + failure.message : ''),
  }
}

export function infrastructure(input: {
  failure: Pick<Result.Failure, 'kind' | 'message'>
  statuses: readonly number[]
}): string | undefined {
  const { failure } = input
  if (failure.kind === 'budget' || failure.kind === 'agent_timeout' || failure.kind === 'cancelled')
    return undefined
  if (failure.message.includes('No space left on device')) return 'the slot ran out of disk'
  if (
    failure.kind === 'environment' &&
    (failure.message.startsWith(queued) || failure.message.startsWith(stalledPrefix))
  )
    return 'the agent never started'
  if (failure.kind === 'environment' && failure.message.startsWith(unansweredPrefix))
    return 'the model endpoint was not reached'
  if (
    failure.kind === 'agent' &&
    (/\berror code: (502|530|1016)\b/.test(failure.message) ||
      input.statuses.some((status) => unreached.includes(status)))
  )
    return 'the model endpoint was not reached'
  return undefined
}
