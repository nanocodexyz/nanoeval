import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Cascade from '../src/Cascade.ts'
import * as Config from '../src/Config.ts'
import * as Turn from '../src/Turn.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'codex-options',
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

const lean =
  'nano-ds-lean=codex:@cf/deepseek-ai/deepseek-v4.1-flash-1017:low:lean_tool_arguments=on:compact_instructions=on:lenient_patches=on:min_wait_ms=120000:context_window=1048576:max_output_tokens=65536'

const turn: Turn.Turn = {
  hand: 'slot',
  model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  prompt: 'Write the greeting.',
  provider: 'codex',
  requestId: 'turn-1',
  thinking: 'low',
}

test('a codex agent names the six codex options after the cascade keys and prints them back', () => {
  const agent = parseAgent(lean)
  assert.deepEqual(agent, {
    compactInstructions: true,
    contextWindow: 1048576,
    id: 'nano-ds-lean',
    leanToolArguments: true,
    lenientPatches: true,
    maxOutputTokens: 65536,
    minWaitMs: 120000,
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    orchestration: 'direct',
    provider: 'codex',
    thinking: 'low',
  })
  assert.equal(agentText(agent), lean)
  assert.deepEqual(Config.parse({ ...config, agents: [agent] }).agents[0], agent)
})

test('the codex options follow the cascade keys and refuse another order', () => {
  const cascade =
    'cv=codex:@cf/deepseek-ai/deepseek-v4.1-flash-1017:low:branches=2:picker=verify_lazy:verifier_model=claude-haiku-5-5:fix_provider=claude:fix_model=claude-sonnet-5-5:verifier_share=10:lean_tool_arguments=on:max_output_tokens=65536'
  assert.equal(agentText(parseAgent(cascade)), cascade)
  assert.throws(() => parseAgent('x=codex:m:low:max_output_tokens=65536:lean_tool_arguments=on'))
})

test('only a codex session takes the codex options, and a limit is a positive whole number', () => {
  for (const [field, value] of [
    ['compactInstructions', true],
    ['leanToolArguments', true],
    ['lenientPatches', true],
    ['minWaitMs', 1000],
    ['contextWindow', 272000],
    ['maxOutputTokens', 4096],
  ] as const) {
    const agent = { id: 'c', model: 'claude-opus-5-5', provider: 'claude' as const, [field]: value }
    assert.throws(() => Config.parse({ ...config, agents: [agent] }), /only a codex session takes/)
  }
  for (const field of ['minWaitMs', 'contextWindow', 'maxOutputTokens'] as const)
    assert.throws(() =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', provider: 'codex', [field]: 0 }],
      }),
    )
  assert.throws(() =>
    Config.parse({
      ...config,
      agents: [{ id: 'x', model: 'm', provider: 'codex', lenientPatches: false }],
    }),
  )
})

test('a codex turn sends the options in snake case and a claude turn sends none', () => {
  const options = {
    compactInstructions: true,
    contextWindow: 1048576,
    leanToolArguments: true,
    lenientPatches: true,
    maxOutputTokens: 65536,
    minWaitMs: 120000,
  } as const
  const body = Turn.body({ ...turn, ...options })
  assert.equal(body['compact_instructions'], true)
  assert.equal(body['context_window'], 1048576)
  assert.equal(body['lean_tool_arguments'], true)
  assert.equal(body['lenient_patches'], true)
  assert.equal(body['max_output_tokens'], 65536)
  assert.equal(body['min_wait_ms'], 120000)
  const sent = JSON.parse(Turn.sent({ ...turn, ...options }, { at: 1, session: 's' }))
  assert.equal(sent['max_output_tokens'], 65536)
  const claude = Turn.body({ ...turn, ...options, model: 'claude-sonnet-5-5', provider: 'claude' })
  for (const key of [
    'compact_instructions',
    'context_window',
    'lean_tool_arguments',
    'lenient_patches',
    'max_output_tokens',
    'min_wait_ms',
  ])
    assert.equal(claude[key], undefined)
  assert.deepEqual(Turn.body(turn)['max_output_tokens'], undefined)
})

test('a cascade fix turn drops the codex options of the executor', () => {
  const bare = Cascade.bare({
    ...turn,
    contextWindow: 1048576,
    leanToolArguments: true as const,
    minWaitMs: 5,
  })
  assert.equal('contextWindow' in bare, false)
  assert.equal('leanToolArguments' in bare, false)
  assert.equal('minWaitMs' in bare, false)
})
