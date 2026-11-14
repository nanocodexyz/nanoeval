import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planSummary } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'
import * as Plans from '../src/Plans.ts'
import * as Sql from '../src/Sql.ts'
import * as Rows from './Rows.ts'

const secret = 'a secret of the worker, 32 or more characters'
const messages = 'https://api.anthropic.com/v1/messages?beta=true'

function open(): Sql.Sql {
  const sql = Rows.database()
  Sql.setup(sql, Plans.tables)
  return sql
}

function claude() {
  const seen = {
    gate: undefined as Promise<void> | undefined,
    grants: [] as string[],
    issued: 0,
    refused: false,
    requests: [] as string[],
  }
  return {
    fetch: async (input: string, init: RequestInit): Promise<Response> => {
      const url = new URL(input)
      seen.requests.push(init.method + ' ' + url.origin + url.pathname)
      if (url.pathname === '/v1/oauth/token') {
        seen.grants.push((JSON.parse(String(init.body)) as { grant_type: string }).grant_type)
        await seen.gate
        if (seen.refused) return Response.json({ error: 'invalid_grant' }, { status: 400 })
        seen.issued++
        return Response.json({
          access_token: 'access-' + seen.issued,
          account: { uuid: 'account-1' },
          expires_in: 3600,
          organization: { uuid: 'organization-1' },
          refresh_token: 'refresh-' + seen.issued,
          scope: 'user:profile user:inference',
          token_type: 'Bearer',
        })
      }
      if (url.pathname === '/api/oauth/profile')
        return new Headers(init.headers).get('authorization') === 'Bearer access-' + seen.issued
          ? Response.json({
              account: { uuid: 'account-1' },
              organization: { uuid: 'organization-1' },
            })
          : Response.json({ error: 'unauthorized' }, { status: 401 })
      return Response.json({})
    },
    seen,
  }
}

async function signIn(options: Plans.account.Options): Promise<Plans.Account> {
  const plans = await Plans.account(options)
  const started = await plans.signIn({ provider: 'claude' })
  assert.equal(started.provider, 'claude')
  const state = new URL((started as { authorization_url: string }).authorization_url).searchParams
  await plans.complete({ code: 'code-1#' + state.get('state') })
  return plans
}

function provider(answer: (authorization: string | null) => number) {
  const sent: { headers: Headers; url: string }[] = []
  return {
    relay: async (request: { headers: Headers; url: string }) => {
      sent.push(request)
      return new Response('{}', { status: answer(request.headers.get('authorization')) })
    },
    sent,
  }
}

test('the store replaces a record only at the revision its writer read', async () => {
  const store = Plans.store(open())
  assert.deepEqual(await store.load('k'), { payload: undefined, revision: 0 })
  assert.equal(await store.compareAndSwap('k', { payload: 'one', revision: 0 }), 1)
  assert.equal(await store.compareAndSwap('k', { payload: 'late', revision: 0 }), undefined)
  assert.equal(await store.compareAndSwap('k', { payload: 'two', revision: 1 }), 2)
  assert.deepEqual(await store.load('k'), { payload: 'two', revision: 2 })
})

test('a sign-in is kept sealed, and gives the bearer token of the plan', async () => {
  const sql = open()
  const scripted = claude()
  const plans = await signIn({ fetch: scripted.fetch, secret, sql })
  assert.equal((await plans.status()).claude.state, 'authenticated')
  assert.deepEqual((await plans.inject('claude')).headers, {
    'anthropic-beta': 'oauth-2025-04-20',
    authorization: 'Bearer access-1',
  })
  const kept = JSON.stringify(sql.all('SELECT key, payload FROM plan_records'))
  assert.match(kept, /plans:owner:claude/)
  assert.ok(!kept.includes('access-1') && !kept.includes('refresh-1'), 'the record is sealed')

  const again = await Plans.account({ fetch: scripted.fetch, secret, sql })
  assert.equal(await again.signedIn('claude'), true)
  const other = await Plans.account({ fetch: scripted.fetch, secret: secret + ' changed', sql })
  await assert.rejects(other.status(), /does not open with this key/)
  await assert.rejects(other.signIn({ provider: 'claude' }), /does not open with this key/)
  await other.signOut({ provider: 'claude' })
  assert.equal((await other.status()).claude.state, 'signed_out', 'signing out forgets it')
  assert.equal((await again.status()).claude.state, 'signed_out')
  assert.deepEqual(
    scripted.seen.requests.slice(2),
    [],
    'a sign-in that does not open is not revoked',
  )
  await assert.rejects(Plans.account({ secret: 'short', sql }), /at least 32 characters/)
})

test('a request the provider answers 401 is sent once more with a refreshed token', async () => {
  const scripted = claude()
  const plans = await signIn({ fetch: scripted.fetch, secret, sql: open() })
  const upstream = provider((authorization) => (authorization === 'Bearer access-1' ? 401 : 200))
  const response = await Plans.send(plans, {
    endpoint: messages,
    headers: [
      ['anthropic-beta', 'tools-1'],
      ['authorization', 'Bearer stale'],
      ['x-api-key', 'stale'],
    ],
    relay: upstream.relay,
  })
  assert.equal(response.status, 200)
  assert.deepEqual(scripted.seen.grants, ['authorization_code', 'refresh_token'])
  assert.deepEqual(
    upstream.sent.map((request) => [
      request.url,
      request.headers.get('authorization'),
      request.headers.get('x-api-key'),
      request.headers.get('anthropic-beta'),
    ]),
    [
      [messages, 'Bearer access-1', null, 'tools-1,oauth-2025-04-20'],
      [messages, 'Bearer access-2', null, 'tools-1,oauth-2025-04-20'],
    ],
  )
})

test('whoever asks for the credential during a refresh waits for it, and the state does not say so', async () => {
  const scripted = claude()
  const plans = await signIn({ fetch: scripted.fetch, secret, sql: open() })
  await plans.rejected('claude', { generation: (await plans.inject('claude')).generation })
  let release = () => {}
  scripted.seen.gate = new Promise((resolve) => {
    release = resolve
  })
  const asked = [plans.inject('claude'), plans.inject('claude')]
  while (scripted.seen.grants.length < 2) await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await plans.status()).claude.state, 'exchange_uncertain')
  assert.equal(await plans.signedIn('claude'), false)
  release()
  assert.deepEqual(
    (await Promise.all(asked)).map((injection) => injection.headers['authorization']),
    ['Bearer access-2', 'Bearer access-2'],
  )
  assert.deepEqual(scripted.seen.grants, ['authorization_code', 'refresh_token'])
  assert.equal(await plans.signedIn('claude'), true)
})

test('a second 401, after the refresh, is the answer of the provider', async () => {
  const scripted = claude()
  const plans = await signIn({ fetch: scripted.fetch, secret, sql: open() })
  const upstream = provider(() => 401)
  const response = await Plans.send(plans, {
    endpoint: messages,
    headers: [],
    relay: upstream.relay,
  })
  assert.equal(response.status, 401)
  assert.equal(upstream.sent.length, 2)
  assert.equal((await plans.status()).claude.state, 'authenticated')
})

test('a plan whose refresh is refused cannot be used, and the error names the sign-in', async () => {
  const scripted = claude()
  const plans = await signIn({ fetch: scripted.fetch, secret, sql: open() })
  scripted.seen.refused = true
  const upstream = provider(() => 401)
  const failed = (error: unknown) =>
    error instanceof Plans.UnusableError && error.message.includes(Config.planSignIn)
  await assert.rejects(
    Plans.send(plans, { endpoint: messages, headers: [], relay: upstream.relay }),
    failed,
  )
  assert.equal(upstream.sent.length, 1)
  assert.equal((await plans.status()).claude.state, 'signed_out')
  await assert.rejects(
    Plans.send(plans, { endpoint: messages, headers: [], relay: upstream.relay }),
    failed,
  )
  assert.equal(upstream.sent.length, 1, 'a plan that is signed out sends nothing')
})

test('the token of a plan goes to the Messages endpoints of Claude only', async () => {
  const scripted = claude()
  const plans = await signIn({ fetch: scripted.fetch, secret, sql: open() })
  const upstream = provider(() => 200)
  for (const endpoint of [
    'https://example.com/v1/messages?beta=true',
    'https://api.anthropic.com/v1/files?beta=true',
    'https://api.anthropic.com/v1/messages',
  ])
    await assert.rejects(
      Plans.send(plans, { endpoint, headers: [], relay: upstream.relay }),
      /a claude plan does not serve/,
    )
  assert.equal(upstream.sent.length, 0)
})

test('one address takes the place of the hosts of Claude, for a network that needs a forwarder', async () => {
  const scripted = claude()
  const url = 'http://127.0.0.1:9/'
  const plans = await signIn({ fetch: scripted.fetch, secret, sql: open(), url })
  assert.deepEqual(scripted.seen.requests, [
    'POST http://127.0.0.1:9/v1/oauth/token',
    'GET http://127.0.0.1:9/api/oauth/profile',
  ])
  const upstream = provider(() => 200)
  await Plans.send(plans, { endpoint: messages, headers: [], relay: upstream.relay, url })
  assert.equal(upstream.sent[0]!.url, 'http://127.0.0.1:9/v1/messages?beta=true')
  assert.equal(Plans.target(messages, undefined), messages)
})

test('a run a plan pays for has claude sessions only', () => {
  const config = (extra: Record<string, unknown>) => ({
    agents: [{ id: 'a', model: 'claude-haiku-4-5', provider: 'claude' }],
    attempts: 1,
    budget: { modelUsd: 5, sandboxUsd: 0 },
    eval: { name: 'e' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'n',
    sandbox: { backend: 'dir', max: 1, network: 'host', pollMs: 250, provider: 'local', slots: 1 },
    ...extra,
  })
  assert.equal(Config.parse(config({})).payer, undefined)
  assert.equal(Config.parse(config({ payer: 'deployment' })).payer, undefined)
  assert.equal(Config.parse(config({ payer: 'plan' })).payer, 'plan')
  assert.equal(
    Config.parse(
      config({ judge: { model: 'claude-haiku-4-5', provider: 'claude' }, payer: 'plan' }),
    ).payer,
    'plan',
  )
  assert.equal(
    Config.parse(
      config({ agents: [{ id: 'oracle', model: 'solution', provider: 'oracle' }], payer: 'plan' }),
    ).payer,
    'plan',
  )
  assert.throws(() => Config.parse(config({ payer: 'wallet' })), /payer must be one of/)
  for (const provider of ['codex', 'codex-cli', 'claude-code'])
    assert.throws(
      () => Config.parse(config({ agents: [{ id: 'b', model: 'm', provider }], payer: 'plan' })),
      new RegExp('pays for claude sessions .*, and b is ' + provider),
    )
  assert.throws(
    () =>
      Config.parse(config({ judge: { model: 'gpt-6-luna', provider: 'codex' }, payer: 'plan' })),
    /and the judge is codex/,
  )
})

test('the state of the plan is printed with what to do next', () => {
  assert.match(
    planSummary({ account_id: 'account-1', expires_at: 1_800_000_000_000, state: 'authenticated' }),
    /^claude plan: signed in as account account-1, with a token until 2027-01-15T08:00:00.000Z/,
  )
  assert.match(
    planSummary({ expires_at: 1_800_000_000_000, state: 'pending' }),
    /waits until 2027-01-15T08:00:00.000Z for its code: nanoeval plans complete/,
  )
  assert.equal(
    planSummary({ state: 'signed_out' }),
    'claude plan: signed_out: sign in with nanoeval plans sign-in claude',
  )
})
