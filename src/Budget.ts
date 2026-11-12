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

function microUsd(usd: number): number {
  return Math.round(usd * 1e6)
}
