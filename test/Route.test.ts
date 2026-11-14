import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Atif from '../src/Atif.ts'
import * as Proxy from '../src/Proxy.ts'
import * as Route from '../src/Route.ts'

const started = (payload: Record<string, unknown>): Atif.SessionEvent => ({
  created_at: 1,
  event: { event: { payload, type: 'run.started' }, source: 'agent' },
  request_id: 'attempt',
  seq: 1,
})

const called = (usage: Record<string, unknown>): Atif.SessionEvent => ({
  created_at: 2,
  event: { event: { payload: { usage }, type: 'model.call.completed' }, source: 'agent' },
  request_id: 'attempt',
  seq: 2,
})

test('who pays follows the credential the deployment would put on a request', () => {
  const paid = (variables: Proxy.Variables, provider: Proxy.Provider) =>
    Route.paid({
      gateway: variables.TEMPO_KEY,
      held: Proxy.key(variables, provider),
      plan: false,
    })
  assert.deepEqual(paid({ OPENAI_API_KEY: 'k' }, 'codex'), { payer: 'key' })
  assert.deepEqual(paid({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://there' }, 'claude'), {
    payer: 'key',
    through: 'base',
  })
  assert.deepEqual(paid({ TEMPO_KEY: 't' }, 'codex'), { payer: 'gateway' })
  assert.deepEqual(paid({ OPENAI_API_KEY: 'k', TEMPO_KEY: 't' }, 'codex'), { payer: 'key' })
  assert.deepEqual(paid({ OPENAI_API_KEY: 'k', TEMPO_KEY: 't' }, 'claude'), { payer: 'gateway' })
  assert.equal(paid({}, 'claude'), undefined)
  const login = { headers: { authorization: 'Bearer token' }, kind: 'plan' as const }
  assert.deepEqual(Route.paid({ gateway: 't', held: login, plan: false }), { payer: 'login' })
  assert.deepEqual(
    Route.paid({
      gateway: undefined,
      held: { ...login, relay: { secret: 's', url: 'http://relay' } },
      plan: false,
    }),
    { payer: 'login', through: 'relay' },
  )
  assert.deepEqual(
    Route.paid({ gateway: 't', held: Proxy.key({ TEMPO_KEY: 't' }, 'claude'), plan: true }),
    {
      payer: 'plan',
    },
  )
})

test('a run that is planned is paid as the deployment says, and by the plan when it names it', () => {
  const deployment: Route.Deployment = { claude: { payer: 'key' }, codex: null }
  assert.deepEqual(Route.planned(deployment, { plan: false, provider: 'claude' }), { payer: 'key' })
  assert.deepEqual(Route.planned(deployment, { plan: true, provider: 'claude' }), { payer: 'plan' })
  assert.equal(Route.planned(deployment, { plan: false, provider: 'codex' }), undefined)
  assert.equal(Route.planned(deployment, { plan: false, provider: 'oracle' }), undefined)
  assert.equal(Route.planned(undefined, { plan: true, provider: 'claude' }), undefined)
})

test('the transport, the host and the effort are the ones the session reports when its turn starts', () => {
  const sse = started({
    effort: 'medium',
    model: 'gpt-6-luna',
    transport: 'responses_https_sse',
    websocket_url: 'https://api.openai.com/v1',
  })
  const socket = started({
    effort: 'medium',
    model: 'gpt-6-luna',
    transport: 'responses_websocket_v2',
    websocket_url: 'wss://chatgpt.com/backend-api/codex/responses',
  })
  const messages = started({
    effort: 'medium',
    model: 'claude-haiku-5-5',
    transport: 'messages_sse',
    websocket_url: '',
  })
  assert.deepEqual(Route.reported([sse, socket]), {
    effort: 'medium',
    host: 'api.openai.com',
    transport: 'responses_https_sse',
  })
  assert.deepEqual(Route.reported([socket]), {
    effort: 'medium',
    host: 'chatgpt.com',
    transport: 'responses_websocket_v2',
  })
  assert.deepEqual(Route.reported([messages]), { effort: 'medium', transport: 'messages_sse' })
  assert.deepEqual(
    Route.reported([
      started({ transport: 'responses_https_sse', websocket_url: 'https://models.example/v1' }),
    ]),
    { host: 'another host', transport: 'responses_https_sse' },
  )
  assert.deepEqual(Route.reported([started({ websocket_url: 'not a url' })]), {
    host: 'another host',
  })
  assert.deepEqual(Route.reported([called({})]), {})
})

test('a route reads as who paid, how the model was reached and at which effort', () => {
  const gateway: Route.Route = {
    effort: 'medium',
    host: 'api.openai.com',
    payer: 'gateway',
    transport: 'responses_https_sse',
  }
  const login: Route.Route = {
    effort: 'medium',
    host: 'chatgpt.com',
    payer: 'login',
    through: 'relay',
    transport: 'responses_websocket_v2',
  }
  assert.equal(
    Route.text([gateway]),
    'the gateway key, responses_https_sse to api.openai.com, effort medium',
  )
  assert.equal(
    Route.text([login, gateway, { ...login }]),
    'the gateway key, responses_https_sse to api.openai.com, effort medium and a plan login through the relay, responses_websocket_v2 to chatgpt.com, effort medium',
  )
  assert.equal(
    Route.text([{ payer: 'key', through: 'base' }]),
    'the provider key through a base URL',
  )
  assert.equal(
    Route.text([{ payer: 'plan', transport: 'messages_sse' }]),
    'the plan signed in on the Worker, messages_sse',
  )
  assert.equal(Route.text([{ transport: 'messages_sse' }]), 'payer not recorded, messages_sse')
  assert.equal(Route.text([]), 'not recorded')
  assert.equal(Route.text(undefined), 'not recorded')
  assert.deepEqual(Route.distinct([undefined, {}, login, { ...login }]), [login])
})

test('two sides differ in what both record, and what one does not record is named', () => {
  const gateway: Route.Route = {
    host: 'api.openai.com',
    payer: 'gateway',
    transport: 'responses_https_sse',
  }
  const login: Route.Route = {
    host: 'chatgpt.com',
    payer: 'login',
    transport: 'responses_websocket_v2',
  }
  assert.deepEqual(Route.differences([gateway], [{ ...gateway }]), { differ: [], missing: [] })
  assert.deepEqual(Route.differences([gateway], [login]), {
    differ: [
      { aspect: 'payer', left: 'the gateway key', right: 'a plan login' },
      { aspect: 'transport', left: 'responses_https_sse', right: 'responses_websocket_v2' },
      { aspect: 'host', left: 'api.openai.com', right: 'chatgpt.com' },
    ],
    missing: [],
  })
  assert.deepEqual(Route.differences([], [login]), {
    differ: [],
    missing: [
      { aspect: 'payer', side: 'left' },
      { aspect: 'transport', side: 'left' },
      { aspect: 'host', side: 'left' },
    ],
  })
  assert.deepEqual(Route.differences([{ payer: 'key' }], [{ payer: 'key' }]), {
    differ: [],
    missing: [],
  })
  assert.deepEqual(Route.differences([], []), {
    differ: [],
    missing: [{ aspect: 'payer', side: 'both' }],
  })
  assert.deepEqual(
    Route.differences([gateway, login], [login]).differ.map((each) => each.aspect),
    ['payer', 'transport', 'host'],
  )
})

test('reasoning tokens are summed from the model calls that report them, and absent when none does', () => {
  const codex = [
    called({
      input_tokens: 10,
      output_tokens: 206,
      output_tokens_details: { reasoning_tokens: 40 },
    }),
    called({
      input_tokens: 10,
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 0 },
    }),
  ]
  assert.equal(Atif.usage(codex).reasoningTokens, 40)
  assert.equal(Atif.usage(codex).outputTokens, 306)
  const claude = [called({ input_tokens: 10, output_tokens: 198 })]
  assert.equal(Atif.usage(claude).reasoningTokens, undefined)
  assert.equal('reasoningTokens' in Atif.usage(claude), false)
  assert.equal(Atif.sum([Atif.usage(codex), Atif.usage(claude)]).reasoningTokens, 40)
  assert.equal(Atif.sum([Atif.usage(claude)]).reasoningTokens, undefined)
  const trajectory = Atif.fromEvents(codex, {
    model: 'm',
    name: 'nanocode',
    session: 's',
    version: 'v',
  })
  assert.equal(trajectory.final_metrics.extra.reasoning_tokens, 40)
  assert.equal(trajectory.steps[0]!.metrics!.extra['reasoning_tokens'], 40)
})

test('a run is refused when the Worker holds no credential for the models it names', () => {
  const deployment: Route.Deployment = { claude: { payer: 'key' }, codex: null }
  const users = [
    { name: 'the agent haiku', provider: 'claude' as const },
    { name: 'the agent luna', provider: 'codex' as const },
    { name: 'the judge', provider: 'codex' as const },
  ]
  assert.equal(
    Route.unserved(deployment, { plan: false, users }),
    'the Worker holds no credential for the codex models of the agent luna and the judge: start nanoeval worker with OPENAI_API_KEY or TEMPO_KEY in its environment or with --codex-login FILE, or give a deployed Worker one of them as a secret. A run with --oracle needs none',
  )
  assert.equal(Route.unserved(deployment, { plan: false, users: users.slice(0, 1) }), undefined)
  assert.equal(Route.unserved(deployment, { plan: false, users: [] }), undefined)
  assert.equal(Route.unserved(deployment, { plan: true, users }), undefined)
  assert.equal(Route.unserved(undefined, { plan: false, users }), undefined)
  assert.match(
    Route.unserved({ claude: null, codex: null }, { plan: false, users })!,
    /^the Worker holds no credential for the claude models of the agent haiku: start nanoeval worker with ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or TEMPO_KEY in its environment or with --claude-login FILE,/,
  )
})
