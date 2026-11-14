import type * as Result from './Result.ts'

export const queued = 'the turn never started'

export const stalledPrefix = 'the agent never reached its model'

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
  if (
    failure.kind === 'agent' &&
    (/\berror code: (502|530)\b/.test(failure.message) ||
      input.statuses.some((status) => unreached.includes(status)))
  )
    return 'the model endpoint was not reached'
  return undefined
}
