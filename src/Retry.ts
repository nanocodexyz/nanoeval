import type * as Proxy from './Proxy.ts'
import type * as Result from './Result.ts'
import * as Verdict from './Verdict.ts'

export const queued = 'the turn never started'

export const refusedPrefix = 'the run ended the turn'

export const refusing: readonly number[] = [401, 402, 403, 404]

export const stalledPrefix = 'the agent never reached its model'

export const unansweredPrefix = 'the model endpoint never answered the agent'

export const unreached: readonly number[] = [502, 530]

export function refused(input: {
  now: number
  requests: readonly { at: number; refusal?: Proxy.Refusal; status: number }[]
  spent?: { at: number; message: string }
  waitSec: number
}): Result.Failure | undefined {
  const { requests, spent } = input
  const tail = requests.slice(
    requests.findLastIndex((request) => !refusing.includes(request.status)) + 1,
  )
  const first = tail[0]
  const last = tail.at(-1)
  if (!first || !last) return undefined
  const waitMs = input.waitSec * 1000
  if (last.refusal === 'spent' && spent && input.now - spent.at >= waitMs)
    return {
      at: input.now,
      kind: 'budget',
      message:
        refusedPrefix +
        ': its model request was answered 402 after the payment was refused for ' +
        input.waitSec +
        ' s: ' +
        spent.message,
    }
  if (last.at - first.at < waitMs) return undefined
  return {
    at: input.now,
    kind: 'agent',
    message:
      refusedPrefix +
      ': its last ' +
      tail.length +
      ' model requests were answered ' +
      [...new Set(tail.map((request) => request.status))].join(', ') +
      ' and nothing else for ' +
      Math.floor((last.at - first.at) / 1000) +
      ' s',
  }
}

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
  if (
    failure.message.includes('No space left on device') ||
    (failure.kind === 'environment' && failure.message.startsWith(Verdict.fullPrefix))
  )
    return 'the slot ran out of disk'
  if (failure.kind === 'environment' && failure.message.startsWith(Verdict.brokenPrefix))
    return 'the disk of the slot failed'
  if (failure.kind === 'environment' && failure.message.startsWith(Verdict.unfetchedPrefix))
    return 'the verifier could not download its dependencies'
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
