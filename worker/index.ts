import * as Protocol from '../src/Protocol.ts'
import type * as Runs from '../src/Runs.ts'
import * as Blobs from './Blobs.ts'
import { locations, type Env } from './Env.ts'
import * as Evals from './Evals.ts'
import * as PoolObject from './Pool.ts'
import { Run } from './Run.ts'
import { AgentSession, authorized, nanocode } from './Sessions.ts'
import * as Storage from './Storage.ts'
import * as Vault from './Vault.ts'

const { Evals: EvalsObject } = Evals
const { Pool } = PoolObject
const { PlanVault } = Vault

export { AgentSession, EvalsObject as Evals, PlanVault, Pool, Run }

const json = Storage.json

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname.startsWith('/sessions/')) return nanocode.fetch(request, env)

    const [, v1, resource, ...path] = url.pathname.split('/')
    if (v1 !== 'v1' || !resource) return json({ error: 'route not found' }, 404)
    const runner =
      (resource === 'runs' && (path[1] === 'runner' || path[1] === 'model')) ||
      (resource === 'pool' && path[0] === 'members' && path.length === 3)
    if (!runner && !(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    if (resource === 'version')
      return json({
        commit: env.COMMIT || null,
        protocol: Protocol.version,
      } satisfies Protocol.Version)
    if (resource === 'evals') return Evals.route(request, env, path)
    if (resource === 'blobs') return Blobs.route(request, env, path)
    if (resource === 'plans') return Vault.route(request, { env, path })
    const location = url.searchParams.get('location') ?? env.RUN_LOCATION_HINT
    const hint = locations.find((candidate) => candidate === location)
    if (location && !hint)
      return json({ error: 'a location is one of ' + locations.join(', ') }, 400)
    if (resource === 'pool' && !path.includes('internal'))
      return PoolObject.stub(env, hint).fetch(
        new Request('https://pool.internal/' + path.join('/') + (hint ? '?location=' + hint : ''), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
      )
    if (resource !== 'runs') return json({ error: 'route not found' }, 404)

    const [id, ...rest] = path
    if (!id && request.method === 'GET') {
      const limit = url.searchParams.get('limit')
      if (limit !== null && !/^[1-9][0-9]*$/.test(limit))
        return json({ error: 'limit is a number of runs above zero' }, 400)
      const listed = await Evals.object(env, Evals.indexName).fetch(
        'https://eval.internal/runs' + (limit === null ? '' : '?limit=' + limit),
      )
      const { runs } = (await listed.json()) as { runs: Runs.Listed[] }
      return json({
        runs: await Promise.all(
          runs.map(async (run): Promise<Runs.Listed> => {
            if (run.state === 'finished') return run
            const live = await env.RUNS.get(env.RUNS.idFromName(run.id)).fetch(
              'https://run.internal/counts',
            )
            if (!live.ok) return run
            const { counts, finishedAt } = (await live.json()) as {
              counts: Runs.Counts
              finishedAt: number | null
            }
            return {
              ...run,
              counts,
              finishedAt,
              state: finishedAt === null ? 'running' : 'finished',
            }
          }),
        ),
      })
    }
    if (!id) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
      const created = crypto.randomUUID()
      const target = new URL('https://run.internal/create')
      target.searchParams.set('id', created)
      target.searchParams.set('url', (env.PUBLIC_URL || url.origin).replace(/\/+$/, ''))
      if (hint) target.searchParams.set('location', hint)
      return env.RUNS.get(
        env.RUNS.idFromName(created),
        hint ? { locationHint: hint } : undefined,
      ).fetch(
        new Request(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request.body,
        }),
      )
    }
    if (!/^[0-9a-f-]{36}$/.test(id) || rest[0] === 'metered')
      return json({ error: 'route not found' }, 404)
    return env.RUNS.get(env.RUNS.idFromName(id)).fetch(
      new Request('https://run.internal/' + (rest.join('/') || 'status') + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    )
  },
} satisfies ExportedHandler<Env>
