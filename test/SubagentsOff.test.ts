import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'
import * as Turn from '../src/Turn.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'subagents-off',
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
  model: 'claude-opus-5-5',
  prompt: 'Write the greeting.',
  provider: 'claude',
  requestId: 'turn-1',
  thinking: 'medium',
}

const usage =
  /\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\]\[:clearing_cache_floors=on\]\[:verification_requested=on\]\[:persistence_nudge=on\], not x=/

const nosub = 'nano-med-nosub=claude:claude-opus-5-5:medium:subagents=off'

const direct =
  'nano-dn=claude-direct:claude-opus-5-5:high:tool_result_tokens=2000:yield_share=25:finish_ambiguity=on:tool_result_clearing=12/20000:subagents=off'

test('an agent names subagents=off after tool_result_clearing in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(nosub), {
    id: 'nano-med-nosub',
    model: 'claude-opus-5-5',
    provider: 'claude',
    subagents: false,
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent(direct), {
    finishAmbiguity: true,
    id: 'nano-dn',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    subagents: false,
    thinking: 'high',
    toolResultClearing: { atLeastTokens: 20000, keep: 12 },
    toolResultTokens: 2000,
    yieldShare: 25,
  })
  for (const text of [
    nosub,
    direct,
    'a=claude:claude-opus-5-5:subagents=off',
    'b=claude+preflight:claude-sonnet-5-5:low:finish_check=on:subagents=off',
    'c=claude:claude-opus-5-5:medium:tool_result_clearing=2/10000:subagents=off',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.equal(
    agentText(parseAgent('nano-med-plain=claude:claude-opus-5-5:medium')),
    'nano-med-plain=claude:claude-opus-5-5:medium',
  )
  for (const text of [
    'x=claude:claude-opus-5-5:subagents=',
    'x=claude:claude-opus-5-5:subagents=on',
    'x=claude:claude-opus-5-5:subagents=false',
    'x=claude:claude-opus-5-5:subagents=0',
    'x=claude:claude-opus-5-5:subagents=OFF',
    'x=claude:claude-opus-5-5:subagents=off:tool_result_clearing=2/10000',
    'x=claude:claude-opus-5-5:subagents=off:finish_check=on',
    'x=claude:claude-opus-5-5:subagents=off:subagents=off',
    'x=claude:claude-opus-5-5:subagent=off',
    'x=claude:claude-opus-5-5:no_subagents=on',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes subagents as false for a claude agent and refuses other values and other providers', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
        parseAgent(nosub),
        parseAgent(direct),
      ],
    }).agents.map((agent) => [agent.id, agent.subagents, 'subagents' in agent]),
    [
      ['nano-med-plain', undefined, false],
      ['nano-med-nosub', false, true],
      ['nano-dn', false, true],
    ],
  )
  assert.equal(Config.agentKeys.includes('subagents'), true)
  for (const subagents of [true, 'off', 0, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider: 'claude', subagents }],
        }),
      /x has a subagents that is not false/,
    )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'nanocode-claude', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider, subagents: false }],
        }),
      /x has a subagents, which only a claude session takes/,
    )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:subagents=off',
    'nanox=codex-code-mode:gpt-6-luna:high:subagents=off',
    'nanox=claude-code:claude-opus-5-5:medium:subagents=off',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a subagents, which only a claude session takes/,
    )
})

test('a turn sends subagents as false only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      finishAmbiguity: true,
      finishRetries: 2,
      toolResultClearing: { atLeastTokens: 10000, keep: 2 },
      toolResultTokens: 2000,
      yieldShare: 25,
    } as const
    for (const named of [plain, others]) {
      assert.equal('subagents' in Turn.body(named), false)
      assert.equal('subagents' in JSON.parse(Turn.sent(named, input)), false)
      const without = { ...named, subagents: false } as const
      const { subagents: sent, ...body } = Turn.body(without)
      assert.equal(sent, false)
      assert.deepEqual(body, Turn.body(named))
      const { subagents: recorded, ...rest } = JSON.parse(Turn.sent(without, input))
      assert.equal(recorded, false)
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
    }
  }
  assert.equal(
    JSON.stringify(Turn.body(turn)),
    '{"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, subagents: false })),
    '{"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","subagents":false,"thinking":"medium"}',
  )
  assert.equal(
    Turn.sent(turn, input),
    '{"at_ms":1800000000000,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
  assert.equal(
    Turn.sent({ ...turn, subagents: false }, input),
    '{"at_ms":1800000000000,"deadline":null,"request_id":"turn-1","session":"run-a00001","subagents":false}\n',
  )
  const codex: Turn.Turn = { ...turn, model: 'gpt-6-luna', provider: 'codex' }
  assert.equal(
    JSON.stringify(Turn.body(codex)),
    '{"hand":"slot","model":"gpt-6-luna","prompt":"Write the greeting.","provider":"codex","request_id":"turn-1","subagents":false,"thinking":"medium","web_search":false}',
  )
  assert.equal(
    Turn.sent(codex, input),
    '{"at_ms":1800000000000,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
})
