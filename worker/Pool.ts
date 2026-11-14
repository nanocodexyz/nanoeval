import { DurableObject } from 'cloudflare:workers'
import { privateKeyToAccount } from 'viem/accounts'
import * as Budget from '../src/Budget.ts'
import type * as Config from '../src/Config.ts'
import * as E2b from '../src/E2b.ts'
import * as Gateway from '../src/Gateway.ts'
import * as Hold from '../src/Hold.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Payment from '../src/Payment.ts'
import * as Members from '../src/Pool.ts'
import type * as Protocol from '../src/Protocol.ts'
import type * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import type * as SqlSetup from '../src/Sql.ts'
import { locations, type Env } from './Env.ts'
import * as Storage from './Storage.ts'

export class RequestError extends Error {
  override name = 'Pool.RequestError'
}

const json = Storage.json
const message = Storage.message

function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function same(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', Bytes.fromText(left) as Uint8Array<ArrayBuffer>),
    crypto.subtle.digest('SHA-256', Bytes.fromText(right) as Uint8Array<ArrayBuffer>),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

export function stub(env: Env, location: string | undefined): DurableObjectStub {
  const hint = locations.find((candidate) => candidate === location)
  return env.POOL.get(
    env.POOL.idFromName(hint ? 'pool-' + hint : 'pool'),
    hint ? { locationHint: hint } : undefined,
  )
}

export async function call<T>(env: Env, input: call.Input): Promise<T> {
  const { action, location } = input
  const response = await stub(env, location).fetch(
    'https://pool.internal/internal/' + action + (location ? '?location=' + location : ''),
    { body: JSON.stringify(input.body), method: 'POST' },
  )
  if (!response.ok)
    throw new RequestError(
      'the pool answered ' +
        response.status +
        ' to ' +
        action +
        ': ' +
        (await response.text()).slice(0, 500),
    )
  return (await response.json()) as T
}

export declare namespace call {
  type Input = { action: string; body: unknown; location: string | undefined }
}

export class Pool extends DurableObject<Env> {
  private readonly holds = Hold.create()
  private location: string | undefined
  private readonly sql: SqlSetup.Sql
  private sweeping: Promise<void> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = Storage.sql(ctx)
    Members.setup(this.sql)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    this.location = url.searchParams.get('location') ?? undefined
    if (request.method === 'GET' && !parts.length) return json(this.status())
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (parts[0] === 'internal' && parts[1]) return this.internal(parts[1], body)
    if (parts[0] === 'close' && !parts[1]) {
      for (const member of Members.all(this.sql))
        if (member.state === 'idle') await this.shut(member, 'closed by the operator')
      await this.schedule()
      return json(this.status())
    }
    if (parts[0] === 'members' && !parts[1]) return this.register(body)
    if (parts[0] === 'members' && parts[1] && parts[2]) {
      const member = Members.get(this.sql, Number(parts[1]))
      const header = request.headers.get('authorization') ?? ''
      if (!member || !(await same(header, 'Bearer ' + member.token)))
        return json({ error: 'unauthorized' }, 401)
      if (parts[2] === 'next') return json(await this.next(member.id, body as Protocol.Waiting))
      if (parts[2] === 'leave') {
        const current = Members.get(this.sql, member.id)
        if (current && Members.leaves(current)) await this.shut(current, 'the runner left')
        await this.schedule()
        return json({ left: true })
      }
    }
    return json({ error: 'route not found' }, 404)
  }

  override async alarm(): Promise<void> {
    await this.sweep()
  }

  private holding(id: number): boolean {
    return this.holds.has('member:' + id)
  }

  private release(id: number): void {
    this.holds.release((key) => key === 'member:' + id)
  }

  private status() {
    return {
      members: Members.all(this.sql).map((member) => ({
        createdAt: member.created_at,
        error: member.error,
        expiresAt: member.expires_at,
        handle: member.handle ? (JSON.parse(member.handle) as Sandbox.Handle).id : null,
        holding: this.holding(member.id),
        id: member.id,
        idleSec: member.idle_sec,
        idleUntil: member.idle_until,
        machine: member.machine,
        paidUntil: member.paid_until,
        run: member.run,
        runs: member.runs,
        seenAt: member.seen_at,
        spec: JSON.parse(member.spec) as Members.Spec,
        state: member.state,
      })),
      payments: Members.payments(this.sql),
      spendUsd: Members.spent(this.sql),
    }
  }

  private async internal(action: string, body: Record<string, unknown>): Promise<Response> {
    const now = Date.now()
    if (action === 'enroll') {
      const member = Members.enroll(this.sql, {
        ...(body as Omit<Members.enroll.Input, 'now' | 'token'>),
        now,
        token: secret(),
      })
      return json(this.standing(member))
    }
    if (action === 'take')
      return json({
        member:
          Members.take(this.sql, {
            ...(body as Pick<Members.take.Input, 'lifetimeSec' | 'run' | 'wanted'>),
            holding: (id) => this.holding(id),
            now,
          }) ?? null,
      })
    if (action === 'assign') {
      const input = body as { config: Config.Runner; id: number; run: string }
      const member = Members.get(this.sql, input.id)
      const assigned =
        member !== undefined &&
        Members.assign(this.sql, {
          assignment: JSON.stringify({
            ...input.config,
            pool: this.standing(member),
          } satisfies Config.Runner),
          id: input.id,
          run: input.run,
        })
      if (assigned) this.release(input.id)
      return json({ assigned })
    }
    if (action === 'settle') {
      const kept = Members.settle(this.sql, { ...(body as Omit<Members.settle.Input, 'now'>), now })
      if (kept) await this.schedule()
      return json({ kept })
    }
    if (action === 'drop') {
      const input = body as { error?: string; id: number; run: string }
      const dropped = Members.end(this.sql, input)
      if (dropped) this.release(input.id)
      return json({ dropped })
    }
    return json({ error: 'route not found' }, 404)
  }

  private async register(body: Record<string, unknown>): Promise<Response> {
    const backend = body['backend'] as Slot.Backend
    const network = body['network'] as Slot.Network
    const noticeSec = body['noticeSec']
    const machine = body['machine']
    if (
      !(backend in Slot.networks) ||
      !Slot.networks[backend].includes(network) ||
      !Number.isSafeInteger(noticeSec) ||
      (noticeSec as number) < 1 ||
      !(machine === undefined || (typeof machine === 'string' && /^[0-9a-f-]{36}$/.test(machine)))
    )
      return json(
        {
          error:
            'a standing runner names its backend, a network of it, its notice, and the machine of its members as a UUID',
        },
        400,
      )
    const member = Members.enroll(this.sql, {
      idleSec: 0,
      ...(machine === undefined ? {} : { machine: machine as string }),
      noticeSec: noticeSec as number,
      now: Date.now(),
      spec: { backend, kind: 'machine', network, provider: null, runtime: null, template: null },
      token: secret(),
      usd: 0,
    })
    await this.schedule()
    return json(this.standing(member), 201)
  }

  private standing(member: Members.Member): Protocol.Standing {
    return {
      ...(this.location ? { location: this.location } : {}),
      member: member.id,
      token: member.token,
    }
  }

  private async next(id: number, body: Protocol.Waiting): Promise<Protocol.Next> {
    const asked = typeof body.waitMs === 'number' && body.waitMs > 0 ? body.waitMs : 0
    const until = Date.now() + Math.min(asked, Number(this.env.HOLD_MS))
    if (typeof body.done === 'string')
      Members.served(this.sql, { id, now: Date.now(), run: body.done })
    Members.seen(this.sql, {
      ...(body.capabilities ? { capabilities: body.capabilities } : {}),
      id,
      now: Date.now(),
    })
    for (;;) {
      const member = Members.get(this.sql, id)
      if (!member || member.state === 'closed' || member.state === 'failed')
        return { state: 'closed' }
      if (member.state === 'assigned' && member.assignment)
        return { config: JSON.parse(member.assignment) as Config.Runner, state: 'assigned' }
      const left = until - Date.now()
      if (left <= 0 || (await this.holds.wait('member:' + id, left)) === 'superseded') {
        Members.seen(this.sql, { id, now: Date.now() })
        await this.schedule()
        return { state: 'idle' }
      }
    }
  }

  private provider(member: Members.Member): Sandbox.Provider {
    const spec = JSON.parse(member.spec) as Members.Spec
    if (spec.provider === 'local')
      return Local.create({
        token: this.env.LOCAL_SANDBOX_TOKEN!,
        url: this.env.LOCAL_SANDBOX_URL!,
      })
    const budget = Budget.create({
      limitUsd: member.usd,
      spentUsd: Math.min(member.usd, Math.max(0, Members.spent(this.sql, member.id))),
    })
    const onCharge = (charge: Payment.Charge) =>
      Members.pay(this.sql, {
        at: Date.now(),
        detail: JSON.stringify(charge),
        member: member.id,
        usd: charge.usd,
      })
    if (spec.provider === 'gateway')
      return Gateway.create({
        budget,
        key: this.env.TEMPO_KEY!,
        onCharge,
        ...(this.env.TEMPO_GATEWAY_URL ? { url: this.env.TEMPO_GATEWAY_URL } : {}),
      })
    return E2b.create({
      pay: Payment.payer({
        account: privateKeyToAccount(this.env.TEMPO_PRIVATE_KEY as `0x${string}`),
        budget,
        onCharge,
      }),
    })
  }

  private async shut(member: Members.Member, reason: string): Promise<void> {
    let error: string | undefined
    if (member.handle)
      try {
        await this.provider(member).kill(JSON.parse(member.handle) as Sandbox.Handle)
      } catch (failure) {
        error = reason + ', and its sandbox could not be terminated: ' + message(failure)
      }
    Members.end(this.sql, { ...(error === undefined ? {} : { error }), id: member.id })
    this.release(member.id)
  }

  private sweep(): Promise<void> {
    this.sweeping ??= this.work().finally(() => {
      this.sweeping = undefined
    })
    return this.sweeping
  }

  private async work(): Promise<void> {
    const now = Date.now()
    for (const member of Members.all(this.sql))
      if (member.state === 'idle' && this.holding(member.id))
        Members.seen(this.sql, { id: member.id, now })
    for (const due of Members.due(this.sql, { holding: (id) => this.holding(id), now })) {
      if (due.action === 'close') {
        await this.shut(due.member, due.reason)
        continue
      }
      try {
        const provider = this.provider(due.member)
        if (!provider.renew) throw new Error('the provider renews no lease')
        const renewed = await provider.renew(
          {
            ...(JSON.parse(due.member.handle!) as Sandbox.Handle),
            paidUntil: due.member.paid_until,
          },
          Members.renewal(due.member, Gateway.leaseSec),
        )
        Members.renewed(this.sql, { id: due.member.id, paidUntil: renewed.paidUntil })
      } catch (error) {
        Members.unrenewed(this.sql, { error: message(error), id: due.member.id })
      }
    }
    await this.schedule()
  }

  private async schedule(): Promise<void> {
    const at = Members.wakeAt(this.sql)
    if (at === undefined) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now()))
  }
}
