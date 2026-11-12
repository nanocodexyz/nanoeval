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

export function create(options: create.Options): Sandbox.Provider {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const base = (options.url || origin).replace(/\/+$/, '') + '/v1/compute/'

  const pay = async (operation: string, sent: Sent): Promise<Response> => {
    const init = (headers: Record<string, string>): RequestInit => ({
      ...(sent.body === undefined ? {} : { body: sent.body as string | Uint8Array<ArrayBuffer> }),
      headers: { 'gateway-app': app, ...sent.headers, ...headers },
      method: 'POST',
    })
    const askedAt = Date.now()
    const asked = await send(base + operation, init({}))
    options.onCall?.({ ms: Date.now() - askedAt, operation, paid: false })
    if (asked.status !== 402)
      throw new UnpricedError(
        'the gateway answered ' +
          asked.status +
          ' to an unpaid ' +
          operation +
          ' instead of its price: ' +
          (await asked.text()).slice(0, 500),
      )
    await asked.body?.cancel()
    const charge = quote(asked.headers.get('www-authenticate'))
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
    if (response.ok) return response
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
    ).json()) as T

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
          const response = await pay('write', {
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
      const created = await call<{ expiresAt?: number; paidUntil?: number; sandboxId?: string }>(
        'create',
        {
          image: input.template ?? template,
          lease: Math.min(input.leaseSec ?? leaseSec, input.timeoutSec),
          provider: 'e2b',
          timeout: input.timeoutSec,
        },
      )
      if (
        typeof created.sandboxId !== 'string' ||
        typeof created.expiresAt !== 'number' ||
        typeof created.paidUntil !== 'number'
      )
        throw new RequestError('the gateway returned no sandbox with a lease')
      return {
        expiresAt: created.expiresAt,
        handle: { home, id: created.sandboxId },
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
      const renewed = await call<{ paidUntil?: number }>('renew', {
        sandboxId: handle.id,
        seconds,
      })
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
