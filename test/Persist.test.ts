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
  name: 'persistence',
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
  /\[:tool_result_tokens=N\]\[:persist_finish=on\]\[:skip_finish_check=on\]\[:late_finish_check_ms=N\]\[:result_effort=low\|medium\|high\|xhigh\|max\]\[:stop_at_target=on\]\[:yield_floor_ms=N\]\[:yield_share=N\]\[:finish_retries=N\]\[:finish_check=on\]\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\|on\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:single_verification=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\]\[:stall_nudge_ms=N\]\[:hedge_cap_percent=0\.\.100\], not x=/

test('an agent names a finish that goes on with an unmet requirement', () => {
  const plain = 'nano-plain-persist=claude:claude-opus-5-5:medium:persist_finish=on'
  assert.deepEqual(parseAgent(plain), {
    id: 'nano-plain-persist',
    model: 'claude-opus-5-5',
    persistFinish: true,
    provider: 'claude',
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent('nanox-persist=codex:gpt-6-luna:high:persist_finish=on'), {
    id: 'nanox-persist',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    persistFinish: true,
    provider: 'codex',
    thinking: 'high',
  })
  for (const text of [
    plain,
    'a=claude:claude-opus-5-5:persist_finish=on',
    'b=claude-direct:claude-opus-5-5:high:persist_finish=on',
    'c=codex-code-mode:gpt-6-luna:high:persist_finish=on',
    'd=codex+preflight:gpt-6-luna:cell_yield_ms=120000:persist_finish=on',
    'e=claude:claude-haiku-5-5:high:branches=lazy2:refusal_fallback=session:cell_yield_ms=5000:brief_finish=on:fold_finish=on:low_effort_rounds=on:brief_final=on:lean_cells=on:escalate_model=claude-opus-5-5:escalate_tool_errors=3:escalate_context_tokens=150000:tool_result_tokens=2000:persist_finish=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:persist_finish=off',
    'x=claude:claude-opus-5-5:persist_finish=true',
    'x=claude:claude-opus-5-5:persist_finish=',
    'x=claude:claude-opus-5-5:persist_finish',
    'x=claude:claude-opus-5-5:persist_finish=on:brief_finish=on',
    'x=claude:claude-opus-5-5:persist_finish=on:tool_result_tokens=2000',
    'x=claude:claude-opus-5-5:persist_finish=on:persist_finish=on',
  ])
    assert.throws(() => parseAgent(text), usage)
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-opus-5-5:medium'),
        parseAgent(plain),
        parseAgent('nanox-persist=codex:gpt-6-luna:high:persist_finish=on'),
        parseAgent('nanoj=codex-jobs:gpt-6-luna:persist_finish=on'),
      ],
    }).agents.map((agent) => [agent.id, agent.persistFinish, agent.briefFinish]),
    [
      ['nano', undefined, undefined],
      ['nano-plain-persist', true, undefined],
      ['nanox-persist', true, undefined],
      ['nanoj', true, undefined],
    ],
  )
  for (const value of [false, 'on', 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [
            { id: 'nano', model: 'claude-opus-5-5', persistFinish: value, provider: 'claude' },
          ],
        }),
      /nano has a persistFinish that is not true/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'oracle', model: 'solution', persistFinish: true, provider: 'oracle' }],
      }),
    /oracle has a persistFinish, which only a claude or codex session takes/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ ...parseAgent('cc=claude-code:claude-opus-5-5'), persistFinish: true }],
      }),
    /cc has a persistFinish, which only a claude or codex session takes/,
  )
})

test('a turn sends persist_finish as true for an agent that names it, and nothing for one that does not', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const provider of ['claude', 'codex'] as const)
    for (const orchestration of [undefined, 'direct'] as const) {
      const plain = { ...turn, provider, ...(orchestration ? { orchestration } : {}) }
      assert.equal('persist_finish' in Turn.body(plain), false)
      assert.equal('persist_finish' in JSON.parse(Turn.sent(plain, input)), false)
      const others = { ...plain, briefFinish: true, foldFinish: true, leanCells: true } as const
      assert.equal('persist_finish' in Turn.body(others), false)
      assert.equal('persist_finish' in JSON.parse(Turn.sent(others, input)), false)
      const named = { ...plain, persistFinish: true } as const
      assert.equal(Turn.body(named).persist_finish, true)
      assert.equal(JSON.parse(Turn.sent(named, input)).persist_finish, true)
      assert.deepEqual(
        Object.keys(Turn.body(named)).filter((key) => key !== 'persist_finish'),
        Object.keys(Turn.body(plain)),
      )
      const all = { ...others, persistFinish: true } as const
      assert.deepEqual(
        ['brief_finish', 'fold_finish', 'lean_cells', 'persist_finish'].map(
          (name) => Turn.body(all)[name],
        ),
        [true, true, true, true],
      )
    }
})
