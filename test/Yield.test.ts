import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'yields',
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

test('an agent names the yield time of the cells of its sessions', () => {
  const yielding = parseAgent('nano-y120=claude:claude-opus-5-5:high:cell_yield_ms=120000')
  assert.deepEqual(yielding, {
    cellYieldMs: 120000,
    id: 'nano-y120',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'high',
  })
  assert.equal(agentText(yielding), 'nano-y120=claude:claude-opus-5-5:high:cell_yield_ms=120000')
  for (const text of [
    'b=claude-direct:claude-opus-5-5:branches=2:refusal_fallback=return_once:cell_yield_ms=45000',
    'nanoxc=codex-code-mode:gpt-6-luna:cell_yield_ms=30000',
    'nanoxp=codex+preflight:gpt-6-luna:high:branches=3:cell_yield_ms=1',
    'nano-s=claude:claude-opus-5-5:refusal_fallback=session:cell_yield_ms=600000',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.deepEqual(
    parseAgent(
      'b=claude-direct:claude-opus-5-5:branches=2:refusal_fallback=return_once:cell_yield_ms=45000',
    ),
    {
      branches: 2,
      cellYieldMs: 45000,
      id: 'b',
      model: 'claude-opus-5-5',
      orchestration: 'direct',
      provider: 'claude',
      refusalFallback: 'return_once',
    },
  )
  for (const text of [
    'x=claude:claude-opus-5-5:high:cell_yield_ms=',
    'x=claude:claude-opus-5-5:high:cell_yield_ms=-1',
    'x=claude:claude-opus-5-5:high:cell_yield_ms=1.5',
    'x=claude:claude-opus-5-5:high:cell_yield_ms=2m',
    'x=claude:claude-opus-5-5:high:cell_yield_ms=1:cell_yield_ms=2',
    'x=claude:claude-opus-5-5:high:cell_yield_ms=1:branches=2',
    'x=claude:claude-opus-5-5:high:cell_yield=1',
  ])
    assert.throws(
      () => parseAgent(text),
      /an agent is ID=HARNESS:MODEL\[:THINKING\]\[:branches=\[lazy\]N\]\[:picker=verify\|verify_lazy\]\[:verifier_model=MODEL\]\[:refusal_fallback=return_once\|session\]\[:cell_yield_ms=N\]\[:brief_finish=on\]\[:fold_finish=on\]\[:low_effort_rounds=on\]\[:brief_final=on\]\[:lean_cells=on\]\[:escalate_model=MODEL\]\[:escalate_tool_errors=N\]\[:escalate_context_tokens=N\]\[:tool_result_tokens=N\]\[:persist_finish=on\]\[:skip_finish_check=on\]\[:late_finish_check_ms=N\]\[:result_effort=low\|medium\|high\|xhigh\|max\]\[:stop_at_target=on\]\[:yield_floor_ms=N\]\[:yield_share=N\]\[:finish_retries=N\]\[:finish_check=on\]\[:finish_ambiguity=on\]\[:tool_result_clearing=KEEP\/TOKENS\]\[:subagents=off\|on\]\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\], not x=/,
    )
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano=claude:claude-opus-5-5:high'),
        yielding,
        parseAgent('nanox=codex:gpt-6-luna:cell_yield_ms=30000'),
      ],
    }).agents.map((agent) => [agent.id, agent.cellYieldMs]),
    [
      ['nano', undefined],
      ['nano-y120', 120000],
      ['nanox', 30000],
    ],
  )
  for (const cellYieldMs of [0, -1, 1.5, '120000', Number.MAX_SAFE_INTEGER + 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ cellYieldMs, id: 'x', model: 'm', provider: 'claude' }],
        }),
      /x: cellYieldMs must be an integer of at least 1/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('x=claude:claude-opus-5-5:cell_yield_ms=0')],
      }),
    /x: cellYieldMs must be an integer of at least 1/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('x=claude:claude-opus-5-5:cell_yield_ms=99999999999999999999')],
      }),
    /x: cellYieldMs must be an integer of at least 1/,
  )
  for (const text of [
    'cli=codex-cli:gpt-6.1-sol:high:cell_yield_ms=120000',
    'code=claude-code:claude-opus-5-5:cell_yield_ms=120000',
    'fx=fx-chat:gpt-6-luna:cell_yield_ms=120000',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /has a cellYieldMs, which only claude and codex sessions take/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ cellYieldMs: 120000, id: 'oracle', model: 'solution', provider: 'oracle' }],
      }),
    /oracle has a cellYieldMs, which only claude and codex sessions take/,
  )
})
