import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'hedges',
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

test('an agent names the hedge cap of its sessions, and one without it names none', () => {
  const text = 'nano-nohedge=claude:claude-opus-5-5:high:hedge_cap_percent=0'
  const agent = parseAgent(text)
  assert.deepEqual(agent, {
    hedgeCapPercent: 0,
    id: 'nano-nohedge',
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'high',
  })
  assert.equal(agentText(agent), text)
  assert.equal(parseAgent('nano=claude:claude-opus-5-5:high').hedgeCapPercent, undefined)
  for (const named of [
    'x=codex:gpt-6-luna:high:hedge_cap_percent=25',
    'x=nanocode-codex:gpt-6-luna:high:hedge_cap_percent=0',
    'x=claude:claude-opus-5-5:high:stall_nudge_ms=1:hedge_cap_percent=10',
  ])
    assert.equal(agentText(parseAgent(named)), named)
  for (const bad of [
    'x=claude:claude-opus-5-5:high:hedge_cap_percent=',
    'x=claude:claude-opus-5-5:high:hedge_cap_percent=1.5',
    'x=claude:claude-opus-5-5:high:hedge_cap_percent=0:stall_nudge_ms=1',
  ])
    assert.throws(() => parseAgent(bad))
})

test('the configuration takes hedgeCapPercent from 0 to 100 for a nanocode agent only', () => {
  const agent = { hedgeCapPercent: 0, id: 'a', model: 'claude-haiku-5-5', provider: 'claude' }
  const parsed = (fields: Record<string, unknown>) =>
    Config.parse({ ...config, agents: [{ ...agent, ...fields }] }).agents[0]!
  assert.equal(parsed({}).hedgeCapPercent, 0)
  assert.equal(parsed({ hedgeCapPercent: 100 }).hedgeCapPercent, 100)
  assert.equal(
    'hedgeCapPercent' in parsed({ hedgeCapPercent: undefined }),
    false,
    'an agent that names no cap keeps the hedge nanocode defaults to',
  )
  for (const provider of ['codex', 'nanocode-claude', 'nanocode-codex'])
    assert.equal(parsed({ model: 'gpt-6-luna', provider }).hedgeCapPercent, 0, provider)
  for (const hedgeCapPercent of [-1, 101, 1.5, '0'])
    assert.throws(() => parsed({ hedgeCapPercent }), /whole percent from 0 to 100/)
  assert.throws(
    () => parsed({ model: 'gpt-6-luna', provider: 'codex-cli' }),
    /only a nanocode session or agent takes/,
  )
})
