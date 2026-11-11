import * as Proxy from '../src/Proxy.ts'
import type { Env } from './Env.ts'
import { plan } from './Sessions.ts'

export type Outcome = { status: number; usage?: Proxy.Usage }

const hopHeaders = [
  'connection',
  'content-encoding',
  'content-length',
  'set-cookie',
  'transfer-encoding',
]

export async function refuse(
  request: Request,
  input: { message: string; status: number },
): Promise<Response> {
  const { message, status } = input
  await request.arrayBuffer().catch(() => undefined)
  return Response.json(
    { error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error' } },
    { status },
  )
}

export function credential(env: Env, provider: Proxy.Provider): Proxy.Credential | undefined {
  const headers = plan(env, provider)
  if (headers)
    return {
      headers,
      kind: 'plan',
      ...(provider === 'codex' && env.CHATGPT_RELAY_URL
        ? { relay: { secret: env.CHATGPT_RELAY_SECRET ?? '', url: env.CHATGPT_RELAY_URL } }
        : {}),
    }
  const key = provider === 'claude' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY
  const base = provider === 'claude' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL
  return key ? { ...(base ? { base } : {}), key, kind: 'key' } : undefined
}

export async function forward(env: Env, input: forward.Input): Promise<Response> {
  const { provider, request } = input
  const held = credential(env, provider)
  if (!held) {
    input.settle({ status: 401 })
    return refuse(request, {
      message: 'the deployment has no ' + provider + ' credential',
      status: 401,
    })
  }
  const target = Proxy.forward({
    credential: held,
    headers: request.headers,
    path: input.path,
    provider,
    search: input.search,
  })
  let upstream: Response
  try {
    upstream = await fetch(target.url, {
      body: request.body,
      headers: target.headers,
      method: request.method,
    })
  } catch (error) {
    input.settle({ status: 502 })
    return refuse(request, {
      message: 'the model provider was not reached: ' + String(error),
      status: 502,
    })
  }
  const headers = new Headers()
  upstream.headers.forEach((value, name) => {
    if (!hopHeaders.includes(name)) headers.set(name, value)
  })
  if (!upstream.body) {
    input.settle({ status: upstream.status })
    return new Response(null, { headers, status: upstream.status })
  }
  const meter = Proxy.meter(provider)
  const decoder = new TextDecoder()
  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush() {
        const usage = meter.usage()
        input.settle({ status: upstream.status, ...(usage ? { usage } : {}) })
      },
      transform(chunk, controller) {
        meter.push(decoder.decode(chunk, { stream: true }))
        controller.enqueue(chunk)
      },
    }),
  )
  return new Response(body, { headers, status: upstream.status })
}

export declare namespace forward {
  type Input = {
    path: string
    provider: Proxy.Provider
    request: Request
    search: string
    settle(outcome: Outcome): void
  }
}
