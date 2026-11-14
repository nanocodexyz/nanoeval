import type * as Budget from './Budget.ts'
import * as Payment from './Payment.ts'
import type * as Sandbox from './Sandbox.ts'

export class RequestError extends Error {
  override name = 'Gateway.RequestError'
}

export class UnpricedError extends RequestError {
  override name = 'Gateway.UnpricedError'
}

export class RefusedError extends RequestError {
  override name = 'Gateway.RefusedError'
  readonly status: number
  constructor(status: number, text: string) {
    super(text)
    this.status = status
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type Sent = {
  body?: string | Uint8Array
  headers?: Record<string, string>
}

export const app = 'nanoeval'

export const execSec = 120

export const home = '/root/.nanoeval'

export const leaseSec = 300

export const maxTimeoutSec = 86_400

export const origin = 'https://gateway.tempo-dev.workers.dev'

export const template = 'code-interpreter-v1'

export type KeyUsage = {
  channelDepositUsd: number
  channelSpentUsd: number
  limitRemainingUsd: number
  walletUsd: number
}

export type Charged = { channelUsd: number; outsideUsd: number; usd: number }

export type Lease = { amount: string; currency: string; realm: string; seconds: number }

export type Funding = { deposit?: number; topUp?: number }

export async function fund(
  options: { fetch?: Fetch; key: string; url?: string },
  funding: Funding,
) {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const response = await send((options.url || origin).replace(/\/+$/, '') + '/api/keys/me', {
    body: JSON.stringify(funding),
    headers: { authorization: 'Bearer ' + options.key, 'content-type': 'application/json' },
    method: 'PATCH',
  })
  const text = await response.text()
  if (!response.ok)
    throw new RefusedError(
      response.status,
      'the gateway refused to change the funding of the key with ' +
        response.status +
        ': ' +
        text.slice(0, 300),
    )
}

export async function usage(options: {
  fetch?: Fetch
  key: string
  url?: string
}): Promise<KeyUsage> {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const response = await send((options.url || origin).replace(/\/+$/, '') + '/api/keys/me', {
    headers: { authorization: 'Bearer ' + options.key },
  })
  const text = await response.text()
  if (!response.ok)
    throw new RefusedError(
      response.status,
      'the gateway refused to say what the key was charged with ' +
        response.status +
        ': ' +
        text.slice(0, 300),
    )
  let used: Record<string, Record<string, unknown> | undefined> | undefined
  try {
    used = (JSON.parse(text) as { usage?: typeof used }).usage
  } catch {
    used = undefined
  }
  const amount = (value: unknown): number => {
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    if (typeof parsed !== 'number' || !Number.isFinite(parsed))
      throw new RequestError('the gateway reported the usage of the key without its amounts')
    return parsed
  }
  return {
    channelDepositUsd: amount(used?.['channel']?.['deposit']),
    channelSpentUsd: amount(used?.['channel']?.['spent']),
    limitRemainingUsd: amount(used?.['limit']?.['remaining']),
    walletUsd: amount(used?.['wallet']?.['balance']),
  }
}

export function charged(start: KeyUsage, end: KeyUsage): Charged {
  const micro = (usd: number) => Math.round(usd * 1e6)
  const channel = micro(end.channelSpentUsd) - micro(start.channelSpentUsd)
  const outside =
    micro(start.limitRemainingUsd) -
    micro(end.limitRemainingUsd) -
    (micro(end.channelDepositUsd) - micro(start.channelDepositUsd))
  return { channelUsd: channel / 1e6, outsideUsd: outside / 1e6, usd: (channel + outside) / 1e6 }
}

export function quote(header: string | null): Payment.Charge {
  const offers = [...(header ?? '').matchAll(/Payment ((?:[a-z]+="[^"]*"(?:, )?)+)/g)].map(
    (match) =>
      Object.fromEntries(
        [...match[1]!.matchAll(/([a-z]+)="([^"]*)"/g)].map((field) => [field[1]!, field[2]!]),
      ),
  )
  const offer = offers[0]
  if (!offer?.['request']) throw new RequestError('the gateway asked for payment without a price')
  let request: { amount?: unknown; currency?: unknown }
  try {
    request = JSON.parse(atob(offer['request'].replaceAll('-', '+').replaceAll('_', '/')))
  } catch {
    throw new RequestError('the gateway asked for payment with a request that is not JSON')
  }
  return {
    amount: String(request.amount),
    currency: String(request.currency),
    description: offer['description'] ?? '',
    intent: offer['intent'] ?? '',
    method: offer['method'] ?? '',
    realm: offer['realm'] ?? '',
    usd: Payment.usd(String(request.amount)),
  }
}

export function leased(lease: Lease, seconds: number): Payment.Charge {
  const least = BigInt(1000)
  const scaled =
    (BigInt(lease.amount) * BigInt(seconds) + BigInt(lease.seconds - 1)) / BigInt(lease.seconds)
  const amount = String(scaled > least ? scaled : least)
  return {
    amount,
    currency: lease.currency,
    description: 'compute.renew estimated at the lease rate',
    intent: 'session',
    method: 'tempo',
    realm: lease.realm,
    usd: Payment.usd(amount),
  }
}

function ownerPriced(status: number, header: string | null, text: string): boolean {
  return status === 402 && !header?.includes('Payment ') && code(text) === 'payment_failed'
}

export function create(options: create.Options): Sandbox.Provider {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const base = (options.url || origin).replace(/\/+$/, '') + '/v1/compute/'

  const pay = async (
    operation: string,
    sent: Sent,
    unquoted?: Payment.Charge,
  ): Promise<{ charge: Payment.Charge; response: Response }> => {
    const init = (headers: Record<string, string>): RequestInit => ({
      ...(sent.body === undefined ? {} : { body: sent.body as string | Uint8Array<ArrayBuffer> }),
      headers: { 'gateway-app': app, ...sent.headers, ...headers },
      method: 'POST',
    })
    const askedAt = Date.now()
    const asked = await send(base + operation, init({}))
    options.onCall?.({ ms: Date.now() - askedAt, operation, paid: false })
    const header = asked.headers.get('www-authenticate')
    const unpaid = asked.status === 402 && header?.includes('Payment ') ? '' : await asked.text()
    if (unpaid === '') await asked.body?.cancel()
    const charge =
      unpaid !== '' && unquoted && ownerPriced(asked.status, header, unpaid)
        ? unquoted
        : asked.status === 402 && unpaid === ''
          ? quote(header)
          : undefined
    if (!charge)
      throw new UnpricedError(
        'the gateway answered ' +
          asked.status +
          ' to an unpaid ' +
          operation +
          ' instead of its price: ' +
          unpaid.slice(0, 500),
      )
    const budgeted = operation !== 'terminate'
    if (budgeted) options.budget.charge(charge.usd, 'compute.' + operation)
    await options.onCharge(charge)
    const kept = (outcome: string) =>
      options.onCharge({
        ...charge,
        amount: '0',
        description: charge.description + ' ' + outcome,
        usd: 0,
      })
    let response: Response
    let answer = ''
    const paidAt = Date.now()
    try {
      response = await send(base + operation, init({ authorization: 'Bearer ' + options.key }))
      if (!response.ok) answer = await response.text()
      options.onCall?.({ ms: Date.now() - paidAt, operation, paid: true })
    } catch (error) {
      await kept('unanswered')
      throw new RequestError(
        'the gateway did not answer the paid ' +
          operation +
          ', which may have been charged, so its price stays in the spend: ' +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      )
    }
    if (response.ok) return { charge, response }
    if (response.status >= 500 && code(answer) === undefined) {
      await kept('answered ' + response.status + ' without a problem')
      throw new RequestError(
        'the paid ' +
          operation +
          ' was answered ' +
          response.status +
          ' without a problem of the gateway, which may have been charged, so its price stays in the spend: ' +
          answer.slice(0, 500),
      )
    }
    if (budgeted) options.budget.refund(charge.usd, 'compute.' + operation)
    await options.onCharge({
      ...charge,
      amount: '-' + charge.amount,
      description: charge.description + ' refused with ' + response.status,
      usd: -charge.usd,
    })
    throw new RefusedError(
      response.status,
      'the gateway refused ' + operation + ' with ' + response.status + ': ' + answer.slice(0, 500),
    )
  }
  const call = async <T>(operation: string, body: unknown): Promise<T> =>
    (await (
      await pay(operation, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      })
    ).response.json()) as T

  return {
    name: 'gateway',
    connect(handle) {
      return {
        async exec(command) {
          const output = await call<Sandbox.Output & { timedOut?: boolean }>('exec', {
            command: ['bash', '-lc', command],
            sandboxId: handle.id,
            timeout: execSec,
          })
          if (output.timedOut)
            throw new RequestError('the command did not finish within ' + execSec + ' s')
          return { exitCode: output.exitCode, stderr: output.stderr, stdout: output.stdout }
        },
        async write(path, data) {
          const { response } = await pay('write', {
            body: data,
            headers: {
              'content-type': 'application/octet-stream',
              'gateway-path': path,
              'gateway-sandbox': handle.id,
              'gateway-size': String(data.length),
            },
          })
          await response.body?.cancel()
        },
      }
    },
    async create(input) {
      if (
        !Number.isSafeInteger(input.timeoutSec) ||
        input.timeoutSec < 1 ||
        input.timeoutSec > maxTimeoutSec
      )
        throw new RequestError('a gateway sandbox timeout is 1 to ' + maxTimeoutSec + ' seconds')
      const lease = Math.min(input.leaseSec ?? leaseSec, input.timeoutSec)
      const paid = await pay('create', {
        body: JSON.stringify({
          image: input.template ?? template,
          lease,
          provider: 'e2b',
          timeout: input.timeoutSec,
        }),
        headers: { 'content-type': 'application/json' },
      })
      const created = (await paid.response.json()) as {
        expiresAt?: number
        paidUntil?: number
        sandboxId?: string
      }
      if (
        typeof created.sandboxId !== 'string' ||
        typeof created.expiresAt !== 'number' ||
        typeof created.paidUntil !== 'number'
      )
        throw new RequestError('the gateway returned no sandbox with a lease')
      return {
        expiresAt: created.expiresAt,
        handle: {
          home,
          id: created.sandboxId,
          lease: {
            amount: paid.charge.amount,
            currency: paid.charge.currency,
            realm: paid.charge.realm,
            seconds: lease,
          } satisfies Lease,
        },
        paidUntil: created.paidUntil,
      }
    },
    async kill(handle) {
      try {
        await call('terminate', { sandboxId: handle.id })
      } catch (error) {
        if (!(error instanceof RefusedError && error.status === 404)) throw error
      }
    },
    async renew(handle, seconds) {
      const lease = handle['lease'] as Lease | undefined
      const paidUntil = typeof handle['paidUntil'] === 'number' ? handle['paidUntil'] : Date.now()
      const span = Math.max(0, Math.ceil((paidUntil - Date.now()) / 1000)) + seconds
      const { response } = await pay(
        'renew',
        {
          body: JSON.stringify({ sandboxId: handle.id, seconds }),
          headers: { 'content-type': 'application/json' },
        },
        lease ? leased(lease, span) : undefined,
      )
      const renewed = (await response.json()) as { paidUntil?: number }
      if (typeof renewed.paidUntil !== 'number')
        throw new RequestError('the gateway renewed without a lease')
      return { paidUntil: renewed.paidUntil }
    },
  }
}

export declare namespace create {
  type Options = {
    budget: Budget.Budget
    fetch?: Fetch
    key: string
    onCall?(call: { ms: number; operation: string; paid: boolean }): void
    onCharge(charge: Payment.Charge): void | Promise<void>
    url?: string
  }
}

function code(answer: string): string | undefined {
  try {
    const problem = JSON.parse(answer) as { code?: unknown } | null
    return typeof problem?.code === 'string' ? problem.code : undefined
  } catch {
    return undefined
  }
}
