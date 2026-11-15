import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import * as Logins from '../src/Logins.ts'
import * as Retry from '../src/Retry.ts'
import * as Meter from '../worker/Meter.ts'

async function provider(accepted: string) {
  const server = Http.createServer((request, response) => {
    request.resume()
    const ok = request.headers['authorization'] === 'Bearer ' + accepted
    response
      .writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      .end(JSON.stringify(ok ? { id: 'msg' } : { error: { type: 'authentication_error' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/messages'
  return { close: () => new Promise((resolve) => server.close(resolve)), url }
}

async function send(input: { accepted: string; logins: readonly string[] }) {
  const upstream = await provider(input.accepted)
  const outcomes: Meter.Outcome[] = []
  const asked: (string | undefined)[] = []
  const hooks = Meter.rejecting({ settle: (outcome) => void outcomes.push(outcome) })
  try {
    const response = await Logins.send({
      attempt: (headers) =>
        Meter.relay({
          body: new TextEncoder().encode('{}').buffer,
          headers: new Headers(headers),
          hooks,
          method: 'POST',
          provider: 'claude',
          url: upstream.url,
        }),
      credential: async (rejected) => {
        asked.push(rejected)
        return Logins.claude(input.logins[asked.length - 1] ?? input.logins.at(-1)!)
      },
    })
    await response.text()
    return { asked, outcomes, status: response.status }
  } finally {
    await upstream.close()
  }
}

const failure = { at: 1, kind: 'agent' as const, message: 'Messages HTTP 401' }

test('a login that is refreshed after a 401 leaves the attempt to its agent', async () => {
  const sent = await send({ accepted: 'access-2', logins: ['access-1', 'access-2'] })
  assert.equal(sent.status, 200)
  assert.deepEqual(sent.asked, [undefined, 'access-1'])
  assert.deepEqual(
    sent.outcomes.map((outcome) => [outcome.status, outcome.refusal]),
    [
      [401, 'login'],
      [200, undefined],
    ],
  )
  assert.equal(Retry.rejected({ failure, requests: sent.outcomes }), undefined)
})

test('a 401 that no refresh ends is an environment error that the run retries', async () => {
  for (const logins of [['access-1'], ['access-1', 'access-2']]) {
    const sent = await send({ accepted: 'access-3', logins })
    assert.equal(sent.status, 401)
    assert.equal(sent.outcomes.at(-1)?.refusal, 'login')
    const rejected = Retry.rejected({ failure, requests: sent.outcomes })
    assert.deepEqual(rejected, {
      at: 1,
      kind: 'environment',
      message: Retry.rejectedPrefix + ': Messages HTTP 401',
    })
    assert.equal(
      Retry.infrastructure({ failure: rejected!, statuses: [401] }),
      'the model provider rejected the plan login',
    )
  }
})

test('only an agent failure after a rejected login is an error of the login', () => {
  const requests = [{ refusal: 'login' as const }]
  for (const kind of ['agent_timeout', 'budget', 'cancelled', 'environment'] as const)
    assert.equal(Retry.rejected({ failure: { ...failure, kind }, requests }), undefined)
  assert.equal(Retry.rejected({ failure, requests: [] }), undefined)
  assert.equal(Retry.rejected({ failure, requests: [{}] }), undefined)
  assert.equal(
    Retry.infrastructure({
      failure: { kind: 'agent', message: 'Messages HTTP 401' },
      statuses: [],
    }),
    undefined,
  )
})

test('a key is never marked as a rejected login', async () => {
  const outcomes: Meter.Outcome[] = []
  const upstream = await provider('key')
  try {
    const response = await Meter.relay({
      headers: new Headers({ authorization: 'Bearer other' }),
      hooks: { settle: (outcome) => void outcomes.push(outcome) },
      method: 'POST',
      provider: 'claude',
      url: upstream.url,
    })
    await response.text()
  } finally {
    await upstream.close()
  }
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.status, outcome.refusal]),
    [[401, undefined]],
  )
})
