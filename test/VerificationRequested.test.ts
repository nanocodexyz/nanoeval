import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'
import * as Installed from '../src/Installed.ts'
import * as Turn from '../src/Turn.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'verification-requested',
  sandbox: {
    backend: 'krun',
    max: 1,
    network: 'private',
    pollMs: 250,
    provider: 'local',
    slots: 2,
    timeoutSec: 3600,
  },
}

const turn: Turn.Turn = {
  hand: 'slot',
  model: 'gpt-6-luna',
  orchestration: 'direct',
  prompt: 'Write the greeting.',
  provider: 'codex',
  requestId: 'turn-1',
  thinking: 'high',
}

const usage =
  /\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\]\[:clearing_cache_floors=on\]\[:verification_requested=on\]\[:persistence_nudge=on\], not x=/

const verify = 'nanox-verify=codex:gpt-6-luna:high:verification_requested=on'

const persist = 'nanox-pv=codex:gpt-6-luna:high:persist_finish=on:verification_requested=on'

test('an agent names verification_requested after clearing_cache_floors in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(verify), {
    id: 'nanox-verify',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    provider: 'codex',
    thinking: 'high',
    verificationRequested: true,
  })
  assert.deepEqual(parseAgent(persist), {
    id: 'nanox-pv',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    persistFinish: true,
    provider: 'codex',
    thinking: 'high',
    verificationRequested: true,
  })
  for (const text of [
    verify,
    persist,
    'a=codex:gpt-6-luna:verification_requested=on',
    'b=codex-code-mode:gpt-6-luna:high:verification_requested=on',
    'c=codex-jobs:gpt-6-luna:high:verification_requested=on',
    'd=codex+preflight:gpt-6-luna:high:cell_yield_ms=120000:persist_finish=on:verification_requested=on',
    'e=codex:gpt-6-luna:high:branches=3:verification_requested=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.deepEqual(
    parseAgent('nanox-verify=codex-direct:gpt-6-luna:high:verification_requested=on'),
    parseAgent(verify),
  )
  for (const text of [
    'x=codex:gpt-6-luna:high:verification_requested=',
    'x=codex:gpt-6-luna:high:verification_requested=1',
    'x=codex:gpt-6-luna:high:verification_requested=true',
    'x=codex:gpt-6-luna:high:verification_requested=off',
    'x=codex:gpt-6-luna:high:verification_requested=ON',
    'x=codex:gpt-6-luna:high:verification_requested',
    'x=codex:gpt-6-luna:high:verification_requested=on:persist_finish=on',
    'x=codex:gpt-6-luna:high:verification_requested=on:cell_yield_ms=120000',
    'x=codex:gpt-6-luna:high:verification_requested=on:verification_requested=on',
    'x=codex:gpt-6-luna:high:verification_request=on',
    'x=claude:claude-opus-5-5:medium:verification_requested=on:clearing_cache_floors=on',
    'x=claude:claude-opus-5-5:medium:verification_requested=on:subagents=off',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes verificationRequested for a codex agent and refuses bad values and every other harness', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nanox=codex:gpt-6-luna:high'),
        parseAgent(verify),
        parseAgent(persist),
        parseAgent('nanox-cm=codex-code-mode:gpt-6-luna:high:verification_requested=on'),
        parseAgent('nanox-jobs=codex-jobs:gpt-6-luna:high:verification_requested=on'),
      ],
    }).agents.map((agent) => [
      agent.id,
      agent.verificationRequested,
      agent.persistFinish,
      agent.orchestration,
    ]),
    [
      ['nanox', undefined, undefined, 'direct'],
      ['nanox-verify', true, undefined, 'direct'],
      ['nanox-pv', true, true, 'direct'],
      ['nanox-cm', true, undefined, undefined],
      ['nanox-jobs', true, undefined, 'jobs'],
    ],
  )
  assert.equal(Config.agentKeys.includes('verificationRequested'), true)
  assert.equal((Config.finishLevers as readonly string[]).includes('verificationRequested'), false)
  const plain = Config.parse({ ...config, agents: [parseAgent('nanox=codex:gpt-6-luna:high')] })
  assert.equal(
    JSON.stringify(plain.agents),
    '[{"id":"nanox","model":"gpt-6-luna","orchestration":"direct","provider":"codex","thinking":"high"}]',
  )
  assert.equal(
    JSON.stringify(
      Config.parse({
        ...config,
        agents: [
          { ...parseAgent('nanox=codex:gpt-6-luna:high'), verificationRequested: undefined },
        ],
      }).agents,
    ),
    JSON.stringify(plain.agents),
  )
  for (const verificationRequested of [false, 'on', 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider: 'codex', verificationRequested }],
        }),
      /x has a verificationRequested that is not true/,
    )
  for (const provider of ['claude', 'oracle', ...Installed.kinds])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider, verificationRequested: true }],
        }),
      /x has a verificationRequested, which only a codex session takes/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:medium:verification_requested=on',
    'x=claude-direct:claude-opus-5-5:medium:verification_requested=on',
    'x=claude:claude-opus-5-5:medium:persist_finish=on:verification_requested=on',
    'x=claude:claude-opus-5-5:medium:subagents=off:clearing_cache_floors=on:verification_requested=on',
    ...Installed.harnesses.map((harness) => 'x=' + harness + ':m:verification_requested=on'),
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x has a verificationRequested, which only a codex session takes/,
    )
})

test('a turn sends verification_requested only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  const { orchestration: _, ...codeMode } = turn
  for (const plain of [
    turn,
    codeMode,
    { ...turn, orchestration: 'jobs' },
    { ...turn, cellYieldMs: 120000, persistFinish: true },
  ] as const) {
    assert.equal('verification_requested' in Turn.body(plain), false)
    assert.equal('verification_requested' in JSON.parse(Turn.sent(plain, input)), false)
    const named = { ...plain, verificationRequested: true } as const
    const { verification_requested: sent, ...body } = Turn.body(named)
    assert.equal(sent, true)
    assert.deepEqual(body, Turn.body(plain))
    const { verification_requested: recorded, ...rest } = JSON.parse(Turn.sent(named, input))
    assert.equal(recorded, true)
    assert.deepEqual(rest, JSON.parse(Turn.sent(plain, input)))
    assert.equal(
      JSON.stringify(Turn.body({ ...plain, verificationRequested: undefined })),
      JSON.stringify(Turn.body(plain)),
    )
    assert.equal(
      Turn.sent({ ...plain, verificationRequested: undefined }, input),
      Turn.sent(plain, input),
    )
  }
  assert.equal(
    JSON.stringify(Turn.body(turn)),
    '{"hand":"slot","codex_orchestration":"direct","model":"gpt-6-luna","prompt":"Write the greeting.","provider":"codex","request_id":"turn-1","subagents":false,"thinking":"high","web_search":false}',
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, verificationRequested: true })),
    '{"verification_requested":true,"hand":"slot","codex_orchestration":"direct","model":"gpt-6-luna","prompt":"Write the greeting.","provider":"codex","request_id":"turn-1","subagents":false,"thinking":"high","web_search":false}',
  )
  assert.equal(
    Turn.sent(turn, input),
    '{"at_ms":1800000000000,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
  assert.equal(
    Turn.sent({ ...turn, verificationRequested: true }, input),
    '{"at_ms":1800000000000,"verification_requested":true,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
  const claude: Turn.Turn = {
    hand: 'slot',
    model: 'claude-opus-5-5',
    prompt: 'Write the greeting.',
    provider: 'claude',
    requestId: 'turn-1',
    thinking: 'medium',
  }
  assert.equal(
    JSON.stringify(Turn.body(claude)),
    '{"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
})
