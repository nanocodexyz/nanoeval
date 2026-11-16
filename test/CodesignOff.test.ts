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
  name: 'codesign-off',
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

const usage = /\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\], not x=/

const nocd = 'nano-high-nocd=claude:claude-opus-5-5:high:codesign=off'

const direct =
  'nano-dn=claude-direct:claude-opus-5-5:high:finish_check=on:subagents=off:clearing_cache_floors=on:codesign=off'

test('an agent names codesign=off last in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(nocd), {
    codesign: false,
    id: 'nano-high-nocd',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'high',
  })
  assert.deepEqual(parseAgent(direct), {
    clearingCacheFloors: true,
    codesign: false,
    finishCheck: true,
    id: 'nano-dn',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    subagents: false,
    thinking: 'high',
  })
  for (const text of [
    nocd,
    direct,
    'a=claude:claude-opus-5-5:codesign=off',
    'b=claude+preflight:claude-sonnet-5-5:low:finish_check=on:codesign=off',
    'c=claude:claude-opus-5-5:high:finish_check=on:codesign=off',
    'd=codex:gpt-6-luna:high:context_window=128000:codesign=off',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:codesign=',
    'x=claude:claude-opus-5-5:codesign=on',
    'x=claude:claude-opus-5-5:codesign=false',
    'x=claude:claude-opus-5-5:codesign=0',
    'x=claude:claude-opus-5-5:codesign=OFF',
    'x=claude:claude-opus-5-5:codesign=off:subagents=off',
    'x=claude:claude-opus-5-5:codesign=off:clearing_cache_floors=on',
    'x=claude:claude-opus-5-5:codesign=off:finish_check=on',
    'x=claude:claude-opus-5-5:codesign=off:context_window=1000',
    'x=claude:claude-opus-5-5:codesign=off:codesign=off',
    'x=claude:claude-opus-5-5:co_design=off',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes codesign as false for a claude agent and refuses other values and other providers', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-high=claude:claude-opus-5-5:high:finish_check=on'),
        parseAgent(nocd),
        parseAgent(direct),
      ],
    }).agents.map((agent) => [agent.id, agent.codesign, 'codesign' in agent]),
    [
      ['nano-high', undefined, false],
      ['nano-high-nocd', false, true],
      ['nano-dn', false, true],
    ],
  )
  assert.equal(Config.agentKeys.includes('codesign'), true)
  for (const codesign of [true, 'off', 0, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ codesign, id: 'x', model: 'm', provider: 'claude' }],
        }),
      /x has a codesign that is not false/,
    )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'opencode', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ codesign: false, id: 'x', model: 'm', provider }],
        }),
      /x has a codesign, which only a claude session takes/,
    )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:codesign=off',
    'nanox=codex-code-mode:gpt-6-luna:high:codesign=off',
    'nanox=claude-code:claude-opus-5-5:high:codesign=off',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a codesign, which only a claude session takes/,
    )
})

test('a turn sends codesign as false only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      clearingCacheFloors: true,
      finishCheck: true,
      subagents: false,
      toolResultClearing: { atLeastTokens: 10000, keep: 2 },
    } as const
    for (const named of [plain, others]) {
      assert.equal('codesign' in Turn.body(named), false)
      assert.equal('codesign' in JSON.parse(Turn.sent(named, input)), false)
      const without = { ...named, codesign: false } as const
      const { codesign: sent, ...body } = Turn.body(without)
      assert.equal(sent, false)
      assert.deepEqual(body, Turn.body(named))
      const { codesign: recorded, ...rest } = JSON.parse(Turn.sent(without, input))
      assert.equal(recorded, false)
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
    }
  }
  assert.equal(
    JSON.stringify(Turn.body(turn)),
    '{"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, codesign: false })),
    '{"hand":"slot","codesign":false,"model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    Turn.sent(turn, input),
    '{"at_ms":1800000000000,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
  assert.equal(
    Turn.sent({ ...turn, codesign: false }, input),
    '{"at_ms":1800000000000,"codesign":false,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
})
