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
  name: 'tool-result-clearing',
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
  /\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\|on\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\], not x=/

const clearing = 'nano-med-clear=claude:claude-opus-5-5:medium:tool_result_clearing=2/10000'

const direct =
  'nano-dt=claude-direct:claude-opus-5-5:high:tool_result_tokens=2000:yield_share=25:finish_ambiguity=on:tool_result_clearing=12/20000'

test('an agent names tool_result_clearing after finish_ambiguity in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(clearing), {
    id: 'nano-med-clear',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
    toolResultClearing: { atLeastTokens: 10000, keep: 2 },
  })
  assert.deepEqual(parseAgent(direct), {
    finishAmbiguity: true,
    id: 'nano-dt',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    thinking: 'high',
    toolResultClearing: { atLeastTokens: 20000, keep: 12 },
    toolResultTokens: 2000,
    yieldShare: 25,
  })
  for (const text of [
    clearing,
    direct,
    'a=claude:claude-opus-5-5:tool_result_clearing=0/0',
    'b=claude+preflight:claude-sonnet-5-5:low:finish_check=on:tool_result_clearing=1/5000',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:tool_result_clearing=',
    'x=claude:claude-opus-5-5:tool_result_clearing',
    'x=claude:claude-opus-5-5:tool_result_clearing=2',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/',
    'x=claude:claude-opus-5-5:tool_result_clearing=/10000',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/10000/1',
    'x=claude:claude-opus-5-5:tool_result_clearing=2,10000',
    'x=claude:claude-opus-5-5:tool_result_clearing=2:10000',
    'x=claude:claude-opus-5-5:tool_result_clearing=-2/10000',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/1.5',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/10k',
    'x=claude:claude-opus-5-5:tool_result_clearing=on',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/10000:finish_ambiguity=on',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/10000:yield_share=25',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/10000:tool_result_clearing=2/10000',
    'x=claude:claude-opus-5-5:tool_result_clearings=2/10000',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes toolResultClearing for a claude agent and refuses malformed values and other providers', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
        parseAgent(clearing),
        parseAgent(direct),
        {
          id: 'zero',
          model: 'm',
          provider: 'claude',
          toolResultClearing: { atLeastTokens: 0, keep: 0 },
        },
      ],
    }).agents.map((agent) => [agent.id, agent.toolResultClearing]),
    [
      ['nano-med-plain', undefined],
      ['nano-med-clear', { atLeastTokens: 10000, keep: 2 }],
      ['nano-dt', { atLeastTokens: 20000, keep: 12 }],
      ['zero', { atLeastTokens: 0, keep: 0 }],
    ],
  )
  assert.equal(Config.agentKeys.includes('toolResultClearing'), true)
  assert.equal(
    'toolResultClearing' in
      Config.parse({
        ...config,
        agents: [parseAgent('nano-med-plain=claude:claude-opus-5-5:medium')],
      }).agents[0]!,
    false,
  )
  for (const toolResultClearing of [
    null,
    true,
    'on',
    '2/10000',
    2,
    [2, 10000],
    { atLeastTokens: 10000, keep: 2, other: 1 },
    { at_least_tokens: 10000, keep: 2 },
  ])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider: 'claude', toolResultClearing }],
        }),
      /x has a toolResultClearing that is not \{ atLeastTokens, keep \}/,
    )
  for (const atLeastTokens of [undefined, -1, 1.5, '10000', null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [
            {
              id: 'x',
              model: 'm',
              provider: 'claude',
              toolResultClearing: { atLeastTokens, keep: 2 },
            },
          ],
        }),
      /x: toolResultClearing.atLeastTokens must be an integer of at least 0/,
    )
  for (const keep of [undefined, -1, 0.5, '2', null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [
            {
              id: 'x',
              model: 'm',
              provider: 'claude',
              toolResultClearing: { atLeastTokens: 10000, keep },
            },
          ],
        }),
      /x: toolResultClearing.keep must be an integer of at least 0/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:tool_result_clearing=99999999999999999999/10000',
    'x=claude:claude-opus-5-5:tool_result_clearing=2/99999999999999999999',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x: toolResultClearing\.(atLeastTokens|keep) must be an integer of at least 0/,
    )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [
            {
              id: 'x',
              model: 'm',
              provider,
              toolResultClearing: { atLeastTokens: 10000, keep: 2 },
            },
          ],
        }),
      /x has a toolResultClearing, which only a claude session takes/,
    )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:tool_result_clearing=2/10000',
    'nanox=codex-code-mode:gpt-6-luna:high:tool_result_clearing=2/10000',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a toolResultClearing, which only a claude session takes/,
    )
})

test('a turn sends tool_result_clearing only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      finishAmbiguity: true,
      finishRetries: 2,
      toolResultTokens: 2000,
      yieldShare: 25,
    } as const
    for (const named of [plain, others]) {
      assert.equal('tool_result_clearing' in Turn.body(named), false)
      assert.equal('tool_result_clearing' in JSON.parse(Turn.sent(named, input)), false)
      const withClearing = { ...named, toolResultClearing: { atLeastTokens: 10000, keep: 2 } }
      const { tool_result_clearing: sent, ...body } = Turn.body(withClearing)
      assert.deepEqual(sent, { at_least_tokens: 10000, keep: 2 })
      assert.deepEqual(body, Turn.body(named))
      const { tool_result_clearing: recorded, ...rest } = JSON.parse(Turn.sent(withClearing, input))
      assert.deepEqual(recorded, { at_least_tokens: 10000, keep: 2 })
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
    }
    assert.equal(
      JSON.stringify(Turn.body({ ...plain, toolResultClearing: undefined })),
      JSON.stringify(Turn.body(plain)),
    )
    assert.equal(
      Turn.sent({ ...plain, toolResultClearing: undefined }, input),
      Turn.sent(plain, input),
    )
  }
  assert.equal(
    JSON.stringify(Turn.body(turn)),
    '{"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    JSON.stringify(
      Turn.body({
        ...turn,
        finishAmbiguity: true,
        toolResultClearing: { atLeastTokens: 10000, keep: 2 },
      }),
    ),
    '{"finish_ambiguity":true,"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium","tool_result_clearing":{"at_least_tokens":10000,"keep":2}}',
  )
})
