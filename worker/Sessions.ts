import { env as bound } from 'cloudflare:workers'
import type { Contracts } from 'nanocode-ts'
import { App, Forward } from 'nanocode-ts/cloudflare'
import manifest from '../package.json' with { type: 'json' }
import type * as Atif from '../src/Atif.ts'
import * as Blocklist from '../src/Blocklist.ts'
import type * as Config from '../src/Config.ts'
import * as Logins from '../src/Logins.ts'
import * as Pins from '../src/Pins.ts'
import * as Plans from '../src/Plans.ts'
import * as Picker from '../src/Picker.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Sql from '../src/Sql.ts'
import * as Telemetry from '../src/Telemetry.ts'
import { account, type Env } from './Env.ts'
import * as Meter from './Meter.ts'
import * as Storage from './Storage.ts'
import * as WorkersAi from './WorkersAi.ts'
import * as Vault from './Vault.ts'

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

function refuse(message: string): Response {
  return Response.json(
    { type: 'error', error: { type: 'authentication_error', message } },
    { status: 401 },
  )
}

const cellYieldMs = (bound as Env).CELL_YIELD_MS

type Opened = App.create.Limits & Pick<Contracts.AgentConfiguration, 'cell_yield_ms'>

async function agentOf(env: Env, session: Proxy.Session): Promise<Config.Agent> {
  const answer = await env.RUNS.get(env.RUNS.idFromName(session.run)).fetch(
    'https://run.internal/attempts/' + session.attempt + '/agent',
  )
  if (!answer.ok) throw new Error('the run answered ' + answer.status)
  return answer.json<Config.Agent>()
}

export const revision =
  (bound as Env).NANOCODE_TS_REVISION || Pins.pinned(manifest.dependencies['nanocode-ts'])

export const nanocode = App.create<Env>({
  authenticate: async (request, env) => ((await authorized(request, env)) ? account : null),
  egress: (env) =>
    Forward.create({
      fetch: async (request, dispatch) => {
        const name = dispatch.provider ?? 'claude'
        const headers = new Headers(request.headers)
        const source = new URL(request.url)
        const login = dispatch.subscription && dispatch.payer !== 'plan' && Logins.held(env, name)
        const signed = dispatch.subscription && !login
        let target = request.url
        const workersAi = Proxy.workersAi(request.url, env.WORKERS_AI_GATEWAY_URL)

        const binding =
          workersAi && !env.WORKERS_AI_TOKEN && env.AI
            ? WorkersAi.fetcher(
                env.AI,
                env.WORKERS_AI_GATEWAY ? { gateway: env.WORKERS_AI_GATEWAY } : {},
              )
            : undefined

        if (workersAi) {
          if (env.WORKERS_AI_TOKEN)
            Proxy.authorize(headers, { key: env.WORKERS_AI_TOKEN, kind: 'key', scheme: 'bearer' })
          else if (!binding) return refuse('no Workers AI binding or credential is set')
          target = workersAi
        } else if (signed) {
          if (name !== 'claude' || request.method !== 'POST')
            return refuse('no ' + name + ' plan login is set')
        } else if (login) {
          headers.delete('x-api-key')
          if (name === 'claude') target = Plans.target(request.url, env.CLAUDE_PLAN_URL)
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

        const session = Proxy.session(dispatch.authority.session_name ?? '')
        const path =
          (session?.judge !== undefined
            ? 'judge/'
            : session?.verifier !== undefined
              ? Picker.path
              : '') + new URL(target).pathname.replace(/^\/+/, '')
        const tell = async (body: Record<string, unknown>): Promise<Meter.Admission> => {
          const answer = await env.RUNS.get(env.RUNS.idFromName(session!.run)).fetch(
            'https://run.internal/metered',
            { body: JSON.stringify({ ...session, ...body }), method: 'POST' },
          )
          if (!answer.ok) throw new Error('the run answered ' + answer.status)
          return (await answer.json()) as Meter.Admission
        }
        const hooks: Meter.Hooks = {
          ...(session
            ? {
                admit: (waitedMs: number) => tell({ admit: { waitedMs } }).catch(() => ({})),
                pace: () =>
                  tell({ pace: true, path }).then(
                    (answer) => answer.pauseMs,
                    () => undefined,
                  ),
                refused: (refused: Meter.Refused) =>
                  tell({ refused }).then(
                    (answer) => answer.pauseMs,
                    () => undefined,
                  ),
                release: (flight: number) =>
                  tell({ released: flight }).then(
                    () => {},
                    () => {},
                  ),
              }
            : {}),
          settle: async (outcome) => {
            if (session) await tell({ outcome, path, provider: name }).catch(() => {})
          },
        }
        const unpaid = async (error: unknown): Promise<Response> => {
          if (!(error instanceof Plans.UnusableError) && !(error instanceof Logins.RefusedError))
            throw error
          await hooks.settle({ at: Date.now(), ms: 0, refusal: 'plan', status: 401 })
          await hooks.refused?.({ kind: 'plan', text: error.message, tries: 0 })
          return refuse(error.message)
        }
        const credential = (rejected?: string) =>
          Logins.headers(env, { provider: name, ...(rejected === undefined ? {} : { rejected }) })
        const carrying = (held: Logins.Headers): Headers => {
          const sent = new Headers(headers)
          for (const [header, value] of Object.entries(held)) sent.set(header, value)
          return sent
        }
        if (binding && (request.method !== 'POST' || headers.has('upgrade')))
          return refuse('the Workers AI binding serves chat completions only')
        if (request.method !== 'POST' || headers.has('upgrade')) {
          const plain = (sent: Headers) =>
            fetch(
              new Request(target, {
                method: request.method,
                headers: sent,
                body: request.body,
                signal: request.signal,
              }),
            )
          if (!login) return plain(headers)
          try {
            if (request.body) return await plain(carrying(await credential()))
            return await Logins.send({ attempt: (held) => plain(carrying(held)), credential })
          } catch (error) {
            return unpaid(error)
          }
        }
        let body = await request.arrayBuffer()
        if (name === 'claude' && session && session.judge === undefined) {
          let value: Record<string, unknown> | undefined
          try {
            const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
            if (typeof parsed === 'object' && parsed !== null)
              value = parsed as Record<string, unknown>
          } catch {}
          if (value && Blocklist.searches(value)) {
            const held = (await agentOf(env, session)) as Config.Agent & {
              webBlocklist?: Blocklist.List
            }
            if (held.webBlocklist) {
              const filtered = Blocklist.anthropic(value, held.webBlocklist)
              if ('refusal' in filtered)
                return Response.json(
                  {
                    type: 'error',
                    error: { type: 'invalid_request_error', message: filtered.refusal },
                  },
                  { status: 400 },
                )
              body = new TextEncoder().encode(JSON.stringify(filtered.body)).buffer as ArrayBuffer
            }
          }
        }
        const relay = (to: { headers: Headers; url: string }) =>
          Meter.relay({
            body,
            ...(workersAi ? { cost: false as const } : {}),
            ...(binding ? { fetch: binding } : {}),
            headers: to.headers,
            hooks: signed || login ? Meter.rejecting(hooks) : hooks,
            method: request.method,
            provider: name,
            signal: request.signal,
            url: to.url,
          })
        if (!signed && !login) return relay({ headers, url: target })
        try {
          if (login)
            return await Logins.send({
              attempt: (held) => relay({ headers: carrying(held), url: target }),
              credential,
            })
          return await Plans.send(Vault.vault(env), {
            endpoint: request.url,
            headers: dispatch.headers,
            relay,
            ...(env.CLAUDE_PLAN_URL ? { url: env.CLAUDE_PLAN_URL } : {}),
          })
        } catch (error) {
          return unpaid(error)
        }
      },
    }),
  hands: 'always',
  headless: true,
  hedge: { cap_percent: 0 },
  limits: async (opened, env): Promise<Opened> => {
    const session = Proxy.session(opened.authority.session_name ?? '')
    const named =
      session && session.judge === undefined ? (await agentOf(env, session)).cellYieldMs : undefined
    const ms = named ?? (cellYieldMs ? Number(cellYieldMs) : undefined)
    return ms === undefined ? {} : { cell_yield_ms: ms }
  },
  subscription: async (_account, env, provider) =>
    Logins.held(env, provider) ||
    (provider === 'claude' && (await Vault.unusable(env)) === undefined),
  workspace: false,
})

type Destroy = () => Promise<Response>

type Published = (scope: string, events: Atif.SessionEvent[], bytes: number[]) => void

const hosted = nanocode.AgentSession

function inherited<Method>(name: string, missing: string): Method {
  const method = (hosted.prototype as unknown as Record<string, unknown>)[name]
  if (typeof method !== 'function') throw new Error('this nanocode-ts build does not ' + missing)
  return method as Method
}

const destroy = inherited<Destroy>('destroy', 'delete a session in its object')

const publish = inherited<Published>('published', 'hand the events of a session to its object')

const removed = { code: 1000, reason: 'session deleted' }

export class AgentSession extends hosted {
  private readonly closing = new Map<WebSocket, () => void>()
  private detached: Promise<void> | undefined
  private open = true
  private readonly sql: Sql.Sql
  private readonly streams = new Set<() => Promise<void>>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = Storage.sql(ctx)
    Sql.setup(this.sql, Telemetry.tables)
  }

  async destroy(): Promise<Response> {
    this.detached ??= this.detach()
    await this.detached
    return destroy.call(this)
  }

  private async detach(): Promise<void> {
    await Promise.all([...this.streams].map((end) => end()))
    const closed = this.ctx.getWebSockets().map(
      (socket) =>
        new Promise<void>((resolve) => {
          this.closing.set(socket, resolve)
          try {
            socket.close(removed.code, removed.reason)
          } catch {
            resolve()
          }
        }),
    )
    let stop = () => {}
    const expired = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Number(this.env.REMOTE_TIMEOUT_MS))
      stop = () => clearTimeout(timer)
    })
    await Promise.race([Promise.all(closed), expired])
    stop()
  }

  published(scope: string, events: Atif.SessionEvent[], bytes: number[]): void {
    if (scope === Telemetry.scope)
      this.open = Telemetry.record(this.sql, { events, open: this.open })
    const logged = events.flatMap((event, index) => (Telemetry.live(event) ? [] : [index]))
    publish.call(
      this,
      scope,
      logged.map((index) => events[index]!),
      logged.map((index) => bytes[index]!),
    )
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.detached) return Storage.json({ error: removed.reason }, 410)
    const response = await super.fetch(request)
    if (response.body && response.headers.get('content-type') === 'text/event-stream')
      return this.streamed(response)
    if (!request.headers.has(Telemetry.header) || !response.ok) return response
    const page = await response.json<{ has_more: boolean; next_cursor: number }>()
    return Storage.json({
      ...page,
      telemetry: Telemetry.read(this.sql, {
        after: Number(new URL(request.url).searchParams.get('after') ?? '0'),
        last: !page.has_more,
        through: page.next_cursor,
      }),
    })
  }

  private streamed(response: Response): Response {
    const { readable, writable } = new IdentityTransformStream()
    const reader = response.body!.getReader()
    const writer = writable.getWriter()
    const end = () => reader.cancel().catch(() => {})
    const copy = async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return writer.close()
        await writer.write(chunk.value)
      }
    }
    this.streams.add(end)
    void copy()
      .catch((error) => Promise.all([end(), writer.abort(error)]))
      .catch(() => {})
      .finally(() => this.streams.delete(end))
    return new Response(readable, response)
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await super.webSocketClose?.(socket, code, reason, wasClean)
    this.closing.get(socket)?.()
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    await super.webSocketError?.(socket, error)
    this.closing.get(socket)?.()
  }
}
