import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rerunConfig, runsTable } from '../cli/nanoeval.ts'
import type * as Config from '../src/Config.ts'

const parent: Config.Config = {
  agents: [{ id: 'luna', model: 'gpt-6-luna', provider: 'codex' }],
  attempts: 2,
  budget: { modelUsd: 2, sandboxUsd: 1.5 },
  eval: { name: 'terminal-bench-2.1', version: 'a'.repeat(64) },
  limits: { attachSec: 90, claims: 5, leaseSec: 30, setupSec: 7200, stepRetries: 1 },
  name: 'first',
  sandbox: {
    backend: 'krun',
    disks: 'remove',
    freeDiskMb: 4000,
    leaseSec: 900,
    max: 0,
    memoryMb: 16384,
    network: 'private',
    pollMs: 1000,
    provider: 'gateway',
    runtime: { bytes: 1, digest: 'b'.repeat(64) },
    slots: 6,
    template: 'base',
    timeoutSec: 3600,
    verifierCache: true,
    warm: { idleSec: 600, usd: 1 },
  },
}

const own: Config.Config = {
  agents: parent.agents,
  attempts: 2,
  budget: { sandboxUsd: 0 },
  eval: parent.eval,
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'second',
  rerun: { run: '0'.repeat(36), select: 'errored' },
  sandbox: {
    backend: 'auto',
    disks: 'keep',
    max: 1,
    network: 'private',
    pollMs: 250,
    provider: 'local',
    slots: 4,
  },
}

test('a rerun takes the budgets, the limits and the sandbox settings of its run that the command does not name', () => {
  const inherited = rerunConfig(own, { named: new Set(['rerun', 'errored', 'name']), parent })
  assert.deepEqual(inherited.budget, parent.budget)
  assert.deepEqual(inherited.limits, parent.limits)
  const { runtime: _runtime, timeoutSec: _timeoutSec, ...sandbox } = parent.sandbox
  assert.deepEqual(
    inherited.sandbox,
    sandbox,
    'the lifetime that was computed for the rows of the first run and its runtime archive are not taken over',
  )
  assert.deepEqual(
    [inherited.name, inherited.rerun, inherited.attempts],
    [own.name, own.rerun, own.attempts],
  )
})

test('what the command of a rerun names wins over its run', () => {
  const named = new Set([
    'backend',
    'model-budget-usd',
    'sandbox-timeout-sec',
    'sandboxes',
    'setup-sec',
    'slots',
  ])
  const inherited = rerunConfig(
    {
      ...own,
      budget: { modelUsd: 0.5, sandboxUsd: 0 },
      limits: { ...own.limits, setupSec: 300 },
      sandbox: {
        ...own.sandbox,
        backend: 'dir',
        max: 2,
        network: 'host',
        runtime: { bytes: 2, digest: 'c'.repeat(64) },
        slots: 2,
        timeoutSec: 1200,
      },
    },
    { named, parent },
  )
  assert.deepEqual(inherited.budget, { modelUsd: 0.5, sandboxUsd: 1.5 })
  assert.deepEqual(inherited.limits, { ...parent.limits, setupSec: 300 })
  assert.deepEqual(
    [
      inherited.sandbox.backend,
      inherited.sandbox.network,
      inherited.sandbox.max,
      inherited.sandbox.slots,
      inherited.sandbox.timeoutSec,
      inherited.sandbox.runtime?.digest,
      inherited.sandbox.provider,
      inherited.sandbox.memoryMb,
    ],
    ['dir', 'host', 2, 2, 1200, 'c'.repeat(64), 'gateway', 16384],
    'a backend that is named brings its own network',
  )
  const plain = rerunConfig(own, {
    named: new Set(),
    parent: { ...own, budget: { sandboxUsd: 0 }, name: 'first' },
  })
  assert.deepEqual(plain, own, 'a run without the optional settings hands none on')
})

test('the list of runs has a line for each run', () => {
  assert.equal(
    runsTable([
      {
        counts: { active: 1, errored: 0, failed: 1, passed: 2, total: 5, unclaimed: 1 },
        createdAt: 0,
        eval: { name: 'tb21-small', version: 'a'.repeat(64) },
        finishedAt: null,
        id: 'id-1',
        name: 'first',
        state: 'running',
      },
      {
        counts: { active: 0, errored: 1, failed: 0, passed: 3, total: 4, unclaimed: 0 },
        createdAt: 1000,
        eval: { name: 'tb21-small', version: 'a'.repeat(64) },
        finishedAt: 2000,
        id: 'id-2',
        name: 'second',
        state: 'finished',
      },
    ]),
    'id-1  running  passed 2, failed 1, errored 0 of 5, active 1, unclaimed 1  created 1970-01-01T00:00:00.000Z  tb21-small@aaaaaaaaaaaa  first\n' +
      'id-2  finished  passed 3, failed 0, errored 1 of 4  created 1970-01-01T00:00:01.000Z  tb21-small@aaaaaaaaaaaa  second',
  )
})
