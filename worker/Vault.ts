import { DurableObject } from 'cloudflare:workers'
import { Egress } from 'nanocode-egress/cloudflare'
import * as Plans from '../src/Plans.ts'
import * as Sql from '../src/Sql.ts'
import { account, type Env } from './Env.ts'
import * as Storage from './Storage.ts'

type Provider = Parameters<Plans.Account['inject']>[0]

export class PlanVault extends DurableObject<Env> {
  private opened: Promise<Plans.Account> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    Sql.setup(Storage.sql(ctx), Plans.tables)
  }

  private plans(): Promise<Plans.Account> {
    return (this.opened ??= Plans.account({
      secret: this.env.PLAN_SECRET ?? '',
      sql: Storage.sql(this.ctx),
      ...(this.env.CLAUDE_PLAN_URL ? { url: this.env.CLAUDE_PLAN_URL } : {}),
    }))
  }

  async complete(options: Parameters<Plans.Account['complete']>[0]) {
    return (await this.plans()).complete(options)
  }

  async inject(provider: Provider) {
    return (await this.plans()).inject(provider)
  }

  async rejected(provider: Provider, options: Parameters<Plans.Account['rejected']>[1]) {
    return (await this.plans()).rejected(provider, options)
  }

  async signIn(options: Parameters<Plans.Account['signIn']>[0]) {
    return (await this.plans()).signIn(options)
  }

  async signOut(options: Parameters<Plans.Account['signOut']>[0]) {
    return (await this.plans()).signOut(options)
  }

  async signedIn(provider: Provider) {
    return (await this.plans()).signedIn(provider)
  }

  async status() {
    return (await this.plans()).status()
  }

  async unusable(): Promise<string | undefined> {
    try {
      await (await this.plans()).inject('claude')
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

const vaults = Egress.durable<Env>((env) => env.PLANS)

const routes = Egress.routes<Env>({ account: () => account, plans: vaults, prefix: '/v1/plans' })

export function vault(env: Env): Plans.Account {
  return vaults(env, account)
}

export async function unusable(env: Env): Promise<string | undefined> {
  if (!env.PLAN_SECRET) return 'the Worker has no PLAN_SECRET'
  return env.PLANS.get(env.PLANS.idFromName(account)).unusable()
}

export async function route(
  request: Request,
  input: { env: Env; path: readonly string[] },
): Promise<Response> {
  if (input.path[0] === 'codex')
    return Storage.json(
      {
        error:
          'a ChatGPT plan on a Worker needs the relay container of nanocode-egress, which this Worker does not run: nanoeval worker --codex-login runs a local Worker on one',
      },
      501,
    )
  if (!input.env.PLAN_SECRET)
    return Storage.json(
      { error: 'plans need PLAN_SECRET, the secret of the Worker that seals a signed-in plan' },
      400,
    )
  return (await routes(request, input.env)) ?? Storage.json({ error: 'route not found' }, 404)
}
