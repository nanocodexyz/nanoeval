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
  name: 'clearing-cache-floors',
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
  /\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\], not x=/

const floors = 'nano-med-floors=claude:claude-opus-5-5:medium:clearing_cache_floors=on'

const direct =
  'nano-df=claude-direct:claude-opus-5-5:high:brief_finish=on:yield_share=25:finish_check=on:finish_ambiguity=on:tool_result_clearing=2/10000:clearing_cache_floors=on'

test('an agent names clearing_cache_floors after subagents in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(floors), {
    clearingCacheFloors: true,
    id: 'nano-med-floors',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent(direct), {
    briefFinish: true,
    clearingCacheFloors: true,
    finishAmbiguity: true,
    finishCheck: true,
    id: 'nano-df',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    thinking: 'high',
    toolResultClearing: { atLeastTokens: 10000, keep: 2 },
    yieldShare: 25,
  })
  for (const text of [
    floors,
    direct,
    'a=claude:claude-opus-5-5:clearing_cache_floors=on',
    'b=claude+preflight:claude-sonnet-5-5:low:yield_share=50:clearing_cache_floors=on',
    'c=claude:claude-opus-5-5:medium:tool_result_clearing=2/10000:clearing_cache_floors=on',
    'd=claude:claude-opus-5-5:medium:skip_finish_check=on:clearing_cache_floors=on',
    'e=claude:claude-opus-5-5:medium:tool_result_clearing=2/10000:subagents=off:clearing_cache_floors=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:clearing_cache_floors=',
    'x=claude:claude-opus-5-5:clearing_cache_floors=1',
    'x=claude:claude-opus-5-5:clearing_cache_floors=true',
    'x=claude:claude-opus-5-5:clearing_cache_floors=off',
    'x=claude:claude-opus-5-5:clearing_cache_floors',
    'x=claude:claude-opus-5-5:clearing_cache_floors=on:yield_share=25',
    'x=claude:claude-opus-5-5:clearing_cache_floors=on:finish_ambiguity=on',
    'x=claude:claude-opus-5-5:clearing_cache_floors=on:tool_result_clearing=2/10000',
    'x=claude:claude-opus-5-5:clearing_cache_floors=on:subagents=off',
    'x=claude:claude-opus-5-5:clearing_cache_floors=on:clearing_cache_floors=on',
    'x=claude:claude-opus-5-5:clearing_cache_floor=on',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes clearingCacheFloors for a claude agent and refuses bad values and other providers', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
        parseAgent(floors),
        parseAgent(direct),
        parseAgent(
          'nano-skip=claude:claude-opus-5-5:medium:skip_finish_check=on:clearing_cache_floors=on',
        ),
      ],
    }).agents.map((agent) => [agent.id, agent.clearingCacheFloors, agent.toolResultClearing]),
    [
      ['nano-med-plain', undefined, undefined],
      ['nano-med-floors', true, undefined],
      ['nano-df', true, { atLeastTokens: 10000, keep: 2 }],
      ['nano-skip', true, undefined],
    ],
  )
  assert.equal(Config.finishLevers.includes('clearingCacheFloors'), true)
  assert.equal(Config.agentKeys.includes('clearingCacheFloors'), true)
  for (const clearingCacheFloors of [false, 'on', 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ clearingCacheFloors, id: 'x', model: 'm', provider: 'claude' }],
        }),
      /x has a clearingCacheFloors that is not true/,
    )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ clearingCacheFloors: true, id: 'x', model: 'm', provider }],
        }),
      /x has a clearingCacheFloors, which only a claude session takes/,
    )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:clearing_cache_floors=on',
    'nanox=codex-code-mode:gpt-6-luna:high:clearing_cache_floors=on',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a clearingCacheFloors, which only a claude session takes/,
    )
})

test('a turn sends clearing_cache_floors only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      briefFinish: true,
      finishAmbiguity: true,
      finishCheck: true,
      toolResultClearing: { atLeastTokens: 10000, keep: 2 },
      yieldShare: 25,
    } as const
    for (const named of [plain, others]) {
      assert.equal('clearing_cache_floors' in Turn.body(named), false)
      assert.equal('clearing_cache_floors' in JSON.parse(Turn.sent(named, input)), false)
      const withFloors = { ...named, clearingCacheFloors: true } as const
      assert.equal(Turn.body(withFloors).clearing_cache_floors, true)
      assert.equal(JSON.parse(Turn.sent(withFloors, input)).clearing_cache_floors, true)
      const { clearing_cache_floors: sent, ...body } = Turn.body(withFloors)
      assert.equal(sent, true)
      assert.deepEqual(body, Turn.body(named))
      const { clearing_cache_floors: _, ...rest } = JSON.parse(Turn.sent(withFloors, input))
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
    }
    assert.equal(
      JSON.stringify(Turn.body({ ...plain, clearingCacheFloors: undefined })),
      JSON.stringify(Turn.body(plain)),
    )
    assert.equal(
      Turn.sent({ ...plain, clearingCacheFloors: undefined }, input),
      Turn.sent(plain, input),
    )
  }
  assert.equal(
    JSON.stringify(Turn.body(turn)),
    '{"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, clearingCacheFloors: true })),
    '{"clearing_cache_floors":true,"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
})
