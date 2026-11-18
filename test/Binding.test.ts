import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import { test } from 'node:test'

import * as WorkersAi from '../worker/WorkersAi.ts'

const url =
  'https://api.cloudflare.com/client/v4/accounts/0a39052b0a32ba8c8444345fe21b7595/ai/v1/chat/completions'
const body = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer

function binding(
  answer: (model: string, inputs: Record<string, unknown>, options: unknown) => unknown,
) {
  const calls: { inputs: Record<string, unknown>; model: string; options: unknown }[] = []
  return {
    ai: {
      run: async (model: string, inputs: Record<string, unknown>, options?: unknown) => {
        calls.push({ inputs, model, options })
        return answer(model, inputs, options)
      },
    },
    calls,
  }
}

test('a chat completions request of a session goes to the binding with its body unchanged, and its stream comes back as server-sent events', async () => {
  const events =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}\n\ndata: [DONE]\n\n'
  const { ai, calls } = binding(() => new Response(events).body)
  const request = {
    messages: [{ content: 'hello', role: 'user' }],
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    reasoning_effort: 'none',
    stream: true,
    stream_options: { include_usage: true },
  }
  const response = await WorkersAi.fetcher(ai, { gateway: 'nanoeval' })(url, {
    body: body(request),
    method: 'POST',
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(await response.text(), events)
  assert.deepEqual(calls, [
    { inputs: request, model: request.model, options: { gateway: { id: 'nanoeval' } } },
  ])
})

test('a native usage trailer of the binding becomes the usage chunk of chat completions, and every other line comes back unchanged', async () => {
  const usage = {
    completion_tokens: 38,
    prompt_tokens: 288,
    prompt_tokens_details: { cached_tokens: 192 },
  }
  const head =
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hi"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n'
  const native = 'data: ' + JSON.stringify({ response: '', usage }) + '\n\ndata: [DONE]\n\n'
  const pieces = [head.slice(0, 37), head.slice(37), native.slice(0, 20), native.slice(20)]
  const { ai } = binding(
    () =>
      new ReadableStream({
        start(controller) {
          for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
          controller.close()
        },
      }),
  )
  const response = await WorkersAi.fetcher(ai)(url, {
    body: body({ messages: [], model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', stream: true }),
    method: 'POST',
  })
  assert.equal(
    await response.text(),
    head +
      'data: ' +
      JSON.stringify({ choices: [], model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', usage }) +
      '\n\ndata: [DONE]\n\n',
  )
})

test('a line without choices that is no empty usage trailer comes back unchanged', async () => {
  const events = 'data: {"response":"hi"}\n\ndata: {"response":"","usage":null}\n\ndata: [DONE]\n\n'
  const { ai } = binding(() => new Response(events).body)
  const response = await WorkersAi.fetcher(ai)(url, {
    body: body({ messages: [], model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', stream: true }),
    method: 'POST',
  })
  assert.equal(await response.text(), events)
})

test('an answer that is no stream comes back as one JSON object', async () => {
  const answer = {
    choices: [{ message: { content: 'hi', role: 'assistant' } }],
    usage: { completion_tokens: 1, prompt_tokens: 3 },
  }
  const { ai } = binding(() => answer)
  const response = await WorkersAi.fetcher(ai)(url, {
    body: body({ messages: [], model: '@cf/zai-org/glm-5.3' }),
    method: 'POST',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), answer)
})

const chunkOf = (fields: Record<string, unknown>) =>
  'data: ' +
  JSON.stringify({
    id: 'chatcmpl-7f051b3d',
    object: 'chat.completion.chunk',
    created: 1794809592,
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    ...fields,
  }) +
  '\n\n'
const part = (prompt: number, completion: number, cached = 0) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: cached },
  neurons: 0.1,
})
const spoken = [
  {
    choices: [
      { index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null },
    ],
    prompt_token_ids: null,
    prompt_text: null,
    p: 'l2h1',
  },
  {
    choices: [
      {
        index: 0,
        delta: { reasoning: 'We', reasoning_content: 'We' },
        logprobs: null,
        finish_reason: null,
        token_ids: null,
      },
    ],
    p: 'us9l',
  },
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'chatcmpl-tool-995b',
              type: 'function',
              function: { name: 'shell', arguments: '{"command": "pwd"}' },
            },
          ],
        },
        logprobs: null,
        finish_reason: 'tool_calls',
        stop_reason: null,
        token_ids: null,
      },
    ],
    p: 'vna5',
  },
]
const parts = [part(5028, 0), part(0, 1), part(0, 9)]
const total = {
  prompt_tokens: 5028,
  completion_tokens: 250,
  total_tokens: 5278,
  prompt_tokens_details: { cached_tokens: 4608 },
  neurons: 41.24070629477501,
}

function pieces(text: string) {
  const sizes = [37, 1, 211, 5, 89]
  const out: string[] = []
  for (let at = 0, n = 0; at < text.length; n += 1) {
    const size = sizes[n % sizes.length]!
    out.push(text.slice(at, at + size))
    at += size
  }
  return () =>
    new ReadableStream({
      start(controller) {
        for (const piece of out) controller.enqueue(new TextEncoder().encode(piece))
        controller.close()
      },
    })
}

test('with usage last, the stream Workers AI writes for deepseek carries its usage once: the usage of each chunk and the empty chunk before the totals are left out', async () => {
  const stream =
    spoken.map((fields, n) => chunkOf({ ...fields, usage: parts[n] })).join('') +
    chunkOf({ choices: [], usage: part(0, 0, 4608), p: 'orzb' }) +
    'data: ' +
    JSON.stringify({ response: '', usage: total }) +
    '\n\ndata: [DONE]\n\n'
  const request = { messages: [], model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', stream: true }
  const asked = async (options: { usage?: 'last' }) =>
    (
      await WorkersAi.fetcher(binding(pieces(stream)).ai, options)(url, {
        body: body(request),
        method: 'POST',
      })
    ).text()
  const last =
    'data: ' +
    JSON.stringify({ choices: [], model: request.model, usage: total }) +
    '\n\ndata: [DONE]\n\n'
  assert.equal(
    await asked({ usage: 'last' }),
    spoken.map((fields) => chunkOf(fields)).join('') + last,
  )
  const session = await asked({})
  assert.equal(
    session,
    spoken.map((fields, n) => chunkOf({ ...fields, usage: parts[n] })).join('') +
      chunkOf({ choices: [], usage: part(0, 0, 4608), p: 'orzb' }) +
      last,
    'a session reads the stream as before',
  )
  const usages = (text: string) =>
    text
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as { usage?: { prompt_tokens: number } })
      .flatMap((value) => (value.usage ? [value.usage.prompt_tokens] : []))
  assert.deepEqual(usages(session), [5028, 0, 0, 0, 5028], 'the prompt tokens fall and rise again')
  assert.deepEqual(usages(await asked({ usage: 'last' })), [5028])
})

test('with usage last, a stream that ends in its own usage chunk and has no totals after it comes back unchanged', async () => {
  const own =
    'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
  for (const stream of [own + 'data: [DONE]\n\n', own, own.trimEnd()]) {
    const response = await WorkersAi.fetcher(binding(pieces(stream)).ai, { usage: 'last' })(url, {
      body: body({ messages: [], model: '@cf/a', stream: true }),
      method: 'POST',
    })
    assert.equal(await response.text(), stream)
  }
})

test('a request the binding cannot serve is refused without calling it', async () => {
  const { ai, calls } = binding(() => ({}))
  const fetch = WorkersAi.fetcher(ai)
  assert.equal(
    (
      await fetch(url.replace('chat/completions', 'responses'), {
        body: body({ model: '@cf/a' }),
        method: 'POST',
      })
    ).status,
    404,
  )
  assert.equal((await fetch(url, { method: 'GET' })).status, 404)
  assert.equal(
    (
      await fetch(url, {
        body: new TextEncoder().encode('{').buffer as ArrayBuffer,
        method: 'POST',
      })
    ).status,
    400,
  )
  assert.equal((await fetch(url, { body: body({ model: 'gpt-5' }), method: 'POST' })).status, 400)
  assert.equal(calls.length, 0)
})

test('an error of the binding answers with a status the meter knows: 429 for capacity, 400 for a bad request, else 502', async () => {
  const fail = (message: string) =>
    WorkersAi.fetcher(
      binding(() => {
        throw new Error(message)
      }).ai,
    )(url, { body: body({ model: '@cf/a' }), method: 'POST' })
  assert.equal((await fail('3040: Capacity temporarily exceeded')).status, 429)
  assert.equal((await fail('5006: invalid input')).status, 400)
  const other = await fail('InferenceUpstreamError: upstream closed')
  assert.equal(other.status, 502)
  assert.match(JSON.stringify(await other.json()), /upstream closed/)
})

test('the deployed Worker binds Workers AI on the tempo account, and a local Worker leaves remote bindings off', () => {
  const config = Fs.readFileSync('wrangler.jsonc', 'utf8')
  assert.match(config, /"ai": \{ "binding": "AI" \}/)
  assert.match(config, /"WORKERS_AI_ACCOUNT_ID": "0a39052b0a32ba8c8444345fe21b7595"/)
  assert.match(
    Fs.readFileSync('cli/nanoeval.ts', 'utf8'),
    /'dev',\n\s+(?:\.\.\.bundle,\n\s+)?'--local',/,
  )
  assert.match(Fs.readFileSync('test/e2e.ts', 'utf8'), /'dev',\n\s+'--local',/)
})
