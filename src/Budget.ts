export class ExceededError extends Error {
  override name = 'Budget.ExceededError'
}

export type Budget = {
  readonly limitUsd: number
  readonly spentUsd: number
  charge(usd: number, purpose: string): void
  refund(usd: number, purpose: string): void
  remaining(): number
}

export function create(options: create.Options): Budget {
  if (!Number.isFinite(options.limitUsd) || options.limitUsd < 0)
    throw new Error('a budget limit must be a nonnegative amount in USD')

  let spent = options.spentUsd ?? 0
  return {
    limitUsd: options.limitUsd,
    get spentUsd() {
      return spent
    },
    charge(usd, purpose) {
      if (!Number.isFinite(usd) || usd < 0)
        throw new Error(purpose + ' has an invalid price: ' + usd)
      if (microUsd(spent) + microUsd(usd) > microUsd(options.limitUsd))
        throw new ExceededError(
          purpose +
            ' costs $' +
            usd +
            ', and $' +
            spent +
            ' of the $' +
            options.limitUsd +
            ' budget is spent',
        )
      spent = (microUsd(spent) + microUsd(usd)) / 1e6
    },
    refund(usd, purpose) {
      if (!Number.isFinite(usd) || usd < 0 || microUsd(usd) > microUsd(spent))
        throw new Error(purpose + ' refunds an amount that was not charged: ' + usd)
      spent = (microUsd(spent) - microUsd(usd)) / 1e6
    },
    remaining() {
      return (microUsd(options.limitUsd) - microUsd(spent)) / 1e6
    },
  }
}

export declare namespace create {
  type Options = {
    limitUsd: number
    spentUsd?: number
  }
}

export type Admission =
  | { state: 'admitted' }
  | { reason: 'held' | 'spent'; state: 'refused' }
  | { state: 'waiting' }

export function held(input: held.Input): boolean {
  return (
    input.flights > 0 &&
    input.largestUsd !== undefined &&
    microUsd(input.spentUsd) + input.flights * microUsd(input.largestUsd) >=
      microUsd(input.limitUsd)
  )
}

export declare namespace held {
  type Input = {
    flights: number
    largestUsd: number | undefined
    limitUsd: number
    spentUsd: number
  }
}

export type Flight = { claim: number; instance: string }

export function flying(
  flight: Flight,
  holder: { claim: number | undefined; instance: string },
): boolean {
  return flight.instance === holder.instance && flight.claim === holder.claim
}

export function admit(input: admit.Input): Admission {
  if (microUsd(input.spentUsd) >= microUsd(input.limitUsd))
    return { reason: 'spent', state: 'refused' }
  if (!input.flights) return { state: 'admitted' }
  const waits = input.waitedMs < input.waitMs
  if (input.largestUsd === undefined) return { state: waits ? 'waiting' : 'admitted' }
  if (!held(input)) return { state: 'admitted' }
  return waits ? { state: 'waiting' } : { reason: 'held', state: 'refused' }
}

export declare namespace admit {
  type Input = held.Input & {
    waitMs: number
    waitedMs: number
  }
}

function microUsd(usd: number): number {
  return Math.round(usd * 1e6)
}
