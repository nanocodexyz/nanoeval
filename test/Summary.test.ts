import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shown, summary } from '../cli/nanoeval.ts'
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
    'haiku: passed 2/6, errored 3, mean reward 0.667 of 3 scored, pass@1 50.0% of 2 tasks, pass@2 100.0% of 1 task',
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

test('the summary names a cancelled run and keeps each row on one line', () => {
  const results = [
    row('one', 1, 'passed'),
    row('two', 1, 'errored'),
    {
      ...row('three', 1, 'errored'),
      failure: { at: 1, kind: 'verifier' as const, message: 'no reward:\n  it wrote none\n' },
    },
  ]
  const lines = summary(status(results)).split('\n')
  assert.equal(lines[0], 'run run-1 (example): finished, cancelled with 1 row not finished')
  assert.equal(lines.at(-2), '  two1 suite/two haiku #1 errored cancelled: the run was cancelled')
  assert.equal(
    lines.at(-1),
    '  three1 suite/three haiku #1 errored verifier: no reward: it wrote none',
  )
  assert.equal(
    summary(status([row('one', 1, 'passed')])).split('\n')[0],
    'run run-1 (example): finished',
  )
})

test('the line of an agent carries its tokens and cost, and the judge has a line of its own', () => {
  const usage = (costUsd: number) => ({
    cacheWriteTokens: 0,
    cachedTokens: 400,
    costUsd,
    inputTokens: 1000,
    modelCalls: 2,
    outputTokens: 50,
    toolCalls: 1,
  })
  const judge = {
    model: 'claude-haiku-4-5',
    provider: 'claude' as const,
    requests: 1,
    usage: { ...usage(0.0028), cachedTokens: 4, inputTokens: 10, outputTokens: 2 },
  }
  const other = { id: 'sol', model: 'gpt-6.1-sol', provider: 'codex' as const }
  const results = [
    { ...row('one', 1, 'passed'), judge, usage: usage(0.0056) },
    { ...row('two', 1, 'failed'), judge, usage: usage(0.0056) },
    { ...row('one', 1, 'passed'), agent: other, judge, usage: usage(0.0168) },
    { ...row('two', 1, 'passed'), agent: other, judge, usage: usage(0.0168) },
  ]
  const lines = summary(status(results)).split('\n')
  assert.equal(
    lines.find((entry) => entry.startsWith('haiku: ')),
    'haiku: passed 1/2, errored 0, mean reward 0.500, pass@1 50.0%, input tokens 2,000 (800 cached), output tokens 100, cost $0.0112',
  )
  assert.equal(
    lines.find((entry) => entry.startsWith('sol: ')),
    'sol: passed 2/2, errored 0, mean reward 1.000, pass@1 100.0%, input tokens 2,000 (800 cached), output tokens 100, cost $0.0336',
  )
  assert.equal(
    lines.find((entry) => entry.startsWith('judge: ')),
    'judge: 4 attempts judged, input tokens 40 (16 cached), output tokens 8, cost $0.0112, beside the agents and in the spend of the run',
  )
  const unpriced = summary(
    status([{ ...row('one', 1, 'passed'), usage: { ...usage(0), costUsd: undefined } }]),
  ).split('\n')
  assert.equal(
    unpriced.find((entry) => entry.startsWith('haiku: ')),
    'haiku: passed 1/1, errored 0, mean reward 1.000, pass@1 100.0%, input tokens 1,000 (400 cached), output tokens 50, cost not known',
  )
  assert.equal(
    unpriced.find((entry) => entry.startsWith('judge: ')),
    undefined,
  )
  assert.equal(
    line(
      summary(
        status([{ ...row('one', 1, 'errored'), usage: { ...usage(0), costUsd: undefined } }]),
      ),
    ),
    'haiku: passed 0/1, errored 1, input tokens 1,000 (400 cached), output tokens 50, cost not known',
  )
  assert.equal(line(summary(status([row('one', 1, 'errored')]))), 'haiku: passed 0/1, errored 1')
  const older = status([row('one', 1, 'passed')])
  delete older['agents'].haiku.judge
  delete older['agents'].haiku.scored
  assert.equal(
    line(summary(older)),
    'haiku: passed 1/1, errored 0, mean reward 1.000, pass@1 100.0%',
  )
})

test('a run names its reruns, and a run too long for the screen is one line a task', () => {
  const results = [
    row('one', 1, 'passed'),
    row('one', 2, 'failed'),
    row('one', 3, 'passed'),
    row('two', 1, 'errored'),
    row('two', 2, 'errored'),
    {
      ...row('two', 3, 'errored'),
      failure: { at: 1, kind: 'verifier' as const, message: 'no reward' },
    },
    row('three', 1, 'failed'),
    { ...row('three', 2, 'errored'), failure: { at: 1, kind: 'agent' as const, message: 'x' } },
  ]
  const run: Record<string, any> = { ...status(results), reruns: ['run-2', 'run-3'] }
  run['attempts'].push({
    agent: 'haiku',
    claims: 0,
    id: 'three3',
    n: 3,
    phase: 'unclaimed',
    task: 'suite/three',
  })
  const full = summary(run).split('\n')
  assert.equal(
    full.find((entry) => entry.startsWith('reruns: ')),
    'reruns: run-2, run-3 (compare --with-reruns reads this run as it stands after them)',
  )
  assert.equal(full.length, 14)
  const compact = summary(run, { tasks: true }).split('\n')
  assert.deepEqual(compact.slice(-3), [
    '  suite/one haiku 2/3',
    '  suite/two haiku 3 errored (cancelled, verifier)',
    '  suite/three haiku 0/1 +1 errored (agent) +1 not ended',
  ])
  assert.equal(compact.length, 8)
  assert.equal(shown(run, { rows: false, tasks: false }), summary(run))
  assert.equal(shown(run, { height: 14, rows: false, tasks: false }), summary(run))
  assert.equal(
    shown(run, { height: 13, rows: false, tasks: false }),
    summary(run, { tasks: true }) +
      '\n(one line a task so that it fits the screen: --rows lists every attempt)',
  )
  assert.equal(shown(run, { height: 13, rows: true, tasks: false }), summary(run))
  assert.equal(shown(run, { rows: false, tasks: true }), summary(run, { tasks: true }))
})
