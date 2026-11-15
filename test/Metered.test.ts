import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { summary } from '../cli/nanoeval.ts'
import * as Arms from '../src/Arms.ts'
import * as Installed from '../src/Installed.ts'
import * as Price from '../src/Price.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Result from '../src/Result.ts'
import * as Meter from '../worker/Meter.ts'

const recorded: readonly Proxy.Usage[] = [
  {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    inputTokens: 3948,
    model: 'gpt-6-luna',
    outputTokens: 203,
    reasoningTokens: 0,
  },
  {
    cacheWriteTokens: 0,
    cachedTokens: 1664,
    inputTokens: 4374,
    model: 'gpt-6-luna',
    outputTokens: 432,
    reasoningTokens: 329,
  },
  {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    inputTokens: 4938,
    model: 'gpt-6-luna',
    outputTokens: 716,
    reasoningTokens: 114,
  },
  {
    cacheWriteTokens: 0,
    cachedTokens: 1664,
    inputTokens: 5684,
    model: 'gpt-6-luna',
    outputTokens: 455,
    reasoningTokens: 48,
  },
  {
    cacheWriteTokens: 0,
    cachedTokens: 1664,
    inputTokens: 6624,
    model: 'gpt-6-luna',
    outputTokens: 200,
    reasoningTokens: 33,
  },
]

const event = (name: string, data: unknown) =>
  'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'

const responsesStream = (usage: Proxy.Usage) =>
  event('response.created', { response: { model: usage.model, status: 'in_progress' } }) +
  event('response.output_text.delta', { delta: 'done', type: 'response.output_text.delta' }) +
  event('response.completed', {
    response: {
      model: usage.model,
      output: [{ type: 'message' }],
      status: 'completed',
      usage: {
        input_tokens: usage.inputTokens,
        input_tokens_details: { cached_tokens: usage.cachedTokens },
        output_tokens: usage.outputTokens,
        output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    },
    type: 'response.completed',
  })

const messagesStream =
  event('message_start', {
    message: {
      model: 'claude-opus-5-5',
      usage: {
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 2100 },
        cache_creation_input_tokens: 2100,
        cache_read_input_tokens: 4700,
        input_tokens: 9,
        output_tokens: 1,
      },
    },
    type: 'message_start',
  }) +
  event('content_block_delta', { delta: { text: 'done', type: 'text_delta' }, index: 0 }) +
  event('message_delta', {
    delta: { stop_reason: 'end_turn' },
    type: 'message_delta',
    usage: { output_tokens: 250 },
  }) +
  event('message_stop', { type: 'message_stop' })

const chatChunk = (fields: Record<string, unknown>) =>
  'data: ' +
  JSON.stringify({ id: 'c', model: '@cf/zai-org/glm-5.3-flash', object: 'chunk', ...fields }) +
  '\n\n'

const chatStream = (usage: boolean) =>
  chatChunk({ choices: [{ delta: { content: 'done' }, index: 0 }], usage: null }) +
  chatChunk({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: null }) +
  (usage
    ? chatChunk({
        choices: [],
        usage: {
          completion_tokens: 310,
          completion_tokens_details: { reasoning_tokens: 120 },
          prompt_tokens: 7200,
          prompt_tokens_details: { cached_tokens: 6400 },
          total_tokens: 7510,
        },
      })
    : '') +
  'data: [DONE]\n\n'

function metered(provider: Proxy.Provider, body: string, pieces = 1): Proxy.Usage | undefined {
  const meter = Proxy.meter(provider)
  const size = Math.ceil(body.length / pieces)
  for (let at = 0; at < body.length; at += size) meter.push(body.slice(at, at + size))
  return meter.usage()
}

function priced(usage: Proxy.Usage, prices?: Price.List): Proxy.Usage {
  const price = usage.costUsd === undefined ? Price.of(usage.model!, prices) : undefined
  return price ? { ...usage, costBy: 'list', costUsd: Price.usd(price, usage) } : usage
}

const answered = (path: string, usage: Proxy.Usage | undefined): Installed.Relayed => ({
  path,
  status: 200,
  usage,
})

test('a streamed answer of the responses route is metered by class, in whatever pieces it arrives', () => {
  for (const usage of recorded)
    for (const pieces of [1, 7, 400])
      assert.deepEqual(metered('codex', responsesStream(usage), pieces), usage)
  const whole = JSON.stringify({
    model: 'gpt-6-luna',
    output: [],
    usage: {
      input_tokens: 4374,
      input_tokens_details: { cached_tokens: 1664 },
      output_tokens: 432,
      output_tokens_details: { reasoning_tokens: 329 },
    },
  })
  assert.deepEqual(metered('codex', whole, 3), recorded[1])
})

test('the answers of the messages and of the chat route are metered by class, streamed or whole', () => {
  const messages = {
    cacheWriteTokens: 2100,
    cachedTokens: 4700,
    inputTokens: 9 + 4700 + 2100,
    model: 'claude-opus-5-5',
    outputTokens: 250,
  }
  assert.deepEqual(metered('claude', messagesStream, 5), messages)
  assert.deepEqual(
    metered(
      'claude',
      JSON.stringify({
        content: [],
        model: 'claude-opus-5-5',
        type: 'message',
        usage: {
          cache_creation_input_tokens: 2100,
          cache_read_input_tokens: 4700,
          input_tokens: 9,
          output_tokens: 250,
        },
      }),
    ),
    messages,
  )
  const chat = {
    cacheWriteTokens: 0,
    cachedTokens: 6400,
    inputTokens: 7200,
    model: '@cf/zai-org/glm-5.3-flash',
    outputTokens: 310,
    reasoningTokens: 120,
  }
  assert.deepEqual(metered('codex', chatStream(true), 4), chat)
  assert.deepEqual(
    metered(
      'codex',
      JSON.stringify({
        choices: [{ message: { content: 'done' } }],
        model: '@cf/zai-org/glm-5.3-flash',
        usage: {
          completion_tokens: 310,
          completion_tokens_details: { reasoning_tokens: 120 },
          prompt_tokens: 7200,
          prompt_tokens_details: { cached_tokens: 6400 },
        },
      }),
    ),
    chat,
  )
  assert.equal(metered('codex', chatStream(false)), undefined, 'a stream that names no usage')
})

test('the requests of a row are priced at the list price of its model, which a price of the run replaces', () => {
  const tokens = { cached: 4992, input: 25568, output: 2006, reasoning: 524 }
  const listUsd =
    ((tokens.input - tokens.cached) * 0.1 + tokens.cached * 0.01 + tokens.output * 0.5) / 1e6
  const row = Installed.metered(
    'codex',
    recorded.map((usage) => answered('responses', priced(usage))),
  )
  assert.deepEqual(
    { ...row, costUsd: undefined },
    {
      cacheWriteTokens: 0,
      cachedTokens: tokens.cached,
      costBy: 'list',
      costUsd: undefined,
      inputTokens: tokens.input,
      modelCalls: 5,
      outputTokens: tokens.output,
      reasoningTokens: tokens.reasoning,
      toolCalls: 0,
    },
  )
  assert.ok(Math.abs(row.costUsd! - listUsd) < 1e-12)

  const own = { 'gpt-6-luna': { cachedUsd: 1, inputUsd: 2, outputUsd: 3 } }
  const replaced = Installed.metered(
    'codex',
    recorded.map((usage) => answered('responses', priced(usage, own))),
  )
  assert.ok(
    Math.abs(
      replaced.costUsd! -
        ((tokens.input - tokens.cached) * 2 + tokens.cached * 1 + tokens.output * 3) / 1e6,
    ) < 1e-12,
  )
  assert.equal(Price.of('a-model-without-a-price', own), undefined)

  const reported = Installed.metered('codex', [
    answered('responses', priced({ ...recorded[0]!, costUsd: 0.25 })),
  ])
  assert.deepEqual([reported.costBy, reported.costUsd], [undefined, 0.25])

  const unpriced = Installed.metered('codex', [
    answered('chat/completions', priced({ ...recorded[0]!, model: 'a-model-without-a-price' })),
    answered('chat/completions', priced(recorded[1]!)),
  ])
  assert.deepEqual([unpriced.modelCalls, unpriced.costUsd], [2, undefined])
})

test('an answer whose usage was not read is counted, and the cost of its row is not known', () => {
  const row = Installed.metered('codex', [
    answered('chat/completions', priced(recorded[0]!)),
    answered('chat/completions', metered('codex', chatStream(false))),
    { again: true, path: 'chat/completions', status: 429, usage: undefined },
    { path: 'chat/completions', status: 402, usage: undefined },
    { path: 'chat/completions', status: 500, usage: undefined },
  ])
  assert.deepEqual(
    [row.modelCalls, row.unmeteredRequests, row.costUsd, row.inputTokens],
    [1, 1, undefined, 3948],
  )
  const counted = Installed.metered('claude', [
    answered('v1/messages/count_tokens', undefined),
    answered('v1/messages', priced({ ...metered('claude', messagesStream)!, costUsd: 0.5 })),
  ])
  assert.deepEqual([counted.unmeteredRequests, counted.costUsd], [undefined, 0.5])

  const attempt = (id: string, usage: Result.Attempt['usage']): Result.Attempt => ({
    agent: { api: 'chat', id: 'fx', model: 'gpt-6-luna', provider: 'fx' },
    finishedAt: 2000,
    id,
    index: 1,
    outcome: 'passed',
    reward: 1,
    sandbox: null,
    session: 's',
    startedAt: 1000,
    task: { checksum: 'sha256:' + id, name: 'suite/' + id },
    timing: {},
    usage,
  })
  const results = [attempt('one', row), attempt('two', { ...row, unmeteredRequests: 2 })]
  assert.equal(Result.uncosted(results), 2)
  const agents = Result.summarize(results)
  assert.deepEqual([agents['fx']!.unmeteredRequests, agents['fx']!.costUsd], [3, null])
  const text = summary({
    agents,
    attempts: [],
    counts: { total: 2 },
    createdAt: 0,
    id: 'r',
    name: 'n',
    spend: { modelUsd: 0, sandboxUsd: 0 },
    state: 'finished',
  })
  assert.match(text, /\nfx: .*, cost not known, unmetered requests: 3, so the cost is incomplete$/)
  const [arm] = Arms.arms([{ attempts: results, id: 'r', name: 'n' } as never], { prices: {} })
  assert.deepEqual([arm!.costUsd, arm!.priced], [null, 0])
  const [whole] = Arms.arms(
    [
      {
        attempts: [attempt('one', { ...row, unmeteredRequests: undefined })],
        id: 'r',
        name: 'n',
      } as never,
    ],
    { prices: {} },
  )
  assert.ok(
    Math.abs(whole!.costUsd! - Price.usd(Price.listed['gpt-6-luna']!, recorded[0]!)) < 1e-12,
  )
})

test('a relayed stream settles with the usage of its last event, and without one when it names none', async () => {
  const bodies = [responsesStream(recorded[1]!), chatStream(true), chatStream(false)]
  let asked = 0
  const server = Http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const body = bodies[asked++]!
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(body.slice(0, 40))
      setTimeout(() => response.end(body.slice(40)), 5)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const settled: Meter.Outcome[] = []
  try {
    for (const body of bodies) {
      const response = await Meter.relay({
        body: new TextEncoder().encode('{}').buffer as ArrayBuffer,
        headers: new Headers({ 'content-type': 'application/json' }),
        hooks: { settle: (outcome) => void settled.push(outcome) },
        method: 'POST',
        provider: 'codex',
        url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
      })
      assert.equal(await response.text(), body, 'the agent gets the answer unchanged')
    }
  } finally {
    server.close()
  }
  assert.deepEqual(
    settled.map((outcome) => [outcome.status, outcome.usage]),
    [
      [200, recorded[1]],
      [
        200,
        {
          cacheWriteTokens: 0,
          cachedTokens: 6400,
          inputTokens: 7200,
          model: '@cf/zai-org/glm-5.3-flash',
          outputTokens: 310,
          reasoningTokens: 120,
        },
      ],
      [200, undefined],
    ],
  )
})
