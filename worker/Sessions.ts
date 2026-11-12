import { App, Forward } from 'nanocode-ts/cloudflare'
import * as Proxy from '../src/Proxy.ts'
import { account, type Env } from './Env.ts'

export async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization') ?? ''
  if (!env.ACCESS_TOKEN || !header.startsWith('Bearer ')) return false

  const encoder = new TextEncoder()
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice('Bearer '.length))),
    crypto.subtle.digest('SHA-256', encoder.encode(env.ACCESS_TOKEN)),
  ])
  return crypto.subtle.timingSafeEqual(actual, expected)
}

export function plan(env: Env, provider: 'claude' | 'codex'): Record<string, string> | undefined {
  if (provider === 'claude')
    return env.CLAUDE_CODE_OAUTH_TOKEN
      ? { authorization: 'Bearer ' + env.CLAUDE_CODE_OAUTH_TOKEN }
      : undefined
  return env.CHATGPT_ACCESS_TOKEN && env.CHATGPT_ACCOUNT_ID
    ? {
        authorization: 'Bearer ' + env.CHATGPT_ACCESS_TOKEN,
        'chatgpt-account-id': env.CHATGPT_ACCOUNT_ID,
      }
    : undefined
}

function refuse(message: string): Response {
  return Response.json(
    { type: 'error', error: { type: 'authentication_error', message } },
    { status: 401 },
  )
}

export const nanocode = App.create<Env>({
  authenticate: async (request, env) => ((await authorized(request, env)) ? account : null),
  egress: (env) =>
    Forward.create({
      fetch: (request, dispatch) => {
        const name = dispatch.provider ?? 'claude'
        const headers = new Headers(request.headers)
        const source = new URL(request.url)
        let target = request.url

        if (dispatch.subscription) {
          const credential = plan(env, name)
          if (!credential) return Promise.resolve(refuse('no ' + name + ' plan login is set'))
          headers.delete('x-api-key')
          for (const [header, value] of Object.entries(credential)) headers.set(header, value)
          if (name === 'codex' && env.CHATGPT_RELAY_URL) {
            target = env.CHATGPT_RELAY_URL.replace(/\/+$/, '') + source.pathname + source.search
            headers.set(Proxy.relaySecretHeader, env.CHATGPT_RELAY_SECRET ?? '')
          }
        } else {
          const held = Proxy.key(env, name)
          if (!held) return Promise.resolve(refuse('no ' + name + ' credential is set'))
          Proxy.authorize(headers, held)
          if (held.base) target = held.base.replace(/\/+$/, '') + source.pathname + source.search
        }

        return fetch(
          new Request(target, {
            method: request.method,
            headers,
            body: request.body,
            signal: request.signal,
          }),
        )
      },
    }),
  hands: 'always',
  subscription: (_account, env, provider) => plan(env, provider) !== undefined,
  workspace: false,
})

export const { AgentSession } = nanocode
