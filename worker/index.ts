import * as Blobs from './Blobs.ts'
import type { Env } from './Env.ts'
import * as Evals from './Evals.ts'
import { Run } from './Run.ts'
import { AgentSession, authorized, nanocode } from './Sessions.ts'
import * as Storage from './Storage.ts'

const { Evals: EvalsObject } = Evals

export { AgentSession, EvalsObject as Evals, Run }

const json = Storage.json

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname.startsWith('/sessions/')) return nanocode.fetch(request, env)

    const [, v1, resource, ...path] = url.pathname.split('/')
    if (v1 !== 'v1' || !resource) return json({ error: 'route not found' }, 404)
    const runner = resource === 'runs' && path[1] === 'runner'
    if (!runner && !(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    if (resource === 'evals') return Evals.route(request, env, path)
    if (resource === 'blobs') return Blobs.route(request, env, path)
    if (resource !== 'runs') return json({ error: 'route not found' }, 404)

    const [id, ...rest] = path
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
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'route not found' }, 404)
    return env.RUNS.get(env.RUNS.idFromName(id)).fetch(
      new Request('https://run.internal/' + (rest.join('/') || 'status') + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    )
  },
} satisfies ExportedHandler<Env>
