import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as GatewayProvider from '../src/Gateway.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import type * as Sandbox from '../src/Sandbox.ts'

export type Charge = { operation: string; usd: number }

export type Entry = Charge & { kept?: number; late?: true; refused?: number }

export type Leased = {
  ended?: 'died' | 'lapsed' | 'terminated'
  endsAt: number
  expiresAt: number
  handle: Sandbox.Handle
  paidUntil: number
  renewals: number
}

export type Mock = {
  cap(limit: number | undefined): void
  readonly capped: readonly Charge[]
  readonly charges: readonly Charge[]
  close(): void
  crowd(seconds: number): void
  die(id: string): Promise<void>
  readonly early: readonly Charge[]
  readonly funding: readonly unknown[]
  hold(after: number): void
  readonly key: string
  lifetime(seconds: number | undefined): void
  readonly log: readonly Entry[]
  readonly modelCosts: readonly number[]
  readonly outside: readonly number[]
  readonly paymentRefusals: readonly string[]
  readonly refused: readonly string[]
  release(): void
  readonly sandboxes: ReadonlyMap<string, Leased>
  tell(on: boolean): void
  readonly unavailable: readonly Charge[]
  readonly url: string
}

export type Options = {
  bootstrapMs?: number
  cap?: number
  key: string
  lifetimeSec?: number
  model(path: string, body: Record<string, any>, cost: number): string | undefined
  refusals?: { passing?: number; spentAfter?: number; spentTimes?: number }
  renewals?: boolean
  sandboxd: { token: string; url: string }
  tells?: boolean
}

export const limitUsd = 100
export const searchUsd = 0.00005

const refusals = {
  passing: [
    {
      detail: 'Delta too small: voucher does not add new funds for this request.',
      status: 402,
      title: 'Delta Too Small',
      type: 'https://paymentauth.org/problems/session/delta-too-small',
    },
    {
      detail: 'Insufficient balance.',
      status: 402,
      title: 'Insufficient Balance',
      type: 'https://paymentauth.org/problems/session/insufficient-balance',
    },
  ],
  spent: {
    code: 'payment_failed',
    detail: 'The wallet holds 0 of the 3 its channel needs now. Add funds to the wallet.',
    status: 402,
    title: 'Payment failed',
    type: '/reference#description/payment-failed',
  },
}

export const callUsd = 0.0001
export const modelUsd = { '/v1/messages': 0.000456, '/v1/responses': 0.000123 }
export const prices: Record<string, number> = { exec: 0.0001, terminate: 0.0001, write: 0.001 }
export const secondUsd = 0.00014
export const templates = ['base', 'code-interpreter-v1', 'desktop']
export const waitSec = 5

const currencies = ['0x' + '0a'.repeat(20), '0x' + '0b'.repeat(20)]

function challenge(operation: string, usd: number): string {
  return currencies
    .map(
      (currency, index) =>
        'Payment id="mock-' +
        index +
        '", realm="gateway.example", method="tempo", intent="session", request="' +
        Buffer.from(
          JSON.stringify({ amount: String(Math.round(usd * 1e6)), currency, unitType: 'request' }),
        ).toString('base64url') +
        '", description="compute.' +
        operation +
        '", expires="2099-01-01T00:00:00.000Z"',
    )
    .join(', ')
}

async function read(request: Http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function start(options: Options): Promise<Mock> {
  let cap = options.cap
  const capped: Charge[] = []
  const charges: Charge[] = []
  let crowdedUntil = 0
  const early: Charge[] = []
  let lifetimeSec = options.lifetimeSec
  let tells = options.tells ?? false
  let told = false
  const held = new Set<string>()
  let holdAfter: number | undefined
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const funding: unknown[] = []
  const log: Entry[] = []
  const quoted = new Map<string, number>()
  const modelCosts: number[] = []
  const outside: number[] = []
  const paymentRefusals: string[] = []
  const refused: string[] = []
  const sum = (values: readonly number[]) => values.reduce((all, value) => all + value, 0)
  const sandboxes = new Map<string, Leased>()
  const unanswered: Http.ServerResponse[] = []
  const unavailable: Charge[] = []
  const provider = Local.create(options.sandboxd)
  const problem = (
    response: Http.ServerResponse,
    status: number,
    detail: string,
    headers: Record<string, string> = {},
    code?: string,
    meta?: Record<string, number>,
  ) => {
    response.writeHead(status, { 'content-type': 'application/problem+json', ...headers })
    response.end(
      JSON.stringify({ ...(code ? { code } : {}), detail, ...(meta ? { meta } : {}), status }),
    )
  }
  const end = async (id: string, ended: NonNullable<Leased['ended']>) => {
    const leased = sandboxes.get(id)
    if (!leased || leased.ended) return
    leased.ended = ended
    await provider.kill(leased.handle).catch(() => {})
  }
  const lapse = setInterval(() => {
    for (const [id, leased] of sandboxes)
      if (!leased.ended && Date.now() > Math.min(leased.paidUntil, leased.expiresAt))
        void end(id, 'lapsed')
      else if (!leased.ended && Date.now() > leased.endsAt) void end(id, 'died')
  }, 100)
  const view = (id: string, leased: Leased) => ({
    expiresAt: leased.expiresAt,
    paidUntil: leased.paidUntil,
    provider: 'e2b',
    sandboxId: id,
  })

  const compute = async (
    request: Http.IncomingMessage,
    response: Http.ServerResponse,
    operation: string,
  ): Promise<void> => {
    const raw = await read(request)
    const now = Date.now()
    const body =
      operation === 'write'
        ? { sandboxId: String(request.headers['gateway-sandbox']) }
        : (JSON.parse(raw.toString()) as Record<string, any>)
    if (request.headers['gateway-app'] !== GatewayProvider.app)
      return problem(response, 400, 'the request names no app of its own')
    const leased = operation === 'create' ? undefined : sandboxes.get(String(body['sandboxId']))
    const until = leased ? Math.max(leased.paidUntil, now) + Number(body['seconds']) * 1000 : 0
    const priced =
      operation === 'create'
        ? secondUsd * Number(body['lease']) + callUsd
        : operation === 'renew'
          ? secondUsd * Math.ceil((until - now) / 1000) + callUsd
          : prices[operation]
    if (priced === undefined)
      return problem(response, 404, 'the gateway has no compute/' + operation)
    const asked = operation + ' ' + String(body['sandboxId'])
    const authorized = request.headers['authorization'] !== undefined
    const usd = authorized ? (quoted.get(asked) ?? priced) : priced
    if (authorized) quoted.delete(asked)
    else quoted.set(asked, priced)
    if (operation === 'create') {
      if (body['provider'] !== 'e2b' || !templates.includes(body['image']))
        return problem(response, 400, 'templateID must be a public template')
      if (!(body['lease'] >= 1 && body['lease'] <= body['timeout']))
        return problem(response, 400, 'lease cannot exceed timeout.')
    }

    if (operation === 'renew' && options.renewals === false) {
      response.writeHead(502, { 'content-type': 'application/problem+json' })
      response.end(
        JSON.stringify({
          code: 'upstream_failed',
          detail: 'The provider sells no renewal of this sandbox.',
          status: 502,
        }),
      )
      return
    }
    if (operation === 'create' && tells && now < crowdedUntil) {
      const left = Math.ceil((crowdedUntil - now) / 1000)
      capped.push({ operation, usd })
      if (told) early.push({ operation, usd })
      told = true
      if (authorized) log.push({ operation, refused: 429, usd })
      return problem(
        response,
        429,
        'E2B refused a sandbox for its cap a moment ago. The gateway asks it again in ' +
          left +
          ' s and until then refuses a new sandbox before anything is paid. Nothing was charged.',
        { 'retry-after': String(left) },
        'rate_limited',
        { kept: 0 },
      )
    }
    const authorization = request.headers['authorization']
    if (authorization === undefined && operation === 'renew')
      return problem(
        response,
        402,
        'E2B prices this call only for the wallet that paid for the sandbox, and this caller has no API key of that wallet.',
        {},
        'payment_failed',
      )
    if (authorization === undefined)
      return problem(response, 402, 'Payment is required (compute.' + operation + ').', {
        'www-authenticate': challenge(operation, usd),
      })
    if (authorization !== 'Bearer ' + options.key)
      return problem(response, 401, 'The API key is unknown, revoked or expired.')
    if (operation !== 'create' && (!leased || leased.ended)) {
      log.push({ operation, refused: 404, usd })
      return problem(response, 404, 'Sandbox ' + body['sandboxId'] + ' ended.')
    }
    if (
      (operation === 'create' || operation === 'renew') &&
      !unavailable.some((charge) => charge.operation === operation)
    ) {
      unavailable.push({ operation, usd })
      log.push({ operation, refused: 503, usd })
      response.writeHead(503, { 'content-type': 'application/problem+json' })
      response.end(
        JSON.stringify({
          code: 'unavailable',
          detail: "The gateway cannot pay the network fee to open your key's channel right now.",
          status: 503,
        }),
      )
      return
    }
    const open = [...sandboxes.values()].filter((sandbox) => !sandbox.ended).length
    if (operation === 'create' && cap !== undefined && open >= cap) {
      capped.push({ operation, usd })
      charges.push({ operation, usd })
      log.push({ kept: usd, operation, refused: 429, usd })
      const detail =
        'you have reached the maximum number of concurrent E2B sandboxes (' + cap + ').'
      if (!tells) return problem(response, 429, detail, {}, 'rate_limited')
      crowdedUntil = now + waitSec * 1000
      told = true
      return problem(
        response,
        429,
        detail + ' E2B took ' + usd + ' before it refused, and returns nothing.',
        { 'retry-after': String(waitSec) },
        'rate_limited',
        { kept: usd },
      )
    }
    if (operation === 'renew') {
      if (tells) leased!.expiresAt = leased!.endsAt
      if (until > leased!.expiresAt) {
        log.push({ operation, refused: 409, usd })
        return tells
          ? problem(
              response,
              409,
              'E2B ends it at expiresAt, which no renewal moves. Nothing was charged.',
              {},
              'conflict',
              {
                expiresAt: leased!.expiresAt,
                renewable: Math.max(
                  0,
                  Math.floor((leased!.expiresAt - Math.max(leased!.paidUntil, now)) / 1000),
                ),
              },
            )
          : problem(response, 409, 'the timeout it was created with ends it first', {}, 'conflict')
      }
    }
    const charge = { operation, usd }
    charges.push(charge)
    log.push({ operation, usd })
    const answer = (value: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }

    if (operation === 'create') {
      const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 0 })
      const id = 'sbx' + created.handle.id
      const endsAt = now + Math.min(body['timeout'], lifetimeSec ?? Infinity) * 1000
      const expiresAt = tells ? endsAt : now + body['timeout'] * 1000
      const fresh = {
        endsAt,
        expiresAt,
        handle: created.handle,
        paidUntil: Math.min(now + body['lease'] * 1000, expiresAt),
        renewals: 0,
      }
      sandboxes.set(id, fresh)
      if (holdAfter === 0) held.add(id)
      else if (holdAfter !== undefined) holdAfter--
      return answer(view(id, fresh))
    }
    const id = String(body['sandboxId'])
    const sandbox = provider.connect(leased!.handle)
    const there = (text: string) => text.replaceAll(GatewayProvider.home, leased!.handle.home)
    if (operation === 'renew') {
      leased!.paidUntil = until
      leased!.renewals++
      return answer(view(id, leased!))
    }
    if (operation === 'terminate') {
      await end(id, 'terminated')
      return answer({ refunded: 0, sandboxId: id, status: 'terminated' })
    }
    if (operation === 'write') {
      if (Number(request.headers['gateway-size']) !== raw.length)
        return problem(response, 400, 'Gateway-Size does not match the received bytes.')
      const text = Bytes.toValidText(raw)
      await sandbox.write(
        there(String(request.headers['gateway-path'])),
        text === undefined ? raw : Bytes.fromText(there(text)),
      )
      return answer({ bytes: raw.length })
    }
    const command = body['command'] as string[]
    if (command.length !== 3 || command[0] !== 'bash' || command[1] !== '-lc')
      return problem(response, 400, 'the mock runs bash -lc commands only')
    if (options.bootstrapMs)
      await new Promise((resolve) => setTimeout(resolve, options.bootstrapMs))
    if (held.has(id)) await released
    const output = leased!.ended
      ? undefined
      : await sandbox.exec(there(command[2]!)).catch((error: unknown) => {
          if (!leased!.ended) throw error
          return undefined
        })
    if (!output) {
      charges.splice(charges.indexOf(charge), 1)
      log.push({ late: true, operation, refused: 404, usd })
      return problem(response, 404, 'Sandbox ' + id + ' ended.')
    }
    return answer({ ...output, timedOut: false, truncated: false })
  }

  const server = Http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://gateway').pathname
    const handled = (async () => {
      if (request.headers.upgrade) return problem(response, 404, 'Not found')
      if (request.method === 'PATCH' && path === '/api/keys/me') {
        if (request.headers['authorization'] !== 'Bearer ' + options.key)
          return problem(response, 401, 'The API key is unknown, revoked or expired.')
        funding.push(JSON.parse((await read(request)).toString()))
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        return
      }
      if (request.method === 'GET' && path === '/api/keys/me') {
        if (request.headers['authorization'] !== 'Bearer ' + options.key)
          return problem(response, 401, 'The API key is unknown, revoked or expired.')
        const channel = sum(modelCosts) + sum(charges.map((charge) => charge.usd))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            usage: {
              channel: { deposit: channel.toFixed(6), spent: channel.toFixed(6) },
              limit: {
                remaining: (limitUsd - channel - sum(outside)).toFixed(6),
                total: limitUsd.toFixed(6),
              },
              wallet: { balance: (limitUsd - channel - sum(outside)).toFixed(6) },
            },
          }),
        )
        return
      }
      if (request.method !== 'POST') return problem(response, 405, 'Method not allowed')
      if (path.startsWith('/v1/compute/'))
        return compute(request, response, path.slice('/v1/compute/'.length))
      if (path !== '/v1/messages' && path !== '/v1/responses')
        return problem(response, 404, 'Not found')
      const body = JSON.parse((await read(request)).toString()) as Record<string, any>
      const authorization = request.headers['authorization']
      if (authorization === undefined || request.headers['x-api-key'] !== undefined) {
        refused.push(path + ' without a bearer token alone')
        return problem(response, 402, 'Payment is required.')
      }
      if (authorization !== 'Bearer ' + options.key) {
        refused.push(path + ' with another key')
        return problem(response, 401, 'The API key is unknown, revoked or expired.')
      }
      const passing = options.refusals?.passing ?? 0
      const spent = options.refusals?.spentAfter
      const refusal =
        spent !== undefined &&
        modelCosts.length >= spent &&
        !(
          options.refusals?.spentTimes !== undefined &&
          paymentRefusals.filter((type) => type === refusals.spent.type).length >=
            options.refusals.spentTimes
        )
          ? refusals.spent
          : paymentRefusals.length < passing
            ? refusals.passing[paymentRefusals.length % refusals.passing.length]!
            : undefined
      if (refusal) {
        paymentRefusals.push(refusal.type)
        response.writeHead(402, { 'content-type': 'application/problem+json' })
        response.end(JSON.stringify(refusal))
        return
      }
      const cost = modelUsd[path]
      const reply = options.model(path, body, cost)
      if (reply === undefined) {
        unanswered.push(response)
        return
      }
      modelCosts.push(cost)
      outside.push(searchUsd)
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply)
    })()
    handled.catch((error: unknown) => {
      refused.push(path + ' failed: ' + String(error))
      if (!response.headersSent) problem(response, 400, String(error))
      else response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    cap(limit) {
      cap = limit
    },
    capped,
    charges,
    close() {
      clearInterval(lapse)
      for (const response of unanswered) response.destroy()
      server.close()
    },
    crowd(seconds) {
      crowdedUntil = Date.now() + seconds * 1000
      told = false
    },
    die: (id) => end(id, 'died'),
    early,
    funding,
    hold(after) {
      holdAfter = after
    },
    key: options.key,
    lifetime(seconds) {
      lifetimeSec = seconds
    },
    log,
    modelCosts,
    outside,
    paymentRefusals,
    refused,
    release: () => release(),
    sandboxes,
    tell(on) {
      tells = on
    },
    unavailable,
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
  }
}
