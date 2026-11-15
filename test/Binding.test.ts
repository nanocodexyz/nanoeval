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
  assert.match(Fs.readFileSync('cli/nanoeval.ts', 'utf8'), /'dev',\n\s+'--local',/)
  assert.match(Fs.readFileSync('test/e2e.ts', 'utf8'), /'dev',\n\s+'--local',/)
})
