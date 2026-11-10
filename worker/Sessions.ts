import { App, Forward } from 'nanocode-ts/cloudflare'
import { account, type Env } from './Env.ts'

const providers = {
  claude: { base: 'ANTHROPIC_BASE_URL', key: 'ANTHROPIC_API_KEY' },
  codex: { base: 'OPENAI_BASE_URL', key: 'OPENAI_API_KEY' },
} as const

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

export const nanocode = App.create<Env>({
  authenticate: async (request, env) => ((await authorized(request, env)) ? account : null),
  egress: (env) =>
    Forward.create({
      fetch: (request, dispatch) => {
        const provider = providers[dispatch.provider ?? 'claude']
        const key = env[provider.key]
        if (!key)
          return Promise.resolve(
            Response.json(
              {
                type: 'error',
                error: { type: 'authentication_error', message: provider.key + ' is not set' },
              },
              { status: 401 },
            ),
          )

        const headers = new Headers(request.headers)
        if (provider.key === 'ANTHROPIC_API_KEY') headers.set('x-api-key', key)
        else headers.set('authorization', 'Bearer ' + key)

        const base = env[provider.base]
        const source = new URL(request.url)
        const target = base
          ? base.replace(/\/+$/, '') + source.pathname + source.search
          : request.url
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
  workspace: false,
})

export const { AgentSession } = nanocode
