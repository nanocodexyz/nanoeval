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
  name: 'verification-requested',
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
  model: 'gpt-6-luna',
  orchestration: 'direct',
  prompt: 'Write the greeting.',
  provider: 'codex',
  requestId: 'turn-1',
  thinking: 'high',
}

const usage =
  /\[:clearing_cache_floors=on\]\[:lenient_patches=on\]\[:min_wait_ms=N\]\[:max_output_tokens=N\]\[:context_window=N\]\[:fix_provider=claude\|codex\]\[:fix_model=MODEL\]\[:fix_thinking=EFFORT\]\[:verifier_provider=claude\|codex\]\[:verifier_thinking=EFFORT\]\[:executor_share=1\.\.100\]\[:verifier_share=1\.\.100\]\[:fork_on=verifier_fail\|verifier_fail_or_unsure\]\[:codesign=off\]\[:verification_requested=on\]\[:single_verification=on\]\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\]\[:stall_nudge_ms=N\]\[:hedge_cap_percent=0\.\.100\], not x=/

const verified = 'nanox-v=codex:gpt-6-luna:high:verification_requested=on'

test('an agent names verification_requested last in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(verified), {
    id: 'nanox-v',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    provider: 'codex',
    thinking: 'high',
    verificationRequested: true,
  })
  for (const text of [
    verified,
    'a=codex-code-mode:gpt-6-luna:high:verification_requested=on',
    'b=codex:gpt-6-luna:high:persist_finish=on:verification_requested=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=codex:gpt-6-luna:verification_requested=off',
    'x=codex:gpt-6-luna:verification_requested=true',
    'x=codex:gpt-6-luna:verification_requested=',
    'x=codex:gpt-6-luna:verification_requested',
    'x=codex:gpt-6-luna:verification_requested=on:persist_finish=on',
    'x=codex:gpt-6-luna:verification_requested=on:verification_requested=on',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes verificationRequested for a codex agent and refuses bad values and other providers', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nanox=codex:gpt-6-luna:high'),
        parseAgent(verified),
        parseAgent('nanoc-v=codex-code-mode:gpt-6-luna:high:verification_requested=on'),
      ],
    }).agents.map((agent) => [agent.id, agent.verificationRequested]),
    [
      ['nanox', undefined],
      ['nanox-v', true],
      ['nanoc-v', true],
    ],
  )
  assert.equal(Config.agentKeys.includes('verificationRequested'), true)
  for (const verificationRequested of [false, 'on', 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider: 'codex', verificationRequested }],
        }),
      /x has a verificationRequested that is not true/,
    )
  for (const provider of ['claude', 'oracle'])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider, verificationRequested: true }],
        }),
      /x has a verificationRequested, which only a codex session takes/,
    )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('nano=claude:claude-opus-5-5:medium:verification_requested=on')],
      }),
    /nano has a verificationRequested, which only a codex session takes/,
  )
})

test('a turn sends verification_requested only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const named of [turn, { ...turn, persistFinish: true } as const]) {
    assert.equal('verification_requested' in Turn.body(named), false)
    assert.equal('verification_requested' in JSON.parse(Turn.sent(named, input)), false)
    const withVerification = { ...named, verificationRequested: true } as const
    const { verification_requested: sent, ...body } = Turn.body(withVerification)
    assert.equal(sent, true)
    assert.deepEqual(body, Turn.body(named))
    const { verification_requested: logged, ...rest } = JSON.parse(
      Turn.sent(withVerification, input),
    )
    assert.equal(logged, true)
    assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
  }
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, verificationRequested: undefined })),
    JSON.stringify(Turn.body(turn)),
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, verificationRequested: true })),
    JSON.stringify({ verification_requested: true, ...Turn.body(turn) }),
  )
})
