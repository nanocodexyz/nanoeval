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
 */
export function fetcher(ai: Binding, options: { gateway?: string } = {}): Fetch {
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
      return new Response(answer, {
        headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' },
        status: 200,
      })
    if (answer instanceof Response) return answer
    return new Response(JSON.stringify(answer), { headers: json, status: 200 })
  }
}
