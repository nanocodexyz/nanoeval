import { Mppx, tempo } from 'mppx/client'
import type * as Budget from './Budget.ts'

export type Charge = {
  amount: string
  currency: string
  description: string
  intent: string
  method: string
  realm: string
  usd: number
}

export type Account = Parameters<typeof tempo.charge>[0] extends infer P
  ? P extends { account?: infer A }
    ? NonNullable<A>
    : never
  : never

export const decimals = 6

export function usd(amount: string): number {
  if (!/^\d+$/.test(amount))
    throw new Error('a charge amount is a base-unit integer, not ' + amount)
  return Number(BigInt(amount)) / 10 ** decimals
}

export function payer(
  options: payer.Options,
): (input: string, init?: RequestInit) => Promise<Response> {
  const mppx = Mppx.create({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    methods: [tempo.charge({ account: options.account })],
    onChallenge: async (challenge, helpers) => {
      const request = challenge.request as { amount?: unknown; currency?: unknown }
      const charge: Charge = {
        amount: String(request.amount),
        currency: String(request.currency),
        description: challenge.description ?? '',
        intent: challenge.intent,
        method: challenge.method,
        realm: challenge.realm,
        usd: usd(String(request.amount)),
      }
      options.budget.charge(charge.usd, charge.description || challenge.realm)
      const credential = await helpers.createCredential()
      await options.onCharge(charge)
      return credential
    },
    polyfill: false,
  })
  return (input, init) => mppx.fetch(input, init)
}

export declare namespace payer {
  type Options = {
    account: Account
    budget: Budget.Budget
    fetch?: typeof fetch
    onCharge(charge: Charge): void | Promise<void>
  }
}
