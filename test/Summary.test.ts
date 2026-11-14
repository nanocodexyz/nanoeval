import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summary } from '../cli/nanoeval.ts'
import * as Result from '../src/Result.ts'

const row = (task: string, index: number, outcome: Result.Attempt['outcome']): Result.Attempt => ({
  agent: { id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' },
  ...(outcome === 'errored'
    ? { failure: { at: 1, kind: 'cancelled' as const, message: 'the run was cancelled' } }
    : {}),
  finishedAt: 2000,
  id: task + index,
  index,
  outcome,
  reward: outcome === 'errored' ? null : outcome === 'passed' ? 1 : 0,
  sandbox: null,
  session: 's',
  startedAt: 1000,
  task: { checksum: 'sha256:' + task, name: 'suite/' + task },
  timing: {},
  usage: null,
})

const status = (results: readonly Result.Attempt[]): Record<string, any> => ({
  agents: Result.summarize(results),
  attempts: results.map((result) => ({
    agent: result.agent.id,
    claims: 1,
    failure: result.failure,
    id: result.id,
    n: result.index,
    outcome: result.outcome,
    task: result.task.name,
  })),
  counts: {
    active: 0,
    errored: results.filter((result) => result.outcome === 'errored').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
    passed: results.filter((result) => result.outcome === 'passed').length,
    total: results.length,
    unclaimed: 0,
  },
  createdAt: 0,
  id: 'run-1',
  name: 'example',
  spend: { modelUsd: 0, sandboxUsd: 0 },
  state: 'finished',
})

const line = (text: string) => text.split('\n').find((entry) => entry.startsWith('haiku: '))

test('the summary says how many tasks a pass@k rates when errors left some out', () => {
  assert.equal(
    line(
      summary(
        status([
          row('one', 1, 'passed'),
          row('one', 2, 'passed'),
          row('two', 1, 'failed'),
          row('two', 2, 'errored'),
          row('three', 1, 'errored'),
          row('three', 2, 'errored'),
        ]),
      ),
    ),
    'haiku: passed 2/6, errored 3, mean reward 0.667, pass@1 50.0% of 2 tasks, pass@2 100.0% of 1 task',
  )
  assert.equal(
    line(
      summary(
        status([
          row('one', 1, 'passed'),
          row('one', 2, 'failed'),
          row('two', 1, 'failed'),
          row('two', 2, 'failed'),
        ]),
      ),
    ),
    'haiku: passed 1/4, errored 0, mean reward 0.250, pass@1 25.0%, pass@2 50.0%',
  )
})

test('the spend says when it is an estimate and which attempts it leaves out', () => {
  const usage = {
    cacheWriteTokens: 0,
    cachedTokens: 40,
    costUsd: 0.5 as number | undefined,
    inputTokens: 65,
    modelCalls: 1,
    outputTokens: 7,
    toolCalls: 1,
  }
  const results = [
    { ...row('one', 1, 'passed'), usage },
    { ...row('two', 1, 'failed'), usage: { ...usage, costUsd: undefined } },
    { ...row('three', 1, 'errored'), usage: { ...usage, costUsd: undefined, modelCalls: 0 } },
    row('four', 1, 'errored'),
  ]
  assert.equal(Result.uncosted(results), 1)
  const spend = (fields: Record<string, unknown>, key: unknown = null) =>
    summary({ ...status(results), key, spend: { modelUsd: 0.5, sandboxUsd: 0, ...fields } })
      .split('\n')
      .find((entry) => entry.startsWith('spend: '))
  assert.equal(spend({}), 'spend: model $0.5000, sandboxes $0.0000')
  assert.equal(
    spend({ uncostedAttempts: 1, unpricedResponses: 3 }),
    'spend: model $0.5000 estimated from tokens, without 1 attempt whose model calls have no cost, sandboxes $0.0000',
  )
  assert.equal(
    spend({ uncostedAttempts: 2, unpricedResponses: 3 }, { start: {} }),
    'spend: model $0.5000, without 2 attempts whose model calls have no cost, sandboxes $0.0000',
  )
})
