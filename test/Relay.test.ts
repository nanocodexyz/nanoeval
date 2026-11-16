import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import { test } from 'node:test'
import * as Proxy from '../src/Proxy.ts'
import type * as Meter from '../worker/Meter.ts'
import * as Model from '../worker/Model.ts'
import * as Relay from '../worker/Relay.ts'

const planSecret = 'p'.repeat(40)

function namespace() {
  const seen: { body: string; headers: Headers; name: string; url: string }[] = []
  const relay: Relay.Namespace = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (request) => {
        seen.push({
          body: await request.text(),
          headers: request.headers,
          name: String(id),
          url: request.url,
        })
        return Response.json({ id: 'answer' })
      },
    }),
  }
  return { relay, seen }
}

const login = {
  CHATGPT_ACCESS_TOKEN: 'login-access',
  CHATGPT_ACCOUNT_ID: 'login-account',
  PLAN_SECRET: planSecret,
}

async function send(variables: Model.Variables, provider: Proxy.Provider = 'codex') {
  const outcomes: Meter.Outcome[] = []
  const response = await Model.forward(variables, {
    hooks: { settle: (outcome) => void outcomes.push(outcome) },
    path: 'responses',
    provider,
    request: new Request('https://run.example/model/row/responses', {
      body: '{"input":"hello","model":"gpt-6-luna"}',
      headers: { authorization: 'Bearer row-token', 'content-type': 'application/json' },
      method: 'POST',
    }),
    search: '',
  })
  return { outcomes, response, text: await response.text() }
}

test('the relay secret is the one the egress relay container derives from PLAN_SECRET', async () => {
  const expected = Buffer.from(
    Crypto.hkdfSync('sha256', planSecret, 'nanocode-egress', 'relay secret v1', 32),
  ).toString('base64url')
  assert.equal(await Relay.secret(planSecret), expected)
  await assert.rejects(Relay.secret('short'), /at least 32/)
})

test('a codex plan request of a Worker that binds the relay container leaves through it, with the login and the derived secret', async () => {
  const { relay, seen } = namespace()
  const sent = await send({ ...login, CHATGPT_RELAY: relay })
  assert.equal(sent.response.status, 200)
  assert.equal(sent.text, '{"id":"answer"}')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.url, Relay.origin + '/backend-api/codex/responses')
  assert.equal(seen[0]!.name, 'relay-0')
  assert.equal(seen[0]!.headers.get('authorization'), 'Bearer login-access')
  assert.equal(seen[0]!.headers.get('chatgpt-account-id'), 'login-account')
  assert.equal(seen[0]!.headers.get(Proxy.relaySecretHeader), await Relay.secret(planSecret))
  assert.equal(seen[0]!.body, '{"input":"hello","model":"gpt-6-luna"}')
})

test('a relay URL wins over the bound container, and a key credential never reaches the container', async () => {
  const { relay, seen } = namespace()
  assert.equal(
    Relay.bound({ CHATGPT_RELAY: relay, CHATGPT_RELAY_URL: 'https://relay.example' }),
    false,
  )
  assert.equal(
    Relay.fetcher({ CHATGPT_RELAY: relay, CHATGPT_RELAY_URL: 'https://relay.example' }, 'k'),
    undefined,
  )
  const keyed = await send({
    CHATGPT_RELAY: relay,
    OPENAI_API_KEY: 'k',
    OPENAI_BASE_URL: 'http://127.0.0.1:9',
  })
  assert.equal(keyed.response.status, 502)
  assert.equal(seen.length, 0)
})

test('requests spread over CHATGPT_RELAY_INSTANCES containers, one key always on the same one', () => {
  const env = { CHATGPT_RELAY_INSTANCES: '8' }
  const names = new Set(
    Array.from({ length: 400 }, (_, index) => Relay.name(env, 'session-' + index)),
  )
  assert.equal(names.size, 8)
  assert.equal(Relay.name(env, 'session-1'), Relay.name(env, 'session-1'))
  assert.equal(Relay.instances({}), 1)
  assert.equal(Relay.instances({ CHATGPT_RELAY_INSTANCES: 'x' }), 1)
  assert.equal(Relay.instances({ CHATGPT_RELAY_INSTANCES: '100000' }), Relay.most)
})

test('a bound relay without PLAN_SECRET is refused as a provider not reached, not sent without a secret', async () => {
  const { relay, seen } = namespace()
  const sent = await send({
    CHATGPT_ACCESS_TOKEN: 'a',
    CHATGPT_ACCOUNT_ID: 'b',
    CHATGPT_RELAY: relay,
  })
  assert.equal(sent.response.status, 502)
  assert.match(sent.text, /PLAN_SECRET/)
  assert.equal(seen.length, 0)
})
