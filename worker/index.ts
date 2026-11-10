import type { Env } from './Env.ts'
import { Run } from './Run.ts'
import { AgentSession, authorized, nanocode } from './Sessions.ts'

export { AgentSession, Run }

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname.startsWith('/sessions/')) return nanocode.fetch(request, env)

    const match = /^\/v1\/runs(?:\/([0-9a-f-]{36})(\/.*)?)?$/.exec(url.pathname)
    if (!match) return json({ error: 'route not found' }, 404)
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)

    const [, id, rest] = match
    if (!id) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      const created = crypto.randomUUID()
      const target = new URL('https://run.internal/create')
      target.searchParams.set('id', created)
      target.searchParams.set('url', (env.PUBLIC_URL || url.origin).replace(/\/+$/, ''))
      return env.RUNS.get(env.RUNS.idFromName(created)).fetch(
        new Request(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request.body,
        }),
      )
    }
    return env.RUNS.get(env.RUNS.idFromName(id)).fetch(
      new Request('https://run.internal' + (rest || '/status') + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    )
  },
} satisfies ExportedHandler<Env>
