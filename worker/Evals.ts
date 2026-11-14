import { DurableObject } from 'cloudflare:workers'
import * as Eval from '../src/Eval.ts'
import * as Runs from '../src/Runs.ts'
import * as SqlSetup from '../src/Sql.ts'
import type { Env } from './Env.ts'
import * as Storage from './Storage.ts'

export const indexName = '.index'

const indexTable =
  'CREATE TABLE IF NOT EXISTS evals (name TEXT PRIMARY KEY, dataset TEXT NOT NULL, digest TEXT NOT NULL, tasks INTEGER NOT NULL, updated_at INTEGER NOT NULL)'

export type Listed = {
  dataset: string
  digest: string
  name: string
  tasks: number
  updatedAt: number
}

export class Evals extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly sql: SqlSetup.Sql

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = Storage.sql(ctx)
    SqlSetup.setup(this.sql, [...Eval.tables, indexTable, ...Runs.tables])
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = request.method + ' ' + url.pathname
    try {
      if (route === 'GET /index')
        return Storage.json({
          evals: this.sql.all('SELECT * FROM evals ORDER BY name').map(
            (row): Listed => ({
              dataset: row['dataset'] as string,
              digest: row['digest'] as string,
              name: row['name'] as string,
              tasks: row['tasks'] as number,
              updatedAt: row['updated_at'] as number,
            }),
          ),
        })
      if (route === 'POST /index') {
        const entry = (await request.json()) as Listed
        this.sql.run(
          'INSERT OR REPLACE INTO evals (name, dataset, digest, tasks, updated_at) VALUES (?, ?, ?, ?, ?)',
          entry.name,
          entry.dataset,
          entry.digest,
          entry.tasks,
          entry.updatedAt,
        )
        return Storage.json({ ok: true })
      }
      if (route === 'GET /runs') {
        const limit = url.searchParams.get('limit')
        return Storage.json({
          runs: Runs.list(this.sql, limit === null ? undefined : Number(limit)),
        })
      }
      if (route === 'POST /runs') {
        Runs.created(this.sql, (await request.json()) as Runs.Entry)
        return Storage.json({ ok: true })
      }
      if (route === 'POST /runs/ended') {
        Runs.ended(this.sql, (await request.json()) as Runs.Ended)
        return Storage.json({ ok: true })
      }
      if (route === 'POST /versions') {
        const input = (await request.json().catch(() => null)) as Eval.put.Input | null
        if (!input || typeof input.dataset !== 'string' || !Array.isArray(input.tasks))
          throw new Eval.InvalidError('a version names its dataset and lists its tasks')
        const work = this.queue.then(() =>
          Eval.put(this.sql, {
            ...(input.base === undefined ? {} : { base: input.base }),
            dataset: input.dataset,
            now: Date.now(),
            source: input.source ?? {},
            tasks: input.tasks,
          }),
        )
        this.queue = work.catch(() => undefined)
        return Storage.json({ version: await work }, 201)
      }
      if (route === 'GET /versions') return Storage.json({ versions: Eval.versions(this.sql) })
      if (route === 'GET /version') {
        const version = Eval.version(this.sql, url.searchParams.get('digest') ?? undefined)
        if (!version) return Storage.json({ error: 'the eval has no such version' }, 404)
        const limit = url.searchParams.get('limit')
        const selection: Eval.Selection = {
          ...(limit ? { limit: Number(limit) } : {}),
          ...(url.searchParams.has('only') ? { only: url.searchParams.getAll('only') } : {}),
        }
        return Storage.json({
          entries: Eval.select(Eval.entries(this.sql, version.digest), selection),
          ...(url.searchParams.get('tasks') === '1'
            ? { tasks: Eval.tasks(this.sql, version.digest, selection) }
            : {}),
          version,
        })
      }
      return Storage.json({ error: 'route not found' }, 404)
    } catch (error) {
      if (error instanceof Eval.InvalidError) return Storage.json({ error: error.message }, 400)
      if (error instanceof Eval.NotFoundError) return Storage.json({ error: error.message }, 404)
      throw error
    }
  }
}

export function object(env: Env, name: string): DurableObjectStub {
  return env.EVALS.get(env.EVALS.idFromName(name))
}

export async function route(
  request: Request,
  env: Env,
  path: readonly string[],
): Promise<Response> {
  const url = new URL(request.url)
  if (!path.length) {
    if (request.method !== 'GET') return Storage.json({ error: 'method not allowed' }, 405)
    return object(env, indexName).fetch('https://eval.internal/index')
  }
  let reference: Eval.Reference
  try {
    reference = Eval.reference(decodeURIComponent(path[0]!))
  } catch (error) {
    return Storage.json({ error: (error as Error).message }, 400)
  }
  const target = object(env, reference.name)
  if (path[1] === 'versions' && request.method === 'GET')
    return target.fetch('https://eval.internal/versions')
  if (path.length > 1) return Storage.json({ error: 'route not found' }, 404)
  if (request.method === 'GET') {
    const query = new URLSearchParams(url.search)
    if (reference.version) query.set('digest', reference.version)
    return target.fetch('https://eval.internal/version?' + query.toString())
  }
  if (request.method !== 'POST') return Storage.json({ error: 'method not allowed' }, 405)
  const created = await target.fetch('https://eval.internal/versions', {
    body: request.body,
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!created.ok) return created
  const { version } = (await created.json()) as { version: Eval.Version }
  await object(env, indexName).fetch('https://eval.internal/index', {
    body: JSON.stringify({
      dataset: version.dataset,
      digest: version.digest,
      name: reference.name,
      tasks: version.tasks,
      updatedAt: version.createdAt,
    } satisfies Listed),
    method: 'POST',
  })
  return Storage.json({ name: reference.name, version }, 201)
}
