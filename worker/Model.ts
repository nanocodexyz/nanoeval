import * as Logins from '../src/Logins.ts'
import * as Plans from '../src/Plans.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Route from '../src/Route.ts'
import type { Env } from './Env.ts'
import * as Meter from './Meter.ts'

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
  if (Logins.held(env, provider))
    return {
      headers: {},
      kind: 'plan',
      ...(provider === 'codex' && env.CHATGPT_RELAY_URL
        ? { relay: { secret: env.CHATGPT_RELAY_SECRET ?? '', url: env.CHATGPT_RELAY_URL } }
        : {}),
    }
  return Proxy.key(env, provider)
}

export function paid(
  env: Env,
  input: { plan: boolean; provider: Proxy.Provider },
): Route.Paid | undefined {
  return Route.paid({
    gateway: env.TEMPO_KEY,
    held: credential(env, input.provider),
    plan: input.plan,
  })
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
  const body = await request.arrayBuffer()
  const relay = (credential: Proxy.Credential) => {
    const target = Proxy.forward({
      credential,
      headers: request.headers,
      path: input.path,
      provider,
      search: input.search,
    })
    return Meter.relay({
      body,
      headers: target.headers,
      hooks: input.hooks,
      method: request.method,
      provider,
      url:
        credential.kind === 'plan' && provider === 'claude'
          ? Plans.target(target.url, env.CLAUDE_PLAN_URL)
          : target.url,
    })
  }
  try {
    if (held.kind === 'key') return await relay(held)
    return await Logins.send({
      attempt: (headers) => relay({ ...held, headers }),
      credential: (rejected) =>
        Logins.headers(env, { provider, ...(rejected === undefined ? {} : { rejected }) }),
    })
  } catch (error) {
    if (error instanceof Logins.RefusedError) {
      await input.hooks.settle({ at, ms: Date.now() - at, refusal: 'plan', status: 401 })
      await input.hooks.refused?.({ kind: 'plan', text: error.message, tries: 0 })
      return refuse(request, { message: error.message, status: 401 })
    }
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
