import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Config from '../src/Config.ts'

const agents: Config.Agent[] = [
  { id: 'cx', model: 'gpt-6-luna', provider: 'codex-cli', thinking: 'high' },
  { id: 'nanox', model: 'gpt-6-luna', provider: 'codex', thinking: 'high' },
]

test('a rerun keeps every agent of its run, or only the agents it names', () => {
  assert.deepEqual(Config.rerunAgents(agents, []), agents)
  assert.deepEqual(Config.rerunAgents(agents, ['nanox']), [agents[1]])
  assert.deepEqual(Config.rerunAgents(agents, ['nanox', 'cx']), agents)
  assert.throws(
    () => Config.rerunAgents(agents, ['nano', 'cx']),
    (error: unknown) =>
      error instanceof Config.InvalidError && /has no agent nano to rerun/.test(error.message),
  )
})

test('a run whose sandboxes are leased removes the disks it unpacked by default', () => {
  assert.equal(Config.disks('local'), 'keep')
  assert.equal(Config.disks('gateway'), 'remove')
  assert.equal(Config.disks('e2b'), 'remove')
})

test('the funding of the key is a deposit above zero, a top-up of at least zero, or both', () => {
  const config = (key: unknown) => ({
    agents,
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'samples' },
    ...(key === undefined ? {} : { key }),
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'funded',
    sandbox: {
      backend: 'krun',
      disks: 'keep',
      max: 0,
      network: 'private',
      pollMs: 250,
      provider: 'local',
      slots: 4,
    },
  })
  assert.equal(Config.parse(config(undefined)).key, undefined)
  assert.deepEqual(Config.parse(config({ deposit: 5, topUp: 0 })).key, { deposit: 5, topUp: 0 })
  assert.deepEqual(Config.parse(config({ topUp: 2 })).key, { topUp: 2 })
  for (const key of [{}, { deposit: 0 }, { topUp: -1 }, { deposit: '5' }, null])
    assert.throws(() => Config.parse(config(key)), /key holds a deposit/)
})
