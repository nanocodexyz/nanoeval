import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
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
      settled.map((outcome) => [outcome.status, outcome.waitMs, outcome.usage?.inputTokens]),
      [
        [429, 1000, undefined],
        [429, 20, undefined],
        [503, 40, undefined],
        [200, undefined, 100],
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
      settled.map((outcome) => [outcome.status, outcome.waitMs]),
      [
        [429, undefined],
        [429, undefined],
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
