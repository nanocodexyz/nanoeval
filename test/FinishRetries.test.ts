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
  name: 'finish-retries',
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
  /\[:yield_share=N\]\[:finish_retries=N\]\[:finish_check=on\]\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\|on\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\]\[:stall_nudge_ms=N\]\[:hedge_cap_percent=0\.\.100\], not x=/

const retry = 'nano-med-retry=claude:claude-opus-5-5:medium:finish_retries=1'

const direct =
  'nano-dr=claude-direct:claude-sonnet-5-5:high:brief_finish=on:late_finish_check_ms=120000:result_effort=low:yield_share=25:finish_retries=3'

test('an agent names finish_retries after yield_share in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(retry), {
    finishRetries: 1,
    id: 'nano-med-retry',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent(direct), {
    briefFinish: true,
    finishRetries: 3,
    id: 'nano-dr',
    lateFinishCheckMs: 120000,
    model: 'claude-sonnet-5-5',
    orchestration: 'direct',
    provider: 'claude',
    resultEffort: 'low',
    thinking: 'high',
    yieldShare: 25,
  })
  for (const text of [
    retry,
    direct,
    'a=claude:claude-opus-5-5:finish_retries=12',
    'b=claude+preflight:claude-opus-5-5:low:stop_at_target=on:finish_retries=2',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:finish_retries=',
    'x=claude:claude-opus-5-5:finish_retries=-1',
    'x=claude:claude-opus-5-5:finish_retries=1.5',
    'x=claude:claude-opus-5-5:finish_retries=on',
    'x=claude:claude-opus-5-5:finish_retries',
    'x=claude:claude-opus-5-5:finish_retries=1:yield_share=25',
    'x=claude:claude-opus-5-5:finish_retries=1:finish_retries=2',
    'x=claude:claude-opus-5-5:finish_retry=1',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes finishRetries for a claude agent and refuses bad values, other providers and skip_finish_check', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
        parseAgent(retry),
        parseAgent(direct),
      ],
    }).agents.map((agent) => [agent.id, agent.finishRetries]),
    [
      ['nano-med-plain', undefined],
      ['nano-med-retry', 1],
      ['nano-dr', 3],
    ],
  )
  for (const finishRetries of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ finishRetries, id: 'x', model: 'm', provider: 'claude' }],
        }),
      /x: finishRetries must be an integer of at least 1/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('x=claude:claude-opus-5-5:finish_retries=0')],
      }),
    /x: finishRetries must be an integer of at least 1/,
  )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ finishRetries: 1, id: 'x', model: 'm', provider }],
        }),
      /x has a finishRetries, which only a claude session takes/,
    )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:finish_retries=1',
    'nanox=codex-code-mode:gpt-6-luna:high:finish_retries=1',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a finishRetries, which only a claude session takes/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:skip_finish_check=on:finish_retries=1',
    'x=claude-direct:claude-opus-5-5:skip_finish_check=on:finish_retries=2',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x has a skipFinishCheck and a finishRetries, which never go in one arm/,
    )
})

test('a turn sends finish_retries only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      briefFinish: true,
      lateFinishCheckMs: 120000,
      resultEffort: 'low',
      yieldShare: 25,
    } as const
    for (const named of [plain, others]) {
      assert.equal('finish_retries' in Turn.body(named), false)
      assert.equal('finish_retries' in JSON.parse(Turn.sent(named, input)), false)
      const withRetries = { ...named, finishRetries: 2 }
      assert.equal(Turn.body(withRetries).finish_retries, 2)
      assert.equal(JSON.parse(Turn.sent(withRetries, input)).finish_retries, 2)
      assert.deepEqual(
        Object.keys(Turn.body(withRetries))
          .filter((key) => key !== 'finish_retries')
          .sort(),
        Object.keys(Turn.body(named)).sort(),
      )
      const { finish_retries: _, ...rest } = JSON.parse(Turn.sent(withRetries, input))
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
    }
    assert.equal(
      JSON.stringify(Turn.body({ ...plain, finishRetries: undefined })),
      JSON.stringify(Turn.body(plain)),
    )
    assert.equal(Turn.sent({ ...plain, finishRetries: undefined }, input), Turn.sent(plain, input))
  }
})
