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
  name: 'escalations',
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
  model: 'claude-haiku-5-5',
  prompt: 'Write the greeting.',
  provider: 'claude',
  requestId: 'turn-1',
  thinking: 'high',
}

const usage =
  /\[:lean_cells=on\]\[:escalate_model=MODEL\]\[:escalate_tool_errors=N\]\[:escalate_context_tokens=N\]\[:tool_result_tokens=N\]\[:persist_finish=on\]\[:skip_finish_check=on\]\[:late_finish_check_ms=N\]\[:result_effort=low\|medium\|high\|xhigh\|max\]\[:stop_at_target=on\]\[:yield_floor_ms=N\]\[:yield_share=N\]\[:finish_retries=N\]\[:finish_check=on\]\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\]\[:clearing_cache_floors=on\]\[:verification_requested=on\], not x=/

const both =
  'nano-esc=claude:claude-haiku-5-5:medium:cell_yield_ms=120000:escalate_model=claude-opus-5-5:escalate_tool_errors=3:escalate_context_tokens=150000'

const bounded =
  'nano-st-trunc=claude:claude-opus-5-5:medium:cell_yield_ms=120000:brief_finish=on:fold_finish=on:tool_result_tokens=2000'

test('an agent names the model its sessions go on with and what moves them to it', () => {
  assert.deepEqual(parseAgent(both), {
    cellYieldMs: 120000,
    escalateContextTokens: 150000,
    escalateModel: 'claude-opus-5-5',
    escalateToolErrors: 3,
    id: 'nano-esc',
    model: 'claude-haiku-5-5',
    provider: 'claude',
    thinking: 'medium',
  })
  for (const text of [
    both,
    'a=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_tool_errors=3',
    'b=claude-direct:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_context_tokens=150000',
    'c=claude+preflight:claude-haiku-5-5:lean_cells=on:escalate_model=claude-opus-5-5:escalate_tool_errors=1:tool_result_tokens=2000',
    'd=claude:claude-haiku-5-5:high:branches=2:refusal_fallback=session:cell_yield_ms=5000:brief_finish=on:fold_finish=on:low_effort_rounds=on:brief_final=on:lean_cells=on:escalate_model=claude-opus-5-5:escalate_tool_errors=2:escalate_context_tokens=100000:tool_result_tokens=4000',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.deepEqual(
    parseAgent('a=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_tool_errors=3'),
    {
      escalateModel: 'claude-opus-5-5',
      escalateToolErrors: 3,
      id: 'a',
      model: 'claude-haiku-5-5',
      provider: 'claude',
    },
  )
  assert.deepEqual(
    parseAgent(
      'b=claude-direct:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_context_tokens=150000',
    ),
    {
      escalateContextTokens: 150000,
      escalateModel: 'claude-opus-5-5',
      id: 'b',
      model: 'claude-haiku-5-5',
      orchestration: 'direct',
      provider: 'claude',
      thinking: 'high',
    },
  )
  for (const text of [
    'x=claude:claude-haiku-5-5:high:escalate_model=',
    'x=claude:claude-haiku-5-5:high:escalate_model',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_model=claude-opus-5-5',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:lean_cells=on',
    'x=claude:claude-haiku-5-5:high:escalate_tool_errors=3:escalate_model=claude-opus-5-5',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_tool_errors=',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_tool_errors=-1',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_tool_errors=1.5',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_tool_errors=three',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_context_tokens=150k',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_context_tokens=1:escalate_tool_errors=1',
    'x=claude:claude-haiku-5-5:high:escalate_model=claude-opus-5-5:escalate_errors=1',
  ])
    assert.throws(() => parseAgent(text), usage)
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-haiku-5-5:medium'),
        parseAgent(both),
        parseAgent(
          'nanod=claude-direct:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_tool_errors=2',
        ),
      ],
    }).agents.map((agent) => [
      agent.id,
      agent.escalateModel,
      agent.escalateToolErrors,
      agent.escalateContextTokens,
    ]),
    [
      ['nano', undefined, undefined, undefined],
      ['nano-esc', 'claude-opus-5-5', 3, 150000],
      ['nanod', 'claude-opus-5-5', 2, undefined],
    ],
  )
  for (const text of [
    'x=claude:claude-haiku-5-5:escalate_tool_errors=3',
    'x=claude:claude-haiku-5-5:escalate_context_tokens=150000',
    'x=claude:claude-haiku-5-5:escalate_tool_errors=3:escalate_context_tokens=150000',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x escalates and names no escalateModel/,
    )
  for (const escalateModel of ['', 3, true, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [
            { escalateModel, escalateToolErrors: 3, id: 'x', model: 'm', provider: 'claude' },
          ],
        }),
      /x escalates and names no escalateModel/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('x=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5')],
      }),
    /x has an escalateModel and neither an escalateToolErrors nor an escalateContextTokens/,
  )
  for (const name of ['escalateContextTokens', 'escalateToolErrors']) {
    for (const value of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, null])
      assert.throws(
        () =>
          Config.parse({
            ...config,
            agents: [
              {
                escalateModel: 'claude-opus-5-5',
                id: 'x',
                model: 'm',
                [name]: value,
                provider: 'claude',
              },
            ],
          }),
        new RegExp('x: ' + name + ' must be an integer of at least 1'),
      )
    for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
      assert.throws(
        () =>
          Config.parse({
            ...config,
            agents: [
              { escalateModel: 'claude-opus-5-5', id: 'x', model: 'm', [name]: 3, provider },
            ],
          }),
        /x has an escalateModel, which only a claude session takes/,
      )
  }
  for (const text of [
    'x=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_tool_errors=0',
    'x=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_tool_errors=99999999999999999999',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x: escalateToolErrors must be an integer of at least 1/,
    )
  for (const text of [
    'x=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_context_tokens=0',
    'x=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_context_tokens=99999999999999999999',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x: escalateContextTokens must be an integer of at least 1/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [
          parseAgent('nanox=codex:gpt-6-luna:high:escalate_model=gpt-6-sol:escalate_tool_errors=3'),
        ],
      }),
    /nanox has an escalateModel, which only a claude session takes/,
  )
})

test('an agent names the bound of the result of a code cell in tokens', () => {
  assert.deepEqual(parseAgent(bounded), {
    briefFinish: true,
    cellYieldMs: 120000,
    foldFinish: true,
    id: 'nano-st-trunc',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
    toolResultTokens: 2000,
  })
  for (const text of [
    bounded,
    'a=claude:claude-opus-5-5:tool_result_tokens=1',
    'b=claude-direct:claude-opus-5-5:high:lean_cells=on:tool_result_tokens=2000',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:high:tool_result_tokens=',
    'x=claude:claude-opus-5-5:high:tool_result_tokens',
    'x=claude:claude-opus-5-5:high:tool_result_tokens=-1',
    'x=claude:claude-opus-5-5:high:tool_result_tokens=1.5',
    'x=claude:claude-opus-5-5:high:tool_result_tokens=2k',
    'x=claude:claude-opus-5-5:high:tool_result_tokens=1:tool_result_tokens=2',
    'x=claude:claude-opus-5-5:high:tool_result_tokens=1:lean_cells=on',
    'x=claude:claude-opus-5-5:high:tool_result_tokens=1:escalate_model=claude-opus-5-5',
    'x=claude:claude-opus-5-5:high:tool_result=1',
  ])
    assert.throws(() => parseAgent(text), usage)
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-opus-5-5:medium'),
        parseAgent(bounded),
        parseAgent(
          'nano-all=claude:claude-haiku-5-5:escalate_model=claude-opus-5-5:escalate_tool_errors=3:tool_result_tokens=4000',
        ),
      ],
    }).agents.map((agent) => [agent.id, agent.escalateModel, agent.toolResultTokens]),
    [
      ['nano', undefined, undefined],
      ['nano-st-trunc', undefined, 2000],
      ['nano-all', 'claude-opus-5-5', 4000],
    ],
  )
  for (const toolResultTokens of [0, -1, 1.5, '2000', Number.MAX_SAFE_INTEGER + 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider: 'claude', toolResultTokens }],
        }),
      /x: toolResultTokens must be an integer of at least 1/,
    )
  for (const text of [
    'x=claude:claude-opus-5-5:tool_result_tokens=0',
    'x=claude:claude-opus-5-5:tool_result_tokens=99999999999999999999',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x: toolResultTokens must be an integer of at least 1/,
    )
  for (const provider of ['codex', 'codex-cli', 'claude-code', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider, toolResultTokens: 2000 }],
        }),
      /x has a toolResultTokens, which only a claude session takes/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('nanox=codex-code-mode:gpt-6-luna:high:tool_result_tokens=2000')],
      }),
    /nanox has a toolResultTokens, which only a claude session takes/,
  )
})

test('a turn sends escalate with the fields its agent names, tool_result_tokens for an agent that names it, and nothing for one that does not', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    for (const name of ['escalate', 'tool_result_tokens']) {
      assert.equal(name in Turn.body(plain), false)
      assert.equal(name in JSON.parse(Turn.sent(plain, input)), false)
    }
    const others = {
      ...plain,
      briefFinal: true,
      briefFinish: true,
      cellYieldMs: 120000,
      foldFinish: true,
      leanCells: true,
      lowEffortRounds: true,
    } as const
    for (const name of ['escalate', 'tool_result_tokens']) {
      assert.equal(name in Turn.body(others), false)
      assert.equal(name in JSON.parse(Turn.sent(others, input)), false)
    }
    const cases = [
      [
        { escalateContextTokens: 150000, escalateModel: 'claude-opus-5-5', escalateToolErrors: 3 },
        { context_tokens: 150000, model: 'claude-opus-5-5', tool_errors: 3 },
      ],
      [
        { escalateModel: 'claude-opus-5-5', escalateToolErrors: 3 },
        { model: 'claude-opus-5-5', tool_errors: 3 },
      ],
      [
        { escalateContextTokens: 150000, escalateModel: 'claude-opus-5-5' },
        { context_tokens: 150000, model: 'claude-opus-5-5' },
      ],
    ] as const
    for (const [fields, escalate] of cases) {
      const named = { ...plain, ...fields }
      assert.deepEqual(Turn.body(named).escalate, escalate)
      assert.deepEqual(JSON.parse(Turn.sent(named, input)).escalate, escalate)
      assert.equal('tool_result_tokens' in Turn.body(named), false)
      assert.deepEqual(
        Object.keys(Turn.body(named)).filter((key) => key !== 'escalate'),
        Object.keys(Turn.body(plain)),
      )
    }
    const limited = { ...plain, toolResultTokens: 2000 }
    assert.equal(Turn.body(limited).tool_result_tokens, 2000)
    assert.equal(JSON.parse(Turn.sent(limited, input)).tool_result_tokens, 2000)
    assert.equal('escalate' in Turn.body(limited), false)
    assert.deepEqual(
      Object.keys(Turn.body(limited)).filter((key) => key !== 'tool_result_tokens'),
      Object.keys(Turn.body(plain)),
    )
    const all = { ...others, ...cases[0][0], toolResultTokens: 2000 }
    assert.deepEqual(Turn.body(all).escalate, cases[0][1])
    assert.equal(Turn.body(all).tool_result_tokens, 2000)
    assert.equal(Turn.body(all).lean_cells, true)
  }
})
