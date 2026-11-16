import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import * as Price from '../src/Price.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Meter from '../worker/Meter.ts'
import * as Model from '../worker/Model.ts'
import * as WorkersAi from '../worker/WorkersAi.ts'

const model = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
const chat = {
  messages: [{ content: 'hello', role: 'user' }],
  model,
  stream: true,
  stream_options: { include_usage: true },
}
const events =
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: {"choices":[],"usage":{"completion_tokens":40,"cost":0.5,"prompt_tokens":1000,"prompt_tokens_details":{"cached_tokens":600}}}\n\n' +
  'data: [DONE]\n\n'
const tokens = { cacheWriteTokens: 0, cachedTokens: 600, inputTokens: 1000, outputTokens: 40 }

type Seen = { body: string; headers: Http.IncomingHttpHeaders; method: string; url: string }

async function upstream() {
  const seen: Seen[] = []
  const server = Http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        body: Buffer.concat(chunks).toString('latin1'),
        headers: request.headers,
        method: request.method!,
        url: request.url!,
      })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"answer"}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  return { close: () => new Promise((resolve) => server.close(resolve)), seen, url }
}

function binding(answer: () => unknown) {
  const calls: { inputs: Record<string, unknown>; model: string; options: unknown }[] = []
  const ai: WorkersAi.Binding = {
    run: async (named, inputs, options) => {
      calls.push({ inputs, model: named, options })
      return answer()
    },
  }
  return { ai, calls }
}

async function send(
  variables: Model.Variables,
  input: {
    body: string
    headers?: Record<string, string>
    path: string
    provider?: Proxy.Provider
  },
) {
  const outcomes: Meter.Outcome[] = []
  const response = await Model.forward(variables, {
    hooks: { settle: (outcome) => void outcomes.push(outcome) },
    path: input.path,
    provider: input.provider ?? 'codex',
    request: new Request('https://run.example/model/row/' + input.path, {
      body: input.body,
      headers: {
        authorization: 'Bearer row-token',
        'content-type': 'application/json',
        ...input.headers,
      },
      method: 'POST',
    }),
    search: '',
  })
  return { outcomes, response, text: await response.text() }
}

const credentials = (url: string): Model.Variables => ({
  CHATGPT_ACCESS_TOKEN: 'login-access',
  CHATGPT_ACCOUNT_ID: 'login-account',
  CHATGPT_RELAY_SECRET: 'relay-secret',
  CHATGPT_RELAY_URL: url,
  OPENAI_API_KEY: 'openai-key',
  OPENAI_BASE_URL: url,
})

test('a chat completions request of an installed agent for a @cf/ model is answered by the Workers AI binding before any credential, and is priced as the same answer of a session', async () => {
  const provider = await upstream()
  try {
    const { ai, calls } = binding(() => new Response(events).body)
    const sent = await send(
      {
        ...credentials(provider.url),
        AI: ai,
        WORKERS_AI_ACCOUNT_ID: 'abc',
        WORKERS_AI_GATEWAY: 'gate',
      },
      { body: JSON.stringify(chat), path: 'chat/completions' },
    )
    assert.equal(sent.response.status, 200)
    assert.equal(sent.text, events)
    assert.deepEqual(calls, [{ inputs: chat, model, options: { gateway: { id: 'gate' } } }])
    assert.deepEqual(provider.seen, [], 'no login, relay or key was asked')
    assert.deepEqual(
      sent.outcomes.map((outcome) => [outcome.route, outcome.status, outcome.usage]),
      [['workers-ai', 200, tokens]],
    )

    const session: Meter.Outcome[] = []
    const answer = await Meter.relay({
      body: new TextEncoder().encode(JSON.stringify(chat)).buffer as ArrayBuffer,
      cost: false,
      fetch: WorkersAi.fetcher(binding(() => new Response(events).body).ai),
      headers: new Headers(),
      hooks: { settle: (outcome) => void session.push(outcome) },
      method: 'POST',
      provider: 'codex',
      url: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions',
    })
    await answer.text()
    assert.deepEqual(sent.outcomes[0]!.usage, session[0]!.usage)

    const price = Price.of(model, Price.list([model + '=0.30,0.006,1.20']))!
    const usage = sent.outcomes[0]!.usage!
    const row = Proxy.metered('codex', [
      {
        path: 'chat/completions',
        status: 200,
        usage: { ...usage, costBy: 'list', costUsd: Price.usd(price, usage) },
      },
    ])
    assert.equal(row.costBy, 'list')
    assert.ok(Math.abs(row.costUsd! - (400 * 0.3 + 600 * 0.006 + 40 * 1.2) / 1e6) < 1e-12)
    assert.equal(Price.of(model, undefined), undefined)
  } finally {
    await provider.close()
  }
})

test('an installed agent reads the usage of a Workers AI stream once, in its last chunk, and the meter reads the same totals', async () => {
  const provider = await upstream()
  try {
    const stream =
      'data: {"id":"a","model":"' +
      model +
      '","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"usage":{"prompt_tokens":5028,"completion_tokens":0,"total_tokens":5028}}\n\n' +
      'data: {"id":"a","model":"' +
      model +
      '","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":1,"total_tokens":1}}\n\n' +
      'data: {"id":"a","model":"' +
      model +
      '","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":4608}}}\n\n' +
      'data: {"response":"","usage":{"prompt_tokens":5028,"completion_tokens":250,"total_tokens":5278,"prompt_tokens_details":{"cached_tokens":4608}}}\n\n' +
      'data: [DONE]\n\n'
    const { ai } = binding(() => new Response(stream).body)
    const sent = await send(
      { ...credentials(provider.url), AI: ai, WORKERS_AI_ACCOUNT_ID: 'abc' },
      { body: JSON.stringify(chat), path: 'chat/completions' },
    )
    assert.equal(
      sent.text,
      'data: {"id":"a","model":"' +
        model +
        '","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
        'data: {"id":"a","model":"' +
        model +
        '","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"model":"' +
        model +
        '","usage":{"prompt_tokens":5028,"completion_tokens":250,"total_tokens":5278,"prompt_tokens_details":{"cached_tokens":4608}}}\n\n' +
        'data: [DONE]\n\n',
    )
    assert.deepEqual(
      sent.outcomes.map((outcome) => [outcome.route, outcome.status, outcome.usage]),
      [
        [
          'workers-ai',
          200,
          { cacheWriteTokens: 0, cachedTokens: 4608, inputTokens: 5028, model, outputTokens: 250 },
        ],
      ],
    )
    assert.deepEqual(provider.seen, [])
  } finally {
    await provider.close()
  }
})

test('a @cf/ request of an installed agent is refused when the Worker has no Workers AI binding or no account, and no credential is asked', async () => {
  const provider = await upstream()
  try {
    const { ai, calls } = binding(() => new Response(events).body)
    for (const [variables, message] of [
      [{ WORKERS_AI_ACCOUNT_ID: 'abc' }, 'the deployment has no Workers AI binding for ' + model],
      [{ AI: ai }, 'the deployment has no WORKERS_AI_ACCOUNT_ID for ' + model],
    ] as const) {
      const sent = await send(
        { ...credentials(provider.url), ...variables },
        { body: JSON.stringify(chat), path: 'chat/completions' },
      )
      assert.equal(sent.response.status, 401)
      assert.deepEqual(JSON.parse(sent.text), { error: { message, type: 'authentication_error' } })
      assert.deepEqual(
        sent.outcomes.map((outcome) => [outcome.route, outcome.status, outcome.ms]),
        [['workers-ai', 401, 0]],
      )
    }
    assert.deepEqual(calls, [])
    assert.deepEqual(provider.seen, [])
  } finally {
    await provider.close()
  }
})

test('an error of the binding and a refusal of Workers AI reach the installed agent as they are, and no credential is asked', async () => {
  const provider = await upstream()
  const thrown = (text: string) => () => {
    throw new Error(text)
  }
  try {
    for (const [answer, status, body] of [
      [
        () => new Response('{"error":"payment required"}', { status: 402 }),
        402,
        '{"error":"payment required"}',
      ],
      [
        thrown('402 payment required'),
        502,
        '{"error":{"message":"402 payment required","type":"workers_ai"}}',
      ],
      [
        thrown('5007: no such model'),
        400,
        '{"error":{"message":"5007: no such model","type":"workers_ai"}}',
      ],
      [
        thrown('3040: capacity temporarily exceeded'),
        429,
        '{"error":{"message":"3040: capacity temporarily exceeded","type":"workers_ai"}}',
      ],
    ] as const) {
      const { ai, calls } = binding(answer)
      const sent = await send(
        { ...credentials(provider.url), AI: ai, WORKERS_AI_ACCOUNT_ID: 'abc' },
        { body: JSON.stringify(chat), path: 'chat/completions' },
      )
      assert.equal(sent.response.status, status)
      assert.equal(sent.text, body)
      assert.equal(calls.length, 1)
      assert.deepEqual(
        sent.outcomes.map((outcome) => [outcome.route, outcome.status]),
        [['workers-ai', status]],
      )
    }
    assert.deepEqual(provider.seen, [])
  } finally {
    await provider.close()
  }
})

test('every other request of an installed agent goes to the credential of the Worker as before, with a binding or without one', async () => {
  const provider = await upstream()
  const { ai, calls } = binding(() => new Response(events).body)
  const bound = { AI: ai, WORKERS_AI_ACCOUNT_ID: 'abc' }
  const key = { OPENAI_API_KEY: 'openai-key', OPENAI_BASE_URL: provider.url }
  const login = {
    CHATGPT_ACCESS_TOKEN: 'login-access',
    CHATGPT_ACCOUNT_ID: 'login-account',
    CHATGPT_RELAY_SECRET: 'relay-secret',
    CHATGPT_RELAY_URL: provider.url,
  }
  const claude = { ANTHROPIC_API_KEY: 'anthropic-key', ANTHROPIC_BASE_URL: provider.url }
  const other = JSON.stringify({ ...chat, model: 'gpt-6-luna' }) + ' \u00e9\n'
  const responses = JSON.stringify({ input: 'hello', model })
  const messages = JSON.stringify({ messages: [], model: 'claude-haiku-5-5' })
  const expected = [
    {
      authorization: 'Bearer openai-key',
      body: other,
      url: '/v1/chat/completions',
    },
    { authorization: 'Bearer openai-key', body: 'no json', url: '/v1/chat/completions' },
    { authorization: 'Bearer openai-key', body: '"' + model + '"', url: '/v1/chat/completions' },
    { authorization: 'Bearer openai-key', body: responses, url: '/v1/responses' },
    {
      account: 'login-account',
      authorization: 'Bearer login-access',
      body: other,
      secret: 'relay-secret',
      url: '/backend-api/codex/chat/completions',
    },
    { body: messages, key: 'anthropic-key', url: '/v1/messages' },
  ]
  try {
    for (const variables of [{}, bound]) {
      provider.seen.length = 0
      const sent = [
        await send({ ...key, ...variables }, { body: other, path: 'chat/completions' }),
        await send({ ...key, ...variables }, { body: 'no json', path: 'chat/completions' }),
        await send({ ...key, ...variables }, { body: '"' + model + '"', path: 'chat/completions' }),
        await send({ ...key, ...variables }, { body: responses, path: 'responses' }),
        await send({ ...login, ...variables }, { body: other, path: 'chat/completions' }),
        await send(
          { ...claude, ...variables },
          { body: messages, path: 'v1/messages', provider: 'claude' },
        ),
      ]
      for (const one of sent) {
        assert.equal(one.response.status, 200)
        assert.equal(one.text, '{"id":"answer"}')
        assert.deepEqual(
          one.outcomes.map((outcome) => Object.keys(outcome).sort()),
          [['at', 'ms', 'status']],
        )
      }
      assert.deepEqual(
        provider.seen.map((request) => ({
          ...(request.headers['chatgpt-account-id']
            ? { account: request.headers['chatgpt-account-id'] }
            : {}),
          ...(request.headers['authorization']
            ? { authorization: request.headers['authorization'] }
            : {}),
          body: Buffer.from(request.body, 'latin1').toString(),
          ...(request.headers['x-api-key'] ? { key: request.headers['x-api-key'] } : {}),
          ...(request.headers[Proxy.relaySecretHeader]
            ? { secret: request.headers[Proxy.relaySecretHeader] }
            : {}),
          url: request.url,
        })),
        expected,
      )
      assert.ok(provider.seen.every((request) => request.method === 'POST'))
      assert.ok(
        provider.seen.every((request) => request.headers['content-type'] === 'application/json'),
      )

      const refused = await send(variables, { body: other, path: 'chat/completions' })
      assert.equal(refused.response.status, 401)
      assert.deepEqual(JSON.parse(refused.text), {
        error: { message: 'the deployment has no codex credential', type: 'authentication_error' },
      })
      assert.deepEqual(
        refused.outcomes.map((outcome) => [
          Object.keys(outcome).sort(),
          outcome.ms,
          outcome.status,
        ]),
        [[['at', 'ms', 'status'], 0, 401]],
      )
    }
    assert.deepEqual(calls, [])
  } finally {
    await provider.close()
  }
})
