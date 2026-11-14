import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as Atif from '../src/Atif.ts'
import * as Compare from '../src/Compare.ts'
import type * as Result from '../src/Result.ts'

const usage: Atif.Usage = {
  cacheWriteTokens: 0,
  cachedTokens: 100,
  costUsd: undefined,
  inputTokens: 300,
  modelCalls: 2,
  outputTokens: 20,
  toolCalls: 2,
}

function attempt(
  agent: Result.Attempt['agent'],
  input: { n: number; outcome: Result.Attempt['outcome']; task: string; usage: Atif.Usage | null },
): Result.Attempt {
  return {
    agent,
    ...(input.outcome === 'errored'
      ? { failure: { at: 0, kind: 'agent' as const, message: 'it exited with 1' } }
      : {}),
    finishedAt: 100_000,
    id: 'a0000' + input.n,
    index: 1,
    outcome: input.outcome,
    reward: input.outcome === 'errored' ? null : input.outcome === 'passed' ? 1 : 0,
    sandbox: null,
    session: 's',
    startedAt: 10_000,
    task: { checksum: 'c', name: 'bench/' + input.task },
    timing: { agentExecution: { finishedAt: 80_000, startedAt: 20_000 } },
    usage: input.usage,
  }
}

test('a comparison has one row per agent across runs, and says what is not known', () => {
  const nano = { id: 'nano', model: 'gpt-6.1-sol', provider: 'codex' as const, thinking: 'high' }
  const cli = { id: 'cli', model: 'gpt-6.1-sol', provider: 'codex-cli' as const, thinking: 'high' }
  const runs: Compare.Run[] = [
    {
      attempts: [
        attempt(nano, { n: 1, outcome: 'passed', task: 'one', usage: { ...usage, costUsd: 0.5 } }),
        attempt(cli, { n: 2, outcome: 'failed', task: 'one', usage }),
      ],
      eval: { name: 'bench', version: '0123456789abcdef' },
      id: 'run-1',
      name: 'first',
      state: 'finished',
    },
    {
      attempts: [
        attempt(nano, { n: 1, outcome: 'errored', task: 'two', usage: null }),
        attempt(cli, { n: 2, outcome: 'passed', task: 'two', usage }),
      ],
      eval: { name: 'bench', version: '0123456789abcdef' },
      id: 'run-2',
      name: 'second',
      state: 'running',
    },
  ]
  const [first, second] = Compare.arms(runs)
  assert.deepEqual(
    [first!.agent, first!.harness, first!.model, first!.attempts, first!.passed, first!.errored],
    ['nano', 'nanocode', 'codex:gpt-6.1-sol:high', 2, 1, 1],
  )
  assert.deepEqual(
    [first!.costUsd, first!.priced, first!.metered, first!.runs],
    [0.5, 1, 1, ['run-1', 'run-2']],
  )
  assert.deepEqual(
    [second!.agent, second!.harness, second!.model, second!.failed, second!.costUsd, second!.tasks],
    ['cli', 'codex-cli 0.166.0', 'codex:gpt-6.1-sol:high', 1, null, 2],
  )
  assert.equal(second!.agentSec, 120)
  assert.equal(second!.inputTokens, 600)

  const table = Compare.table(runs)
  assert.match(table, /^run run-1 \(first\): finished, bench@0123456789ab, 2 attempts ended$/m)
  assert.match(
    table,
    /^\| nano \| nanocode \| codex:gpt-6\.1-sol:high \| 2 \| 1 \| 0 \| 1 \| 2 min 0 s \| 3 min 0 s \| 300 \(100\) \| 20 \| \$0\.5000 for 1 of 2 \|$/m,
  )
  assert.match(
    table,
    /^\| cli \| codex-cli 0\.166\.0 \| codex:gpt-6\.1-sol:high \| 2 \| 1 \| 1 \| 0 \| 2 min 0 s \| 3 min 0 s \| 600 \(200\) \| 40 \| not known \|$/m,
  )
  assert.match(table, /^\| one \| passed 1 min 0 s \| failed 1 min 0 s \|$/m)
  assert.match(table, /^\| two \| errored \(agent\) 1 min 0 s \| passed 1 min 0 s \|$/m)
})

test('a direct-tools codex agent is its own arm beside the code-mode one', () => {
  const nanox = { id: 'nanox', model: 'gpt-6-luna', provider: 'codex' as const, thinking: 'high' }
  const nanoxd = { ...nanox, id: 'nanoxd', orchestration: 'direct' as const }
  const runs: Compare.Run[] = [
    {
      attempts: [
        attempt(nanox, { n: 1, outcome: 'passed', task: 'one', usage }),
        attempt(nanoxd, { n: 2, outcome: 'failed', task: 'one', usage }),
      ],
      eval: { name: 'bench', version: '0123456789abcdef' },
      id: 'run-1',
      name: 'arms',
      state: 'finished',
    },
  ]
  assert.deepEqual(
    Compare.arms(runs).map((arm) => [arm.agent, arm.harness, arm.model, arm.passed, arm.failed]),
    [
      ['nanox', 'nanocode', 'codex:gpt-6-luna:high', 1, 0],
      ['nanoxd', 'nanocode', 'codex-direct:gpt-6-luna:high', 0, 1],
    ],
  )
})

test('runs of one agent on different nanocode revisions are separate rows, and a run is set against a baseline', () => {
  const luna = { id: 'luna', model: 'gpt-6-luna', provider: 'codex' as const }
  const priced = { ...usage, costUsd: 0.25 }
  const at = (n: number, index: number, outcome: Result.Attempt['outcome'], task: string) => ({
    ...attempt(luna, { n, outcome, task, usage: priced }),
    index,
  })
  const baseline: Compare.Run = {
    attempts: [
      at(1, 1, 'passed', 'kept'),
      at(2, 2, 'passed', 'kept'),
      at(3, 1, 'passed', 'broken'),
      at(4, 2, 'failed', 'broken'),
      at(5, 1, 'failed', 'fixed'),
      at(6, 2, 'failed', 'fixed'),
      at(7, 1, 'failed', 'hard'),
      at(8, 2, 'errored', 'hard'),
      at(9, 1, 'passed', 'dropped'),
    ],
    eval: { name: 'bench', version: '0123456789abcdef' },
    id: 'run-old',
    name: 'pins',
    nanocode: { hands: ['nanocode-cli-1234567'], harness: 'nanocode-ts build-abcdef0' },
    state: 'finished',
  }
  const run: Compare.Run = {
    attempts: [
      at(1, 1, 'passed', 'kept'),
      at(2, 2, 'failed', 'kept'),
      at(3, 1, 'failed', 'broken'),
      at(4, 2, 'failed', 'broken'),
      at(5, 1, 'failed', 'fixed'),
      at(6, 2, 'passed', 'fixed'),
      at(7, 1, 'failed', 'hard'),
      at(8, 2, 'failed', 'hard'),
      at(9, 1, 'passed', 'added'),
      at(10, 2, 'passed', 'added'),
    ],
    eval: { name: 'bench', version: '0123456789abcdef' },
    id: 'run-new',
    name: 'master',
    nanocode: {
      hands: ['nanocode 0123456789ab'],
      harness: 'nanocode-ts fedcba987654 on nanocode 0123456789ab',
    },
    state: 'finished',
  }

  const [old, now] = Compare.arms([baseline, run])
  assert.deepEqual(
    [old!.harness, old!.runs, old!.passed, now!.harness, now!.runs, now!.passed],
    [
      'nanocode-ts build-abcdef0, hand nanocode-cli-1234567',
      ['run-old'],
      4,
      'nanocode-ts fedcba987654 on nanocode 0123456789ab, hand nanocode 0123456789ab',
      ['run-new'],
      4,
    ],
  )
  const table = Compare.table([baseline, run])
  assert.match(
    table,
    /^run run-new \(master\): finished, bench@0123456789ab, 10 attempts ended, nanocode-ts fedcba987654 on nanocode 0123456789ab, hand nanocode 0123456789ab$/m,
  )
  assert.match(table, /^\| Task \| luna of run-old \| luna of run-new \|$/m)
  assert.match(
    table,
    /^\| fixed \| failed 1 min 0 s, failed 1 min 0 s \| failed 1 min 0 s, passed 1 min 0 s \|$/m,
  )
  assert.match(table, /^\| added \| not run \| passed 1 min 0 s, passed 1 min 0 s \|$/m)

  const [change] = Compare.changes(baseline, run)
  assert.deepEqual(
    [
      change!.gained,
      change!.lost,
      change!.solved,
      change!.neither,
      change!.onlyRun,
      change!.onlyBaseline,
    ],
    [['fixed'], ['broken'], ['kept'], ['hard'], ['added'], ['dropped']],
  )
  assert.deepEqual(change!.tasks['broken'], { baseline: '1/2', run: '0/2' })

  const against = Compare.against(baseline, run)
  assert.match(against, /^luna: run run-new against the baseline run-old$/m)
  assert.match(
    against,
    /^\| nanocode \| nanocode-ts build-abcdef0, hand nanocode-cli-1234567 \| nanocode-ts fedcba987654 on nanocode 0123456789ab, hand nanocode 0123456789ab \|$/m,
  )
  assert.match(against, /^\| Attempts \| 9 \| 10 \|$/m)
  assert.match(against, /^\| Passed \| 4 \| 4 \|$/m)
  assert.match(against, /^\| Errored \| 1 \| 0 \|$/m)
  assert.match(against, /^\| pass@1 \| 50\.0% \| 40\.0% \|$/m)
  assert.match(against, /^\| pass@2 \| 66\.7% of 3 tasks \| 60\.0% \|$/m)
  assert.match(against, /^\| Input tokens \(cached\) \| 2,700 \(900\) \| 3,000 \(1,000\) \|$/m)
  assert.match(against, /^\| Cost \| \$2\.2500 \| \$2\.5000 \|$/m)
  assert.match(against, /^gained: fixed \(0\/2 to 1\/2\)$/m)
  assert.match(against, /^lost: broken \(1\/2 to 0\/2\)$/m)
  assert.match(against, /^solved in both: 1, in neither: 1$/m)
  assert.match(against, /^not in the baseline: added$/m)
  assert.match(against, /^only in the baseline: dropped$/m)

  const other: Compare.Run = {
    ...run,
    attempts: [
      attempt({ ...luna, id: 'sol' }, { n: 1, outcome: 'passed', task: 'kept', usage: null }),
    ],
  }
  assert.match(Compare.against(baseline, other), /^\| Attempts \| not run \| 1 \|$/m)
})
