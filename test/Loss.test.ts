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
  name: 'losses',
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
  /\[:tool_result_tokens=N\]\[:persist_finish=on\]\[:skip_finish_check=on\]\[:late_finish_check_ms=N\]\[:result_effort=low\|medium\|high\|xhigh\|max\]\[:stop_at_target=on\]\[:yield_floor_ms=N\]\[:yield_share=N\]\[:finish_retries=N\]\[:finish_check=on\]\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\|on\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\]\[:stall_nudge_ms=N\], not x=/

const skipping =
  'nano-skip=claude:claude-opus-5-5:medium:cell_yield_ms=120000:skip_finish_check=on:result_effort=low:stop_at_target=on:yield_floor_ms=30000:yield_share=25'

const late =
  'nano-late=claude-direct:claude-opus-5-5:high:brief_finish=on:late_finish_check_ms=120000:result_effort=xhigh:yield_share=100'

const fields = {
  lateFinishCheckMs: 'late_finish_check_ms',
  resultEffort: 'result_effort',
  skipFinishCheck: 'skip_finish_check',
  stopAtTarget: 'stop_at_target',
  yieldFloorMs: 'yield_floor_ms',
  yieldShare: 'yield_share',
} as const

test('an agent names the six loss levers in their place in the order of the options', () => {
  assert.deepEqual(parseAgent(skipping), {
    cellYieldMs: 120000,
    id: 'nano-skip',
    model: 'claude-opus-5-5',
    provider: 'claude',
    resultEffort: 'low',
    skipFinishCheck: true,
    stopAtTarget: true,
    thinking: 'medium',
    yieldFloorMs: 30000,
    yieldShare: 25,
  })
  assert.deepEqual(parseAgent(late), {
    briefFinish: true,
    id: 'nano-late',
    lateFinishCheckMs: 120000,
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    resultEffort: 'xhigh',
    thinking: 'high',
    yieldShare: 100,
  })
  for (const text of [
    skipping,
    late,
    'a=claude:claude-opus-5-5:skip_finish_check=on',
    'b=claude:claude-opus-5-5:late_finish_check_ms=1',
    'c=claude:claude-opus-5-5:high:result_effort=max',
    'd=claude+preflight:claude-opus-5-5:stop_at_target=on',
    'e=claude:claude-opus-5-5:yield_floor_ms=5000',
    'f=claude:claude-opus-5-5:yield_share=1',
    'g=claude:claude-haiku-5-5:high:lean_cells=on:escalate_model=claude-opus-5-5:escalate_tool_errors=2:tool_result_tokens=4000:skip_finish_check=on:result_effort=medium:stop_at_target=on:yield_floor_ms=10000:yield_share=50',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const effort of Config.efforts)
    assert.equal(
      parseAgent('a=claude:claude-opus-5-5:result_effort=' + effort).resultEffort,
      effort,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:skip_finish_check=off',
    'x=claude:claude-opus-5-5:skip_finish_check',
    'x=claude:claude-opus-5-5:stop_at_target=true',
    'x=claude:claude-opus-5-5:result_effort=none',
    'x=claude:claude-opus-5-5:result_effort=LOW',
    'x=claude:claude-opus-5-5:result_effort=',
    'x=claude:claude-opus-5-5:late_finish_check_ms=-1',
    'x=claude:claude-opus-5-5:late_finish_check_ms=2m',
    'x=claude:claude-opus-5-5:yield_floor_ms=1.5',
    'x=claude:claude-opus-5-5:yield_floor_ms=',
    'x=claude:claude-opus-5-5:yield_share=25%',
    'x=claude:claude-opus-5-5:yield_share=0.5',
    'x=claude:claude-opus-5-5:result_effort=low:skip_finish_check=on',
    'x=claude:claude-opus-5-5:yield_share=25:yield_floor_ms=1000',
    'x=claude:claude-opus-5-5:skip_finish_check=on:tool_result_tokens=2000',
    'x=claude:claude-opus-5-5:yield_floor_ms=1000:yield_floor_ms=2000',
    'x=claude:claude-opus-5-5:yield_floor=1000',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes the six loss levers for a claude agent and refuses bad values, other providers and two finish checks in one arm', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-opus-5-5:medium'),
        parseAgent(skipping),
        parseAgent(late),
      ],
    }).agents.map((agent) => [
      agent.id,
      agent.skipFinishCheck,
      agent.lateFinishCheckMs,
      agent.resultEffort,
      agent.stopAtTarget,
      agent.yieldFloorMs,
      agent.yieldShare,
    ]),
    [
      ['nano', undefined, undefined, undefined, undefined, undefined, undefined],
      ['nano-skip', true, undefined, 'low', true, 30000, 25],
      ['nano-late', undefined, 120000, 'xhigh', undefined, undefined, 100],
    ],
  )
  const agent = { id: 'x', model: 'm', provider: 'claude' }
  for (const name of ['skipFinishCheck', 'stopAtTarget'])
    for (const value of [false, 'on', 1, null])
      assert.throws(
        () => Config.parse({ ...config, agents: [{ ...agent, [name]: value }] }),
        new RegExp('x has a ' + name + ' that is not true'),
      )
  for (const resultEffort of ['none', 'LOW', '', 3, null])
    assert.throws(
      () => Config.parse({ ...config, agents: [{ ...agent, resultEffort }] }),
      /x: resultEffort must be one of low, medium, high, xhigh, max/,
    )
  for (const name of ['lateFinishCheckMs', 'yieldFloorMs'])
    for (const value of [0, -1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1, null])
      assert.throws(
        () => Config.parse({ ...config, agents: [{ ...agent, [name]: value }] }),
        new RegExp('x: ' + name + ' must be an integer of at least 1'),
      )
  for (const yieldShare of [0, -1, 101, 1.5, '25', null])
    assert.throws(
      () => Config.parse({ ...config, agents: [{ ...agent, yieldShare }] }),
      /x: yieldShare must be a whole percent from 1 to 100/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:late_finish_check_ms=0',
    'x=claude:claude-opus-5-5:yield_floor_ms=0',
    'x=claude:claude-opus-5-5:yield_floor_ms=99999999999999999999',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x: (lateFinishCheckMs|yieldFloorMs) must be an integer of at least 1/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:yield_share=0',
    'x=claude:claude-opus-5-5:yield_share=101',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x: yieldShare must be a whole percent from 1 to 100/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [
          parseAgent('x=claude:claude-opus-5-5:skip_finish_check=on:late_finish_check_ms=120000'),
        ],
      }),
    /x has a skipFinishCheck and a lateFinishCheckMs, which never go in one arm/,
  )
  const values = {
    lateFinishCheckMs: 120000,
    resultEffort: 'low',
    skipFinishCheck: true,
    stopAtTarget: true,
    yieldFloorMs: 30000,
    yieldShare: 25,
  }
  for (const [name, value] of Object.entries(values))
    for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
      assert.throws(
        () =>
          Config.parse({ ...config, agents: [{ id: 'x', model: 'm', provider, [name]: value }] }),
        new RegExp('x has a ' + name + ', which only a claude session takes'),
      )
  for (const text of [
    'nanox=codex:gpt-6-luna:high:skip_finish_check=on',
    'nanox=codex-code-mode:gpt-6-luna:high:result_effort=low',
    'nanox=codex:gpt-6-luna:high:yield_share=25',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a (skipFinishCheck|resultEffort|yieldShare), which only a claude session takes/,
    )
})

test('a turn sends each loss lever its agent names and nothing new for an agent that names none', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  const values = {
    lateFinishCheckMs: 120000,
    resultEffort: 'low',
    skipFinishCheck: true,
    stopAtTarget: true,
    yieldFloorMs: 30000,
    yieldShare: 25,
  } as const
  const sent = {
    late_finish_check_ms: 120000,
    result_effort: 'low',
    skip_finish_check: true,
    stop_at_target: true,
    yield_floor_ms: 30000,
    yield_share: 25,
  }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const others = {
      ...plain,
      briefFinish: true,
      cellYieldMs: 120000,
      escalateModel: 'claude-haiku-5-5',
      escalateToolErrors: 3,
      leanCells: true,
      toolResultTokens: 2000,
    } as const
    for (const wire of Object.values(fields))
      for (const named of [plain, others]) {
        assert.equal(wire in Turn.body(named), false)
        assert.equal(wire in JSON.parse(Turn.sent(named, input)), false)
      }
    for (const [name, wire] of Object.entries(fields) as [keyof typeof fields, string][]) {
      const one = { ...plain, [name]: values[name] }
      assert.equal(Turn.body(one)[wire], sent[wire as keyof typeof sent])
      assert.equal(JSON.parse(Turn.sent(one, input))[wire], sent[wire as keyof typeof sent])
      assert.deepEqual(
        Object.keys(Turn.body(one))
          .filter((key) => key !== wire)
          .sort(),
        Object.keys(Turn.body(plain)).sort(),
      )
    }
    const all = { ...others, ...values }
    for (const [wire, value] of Object.entries(sent)) {
      assert.equal(Turn.body(all)[wire], value)
      assert.equal(JSON.parse(Turn.sent(all, input))[wire], value)
    }
    assert.equal(Turn.body(all).tool_result_tokens, 2000)
    assert.equal(Turn.body(all).lean_cells, true)
  }
})
