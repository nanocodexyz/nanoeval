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
  assert.equal(Config.parse(config(undefined)).sandbox.slots, 4)
  const derived = config(undefined)
  assert.equal(
    Config.parse({ ...derived, sandbox: { ...derived.sandbox, slots: undefined } }).sandbox.slots,
    undefined,
    'a run may name no slot count: each runner then takes its own',
  )
  assert.throws(
    () => Config.parse({ ...derived, sandbox: { ...derived.sandbox, slots: 0 } }),
    /sandbox.slots/,
  )
  assert.deepEqual(Config.parse(config({ deposit: 5, topUp: 0 })).key, { deposit: 5, topUp: 0 })
  assert.deepEqual(Config.parse(config({ topUp: 2 })).key, { topUp: 2 })
  for (const key of [{}, { deposit: 0 }, { topUp: -1 }, { deposit: '5' }, null])
    assert.throws(() => Config.parse(config(key)), /key holds a deposit/)
})

test('a run may bound the time of the agent in every row: the smaller of the task and the run', () => {
  const config = (limits: Record<string, unknown>) => ({
    agents,
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'samples' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3, ...limits },
    name: 'bounded',
    sandbox: {
      backend: 'krun',
      disks: 'keep',
      max: 0,
      network: 'private',
      pollMs: 250,
      provider: 'local',
    },
  })
  assert.equal(Config.parse(config({})).limits.agentMaxSec, undefined)
  assert.equal('agentMaxSec' in Config.parse(config({})).limits, false)
  assert.equal(Config.parse(config({ agentMaxSec: 600 })).limits.agentMaxSec, 600)
  for (const agentMaxSec of [0, -1, 1.5, '600', null])
    assert.throws(() => Config.parse(config({ agentMaxSec })), /limits.agentMaxSec/)

  const task = { agent: { timeoutSec: 1800 }, verifier: { env: {}, timeoutSec: 900 } }
  const short = { agent: { timeoutSec: 300 }, verifier: { env: {}, timeoutSec: 900 } }
  assert.equal(Config.bounded({}, task), task, 'a run that names no limit hands the task on')
  assert.equal(
    Config.bounded({ agentMaxSec: 600 }, short),
    short,
    'a task under the limit is itself',
  )
  assert.equal(Config.bounded({ agentMaxSec: 300 }, short), short)
  assert.deepEqual(Config.bounded({ agentMaxSec: 600 }, task), {
    agent: { timeoutSec: 600 },
    verifier: { env: {}, timeoutSec: 900 },
  })
  assert.equal(task.agent.timeoutSec, 1800, 'the task is not changed')
  const limits = { agentMaxSec: 600, setupSec: 600 }
  assert.equal(Config.rowSec(limits, Config.bounded(limits, task)), 600 + 600 + 900)
  assert.equal(Config.rowSec(limits, task), 600 + 1800 + 900)
  assert.equal(
    Config.lifetimeSec(
      Config.parse(config(limits)),
      [task, short].map((each) => Config.bounded(limits, each)),
    ),
    600 + (600 + 600 + 900) + (600 + 300 + 900),
    'the lifetime of a sandbox of the run is counted with the bounded rows',
  )
})
