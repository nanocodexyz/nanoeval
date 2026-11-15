import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Branch from '../src/Branch.ts'
import * as Config from '../src/Config.ts'
import * as Proxy from '../src/Proxy.ts'

test('the first branch keeps the names of the attempt, and the others are named after it', () => {
  assert.equal(Branch.session('run-a1-1', 0), 'run-a1-1')
  assert.equal(Branch.session('run-a1-1', 2), 'run-a1-1-branch-2')
  assert.equal(Branch.slot('abcd1234-a00001-1', 0), 'abcd1234-a00001-1')
  assert.equal(Branch.slot('abcd1234-a00001-1', 2), 'abcd1234-a00001-1-b2')
  assert.equal(Branch.base('abcd1234-a00001-1-b2'), 'abcd1234-a00001-1')
  assert.equal(Branch.base('abcd1234-a00001-1'), 'abcd1234-a00001-1')
  assert.deepEqual(Branch.indexes(3), [0, 1, 2])
})

test('the model requests of a branch session are metered to its attempt and claim', () => {
  const run = '0d6c29c9-f885-4e7c-bff4-23d0045679a0'
  assert.deepEqual(Proxy.session(run + '-a00007-2-branch-1'), {
    attempt: 'a00007',
    branch: 1,
    claim: 2,
    run,
  })
  assert.deepEqual(Proxy.session(run + '-a00007-2'), { attempt: 'a00007', claim: 2, run })
  assert.equal(Proxy.session(run + '-a00007-2-branch-x'), undefined)
})

test('a self-check verdict is the last SELF-CHECK line of the reply', () => {
  assert.equal(Branch.verdict('ran 4 tests\nSELF-CHECK: PASS'), 'pass')
  assert.equal(Branch.verdict('SELF-CHECK: PASS\nthen one broke\nself-check: fail'), 'fail')
  assert.equal(Branch.verdict('everything looks fine'), 'unknown')
  assert.equal(Branch.verdict('SELF-CHECK: PASSED'), 'unknown')
})

test('the chosen branch completed with the best self-check, and the first of equals wins', () => {
  const completed = (verdict: Branch.Verdict): Branch.Outcome => ({
    message: '',
    state: 'completed',
    verdict,
  })
  assert.equal(Branch.choose([completed('fail'), completed('pass'), completed('pass')]), 1)
  assert.equal(Branch.choose([completed('fail'), completed('unknown'), completed('fail')]), 1)
  assert.equal(Branch.choose([{ state: 'timeout' }, completed('fail')]), 1)
  assert.equal(Branch.choose([{ state: 'timeout' }, { error: 'x', state: 'failed' }]), 0)
  assert.equal(Branch.choose([completed('pass'), completed('pass')]), 0)
  assert.throws(() => Branch.choose([]), Branch.InvalidError)
})

test('a branch count is a whole number of at least two', () => {
  assert.ok(Branch.valid(3))
  assert.ok(!Branch.valid(1))
  assert.ok(!Branch.valid(2.5))
  assert.ok(!Branch.valid('3'))
})

test('an agent spec branches its session with :branches=N, and the run checks the count and the harness', () => {
  assert.deepEqual(parseAgent('nanoxb3=codex:gpt-6-luna:high:branches=3'), {
    branches: 3,
    id: 'nanoxb3',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    provider: 'codex',
    thinking: 'high',
  })
  assert.deepEqual(parseAgent('nanoxpb3=codex+preflight:gpt-6-luna:high:branches=3'), {
    branches: 3,
    id: 'nanoxpb3',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    preflight: true,
    provider: 'codex',
    thinking: 'high',
  })
  assert.equal(
    agentText(parseAgent('nanoxb3=codex:gpt-6-luna:high:branches=3')),
    'nanoxb3=codex:gpt-6-luna:high:branches=3',
  )
  const config = {
    agents: [parseAgent('nanoxb3=codex:gpt-6-luna:high:branches=3')],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'example' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'branches',
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
  assert.equal(Config.parse(config).agents[0]!.branches, 3)
  assert.throws(
    () => Config.parse({ ...config, agents: [{ ...config.agents[0], branches: 1 }] }),
    /whole number of at least two/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ branches: 3, id: 'cli', model: 'gpt-6-luna', provider: 'codex-cli' }],
      }),
    /only a claude or codex session can/,
  )
})
