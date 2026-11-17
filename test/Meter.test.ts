import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import * as Proxy from '../src/Proxy.ts'
import * as Retry from '../src/Retry.ts'
import * as Meter from '../worker/Meter.ts'

async function upstream(
  answers: readonly { body: string; headers?: Record<string, string>; status: number }[],
): Promise<{ asked(): number; close(): void; url: string }> {
  let asked = 0
  const server = Http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const answer = answers[Math.min(asked++, answers.length - 1)]!
      response.writeHead(answer.status, answer.headers).end(answer.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    asked: () => asked,
    close: () => void server.close(),
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
  }
}

const limit = JSON.stringify({ error: { message: 'inference request per min rate reached' } })
const reply =
  'data: ' +
  JSON.stringify({ choices: [], usage: { completion_tokens: 7, prompt_tokens: 100 } }) +
  '\n\n'

function relay(url: string, hooks: Meter.Hooks): Promise<Response> {
  return Meter.relay({
    body: new TextEncoder().encode('{}').buffer as ArrayBuffer,
    headers: new Headers({ 'content-type': 'application/json' }),
    hooks,
    method: 'POST',
    provider: 'codex',
    url,
  })
}

test('a limited answer is asked again after the pause the provider names or the pause of the run, and each wait is settled', async () => {
  const server = await upstream([
    { body: limit, headers: { 'retry-after': '1' }, status: 429 },
    { body: limit, status: 429 },
    { body: limit, status: 503 },
    { body: reply, headers: { 'content-type': 'text/event-stream' }, status: 200 },
  ])
  const settled: Meter.Outcome[] = []
  const asked: Meter.Limited[] = []
  const started = Date.now()
  try {
    const response = await relay(server.url, {
      limited: (limited) => {
        asked.push(limited)
        return Retry.pause({
          deadlineAt: started + 60_000,
          now: Date.now(),
          pollMs: 10,
          ...(limited.retryAfterMs === undefined ? {} : { retryAfterMs: limited.retryAfterMs }),
          stepRetries: 3,
          tries: limited.tries,
        })
      },
      settle: (outcome) => void settled.push(outcome),
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), reply)
    assert.ok(Date.now() - started >= 1000 + 20 + 40, 'the run waited 1 s, 20 ms and 40 ms')
    assert.equal(server.asked(), 4)
    assert.deepEqual(asked, [
      { retryAfterMs: 1000, status: 429, tries: 0 },
      { status: 429, tries: 1 },
      { status: 503, tries: 2 },
    ])
    assert.deepEqual(
      settled.map((outcome) => [
        outcome.status,
        outcome.again,
        outcome.waitMs,
        outcome.usage?.inputTokens,
      ]),
      [
        [429, true, 1000, undefined],
        [429, true, 20, undefined],
        [503, true, 40, undefined],
        [200, undefined, undefined, 100],
      ],
    )
  } finally {
    server.close()
  }
})

test('a limited answer reaches the agent as the provider sent it when the attempt has no time left, and when no one waits for it', async () => {
  const server = await upstream([{ body: limit, headers: { 'retry-after': '7' }, status: 429 }])
  const settled: Meter.Outcome[] = []
  try {
    const late = await relay(server.url, {
      limited: (limited) =>
        Retry.pause({
          deadlineAt: 5_000,
          now: 1_000,
          pollMs: 10,
          ...(limited.retryAfterMs === undefined ? {} : { retryAfterMs: limited.retryAfterMs }),
          stepRetries: 3,
          tries: limited.tries,
        }),
      settle: (outcome) => void settled.push(outcome),
    })
    assert.equal(late.status, 429)
    assert.equal(late.headers.get('retry-after'), '7')
    assert.equal(await late.text(), limit)
    const plain = await relay(server.url, { settle: (outcome) => void settled.push(outcome) })
    assert.equal(plain.status, 429)
    assert.equal(await plain.text(), limit)
    assert.equal(server.asked(), 2)
    assert.deepEqual(
      settled.map((outcome) => [outcome.status, outcome.again, outcome.waitMs]),
      [
        [429, undefined, undefined],
        [429, undefined, undefined],
      ],
    )
  } finally {
    server.close()
  }
})

test('a pace holds a request before it is sent and before it is asked again, and the hold is settled with the answer', async () => {
  const server = await upstream([
    { body: limit, status: 429 },
    { body: reply, headers: { 'content-type': 'text/event-stream' }, status: 200 },
    { body: reply, headers: { 'content-type': 'text/event-stream' }, status: 200 },
  ])
  const settled: Meter.Outcome[] = []
  const holds = [60, 40, undefined]
  const sent: number[] = []
  let paced = 0
  const hooks: Meter.Hooks = {
    limited: () => 30,
    pace: () => holds[paced++],
    settle: (outcome) => {
      sent.push(outcome.at)
      settled.push(outcome)
    },
  }
  const started = Date.now()
  try {
    const held = await relay(server.url, hooks)
    assert.equal(await held.text(), reply)
    const free = await relay(server.url, hooks)
    assert.equal(await free.text(), reply)
    assert.equal(paced, 3, 'the pace was asked before each of the three requests the provider got')
    assert.equal(server.asked(), 3)
    assert.deepEqual(
      settled.map((outcome) => [outcome.status, outcome.waitMs]),
      [
        [429, 60 + 30],
        [200, 40],
        [200, undefined],
      ],
    )
    assert.ok(sent[0]! - started >= 60 - 1, 'the first request was sent after its hold')
    assert.ok(sent[1]! - sent[0]! >= 30 + 40 - 1, 'the second after the pause and its hold')
  } finally {
    server.close()
  }
})

test('a streamed answer settles with the time to its first byte and to its first model output', async () => {
  const events = (value: Record<string, unknown>) => 'data: ' + JSON.stringify(value) + '\n\n'
  const server = Http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(events({ type: 'response.created', response: {} }))
      setTimeout(() => {
        response.write(events({ type: 'response.output_text.delta', delta: 'hi' }))
        response.end(
          events({
            type: 'response.completed',
            response: { output: [], usage: { input_tokens: 10, output_tokens: 2 } },
          }),
        )
      }, 80)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const settled: Meter.Outcome[] = []
    const response = await relay('http://127.0.0.1:' + (server.address() as AddressInfo).port, {
      settle: (outcome) => void settled.push(outcome),
    })
    await response.text()
    const [outcome] = settled
    assert.ok(outcome)
    assert.equal(outcome.usage?.outputTokens, 2)
    assert.ok(outcome.firstByteMs !== undefined && outcome.firstDeltaMs !== undefined)
    assert.ok(outcome.firstDeltaMs - outcome.firstByteMs >= 60)
    assert.ok(outcome.firstDeltaMs <= outcome.ms)
  } finally {
    server.close()
  }
})

test('model output is a text, reasoning or tool call delta, or a tool call starting', () => {
  assert.equal(Proxy.delivers({ type: 'response.created' }), false)
  assert.equal(
    Proxy.delivers({ type: 'response.output_item.added', item: { type: 'message' } }),
    false,
  )
  assert.equal(
    Proxy.delivers({ type: 'response.output_item.added', item: { type: 'function_call' } }),
    true,
  )
  assert.equal(Proxy.delivers({ type: 'response.reasoning_summary_text.delta' }), true)
  assert.equal(Proxy.delivers({ type: 'message_start' }), false)
  assert.equal(Proxy.delivers({ type: 'content_block_delta' }), true)
  assert.equal(
    Proxy.delivers({ type: 'content_block_start', content_block: { type: 'tool_use' } }),
    true,
  )
  assert.equal(Proxy.delivers({ choices: [{ delta: { role: 'assistant', content: '' } }] }), false)
  assert.equal(Proxy.delivers({ choices: [{ delta: { content: 'x' } }] }), true)
  assert.equal(Proxy.delivers({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }), true)
})

type Frame = Record<string, unknown>

const create = JSON.stringify({ type: 'response.create', model: 'gpt-5.5', input: [] })
const completed = (output: number) =>
  ({
    type: 'response.completed',
    response: {
      model: 'gpt-5.5',
      output: [],
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 800 },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: 3 },
      },
    },
  }) satisfies Frame

function clock(): { now(): number; tick(ms: number): void } {
  let at = 1_000_000
  return { now: () => at, tick: (ms) => void (at += ms) }
}

test('a socket response is timed from its response.create to its first frame, its first output and its end', async () => {
  const time = clock()
  const settled: Meter.Outcome[] = []
  const socket = Meter.frames({
    hooks: { settle: (o) => void settled.push(o) },
    now: time.now,
    provider: 'codex',
  })
  socket.sent(create)
  time.tick(120)
  socket.received(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }))
  time.tick(30)
  socket.received(JSON.stringify({ type: 'response.in_progress' }))
  time.tick(250)
  socket.received(JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'hm' }))
  time.tick(100)
  socket.received(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }))
  time.tick(600)
  socket.received(JSON.stringify(completed(42)))
  await socket.closed()
  assert.equal(settled.length, 1)
  assert.deepEqual(
    { ...settled[0], usage: undefined },
    { at: 1_000_000, firstByteMs: 120, firstDeltaMs: 400, ms: 1100, status: 200, usage: undefined },
  )
  assert.equal(settled[0]!.usage?.outputTokens, 42)
  assert.equal(settled[0]!.usage?.cachedTokens, 800)
  assert.equal(settled[0]!.usage?.reasoningTokens, 3)
  assert.equal(settled[0]!.usage?.model, 'gpt-5.5')
})

test('each response.create on one socket is its own request, a function call starting is output and a prewarm has none', async () => {
  const time = clock()
  const settled: Meter.Outcome[] = []
  const socket = Meter.frames({
    hooks: { settle: (o) => void settled.push(o) },
    now: time.now,
    provider: 'codex',
  })
  socket.received(JSON.stringify({ type: 'response.created' }))
  socket.sent(JSON.stringify({ type: 'response.create', generate: false }))
  time.tick(50)
  socket.received(JSON.stringify({ type: 'response.created' }))
  time.tick(10)
  socket.received(JSON.stringify(completed(0)))
  time.tick(1000)
  socket.sent(new TextEncoder().encode(create))
  time.tick(200)
  socket.received(JSON.stringify({ type: 'response.created' }))
  time.tick(300)
  socket.received(
    JSON.stringify({
      type: 'response.output_item.added',
      item: { type: 'function_call', name: 'bash' },
    }),
  )
  time.tick(100)
  socket.received(JSON.stringify(completed(9)))
  await socket.closed()
  assert.deepEqual(
    settled.map((o) => [
      o.at - 1_000_000,
      o.firstByteMs,
      o.firstDeltaMs,
      o.ms,
      o.usage?.outputTokens,
    ]),
    [
      [0, 50, undefined, 60, 0],
      [1060, 200, 500, 600, 9],
    ],
  )
})

test('a socket that closes mid-response settles what it saw, and an error frame settles with its status', async () => {
  const time = clock()
  const settled: Meter.Outcome[] = []
  const socket = Meter.frames({
    hooks: { settle: (o) => void settled.push(o) },
    now: time.now,
    provider: 'codex',
  })
  socket.sent(create)
  time.tick(70)
  socket.received(
    JSON.stringify({ type: 'error', status: 429, error: { code: 'rate_limit_exceeded' } }),
  )
  socket.sent(create)
  time.tick(40)
  socket.received(JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }))
  time.tick(5)
  await socket.closed()
  await socket.closed()
  assert.deepEqual(
    settled.map((o) => [o.status, o.firstByteMs, o.firstDeltaMs, o.ms]),
    [
      [429, 70, undefined, 70],
      [200, 40, 40, 45],
    ],
  )
})

test('a socket and a stream carrying the same events are timed and priced alike', async () => {
  const events: Frame[] = [
    { type: 'response.created' },
    { type: 'response.output_item.added', item: { type: 'reasoning' } },
    { type: 'response.function_call_arguments.delta', delta: '{' },
    completed(17),
  ]
  const server = await upstream([
    {
      body: events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
      headers: { 'content-type': 'text/event-stream' },
      status: 200,
    },
  ])
  const streamed: Meter.Outcome[] = []
  try {
    const response = await relay(server.url, { settle: (o) => void streamed.push(o) })
    await response.text()
  } finally {
    server.close()
  }
  const framed: Meter.Outcome[] = []
  const socket = Meter.frames({ hooks: { settle: (o) => void framed.push(o) }, provider: 'codex' })
  socket.sent(create)
  for (const event of events) socket.received(JSON.stringify(event))
  await socket.closed()
  assert.equal(streamed.length, 1)
  assert.equal(framed.length, 1)
  assert.deepEqual(framed[0]!.usage, streamed[0]!.usage)
  assert.equal(typeof streamed[0]!.firstDeltaMs, 'number')
  assert.equal(typeof framed[0]!.firstDeltaMs, 'number')
  assert.equal(typeof framed[0]!.firstByteMs, 'number')
})

function fake(): {
  close(code?: number, reason?: string): void
  closed: { code?: number; reason?: string }[]
  emit(data: unknown): void
  sent: unknown[]
  socket: Meter.Socket
} {
  const listeners = new Map<
    string,
    ((event: { code?: number; data?: unknown; reason?: string }) => void)[]
  >()
  const sent: unknown[] = []
  const closed: { code?: number; reason?: string }[] = []
  const fire = (type: string, event: { code?: number; data?: unknown; reason?: string }) => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  return {
    close: (code, reason) => fire('close', { code, reason }),
    closed,
    emit: (data) => fire('message', { data }),
    sent,
    socket: {
      accept() {},
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      close(code, reason) {
        closed.push({ code, reason })
      },
      send(data) {
        sent.push(data)
      },
    },
  }
}

test('an upgraded answer is passed through a metered socket pair and other answers are kept', async () => {
  const settled: Meter.Outcome[] = []
  const hooks = { settle: (o: Meter.Outcome) => void settled.push(o) }
  const plain = new Response('no', { status: 426 })
  assert.equal(Meter.socket({ hooks, provider: 'codex', upstream: plain }), plain)

  const far = fake()
  const near = fake()
  const client = {}
  const answer = {
    headers: new Headers({ 'x-a': '1' }),
    status: 101,
    webSocket: far.socket,
  } as unknown as Response
  const OriginalResponse = globalThis.Response
  let made: { body: unknown; init: Record<string, unknown> } | undefined
  globalThis.Response = class {
    constructor(body: unknown, init: Record<string, unknown>) {
      made = { body, init }
    }
  } as unknown as typeof Response
  try {
    Meter.socket({ hooks, pair: () => [client, near.socket], provider: 'codex', upstream: answer })
  } finally {
    globalThis.Response = OriginalResponse
  }
  assert.equal(made?.init['status'], 101)
  assert.equal(made?.init['webSocket'], client)
  near.emit(create)
  far.emit(JSON.stringify({ type: 'response.output_text.delta', delta: 'a' }))
  far.emit(JSON.stringify(completed(5)))
  assert.deepEqual(far.sent, [create])
  assert.equal(near.sent.length, 2)
  near.close(1000, 'bye')
  assert.deepEqual(far.closed, [{ code: 1000, reason: 'bye' }])
  far.close(1006)
  assert.deepEqual(near.closed, [{ code: 1000, reason: undefined }])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(settled.length, 1)
  assert.equal(settled[0]!.usage?.outputTokens, 5)
  assert.equal(typeof settled[0]!.firstDeltaMs, 'number')
})
