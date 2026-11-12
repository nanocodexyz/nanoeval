import * as Proxy from '../src/Proxy.ts'

export type Outcome = {
  at: number
  ms: number
  refusal?: Proxy.Refusal
  status: number
  usage?: Proxy.Usage
}

export type Refused = { kind: Proxy.Refusal; text: string; tries: number }

export type Hooks = {
  refused?(refusal: Refused): Promise<number | undefined>
  settle(outcome: Outcome): void | Promise<void>
}

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

export async function relay(input: relay.Input): Promise<Response> {
  const { hooks } = input
  for (let tries = 0; ; tries++) {
    const at = Date.now()
    const upstream = await fetch(input.url, {
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
      })
      const pauseMs = kind && hooks.refused ? await hooks.refused({ kind, text, tries }) : undefined
      if (pauseMs === undefined) return new Response(text, { headers, status: upstream.status })
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
      continue
    }
    if (!upstream.body) {
      await hooks.settle({ at, ms: Date.now() - at, status: upstream.status })
      return new Response(null, { headers, status: upstream.status })
    }
    const meter = Proxy.meter(input.provider)
    const decoder = new TextDecoder()
    let settled = false
    const settle = async () => {
      if (settled) return
      settled = true
      const usage = meter.usage()
      await hooks.settle({
        at,
        ms: Date.now() - at,
        status: upstream.status,
        ...(usage ? { usage } : {}),
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
    headers: Headers
    hooks: Hooks
    method: string
    provider: Proxy.Provider
    signal?: AbortSignal
    url: string
  }
}
