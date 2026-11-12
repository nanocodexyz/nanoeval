import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as GatewayProvider from '../src/Gateway.ts'
import * as Local from '../src/Local.ts'
import type * as Sandbox from '../src/Sandbox.ts'

export type Charge = { operation: string; usd: number }

export type Leased = {
  ended?: 'lapsed' | 'terminated'
  expiresAt: number
  handle: Sandbox.Handle
  paidUntil: number
  renewals: number
}

export type Mock = {
  readonly charges: readonly Charge[]
  close(): void
  readonly key: string
  readonly modelCosts: readonly number[]
  readonly refused: readonly string[]
  readonly sandboxes: ReadonlyMap<string, Leased>
  readonly url: string
}

export type Options = {
  key: string
  model(path: string, body: Record<string, any>, cost: number): string
  sandboxd: { token: string; url: string }
}

export const callUsd = 0.0001
export const modelUsd = { '/v1/messages': 0.000456, '/v1/responses': 0.000123 }
export const prices: Record<string, number> = { exec: 0.0001, terminate: 0.0001, write: 0.001 }
export const secondUsd = 0.00014
export const templates = ['base', 'code-interpreter-v1', 'desktop']

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
  const charges: Charge[] = []
  const modelCosts: number[] = []
  const refused: string[] = []
  const sandboxes = new Map<string, Leased>()
  const provider = Local.create(options.sandboxd)
  const problem = (
    response: Http.ServerResponse,
    status: number,
    detail: string,
    headers: Record<string, string> = {},
  ) => {
    response.writeHead(status, { 'content-type': 'application/problem+json', ...headers })
    response.end(JSON.stringify({ detail, status }))
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
    const usd =
      operation === 'create'
        ? secondUsd * Number(body['lease']) + callUsd
        : operation === 'renew'
          ? secondUsd * Math.ceil((until - now) / 1000) + callUsd
          : prices[operation]
    if (usd === undefined) return problem(response, 404, 'the gateway has no compute/' + operation)
    if (operation === 'create') {
      if (body['provider'] !== 'e2b' || !templates.includes(body['image']))
        return problem(response, 400, 'templateID must be a public template')
      if (!(body['lease'] >= 1 && body['lease'] <= body['timeout']))
        return problem(response, 400, 'lease cannot exceed timeout.')
    }

    const authorization = request.headers['authorization']
    if (authorization === undefined)
      return problem(response, 402, 'Payment is required (compute.' + operation + ').', {
        'www-authenticate': challenge(operation, usd),
      })
    if (authorization !== 'Bearer ' + options.key)
      return problem(response, 401, 'The API key is unknown, revoked or expired.')
    if (operation !== 'create' && (!leased || leased.ended))
      return problem(response, 404, 'Sandbox ' + body['sandboxId'] + ' ended.')
    charges.push({ operation, usd })
    const answer = (value: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }

    if (operation === 'create') {
      const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 0 })
      const id = 'sbx' + created.handle.id
      const fresh = {
        expiresAt: now + body['timeout'] * 1000,
        handle: created.handle,
        paidUntil: now + body['lease'] * 1000,
        renewals: 0,
      }
      sandboxes.set(id, fresh)
      return answer(view(id, fresh))
    }
    const id = String(body['sandboxId'])
    const sandbox = provider.connect(leased!.handle)
    const there = (text: string) => text.replaceAll(GatewayProvider.home, leased!.handle.home)
    if (operation === 'renew') {
      if (until > leased!.expiresAt)
        return problem(response, 409, 'the timeout it was created with ends it first')
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
      await sandbox.write(there(String(request.headers['gateway-path'])), raw)
      return answer({ bytes: raw.length })
    }
    const command = body['command'] as string[]
    if (command.length !== 3 || command[0] !== 'bash' || command[1] !== '-lc')
      return problem(response, 400, 'the mock runs bash -lc commands only')
    const output = await sandbox.exec(there(command[2]!))
    return answer({ ...output, timedOut: false, truncated: false })
  }

  const server = Http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://gateway').pathname
    const handled = (async () => {
      if (request.headers.upgrade) return problem(response, 404, 'Not found')
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
      const cost = modelUsd[path]
      const reply = options.model(path, body, cost)
      modelCosts.push(cost)
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
    charges,
    close() {
      clearInterval(lapse)
      server.close()
    },
    key: options.key,
    modelCosts,
    refused,
    sandboxes,
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
  }
}
