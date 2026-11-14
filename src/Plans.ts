import { Egress, Plans, type Store, Vault } from 'nanocode-egress'
import { planSignIn } from './Config.ts'
import type * as Sql from './Sql.ts'

export class UnusableError extends Error {
  override name = 'Plans.UnusableError'
}

export type Account = Plans.Account

export const tables = [
  `CREATE TABLE IF NOT EXISTS plan_records (
    key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
]

const holder = 'owner'

export function store(sql: Sql.Sql): Store.Store {
  return {
    async compareAndSwap(key, options) {
      return sql.transaction(() => {
        const held = sql.all('SELECT revision FROM plan_records WHERE key = ?', key)[0]
        if (((held?.['revision'] as number | undefined) ?? 0) !== options.revision) return undefined
        sql.run(
          `INSERT INTO plan_records (key, revision, payload) VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET revision = excluded.revision, payload = excluded.payload`,
          key,
          options.revision + 1,
          options.payload,
        )
        return options.revision + 1
      })
    },
    async load(key) {
      const held = sql.all('SELECT revision, payload FROM plan_records WHERE key = ?', key)[0]
      return held
        ? { payload: held['payload'] as string, revision: held['revision'] as number }
        : { payload: undefined, revision: 0 }
    },
  }
}

export function target(endpoint: string, base: string | undefined): string {
  if (!base) return endpoint
  const url = new URL(endpoint)
  return base.replace(/\/+$/, '') + url.pathname + url.search
}

export async function account(options: account.Options): Promise<Account> {
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init))
  const plans = Plans.account(
    Vault.sealed(store(options.sql), await Vault.create(options.secret)),
    { account: holder, fetch: (input, init) => send(target(input, options.url), init) },
  )
  return {
    ...plans,
    async signOut(signOut) {
      try {
        await plans.signOut(signOut)
      } catch (error) {
        if (!(error instanceof Vault.InvalidEnvelopeError)) throw error
        options.sql.run(
          'DELETE FROM plan_records WHERE key = ?',
          'plans:' + holder + ':' + signOut.provider,
        )
      }
    },
  }
}

export declare namespace account {
  type Options = {
    fetch?(input: string, init: RequestInit): Promise<Response>
    secret: string
    sql: Sql.Sql
    url?: string
  }
}

function unusable(error: unknown): never {
  throw new UnusableError(
    'the Claude plan that pays for this session gives no credential: ' +
      (error instanceof Error ? error.message : String(error)) +
      ' (' +
      planSignIn +
      ')',
  )
}

export async function send(plans: Account, input: send.Input): Promise<Response> {
  const url = target(Egress.destination('claude', input.endpoint).toString(), input.url)
  const attempt = async () => {
    const injection = await plans.inject('claude').catch(unusable)
    const response = await input.relay({ headers: Egress.headers(input.headers, injection), url })
    return { injection, response }
  }
  const first = await attempt()
  if (first.response.status !== 401) return first.response
  await first.response.body?.cancel()
  await plans.rejected('claude', { generation: first.injection.generation }).catch(unusable)
  return (await attempt()).response
}

export declare namespace send {
  type Input = {
    endpoint: string
    headers: Iterable<[string, string]>
    relay(request: { headers: Headers; url: string }): Promise<Response>
    url?: string
  }
}
