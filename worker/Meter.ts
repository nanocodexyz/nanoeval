import * as Proxy from '../src/Proxy.ts'
import * as Retry from '../src/Retry.ts'
import type * as WorkersAi from './WorkersAi.ts'

export type Outcome = {
  again?: true
  at: number
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
    const settle = async () => {
      if (settled) return
      settled = true
      const usage = meter.usage()
      await hooks.settle({
        at,
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
        meter.push(decoder.decode(chunk, { stream: true }))
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
