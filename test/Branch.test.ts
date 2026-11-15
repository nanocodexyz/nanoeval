import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import type * as Atif from '../src/Atif.ts'
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

const event = (
  requestId: string,
  type: 'tool.call' | 'tool.result',
  payload: { [key: string]: unknown },
): Atif.SessionEvent => ({
  created_at: 0,
  event: { event: { payload, type }, source: 'agent' },
  request_id: requestId,
  seq: 0,
})

const shell = (
  id: string,
  input: {
    code: number | null
    command: string
    output?: string
    requestId?: string
    tool?: string
  },
): Atif.SessionEvent[] => {
  const requestId = input.requestId ?? Branch.checkRequestId
  const tool = input.tool ?? 'exec_command'
  return [
    event(requestId, 'tool.call', {
      arguments: tool === 'Bash' ? { command: input.command } : { cmd: input.command },
      call_id: id,
      tool,
    }),
    event(requestId, 'tool.result', {
      call_id: id,
      status: 'completed',
      structured_result:
        tool === 'Bash'
          ? { exit_code: input.code, stderr: '', stdout: input.output ?? '' }
          : { exit_code: input.code, output: input.output ?? '' },
      tool,
    }),
  ]
}

const evidenceOf = (events: readonly Atif.SessionEvent[]) =>
  Branch.evidence(events, { requestId: Branch.checkRequestId })

test('a test command is a test runner or test script at the end of the command line, its status unmasked', () => {
  for (const command of [
    'pytest -q',
    'cd /app && python3 -m pytest tests/test_outputs.py -q',
    'bash tests/test.sh',
    'python /app/test_solution.py',
    'cargo test --release',
    'npm test',
    'npm run test',
    'go test ./...',
    'make check',
    'set -o pipefail; pytest -q 2>&1 | tail -5',
    'cd /app && pytest -q && echo ok',
    'timeout 600 pytest -q',
    'PYTHONPATH=. pytest tests',
    './run_tests.sh',
  ])
    assert.ok(Branch.testCommand(command), command)
  for (const command of [
    'pytest -q || true',
    'pytest -q 2>&1 | tail -5',
    'pytest -q; echo done',
    'pytest --version',
    'pytest --collect-only',
    'python solve.py',
    'cat tests/test.sh | head',
    'ls',
    'echo ok > test_a.py',
    "printf '%s\n' 'exit 0' > greeting_test.sh",
  ])
    assert.ok(!Branch.testCommand(command), command)
})

test('a self-check is verified by its last test command after the last file write, which exited 0 with no failure in its output', () => {
  assert.deepEqual(evidenceOf(shell('c1', { code: 0, command: 'pytest -q', output: '3 passed' })), {
    command: 'pytest -q',
    exitCode: 0,
  })
  assert.deepEqual(
    evidenceOf(shell('c1', { code: 0, command: 'bash tests/run.sh', tool: 'Bash' })),
    { command: 'bash tests/run.sh', exitCode: 0 },
  )
  assert.equal(evidenceOf(shell('c1', { code: 1, command: 'pytest -q' })), undefined)
  assert.equal(evidenceOf(shell('c1', { code: 0, command: 'pytest -q || true' })), undefined)
  assert.equal(evidenceOf(shell('c1', { code: 0, command: 'pytest -q | tail -3' })), undefined)
  assert.equal(
    evidenceOf(shell('c1', { code: 0, command: 'pytest -q', output: '2 failed, 1 passed' })),
    undefined,
  )
  assert.equal(evidenceOf(shell('c1', { code: 0, command: 'python solve.py' })), undefined)
  assert.equal(
    evidenceOf(shell('c1', { code: 0, command: 'pytest -q', requestId: 'attempt' })),
    undefined,
    'a test of the turn that worked is no evidence for the self-check',
  )
  assert.equal(
    evidenceOf([
      ...shell('c1', { code: 0, command: 'pytest -q' }),
      event(Branch.checkRequestId, 'tool.call', {
        arguments: {},
        call_id: 'c2',
        tool: 'apply_patch',
      }),
    ]),
    undefined,
    'a file write after the test leaves the self-check unverified',
  )
  assert.deepEqual(
    evidenceOf([
      ...shell('c1', { code: 0, command: 'pytest -q' }),
      ...shell('c2', { code: 0, command: 'ls' }),
    ]),
    { command: 'pytest -q', exitCode: 0 },
  )
  assert.equal(
    evidenceOf([
      ...shell('c1', { code: 0, command: 'pytest -q' }),
      ...shell('c2', { code: 2, command: 'pytest -q tests/test_more.py' }),
    ]),
    undefined,
    'the last test command decides',
  )
  assert.deepEqual(
    evidenceOf([
      event(Branch.checkRequestId, 'tool.call', {
        arguments: { cmd: 'pytest -q' },
        call_id: 'c1',
        tool: 'exec_command',
      }),
      event(Branch.checkRequestId, 'tool.result', {
        call_id: 'c1',
        status: 'completed',
        structured_result: { output: '', session_id: 7 },
        tool: 'exec_command',
      }),
      event(Branch.checkRequestId, 'tool.call', {
        arguments: { chars: '', session_id: 7 },
        call_id: 'c2',
        tool: 'write_stdin',
      }),
      event(Branch.checkRequestId, 'tool.result', {
        call_id: 'c2',
        status: 'completed',
        structured_result: { exit_code: 0, output: '5 passed' },
        tool: 'write_stdin',
      }),
    ]),
    { command: 'pytest -q', exitCode: 0 },
    'a command that outlived its first call ends in write_stdin',
  )
})

test('a verified pass is a PASS verdict with evidence, and the lazy choice keeps the first, else the trunk', () => {
  const pass = {
    evidence: { command: 'pytest', exitCode: 0 as const },
    message: '',
    state: 'completed' as const,
    verdict: 'pass' as const,
  }
  const claimed = { message: '', state: 'completed' as const, verdict: 'pass' as const }
  const failed = { message: '', state: 'completed' as const, verdict: 'fail' as const }
  assert.ok(Branch.verified(pass))
  assert.ok(!Branch.verified(claimed))
  assert.ok(!Branch.verified({ ...pass, verdict: 'fail' }))
  assert.equal(Branch.settle([pass, undefined]), 0)
  assert.equal(Branch.settle([failed, claimed, pass]), 2)
  assert.equal(Branch.settle([failed, undefined, pass]), undefined)
  assert.equal(Branch.settle([failed, claimed, failed]), 0)
  assert.equal(Branch.settle([{ state: 'timeout' }, claimed]), 1)
})

test('a lazy trunk forks when its self-check is not verified, or at 60% of its time while it runs', () => {
  const options = { deadlineAt: 1000, now: 100, startedAt: 0 }
  const pass = {
    evidence: { command: 'pytest', exitCode: 0 as const },
    message: '',
    state: 'completed' as const,
    verdict: 'pass' as const,
  }
  assert.equal(Branch.forkReason(pass, options), undefined)
  assert.equal(Branch.forkReason({ ...pass, evidence: undefined }, options), 'unverified')
  assert.equal(Branch.forkReason({ error: 'x', state: 'failed' }, options), 'unverified')
  assert.equal(Branch.forkReason(undefined, options), undefined)
  assert.equal(Branch.forkReason(undefined, { ...options, now: 599 }), undefined)
  assert.equal(Branch.forkReason(undefined, { ...options, now: 600 }), 'time')
  assert.equal(Branch.forkReason({ state: 'timeout' }, { ...options, now: 1000 }), undefined)
  assert.equal(Branch.forkAt({ deadlineAt: 1000, startedAt: 0 }), 600)
})

test('an agent spec branches lazily with :branches=lazyN, and only an agent that branches is lazy', () => {
  const agent = parseAgent('nanolazy=claude:claude-opus-5-5:high:branches=lazy3')
  assert.deepEqual(agent, {
    branches: 3,
    id: 'nanolazy',
    lazy: true,
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'high',
  })
  assert.equal(agentText(agent), 'nanolazy=claude:claude-opus-5-5:high:branches=lazy3')
  const config = {
    agents: [agent],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'example' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'lazy',
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
  assert.equal(Config.parse(config).agents[0]!.lazy, true)
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', lazy: true, model: 'm', provider: 'claude' }],
      }),
    /only an agent that branches can be/,
  )
})
