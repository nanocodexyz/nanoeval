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
  name: 'levers',
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
  thinking: 'high',
}

test('an agent names the ways its sessions end a turn at less cost', () => {
  const all =
    'nano-cost=claude:claude-opus-5-5:high:cell_yield_ms=120000:brief_finish=on:fold_finish=on:low_effort_rounds=on'
  assert.deepEqual(parseAgent(all), {
    briefFinish: true,
    cellYieldMs: 120000,
    foldFinish: true,
    id: 'nano-cost',
    lowEffortRounds: true,
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'high',
  })
  for (const text of [
    all,
    'a=claude:claude-opus-5-5:brief_finish=on',
    'b=claude-direct:claude-opus-5-5:high:fold_finish=on',
    'c=claude+preflight:claude-opus-5-5:low_effort_rounds=on',
    'd=claude-direct:claude-opus-5-5:high:branches=2:brief_finish=on:low_effort_rounds=on',
    'e=claude:claude-opus-5-5:refusal_fallback=session:fold_finish=on:low_effort_rounds=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.deepEqual(parseAgent('a=claude:claude-opus-5-5:brief_finish=on'), {
    briefFinish: true,
    id: 'a',
    model: 'claude-opus-5-5',
    provider: 'claude',
  })
  for (const text of [
    'x=claude:claude-opus-5-5:brief_finish=off',
    'x=claude:claude-opus-5-5:brief_finish=true',
    'x=claude:claude-opus-5-5:brief_finish=',
    'x=claude:claude-opus-5-5:brief_finish',
    'x=claude:claude-opus-5-5:fold_finish=on:brief_finish=on',
    'x=claude:claude-opus-5-5:brief_finish=on:cell_yield_ms=120000',
    'x=claude:claude-opus-5-5:low_effort_rounds=on:low_effort_rounds=on',
    'x=claude:claude-opus-5-5:low_effort=on',
  ])
    assert.throws(
      () => parseAgent(text),
      /\[:cell_yield_ms=N\]\[:brief_finish=on\]\[:fold_finish=on\]\[:low_effort_rounds=on\]\[:brief_final=on\]\[:lean_cells=on\]\[:escalate_model=MODEL\]\[:escalate_tool_errors=N\]\[:escalate_context_tokens=N\]\[:tool_result_tokens=N\]\[:persist_finish=on\]\[:skip_finish_check=on\]\[:late_finish_check_ms=N\]\[:finish_check_min_requests=N\]\[:result_effort=low\|medium\|high\|xhigh\|max\]\[:stop_at_target=on\]\[:yield_floor_ms=N\]\[:yield_share=N\], not x=/,
    )
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-opus-5-5:high'),
        parseAgent(all),
        parseAgent('nanod=claude-direct:claude-opus-5-5:fold_finish=on'),
      ],
    }).agents.map((agent) => [
      agent.id,
      agent.briefFinish,
      agent.foldFinish,
      agent.lowEffortRounds,
    ]),
    [
      ['nano', undefined, undefined, undefined],
      ['nano-cost', true, true, true],
      ['nanod', undefined, true, undefined],
    ],
  )
  for (const lever of Config.finishLevers) {
    for (const value of [false, 'on', 1, null])
      assert.throws(
        () =>
          Config.parse({
            ...config,
            agents: [{ id: 'x', [lever]: value, model: 'm', provider: 'claude' }],
          }),
        new RegExp('x has a ' + lever + ' that is not true'),
      )
    for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
      assert.throws(
        () =>
          Config.parse({
            ...config,
            agents: [{ id: 'x', [lever]: true, model: 'm', provider }],
          }),
        new RegExp('x has a ' + lever + ', which only a claude session takes'),
      )
  }
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('nanox=codex-code-mode:gpt-6-luna:high:brief_finish=on')],
      }),
    /nanox has a briefFinish, which only a claude session takes/,
  )
})

test('a turn sends each lever of its agent as true, and nothing for one the agent does not name', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  const names = ['brief_finish', 'fold_finish', 'low_effort_rounds']
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    for (const name of names) {
      assert.equal(name in Turn.body(plain), false)
      assert.equal(name in JSON.parse(Turn.sent(plain, input)), false)
    }
    const all = { ...plain, briefFinish: true, foldFinish: true, lowEffortRounds: true } as const
    assert.deepEqual(
      names.map((name) => Turn.body(all)[name]),
      [true, true, true],
    )
    assert.deepEqual(
      names.map((name) => JSON.parse(Turn.sent(all, input))[name]),
      [true, true, true],
    )
    const one = Turn.body({ ...plain, foldFinish: true })
    assert.deepEqual(
      names.map((name) => one[name]),
      [undefined, true, undefined],
    )
    assert.deepEqual(
      Object.keys(Turn.body(all)).filter((key) => !names.includes(key)),
      Object.keys(Turn.body(plain)),
    )
  }
})

test('an agent names a final message of three lines at most', () => {
  const all =
    'nano-st-bf=claude:claude-opus-5-5:high:cell_yield_ms=120000:brief_finish=on:fold_finish=on:brief_final=on'
  assert.deepEqual(parseAgent(all), {
    briefFinal: true,
    briefFinish: true,
    cellYieldMs: 120000,
    foldFinish: true,
    id: 'nano-st-bf',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'high',
  })
  for (const text of [
    all,
    'a=claude:claude-opus-5-5:brief_final=on',
    'b=claude-direct:claude-opus-5-5:high:brief_final=on',
    'c=claude+preflight:claude-opus-5-5:low_effort_rounds=on:brief_final=on',
    'd=claude:claude-opus-5-5:high:branches=2:refusal_fallback=session:cell_yield_ms=5000:brief_finish=on:fold_finish=on:low_effort_rounds=on:brief_final=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.deepEqual(parseAgent('a=claude:claude-opus-5-5:brief_final=on'), {
    briefFinal: true,
    id: 'a',
    model: 'claude-opus-5-5',
    provider: 'claude',
  })
  for (const text of [
    'x=claude:claude-opus-5-5:brief_final=off',
    'x=claude:claude-opus-5-5:brief_final=true',
    'x=claude:claude-opus-5-5:brief_final=',
    'x=claude:claude-opus-5-5:brief_final',
    'x=claude:claude-opus-5-5:brief_final=on:brief_finish=on',
    'x=claude:claude-opus-5-5:brief_final=on:low_effort_rounds=on',
    'x=claude:claude-opus-5-5:brief_final=on:cell_yield_ms=120000',
    'x=claude:claude-opus-5-5:brief_final=on:brief_final=on',
  ])
    assert.throws(
      () => parseAgent(text),
      /\[:low_effort_rounds=on\]\[:brief_final=on\]\[:lean_cells=on\]\[:escalate_model=MODEL\]\[:escalate_tool_errors=N\]\[:escalate_context_tokens=N\]\[:tool_result_tokens=N\]\[:persist_finish=on\]\[:skip_finish_check=on\]\[:late_finish_check_ms=N\]\[:finish_check_min_requests=N\]\[:result_effort=low\|medium\|high\|xhigh\|max\]\[:stop_at_target=on\]\[:yield_floor_ms=N\]\[:yield_share=N\], not x=/,
    )
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-opus-5-5:high'),
        parseAgent(all),
        parseAgent('nanod=claude-direct:claude-opus-5-5:brief_final=on'),
      ],
    }).agents.map((agent) => [
      agent.id,
      agent.briefFinal,
      agent.briefFinish,
      agent.foldFinish,
      agent.lowEffortRounds,
    ]),
    [
      ['nano', undefined, undefined, undefined, undefined],
      ['nano-st-bf', true, true, true, undefined],
      ['nanod', true, undefined, undefined, undefined],
    ],
  )
  assert.equal(Config.finishLevers.includes('briefFinal'), true)
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('nanox=codex:gpt-6-luna:high:brief_final=on')],
      }),
    /nanox has a briefFinal, which only a claude session takes/,
  )
})

test('a turn sends brief_final as true for an agent that names it, and nothing for one that does not', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    assert.equal('brief_final' in Turn.body(plain), false)
    assert.equal('brief_final' in JSON.parse(Turn.sent(plain, input)), false)
    const others = { ...plain, briefFinish: true, foldFinish: true, lowEffortRounds: true } as const
    assert.equal('brief_final' in Turn.body(others), false)
    assert.equal('brief_final' in JSON.parse(Turn.sent(others, input)), false)
    const named = { ...plain, briefFinal: true } as const
    assert.equal(Turn.body(named).brief_final, true)
    assert.equal(JSON.parse(Turn.sent(named, input)).brief_final, true)
    assert.deepEqual(
      Object.keys(Turn.body(named)).filter((key) => key !== 'brief_final'),
      Object.keys(Turn.body(plain)),
    )
    const all = { ...others, briefFinal: true } as const
    assert.deepEqual(
      ['brief_final', 'brief_finish', 'fold_finish', 'low_effort_rounds'].map(
        (name) => Turn.body(all)[name],
      ),
      [true, true, true, true],
    )
  }
})

test('an agent names lean code cells', () => {
  const all =
    'nano-st-lean=claude:claude-opus-5-5:medium:cell_yield_ms=120000:brief_finish=on:fold_finish=on:brief_final=on:lean_cells=on'
  assert.deepEqual(parseAgent(all), {
    briefFinal: true,
    briefFinish: true,
    cellYieldMs: 120000,
    foldFinish: true,
    id: 'nano-st-lean',
    leanCells: true,
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
  })
  for (const text of [
    all,
    'a=claude:claude-opus-5-5:lean_cells=on',
    'b=claude-direct:claude-opus-5-5:high:lean_cells=on',
    'c=claude+preflight:claude-opus-5-5:low_effort_rounds=on:lean_cells=on',
    'd=claude:claude-opus-5-5:high:branches=2:refusal_fallback=session:cell_yield_ms=5000:brief_finish=on:fold_finish=on:low_effort_rounds=on:brief_final=on:lean_cells=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.deepEqual(parseAgent('a=claude:claude-opus-5-5:lean_cells=on'), {
    id: 'a',
    leanCells: true,
    model: 'claude-opus-5-5',
    provider: 'claude',
  })
  for (const text of [
    'x=claude:claude-opus-5-5:lean_cells=off',
    'x=claude:claude-opus-5-5:lean_cells=true',
    'x=claude:claude-opus-5-5:lean_cells=',
    'x=claude:claude-opus-5-5:lean_cells',
    'x=claude:claude-opus-5-5:lean_cells=on:brief_final=on',
    'x=claude:claude-opus-5-5:lean_cells=on:brief_finish=on',
    'x=claude:claude-opus-5-5:lean_cells=on:cell_yield_ms=120000',
    'x=claude:claude-opus-5-5:lean_cells=on:lean_cells=on',
  ])
    assert.throws(
      () => parseAgent(text),
      /\[:brief_final=on\]\[:lean_cells=on\]\[:escalate_model=MODEL\]\[:escalate_tool_errors=N\]\[:escalate_context_tokens=N\]\[:tool_result_tokens=N\]\[:persist_finish=on\]\[:skip_finish_check=on\]\[:late_finish_check_ms=N\]\[:finish_check_min_requests=N\]\[:result_effort=low\|medium\|high\|xhigh\|max\]\[:stop_at_target=on\]\[:yield_floor_ms=N\]\[:yield_share=N\], not x=/,
    )
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-opus-5-5:medium'),
        parseAgent(all),
        parseAgent('nanod=claude-direct:claude-opus-5-5:lean_cells=on'),
      ],
    }).agents.map((agent) => [
      agent.id,
      agent.briefFinal,
      agent.briefFinish,
      agent.foldFinish,
      agent.leanCells,
      agent.lowEffortRounds,
    ]),
    [
      ['nano', undefined, undefined, undefined, undefined, undefined],
      ['nano-st-lean', true, true, true, true, undefined],
      ['nanod', undefined, undefined, undefined, true, undefined],
    ],
  )
  assert.equal(Config.finishLevers.includes('leanCells'), true)
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('nanox=codex:gpt-6-luna:high:lean_cells=on')],
      }),
    /nanox has a leanCells, which only a claude session takes/,
  )
})

test('a turn sends lean_cells as true for an agent that names it, and nothing for one that does not', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    assert.equal('lean_cells' in Turn.body(plain), false)
    assert.equal('lean_cells' in JSON.parse(Turn.sent(plain, input)), false)
    const others = {
      ...plain,
      briefFinal: true,
      briefFinish: true,
      foldFinish: true,
      lowEffortRounds: true,
    } as const
    assert.equal('lean_cells' in Turn.body(others), false)
    assert.equal('lean_cells' in JSON.parse(Turn.sent(others, input)), false)
    const named = { ...plain, leanCells: true } as const
    assert.equal(Turn.body(named).lean_cells, true)
    assert.equal(JSON.parse(Turn.sent(named, input)).lean_cells, true)
    assert.deepEqual(
      Object.keys(Turn.body(named)).filter((key) => key !== 'lean_cells'),
      Object.keys(Turn.body(plain)),
    )
    const all = { ...others, leanCells: true } as const
    assert.deepEqual(
      ['brief_final', 'brief_finish', 'fold_finish', 'lean_cells', 'low_effort_rounds'].map(
        (name) => Turn.body(all)[name],
      ),
      [true, true, true, true, true],
    )
  }
})
