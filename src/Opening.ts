import * as Budget from './Budget.ts'
import * as Gateway from './Gateway.ts'

export const strikes = 2

export type Limits = { leaseSec: number; setupSec: number }

export type Failed = {
  alone?: number
  failures: number
  lastAt: number
  message: string
  pauses: number
  retryAt?: number
  since: number
  strikes: number
}

export type Action = 'end' | 'open' | 'wait'

export type View = {
  closed: boolean
  endsAt: number | null
  failures: number
  lastAt: number
  message: string
  nextAt: number | null
  since: number
}

const passingStatuses: readonly number[] = [402, 408, 429]

export function passing(error: unknown): boolean {
  if (error instanceof Budget.ExceededError) return false
  if (!(error instanceof Gateway.RefusedError || error instanceof Gateway.UnpricedError))
    return false
  return passingStatuses.includes(error.status) || error.status >= 500
}

export function retryAfterSec(error: unknown): number | undefined {
  return error instanceof Gateway.RefusedError || error instanceof Gateway.UnpricedError
    ? error.retryAfterSec
    : undefined
}

export function failed(
  state: Failed | undefined,
  input: { at: number; message: string; passing: boolean; retryAfterSec?: number },
): Failed {
  return {
    ...(state?.alone === undefined ? {} : { alone: state.alone }),
    failures: (state?.failures ?? 0) + 1,
    lastAt: input.at,
    message: input.message,
    pauses: (state?.pauses ?? 0) + 1,
    ...(input.retryAfterSec === undefined
      ? {}
      : { retryAt: input.at + input.retryAfterSec * 1000 }),
    since: state?.since ?? input.at,
    strikes: input.passing ? 0 : (state?.strikes ?? 0) + 1,
  }
}

export function seen(
  state: Failed | undefined,
  input: { now: number; stranded: boolean },
): Failed | undefined {
  if (!state) return undefined
  if (!input.stranded) {
    if (state.alone === undefined) return state
    const { alone: _, ...rest } = state
    return rest
  }
  if (state.alone !== undefined) return state
  return { ...state, alone: input.now, pauses: Math.min(state.pauses, 1) }
}

export function pauseMs(pauses: number, limits: Limits): number {
  if (pauses <= 1) return 0
  return Math.min(limits.leaseSec * 2 ** (pauses - 2), limits.setupSec) * 1000
}

export function closed(state: Failed, input: { limits: Limits; now: number }): boolean {
  return state.strikes >= strikes && input.now - state.lastAt <= input.limits.setupSec * 1000
}

export function nextAt(state: Failed, limits: Limits): number {
  return Math.max(state.lastAt + pauseMs(state.pauses, limits), state.retryAt ?? 0)
}

export function endsAt(state: Failed, limits: Limits): number | undefined {
  return state.alone === undefined ? undefined : state.alone + limits.setupSec * 1000
}

export function next(state: Failed | undefined, input: { limits: Limits; now: number }): Action {
  if (!state) return 'open'
  if (closed(state, input)) return state.alone === undefined ? 'wait' : 'end'
  const end = endsAt(state, input.limits)
  if (end !== undefined && input.now > end) return 'end'
  return input.now < nextAt(state, input.limits) ? 'wait' : 'open'
}

export function ended(state: Failed, input: { limits: Limits; now: number }): string {
  if (closed(state, input)) return state.message
  return (
    'no sandbox could be opened for ' +
    input.limits.setupSec +
    ' s with no other left to take the row, in ' +
    state.failures +
    (state.failures === 1 ? ' try' : ' tries') +
    ', the last of which ended with: ' +
    state.message
  )
}

export function view(state: Failed, input: { limits: Limits; now: number }): View {
  const shut = closed(state, input)
  return {
    closed: shut,
    endsAt: endsAt(state, input.limits) ?? null,
    failures: state.failures,
    lastAt: state.lastAt,
    message: state.message,
    nextAt: shut ? null : nextAt(state, input.limits),
    since: state.since,
  }
}
