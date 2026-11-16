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
  name: 'finish-check',
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
  /\[:finish_retries=N\]\[:finish_check=on\]\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\|on\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\], not x=/

const check = 'nano-med-check=claude:claude-opus-5-5:medium:finish_check=on'

const direct =
  'nano-dc=claude-direct:claude-opus-5-5:high:brief_finish=on:result_effort=low:yield_share=25:finish_retries=2:finish_check=on'

test('an agent names finish_check after finish_retries in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(check), {
    finishCheck: true,
    id: 'nano-med-check',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent(direct), {
    briefFinish: true,
    finishCheck: true,
    finishRetries: 2,
    id: 'nano-dc',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    resultEffort: 'low',
    thinking: 'high',
    yieldShare: 25,
  })
  for (const text of [
    check,
    direct,
    'a=claude:claude-opus-5-5:finish_check=on',
    'b=claude+preflight:claude-sonnet-5-5:low:late_finish_check_ms=120000:finish_check=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:finish_check=',
    'x=claude:claude-opus-5-5:finish_check=1',
    'x=claude:claude-opus-5-5:finish_check=true',
    'x=claude:claude-opus-5-5:finish_check=off',
    'x=claude:claude-opus-5-5:finish_check',
    'x=claude:claude-opus-5-5:finish_check=on:finish_retries=1',
    'x=claude:claude-opus-5-5:finish_check=on:finish_check=on',
    'x=claude:claude-opus-5-5:finish_checks=on',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes finishCheck for a claude agent and refuses bad values, other providers and skip_finish_check', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
        parseAgent(check),
        parseAgent(direct),
      ],
    }).agents.map((agent) => [agent.id, agent.finishCheck, agent.finishRetries]),
    [
      ['nano-med-plain', undefined, undefined],
      ['nano-med-check', true, undefined],
      ['nano-dc', true, 2],
    ],
  )
  assert.equal(Config.finishLevers.includes('finishCheck'), true)
  for (const finishCheck of [false, 'on', 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ finishCheck, id: 'x', model: 'm', provider: 'claude' }],
        }),
      /x has a finishCheck that is not true/,
    )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ finishCheck: true, id: 'x', model: 'm', provider }],
        }),
      /x has a finishCheck, which only a claude session takes/,
    )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:finish_check=on',
    'nanox=codex-code-mode:gpt-6-luna:high:finish_check=on',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a finishCheck, which only a claude session takes/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:skip_finish_check=on:finish_check=on',
    'x=claude-direct:claude-opus-5-5:skip_finish_check=on:finish_check=on',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x has a skipFinishCheck and a finishCheck, which never go in one arm/,
    )
})

test('a turn sends finish_check only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      briefFinish: true,
      finishRetries: 2,
      resultEffort: 'low',
      yieldShare: 25,
    } as const
    for (const named of [plain, others]) {
      assert.equal('finish_check' in Turn.body(named), false)
      assert.equal('finish_check' in JSON.parse(Turn.sent(named, input)), false)
      const withCheck = { ...named, finishCheck: true } as const
      assert.equal(Turn.body(withCheck).finish_check, true)
      assert.equal(JSON.parse(Turn.sent(withCheck, input)).finish_check, true)
      assert.deepEqual(
        Object.keys(Turn.body(withCheck))
          .filter((key) => key !== 'finish_check')
          .sort(),
        Object.keys(Turn.body(named)).sort(),
      )
      const { finish_check: _, ...rest } = JSON.parse(Turn.sent(withCheck, input))
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
    }
    assert.equal(
      JSON.stringify(Turn.body({ ...plain, finishCheck: undefined })),
      JSON.stringify(Turn.body(plain)),
    )
    assert.equal(Turn.sent({ ...plain, finishCheck: undefined }, input), Turn.sent(plain, input))
  }
})
