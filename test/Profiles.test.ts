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
  name: 'profiles',
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
  model: 'kimi-k3.1-pro',
  orchestration: 'direct',
  prompt: 'Write the greeting.',
  provider: 'codex',
  requestId: 'turn-1',
  thinking: 'high',
}

const both = 'nano-gc=codex:kimi-k3.1-pro:high:prompt_variant=compact:tool_profile=lean'

test('an agent names prompt_variant and tool_profile last in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(both), {
    id: 'nano-gc',
    model: 'kimi-k3.1-pro',
    orchestration: 'direct',
    promptVariant: 'compact',
    provider: 'codex',
    thinking: 'high',
    toolProfile: 'lean',
  })
  for (const text of [
    both,
    'a=codex:kimi-k3.1-pro:prompt_variant=compact',
    'b=codex-code-mode:kimi-k3.1-pro:high:tool_profile=lean',
    'c=codex-jobs:kimi-k3.1-pro:medium:persist_finish=on:prompt_variant=compact',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=codex:kimi-k3.1-pro:prompt_variant=',
    'x=codex:kimi-k3.1-pro:prompt_variant=native',
    'x=codex:kimi-k3.1-pro:tool_profile=full',
    'x=codex:kimi-k3.1-pro:tool_profile=lean:prompt_variant=compact',
    'x=codex:kimi-k3.1-pro:prompt_variant=compact:persist_finish=on',
  ])
    assert.throws(
      () => parseAgent(text),
      /\[:prompt_variant=compact\]\[:tool_profile=lean\]\[:omit_media_on_empty_cut=on\], not x=/,
    )
})

test('the configuration takes promptVariant and toolProfile for a codex agent and refuses bad values and other providers', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [parseAgent('nano-g=codex:kimi-k3.1-pro:high'), parseAgent(both)],
    }).agents.map((agent) => [agent.id, agent.promptVariant, agent.toolProfile]),
    [
      ['nano-g', undefined, undefined],
      ['nano-gc', 'compact', 'lean'],
    ],
  )
  assert.equal(Config.agentKeys.includes('promptVariant'), true)
  assert.equal(Config.agentKeys.includes('toolProfile'), true)
  for (const promptVariant of ['native', true, 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', promptVariant, provider: 'codex' }],
        }),
      /promptVariant/,
    )
  for (const toolProfile of ['full', true, 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider: 'codex', toolProfile }],
        }),
      /toolProfile/,
    )
  for (const provider of ['claude', 'codex-cli', 'claude-code', 'oracle']) {
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', promptVariant: 'compact', provider }],
        }),
      /x has a promptVariant, which only a codex session takes/,
    )
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', provider, toolProfile: 'lean' }],
        }),
      /x has a toolProfile, which only a codex session takes/,
    )
  }
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [parseAgent('x=claude:claude-opus-5-5:medium:prompt_variant=compact')],
      }),
    /x has a promptVariant, which only a codex session takes/,
  )
})

test('a codex turn sends compact_instructions and lean_tool_arguments only for an agent that names them, and an agent without them sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct', 'jobs'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    for (const key of ['compact_instructions', 'lean_tool_arguments']) {
      assert.equal(key in Turn.body(plain), false)
      assert.equal(key in JSON.parse(Turn.sent(plain, input)), false)
    }
    const named = { ...plain, promptVariant: 'compact', toolProfile: 'lean' } as const
    const { compact_instructions, lean_tool_arguments, ...body } = Turn.body(named)
    assert.equal(compact_instructions, true)
    assert.equal(lean_tool_arguments, true)
    assert.deepEqual(body, Turn.body(plain))
    const sent = JSON.parse(Turn.sent(named, input))
    assert.equal(sent.compact_instructions, true)
    assert.equal(sent.lean_tool_arguments, true)
    assert.deepEqual(
      Turn.body({ ...plain, promptVariant: 'compact' }).lean_tool_arguments,
      undefined,
    )
    assert.deepEqual(Turn.body({ ...plain, toolProfile: 'lean' }).compact_instructions, undefined)
  }
  const claude = {
    ...turn,
    orchestration: undefined,
    provider: 'claude',
    promptVariant: 'compact',
    toolProfile: 'lean',
  } as const
  assert.equal('compact_instructions' in Turn.body(claude), false)
  assert.equal('lean_tool_arguments' in Turn.body(claude), false)
})
