import * as Proxy from '../src/Proxy.ts'
import type { Env } from './Env.ts'
import * as Meter from './Meter.ts'
import { plan } from './Sessions.ts'

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
  return Proxy.key(env, provider)
}

export async function forward(env: Env, input: forward.Input): Promise<Response> {
  const { provider, request } = input
  const at = Date.now()
  const held = credential(env, provider)
  if (!held) {
    await input.hooks.settle({ at, ms: 0, status: 401 })
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
  const body = await request.arrayBuffer()
  try {
    return await Meter.relay({
      body,
      headers: target.headers,
      hooks: input.hooks,
      method: request.method,
      provider,
      url: target.url,
    })
  } catch (error) {
    await input.hooks.settle({ at, ms: Date.now() - at, status: 502 })
    return refuse(request, {
      message: 'the model provider was not reached: ' + String(error),
      status: 502,
    })
  }
}

export declare namespace forward {
  type Input = {
    hooks: Meter.Hooks
    path: string
    provider: Proxy.Provider
    request: Request
    search: string
  }
}
