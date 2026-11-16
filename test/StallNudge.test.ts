import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'stalls',
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

test('an agent names how often a session hears that it keeps waiting on commands', () => {
  const text = 'nano-haiku-stall=claude:claude-haiku-5-5:medium:stall_nudge_ms=300000'
  const agent = parseAgent(text)
  assert.deepEqual(agent, {
    id: 'nano-haiku-stall',
    model: 'claude-haiku-5-5',
    provider: 'claude',
    stallNudgeMs: 300000,
    thinking: 'medium',
  })
  assert.equal(agentText(agent), text)
  const last = 'x=claude:claude-opus-5-5:high:yield_share=25:clearing_cache_floors=on:stall_nudge_ms=1'
  assert.equal(agentText(parseAgent(last)), last)
  for (const bad of [
    'x=claude:claude-opus-5-5:high:stall_nudge_ms=',
    'x=claude:claude-opus-5-5:high:stall_nudge_ms=1.5',
    'x=claude:claude-opus-5-5:high:stall_nudge_ms=1:yield_share=25',
  ])
    assert.throws(() => parseAgent(bad))
})

test('the configuration takes stallNudgeMs for a claude agent only', () => {
  const agent = { id: 'a', model: 'claude-haiku-5-5', provider: 'claude', stallNudgeMs: 300000 }
  assert.equal(Config.parse({ ...config, agents: [agent] }).agents[0]!.stallNudgeMs, 300000)
  for (const stallNudgeMs of [0, 1.5, '300000'])
    assert.throws(() => Config.parse({ ...config, agents: [{ ...agent, stallNudgeMs }] }))
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'c', model: 'gpt-6-luna', provider: 'codex', stallNudgeMs: 300000 }],
      }),
    /only a claude session takes/,
  )
})
