/** The part of a Workers AI binding (`"ai": { "binding": "AI" }`) that a session's chat completions use. */
export type Binding = {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { gateway?: { id: string }; signal?: AbortSignal },
  ): Promise<unknown>
}

export type Fetch = (
  url: string,
  init: { body?: ArrayBuffer; headers?: Headers; method: string; signal?: AbortSignal },
) => Promise<Response>

const json = { 'content-type': 'application/json' }

function failed(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'workers_ai' } }), {
    headers: json,
    status,
  })
}

function event(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice('data:'.length).trim()
  if (!payload.startsWith('{')) return undefined
  try {
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function chunk(line: string, model: string): string {
  const value = event(line)
  if (!value || 'choices' in value || value['response'] !== '' || !value['usage']) return line
  return 'data: ' + JSON.stringify({ choices: [], model, usage: value['usage'] })
}

function trailer(model: string): TransformStream<string, string> {
  let rest = ''
  return new TransformStream({
    flush(controller) {
      if (rest) controller.enqueue(chunk(rest, model))
    },
    transform(text, controller) {
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      if (lines.length)
        controller.enqueue(lines.map((line) => chunk(line, model)).join('\n') + '\n')
    },
  })
}

function last(model: string): TransformStream<string, string> {
  let held: string[] | undefined
  let rest = ''
  const read = (lines: readonly string[]) => {
    const out: string[] = []
    for (const line of lines) {
      if (held?.length === 1 && line === '') {
        held.push(line)
        continue
      }
      if (line.startsWith('data:') && line.slice('data:'.length).trim() === '[DONE]') {
        out.push(...(held ?? []), line)
        held = undefined
        continue
      }
      const value = event(line)
      if (!value || !('usage' in value)) {
        out.push(line)
        continue
      }
      const choices = value['choices']
      if (choices === undefined) {
        const total = chunk(line, model)
        if (total !== line) held = undefined
        out.push(total)
        continue
      }
      if (Array.isArray(choices) && choices.length === 0) {
        held = [line]
        continue
      }
      const { usage: _usage, ...kept } = value
      out.push('data: ' + JSON.stringify(kept))
    }
    return out
  }
  return new TransformStream({
    flush(controller) {
      const whole = held
      const out = read(rest ? [rest] : [])
      const text =
        held === undefined
          ? out.join('\n')
          : held === whole
            ? [...held, ...out].join('\n') + (out.length ? '' : '\n')
            : [...out, ...held].join('\n')
      if (text) controller.enqueue(text)
    },
    transform(text, controller) {
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      const out = read(lines)
      if (out.length) controller.enqueue(out.join('\n') + '\n')
    },
  })
}

/** The status a thrown Workers AI error answers with: 429 for capacity and rate limits, else 502. */
export function status(error: unknown): number {
  const text = error instanceof Error ? error.message : String(error)
  if (/\b429\b|3040|capacity|rate.?limit|too many requests/i.test(text)) return 429
  if (/\b(400|5006|5007|8001)\b|invalid|unknown (model|parameter)|bad input/i.test(text)) return 400
  return 502
}

/**
 * Answers a session's `POST …/ai/v1/chat/completions` through the binding instead of the REST address.
 * The request body (a chat completions request naming its `@cf/` model) goes to `AI.run` unchanged, and the
 * model's chat completions answer comes back as it is: a stream of server-sent events, or one JSON object.
 * With `usage: 'last'` a stream carries its usage once, in a last chunk without choices, as chat completions
 * with `stream_options.include_usage` does: the usage the binding writes on each chunk is left out.
 */
export function fetcher(ai: Binding, options: { gateway?: string; usage?: 'last' } = {}): Fetch {
  return async (url, init) => {
    if (init.method !== 'POST' || !new URL(url).pathname.endsWith('/ai/v1/chat/completions'))
      return failed(404, 'the Workers AI binding serves chat completions only')
    let inputs: Record<string, unknown>
    try {
      inputs = JSON.parse(new TextDecoder().decode(init.body ?? new ArrayBuffer(0)))
    } catch {
      return failed(400, 'the request body is no JSON')
    }
    const model = inputs['model']
    if (typeof model !== 'string' || !model.startsWith('@cf/'))
      return failed(400, 'the request names no @cf/ model')
    let answer: unknown
    try {
      answer = await ai.run(model, inputs, {
        ...(options.gateway ? { gateway: { id: options.gateway } } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      })
    } catch (error) {
      const code = status(error)
      return failed(code, error instanceof Error ? error.message : String(error))
    }
    if (answer instanceof ReadableStream)
      return new Response(
        answer
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(options.usage === 'last' ? last(model) : trailer(model))
          .pipeThrough(new TextEncoderStream()),
        {
          headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' },
          status: 200,
        },
      )
    if (answer instanceof Response) return answer
    return new Response(JSON.stringify(answer), { headers: json, status: 200 })
  }
}
