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
  name: 'codex-session-options',
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

const usage =
  /\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:single_verification=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\]\[:stall_nudge_ms=N\]\[:hedge_cap_percent=0\.\.100\], not x=/

const all =
  'nanox-dsk=codex:deepseek-v4-pro:high:lenient_patches=on:min_wait_ms=2000:max_output_tokens=32000:context_window=128000'

test('a codex agent names the codex session options after clearing_cache_floors, and its text reads back', () => {
  assert.deepEqual(parseAgent(all), {
    contextWindow: 128000,
    id: 'nanox-dsk',
    lenientPatches: true,
    maxOutputTokens: 32000,
    minWaitMs: 2000,
    model: 'deepseek-v4-pro',
    orchestration: 'direct',
    provider: 'codex',
    thinking: 'high',
  })
  for (const text of [
    all,
    'a=codex:gpt-6-luna:high:lenient_patches=on',
    'b=codex-code-mode:kimi-k3.1-pro:medium:min_wait_ms=1500',
    'c=codex-jobs:glm-5.3:high:max_output_tokens=16000',
    'd=codex:gpt-6-luna:xhigh:persist_finish=on:context_window=200000',
    'e=codex:gpt-6-luna:high:subagents=off:clearing_cache_floors=on:lenient_patches=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=codex:gpt-6-luna:lenient_patches=off',
    'x=codex:gpt-6-luna:min_wait_ms=',
    'x=codex:gpt-6-luna:min_wait_ms=1.5',
    'x=codex:gpt-6-luna:context_window=128000:lenient_patches=on',
    'x=codex:gpt-6-luna:max_output_tokens=10:min_wait_ms=10',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes the codex session options only for a codex agent and only as whole numbers', () => {
  const [agent] = Config.parse({ ...config, agents: [parseAgent(all)] }).agents
  assert.equal(agent!.lenientPatches, true)
  assert.equal(agent!.minWaitMs, 2000)
  assert.equal(agent!.maxOutputTokens, 32000)
  assert.equal(agent!.contextWindow, 128000)
  for (const key of ['contextWindow', 'lenientPatches', 'maxOutputTokens', 'minWaitMs'] as const)
    assert.equal(Config.agentKeys.includes(key), true)
  for (const text of [
    'nanox=claude:claude-opus-5-5:high:lenient_patches=on',
    'nanox=claude-direct:claude-opus-5-5:high:min_wait_ms=2000',
    'nanox=claude:claude-opus-5-5:high:max_output_tokens=8000',
    'nanox=claude:claude-opus-5-5:high:context_window=200000',
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /nanox has a (lenientPatches|minWaitMs|maxOutputTokens|contextWindow), which only a codex session takes/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', lenientPatches: 'on', model: 'm', provider: 'codex' }],
      }),
    /x has a lenientPatches that is not true/,
  )
  for (const minWaitMs of [0, -1, 1.5, '2000'])
    assert.throws(() =>
      Config.parse({ ...config, agents: [{ id: 'x', minWaitMs, model: 'm', provider: 'codex' }] }),
    )
})

test('a codex turn sends the session options in snake case, and a turn without them sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  const codex: Turn.Turn = {
    hand: 'slot',
    model: 'deepseek-v4-pro',
    prompt: 'Write the greeting.',
    provider: 'codex',
    requestId: 'turn-1',
    thinking: 'high',
  }
  const named: Turn.Turn = {
    ...codex,
    contextWindow: 128000,
    lenientPatches: true,
    maxOutputTokens: 32000,
    minWaitMs: 2000,
  }
  const { context_window, lenient_patches, max_output_tokens, min_wait_ms, ...body } =
    Turn.body(named)
  assert.deepEqual(
    { context_window, lenient_patches, max_output_tokens, min_wait_ms },
    { context_window: 128000, lenient_patches: true, max_output_tokens: 32000, min_wait_ms: 2000 },
  )
  assert.deepEqual(body, Turn.body(codex))
  assert.equal(
    JSON.stringify(Turn.body(codex)),
    '{"hand":"slot","model":"deepseek-v4-pro","prompt":"Write the greeting.","provider":"codex","request_id":"turn-1","subagents":false,"thinking":"high","web_search":false}',
  )
  const sent = JSON.parse(Turn.sent(named, input))
  assert.equal(sent.min_wait_ms, 2000)
  assert.equal(sent.lenient_patches, true)
  assert.equal(
    Turn.sent(codex, input),
    '{"at_ms":1800000000000,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
})
