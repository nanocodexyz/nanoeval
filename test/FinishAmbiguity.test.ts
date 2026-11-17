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
  name: 'finish-ambiguity',
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
  /\[:finish_check=on\]\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:hedge_cap_percent=0\.\.100\], not x=/

const ambiguity = 'nano-med-amb=claude:claude-opus-5-5:medium:finish_ambiguity=on'

const direct =
  'nano-da=claude-direct:claude-opus-5-5:high:brief_finish=on:result_effort=low:yield_share=25:finish_retries=2:finish_check=on:finish_ambiguity=on'

test('an agent names finish_ambiguity after yield_share and finish_check in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(ambiguity), {
    finishAmbiguity: true,
    id: 'nano-med-amb',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent(direct), {
    briefFinish: true,
    finishAmbiguity: true,
    finishCheck: true,
    finishRetries: 2,
    id: 'nano-da',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    resultEffort: 'low',
    thinking: 'high',
    yieldShare: 25,
  })
  for (const text of [
    ambiguity,
    direct,
    'a=claude:claude-opus-5-5:finish_ambiguity=on',
    'b=claude+preflight:claude-sonnet-5-5:low:yield_share=50:finish_ambiguity=on',
    'c=claude:claude-opus-5-5:medium:finish_ambiguity=on:tool_result_clearing=2/10000',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:finish_ambiguity=',
    'x=claude:claude-opus-5-5:finish_ambiguity=1',
    'x=claude:claude-opus-5-5:finish_ambiguity=true',
    'x=claude:claude-opus-5-5:finish_ambiguity=off',
    'x=claude:claude-opus-5-5:finish_ambiguity',
    'x=claude:claude-opus-5-5:finish_ambiguity=on:yield_share=25',
    'x=claude:claude-opus-5-5:finish_ambiguity=on:finish_check=on',
    'x=claude:claude-opus-5-5:finish_ambiguity=on:finish_ambiguity=on',
    'x=claude:claude-opus-5-5:finish_ambiguities=on',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes finishAmbiguity for a claude agent and refuses bad values, other providers and skip_finish_check', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
        parseAgent(ambiguity),
        parseAgent(direct),
      ],
    }).agents.map((agent) => [agent.id, agent.finishAmbiguity, agent.finishCheck]),
    [
      ['nano-med-plain', undefined, undefined],
      ['nano-med-amb', true, undefined],
      ['nano-da', true, true],
    ],
  )
  assert.equal(Config.finishLevers.includes('finishAmbiguity'), true)
  assert.equal(Config.agentKeys.includes('finishAmbiguity'), true)
  for (const finishAmbiguity of [false, 'on', 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ finishAmbiguity, id: 'x', model: 'm', provider: 'claude' }],
        }),
      /x has a finishAmbiguity that is not true/,
    )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ finishAmbiguity: true, id: 'x', model: 'm', provider }],
        }),
      /x has a finishAmbiguity, which only a claude session takes/,
    )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:finish_ambiguity=on',
    'nanox=codex-code-mode:gpt-6-luna:high:finish_ambiguity=on',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a finishAmbiguity, which only a claude session takes/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:skip_finish_check=on:finish_ambiguity=on',
    'x=claude-direct:claude-opus-5-5:skip_finish_check=on:finish_ambiguity=on',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x has a skipFinishCheck and a finishAmbiguity, which never go in one arm/,
    )
})

test('a turn sends finish_ambiguity only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      briefFinish: true,
      finishCheck: true,
      finishRetries: 2,
      resultEffort: 'low',
      yieldShare: 25,
    } as const
    for (const named of [plain, others]) {
      assert.equal('finish_ambiguity' in Turn.body(named), false)
      assert.equal('finish_ambiguity' in JSON.parse(Turn.sent(named, input)), false)
      const withAmbiguity = { ...named, finishAmbiguity: true } as const
      assert.equal(Turn.body(withAmbiguity).finish_ambiguity, true)
      assert.equal(JSON.parse(Turn.sent(withAmbiguity, input)).finish_ambiguity, true)
      const { finish_ambiguity: sent, ...body } = Turn.body(withAmbiguity)
      assert.equal(sent, true)
      assert.deepEqual(body, Turn.body(named))
      const { finish_ambiguity: _, ...rest } = JSON.parse(Turn.sent(withAmbiguity, input))
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
    }
    assert.equal(
      JSON.stringify(Turn.body({ ...plain, finishAmbiguity: undefined })),
      JSON.stringify(Turn.body(plain)),
    )
    assert.equal(
      Turn.sent({ ...plain, finishAmbiguity: undefined }, input),
      Turn.sent(plain, input),
    )
  }
})
