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
