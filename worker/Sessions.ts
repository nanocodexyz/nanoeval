import { App, Forward } from 'nanocode-ts/cloudflare'
import * as Proxy from '../src/Proxy.ts'
import { account, type Env } from './Env.ts'
import * as Meter from './Meter.ts'

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
      fetch: async (request, dispatch) => {
        const name = dispatch.provider ?? 'claude'
        const headers = new Headers(request.headers)
        const source = new URL(request.url)
        let target = request.url

        if (dispatch.subscription) {
          const credential = plan(env, name)
          if (!credential) return refuse('no ' + name + ' plan login is set')
          headers.delete('x-api-key')
          for (const [header, value] of Object.entries(credential)) headers.set(header, value)
          if (name === 'codex' && env.CHATGPT_RELAY_URL) {
            target = env.CHATGPT_RELAY_URL.replace(/\/+$/, '') + source.pathname + source.search
            headers.set(Proxy.relaySecretHeader, env.CHATGPT_RELAY_SECRET ?? '')
          }
        } else {
          const held = Proxy.key(env, name)
          if (!held) return refuse('no ' + name + ' credential is set')
          Proxy.authorize(headers, held)
          if (held.base) target = held.base.replace(/\/+$/, '') + source.pathname + source.search
        }

        if (request.method !== 'POST' || headers.has('upgrade'))
          return fetch(
            new Request(target, {
              method: request.method,
              headers,
              body: request.body,
              signal: request.signal,
            }),
          )
        const session = Proxy.session(dispatch.authority.session_name ?? '')
        const path =
          (session?.judge === undefined ? '' : 'judge/') +
          new URL(target).pathname.replace(/^\/+/, '')
        const tell = async (body: Record<string, unknown>): Promise<{ pauseMs?: number }> => {
          const answer = await env.RUNS.get(env.RUNS.idFromName(session!.run)).fetch(
            'https://run.internal/metered',
            { body: JSON.stringify({ ...session, ...body }), method: 'POST' },
          )
          if (!answer.ok) throw new Error('the run answered ' + answer.status)
          return (await answer.json()) as { pauseMs?: number }
        }
        return Meter.relay({
          body: await request.arrayBuffer(),
          headers,
          hooks: {
            ...(session
              ? {
                  refused: (refused: Meter.Refused) =>
                    tell({ refused }).then(
                      (answer) => answer.pauseMs,
                      () => undefined,
                    ),
                }
              : {}),
            settle: async (outcome) => {
              if (session) await tell({ outcome, path }).catch(() => {})
            },
          },
          method: request.method,
          provider: name,
          signal: request.signal,
          url: target,
        })
      },
    }),
  hands: 'always',
  subscription: (_account, env, provider) => plan(env, provider) !== undefined,
  workspace: false,
})

export const { AgentSession } = nanocode
