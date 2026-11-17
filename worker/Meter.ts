import * as Proxy from '../src/Proxy.ts'
import * as Retry from '../src/Retry.ts'
import type * as WorkersAi from './WorkersAi.ts'

export type Outcome = {
  again?: true
  at: number
  firstByteMs?: number
  firstDeltaMs?: number
  flight?: number
  ms: number
  refusal?: Proxy.Refusal
  route?: Route
  status: number
  usage?: Proxy.Usage
  waitMs?: number
}

export type Route = 'workers-ai'

export type Limited = { retryAfterMs?: number; status: number; tries: number }

export type Refused = {
  kind: Exclude<Proxy.Refusal, 'budget' | 'login' | 'model'>
  text: string
  tries: number
}

export type Admission = { flight?: number; pauseMs?: number; refused?: string }

export type Hooks = {
  admit?(waitedMs: number): Promise<Admission>
  limited?(limited: Limited): number | undefined | Promise<number | undefined>
  pace?(): number | undefined | Promise<number | undefined>
  refused?(refusal: Refused): Promise<number | undefined>
  release?(flight: number): void | Promise<void>
  settle(outcome: Outcome): void | Promise<void>
}

export const budgetError = 'model_budget'

const hopHeaders = [
  'connection',
  'content-encoding',
  'content-length',
  'set-cookie',
  'transfer-encoding',
]

function kept(source: Headers): Headers {
  const headers = new Headers()
  source.forEach((value, name) => {
    if (!hopHeaders.includes(name)) headers.set(name, value)
  })
  return headers
}

export function rejecting(hooks: Hooks): Hooks {
  return {
    ...hooks,
    settle: (outcome) =>
      hooks.settle(outcome.status === 401 ? { ...outcome, refusal: 'login' } : outcome),
  }
}

export function routed(hooks: Hooks, route: Route): Hooks {
  return { ...hooks, settle: (outcome) => hooks.settle({ ...outcome, route }) }
}

export async function relay(input: relay.Input): Promise<Response> {
  const { hooks } = input
  const asked = Date.now()
  let flight: number | undefined
  while (hooks.admit) {
    const admission = await hooks.admit(Date.now() - asked)
    if (admission.refused !== undefined) {
      await hooks.settle({ at: asked, ms: Date.now() - asked, refusal: 'budget', status: 402 })
      return Response.json(
        { error: { message: admission.refused, type: budgetError }, type: 'error' },
        { status: 402 },
      )
    }
    if (admission.pauseMs === undefined) {
      flight = admission.flight
      break
    }
    await new Promise((resolve) => setTimeout(resolve, admission.pauseMs))
  }
  const release = async () => {
    if (flight !== undefined) await hooks.release?.(flight)
  }
  try {
    return await forwarded(input, { flight, release })
  } catch (error) {
    await release()
    throw error
  }
}

async function forwarded(
  input: relay.Input,
  held: { flight: number | undefined; release(): Promise<void> },
): Promise<Response> {
  const { hooks } = input
  for (let tries = 0; ; tries++) {
    const heldMs = (await hooks.pace?.()) ?? 0
    if (heldMs) await new Promise((resolve) => setTimeout(resolve, heldMs))
    const waited = heldMs ? { waitMs: heldMs } : {}
    const at = Date.now()
    const upstream = await (input.fetch ?? fetch)(input.url, {
      ...(input.body === undefined ? {} : { body: input.body }),
      headers: input.headers,
      method: input.method,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const headers = kept(upstream.headers)
    if (upstream.status === 402) {
      const text = await upstream.text()
      const kind = Proxy.refusal(text)
      await hooks.settle({
        at,
        ms: Date.now() - at,
        ...(kind ? { refusal: kind } : {}),
        status: upstream.status,
        ...waited,
      })
      const pauseMs = kind && hooks.refused ? await hooks.refused({ kind, text, tries }) : undefined
      if (pauseMs === undefined) {
        await held.release()
        return new Response(text, { headers, status: upstream.status })
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
      continue
    }
    if (hooks.limited && Retry.limited.includes(upstream.status)) {
      const retryAfterMs = Retry.after(upstream.headers.get('retry-after'), Date.now())
      const pauseMs = await hooks.limited({
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        status: upstream.status,
        tries,
      })
      if (pauseMs !== undefined) {
        await upstream.body?.cancel()
        await hooks.settle({
          again: true,
          at,
          ms: Date.now() - at,
          status: upstream.status,
          waitMs: heldMs + pauseMs,
        })
        await new Promise((resolve) => setTimeout(resolve, pauseMs))
        continue
      }
    }
    if (!upstream.body) {
      await hooks.settle({
        at,
        ...(held.flight === undefined ? {} : { flight: held.flight }),
        ms: Date.now() - at,
        status: upstream.status,
        ...waited,
      })
      return new Response(null, { headers, status: upstream.status })
    }
    const meter = Proxy.meter(input.provider, input.cost === false ? { cost: false } : {})
    const decoder = new TextDecoder()
    let settled = false
    const streamed = upstream.headers.get('content-type')?.includes('text/event-stream') ?? false
    let firstByteMs: number | undefined
    let firstDeltaMs: number | undefined
    const settle = async () => {
      if (settled) return
      settled = true
      const usage = meter.usage()
      await hooks.settle({
        at,
        ...(firstByteMs === undefined ? {} : { firstByteMs }),
        ...(firstDeltaMs === undefined ? {} : { firstDeltaMs }),
        ...(held.flight === undefined ? {} : { flight: held.flight }),
        ms: Date.now() - at,
        status: upstream.status,
        ...(usage ? { usage } : {}),
        ...waited,
      })
    }
    const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): Promise<void> } = {
      cancel: settle,
      flush: settle,
      transform(chunk, controller) {
        if (streamed) firstByteMs ??= Date.now() - at
        meter.push(decoder.decode(chunk, { stream: true }))
        if (firstDeltaMs === undefined && meter.delivered()) firstDeltaMs = Date.now() - at
        controller.enqueue(chunk)
      },
    }
    return new Response(upstream.body.pipeThrough(new TransformStream(transformer)), {
      headers,
      status: upstream.status,
    })
  }
}

export declare namespace relay {
  type Input = {
    body?: ArrayBuffer
    cost?: false
    /** Answers the request instead of the network, such as a Workers AI binding. */
    fetch?: WorkersAi.Fetch
    headers: Headers
    hooks: Hooks
    method: string
    provider: Proxy.Provider
    signal?: AbortSignal
    url: string
  }
}

const terminal = ['error', 'response.completed', 'response.failed', 'response.incomplete']

/** Meters a Responses WebSocket: each `response.create` the agent sends is one model request, timed and priced by the same meter as a streamed answer. */
export function frames(input: frames.Input): frames.Frames {
  const { hooks, provider } = input
  const now = input.now ?? Date.now
  const decoder = new TextDecoder()
  let open:
    | {
        at: number
        firstByteMs?: number
        firstDeltaMs?: number
        meter: ReturnType<typeof Proxy.meter>
        status: number
      }
    | undefined
  let settling: Promise<void> = Promise.resolve()
  const text = (data: unknown): string | undefined =>
    typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
        ? decoder.decode(data as ArrayBuffer)
        : undefined
  const parse = (data: string): Record<string, any> | undefined => {
    try {
      const value = JSON.parse(data) as unknown
      return typeof value === 'object' && value !== null
        ? (value as Record<string, any>)
        : undefined
    } catch {
      return undefined
    }
  }
  const settle = () => {
    const done = open
    if (!done) return
    open = undefined
    const usage = done.meter.usage()
    const outcome: Outcome = {
      at: done.at,
      ...(done.firstByteMs === undefined ? {} : { firstByteMs: done.firstByteMs }),
      ...(done.firstDeltaMs === undefined ? {} : { firstDeltaMs: done.firstDeltaMs }),
      ms: now() - done.at,
      status: done.status,
      ...(usage ? { usage } : {}),
    }
    settling = settling.then(
      () => hooks.settle(outcome),
      () => hooks.settle(outcome),
    )
  }
  return {
    sent(data) {
      const value = text(data)
      if (value === undefined || parse(value)?.['type'] !== 'response.create') return
      settle()
      open = {
        at: now(),
        meter: Proxy.meter(provider, input.cost === false ? { cost: false } : {}),
        status: 200,
      }
    },
    received(data) {
      const request = open
      if (!request) return
      const value = text(data)
      if (value === undefined) return
      request.firstByteMs ??= now() - request.at
      request.meter.push('data: ' + value.replace(/\r?\n/g, ' ') + '\n')
      if (request.firstDeltaMs === undefined && request.meter.delivered())
        request.firstDeltaMs = now() - request.at
      const event = parse(value)
      const type = event?.['type']
      if (typeof type !== 'string' || !terminal.includes(type)) return
      if (type === 'error') {
        const status = event?.['status']
        request.status = typeof status === 'number' && status >= 400 ? status : 500
      }
      settle()
    },
    closed() {
      settle()
      return settling
    },
  }
}

export declare namespace frames {
  type Input = {
    cost?: false
    hooks: Pick<Hooks, 'settle'>
    now?: () => number
    provider: Proxy.Provider
  }
  type Frames = {
    /** Settles a request the socket closed before it finished, and resolves once every request is settled. */
    closed(): Promise<void>
    received(data: unknown): void
    sent(data: unknown): void
  }
}

export type Socket = {
  accept(): void
  addEventListener(
    type: 'close' | 'error' | 'message',
    listener: (event: { code?: number; data?: unknown; reason?: string }) => void,
  ): void
  close(code?: number, reason?: string): void
  send(data: string | ArrayBuffer): void
}

/** Passes an upgraded answer through a socket pair that meters it with `frames`; any other answer is returned as it is. */
export function socket(input: socket.Input): Response {
  const upstream = (input.upstream as { webSocket?: Socket | null }).webSocket
  if (input.upstream.status !== 101 || !upstream) return input.upstream
  const [client, server] = (input.pair?.() ??
    Object.values(
      new (
        globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, Socket> }
      ).WebSocketPair(),
    )) as readonly [unknown, Socket]
  const metered = frames(input)
  const shut = (to: Socket, code?: number, reason?: string) => {
    try {
      to.close(code === undefined || code === 1005 || code === 1006 ? 1000 : code, reason)
    } catch {}
  }
  upstream.accept()
  server.accept()
  server.addEventListener('message', (event) => {
    metered.sent(event.data)
    try {
      upstream.send(event.data as string | ArrayBuffer)
    } catch {}
  })
  upstream.addEventListener('message', (event) => {
    metered.received(event.data)
    try {
      server.send(event.data as string | ArrayBuffer)
    } catch {}
  })
  server.addEventListener('close', (event) => {
    void metered.closed()
    shut(upstream, event.code, event.reason)
  })
  upstream.addEventListener('close', (event) => {
    void metered.closed()
    shut(server, event.code, event.reason)
  })
  server.addEventListener('error', () => {
    void metered.closed()
    shut(upstream, 1011)
  })
  upstream.addEventListener('error', () => {
    void metered.closed()
    shut(server, 1011)
  })
  return new Response(null, {
    headers: input.upstream.headers,
    status: 101,
    webSocket: client,
  } as ResponseInit)
}

export declare namespace socket {
  type Input = frames.Input & {
    /** Makes the socket pair the agent and the meter hold, a `WebSocketPair` by default. */
    pair?: () => readonly [unknown, Socket]
    upstream: Response
  }
}
