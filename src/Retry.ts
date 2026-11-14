import type * as Result from './Result.ts'

export const unreached: readonly number[] = [502, 530]

export function infrastructure(input: {
  failure: Pick<Result.Failure, 'kind' | 'message'>
  statuses: readonly number[]
}): string | undefined {
  const { failure } = input
  if (failure.kind === 'budget' || failure.kind === 'agent_timeout' || failure.kind === 'cancelled')
    return undefined
  if (failure.message.includes('No space left on device')) return 'the slot ran out of disk'
  if (
    failure.kind === 'agent' &&
    (/\berror code: (502|530)\b/.test(failure.message) ||
      input.statuses.some((status) => unreached.includes(status)))
  )
    return 'the model endpoint was not reached'
  return undefined
}
