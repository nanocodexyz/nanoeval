import assert from 'node:assert/strict'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import { test } from 'node:test'
import { summary, unsoundList } from '../cli/nanoeval.ts'
import * as Catalog from '../datasets/Catalog.ts'
import type * as Compare from '../src/Compare.ts'
import * as Result from '../src/Result.ts'
import * as Unsound from '../src/Unsound.ts'

const checksum = (task: string) =>
  'sha256:' + Buffer.from(task).toString('hex').padEnd(64, '0').slice(0, 64)

const oracle = { id: 'oracle', model: 'solution', provider: 'oracle' as const }
const haiku = { id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' as const }

const row = (
  task: string,
  outcome: Result.Attempt['outcome'],
  input: {
    agent?: Result.Attempt['agent']
    failure?: Result.Failure
    id?: string
    index?: number
    retryOf?: { attempt: string; run: string }
    version?: string
  } = {},
): Result.Attempt => ({
  agent: input.agent ?? oracle,
  ...(input.failure
    ? { failure: input.failure }
    : outcome === 'errored'
      ? { failure: { at: 1, kind: 'verifier' as const, message: 'no test\n  ran' } }
      : {}),
  finishedAt: 2000,
  id: input.id ?? task + (input.index ?? 1),
  index: input.index ?? 1,
  outcome,
  ...(input.retryOf ? { retryOf: input.retryOf } : {}),
  reward: outcome === 'errored' ? null : outcome === 'passed' ? 1 : 0,
  sandbox: null,
  session: 's',
  startedAt: 1000,
  task: { checksum: checksum(input.version ?? task), name: 'suite/' + task },
  timing: {},
  usage: null,
})

const run = (id: string, attempts: readonly Result.Attempt[]): Compare.Run => ({
  attempts,
  eval: { name: 'suite', version: '0123456789abcdef' },
  id,
  name: id,
  state: 'finished',
})

const entry = (task: string, version = task): Unsound.Entry => ({
  checksum: checksum(version),
  reason: 'its solution installs ' + task + ' without a version.',
  task,
  upstream: 'https://example.com/issues/' + task,
})

const list: Unsound.List = { suite: [entry('drifted'), entry('flaky')] }

test('the list of unsound tasks is read by dataset and refuses what it cannot mean', () => {
  assert.deepEqual(Unsound.parse(JSON.stringify(list), 'unsound.json'), list)
  assert.deepEqual(Unsound.parse('{}', 'unsound.json'), {})
  assert.equal(Unsound.find(list, checksum('flaky'))?.task, 'flaky')
  assert.equal(Unsound.find(list, checksum('other')), undefined)
  const refused = (value: unknown, message: RegExp) =>
    assert.throws(
      () => Unsound.parse(typeof value === 'string' ? value : JSON.stringify(value), 'u.json'),
      (error: Error) => error.name === 'Unsound.InvalidError' && message.test(error.message),
    )
  refused('{', /^u\.json is not JSON: /)
  refused([], /^u\.json has to hold \{"DATASET": \[\{"task": /)
  refused({ suite: { drifted: entry('drifted') } }, /has to hold/)
  refused({ suite: [{ ...entry('drifted'), checksum: 'drifted' }] }, /has to hold/)
  refused({ suite: [{ ...entry('drifted'), reason: ' ' }] }, /has to hold/)
  refused({ suite: [{ ...entry('drifted'), upstream: 'http://example.com' }] }, /has to hold/)
  refused({ suite: [{ checksum: checksum('drifted'), task: 'drifted' }] }, /has to hold/)
  refused(
    { other: [entry('drifted')], suite: [entry('drifted')] },
    /^u\.json lists sha256:[0-9a-f]{64} \(drifted\) twice$/,
  )
})

test('a summary rates an agent over its sound tasks beside all of them', () => {
  const attempts = [
    row('one', 'passed', { agent: haiku }),
    row('one', 'failed', { agent: haiku, index: 2 }),
    row('two', 'failed', { agent: haiku }),
    row('two', 'errored', { agent: haiku, index: 2 }),
    row('drifted', 'passed', { agent: haiku }),
    row('drifted', 'passed', { agent: haiku, index: 2 }),
    row('flaky', 'errored', { agent: haiku }),
    row('flaky', 'errored', { agent: haiku, index: 2 }),
  ]
  assert.equal(Result.summarize(attempts)['haiku']!.passAtK['1'], 0.5)
  assert.deepEqual(Unsound.summary(attempts, list), [
    'haiku on its 2 sound tasks: passed 1/4, errored 1, pass@1 25.0%, pass@2 100.0% of 1 task',
    'unsound, set apart: 2 of 4 tasks, whose own solution does not pass its verifier (nanoeval oracle says why): drifted, flaky',
  ])
  assert.deepEqual(Unsound.summary(attempts.slice(0, 4), list), [])
  assert.deepEqual(Unsound.summary(attempts, {}), [])
  assert.deepEqual(Unsound.summary(attempts.slice(4), list), [
    'haiku ran no sound task',
    'unsound, set apart: 2 of 2 tasks, whose own solution does not pass its verifier (nanoeval oracle says why): drifted, flaky',
  ])
  assert.deepEqual(
    Unsound.summary(
      [row('one', 'passed'), row('drifted', 'failed'), ...attempts.slice(0, 2)],
      list,
    ),
    [
      'oracle on its 1 sound task: passed 1/1, errored 0, pass@1 100.0%',
      'unsound, set apart: 1 of 2 tasks, whose own solution does not pass its verifier (nanoeval oracle says why): drifted',
    ],
  )
})

test('the summary of a run prints the sound lines under its agents', () => {
  const results = [
    row('one', 'passed', { agent: haiku }),
    row('drifted', 'failed', { agent: haiku }),
  ]
  const lines = summary(
    {
      agents: Result.summarize(results),
      attempts: results.map((result) => ({
        agent: result.agent.id,
        claims: 1,
        id: result.id,
        n: result.index,
        outcome: result.outcome,
        task: result.task.name,
      })),
      counts: { active: 0, errored: 0, failed: 1, passed: 1, total: 2, unclaimed: 0 },
      createdAt: 0,
      id: 'run-1',
      name: 'example',
      spend: { modelUsd: 0, sandboxUsd: 0 },
      state: 'finished',
    },
    { unsound: Unsound.summary(results, list) },
  ).split('\n')
  const at = lines.findIndex((line) => line.startsWith('haiku: '))
  assert.deepEqual(lines.slice(at, at + 4), [
    'haiku: passed 1/2, errored 0, mean reward 0.500, pass@1 50.0%',
    'haiku on its 1 sound task: passed 1/1, errored 0, pass@1 100.0%',
    'unsound, set apart: 1 of 2 tasks, whose own solution does not pass its verifier (nanoeval oracle says why): drifted',
    '  one1 suite/one haiku #1 passed',
  ])
})

test('a comparison rates both sides over the sound tasks as they stand after reruns', () => {
  const baseline = [
    run('base', [
      row('one', 'failed', { agent: haiku }),
      row('two', 'passed', { agent: haiku }),
      row('drifted', 'passed', { agent: haiku }),
    ]),
  ]
  const later = [
    run('later', [
      row('one', 'errored', { agent: haiku }),
      row('two', 'passed', { agent: haiku }),
      row('drifted', 'failed', { agent: haiku }),
    ]),
    run('again', [
      row('one', 'passed', { agent: haiku, retryOf: { attempt: 'one1', run: 'later' } }),
    ]),
  ]
  assert.equal(
    Unsound.against({ baseline, list, run: later }),
    [
      'haiku on the sound tasks only:',
      '  baseline: 2 sound tasks: passed 1/2, errored 0, pass@1 50.0%',
      '  run: 2 sound tasks: passed 2/2, errored 0, pass@1 100.0%',
      'unsound, set apart: 1 of 3 tasks, whose own solution does not pass its verifier (nanoeval oracle says why): drifted',
      '',
    ].join('\n'),
  )
  assert.equal(Unsound.against({ baseline, list: {}, run: later }), '')
  assert.equal(
    Unsound.against({
      baseline: [run('base', [row('drifted', 'passed', { agent: haiku })])],
      list,
      run: [run('later', [row('one', 'passed', { agent: haiku })])],
    }),
    [
      'haiku on the sound tasks only:',
      '  baseline: no sound task',
      '  run: 1 sound task: passed 1/1, errored 0, pass@1 100.0%',
      'unsound, set apart: 1 of 2 tasks, whose own solution does not pass its verifier (nanoeval oracle says why): drifted',
      '',
    ].join('\n'),
  )
})

test('the oracle check passes when every sound task does, and names the unsound ones', () => {
  const found = Unsound.check(
    [
      run('solved', [
        row('one', 'passed'),
        row('two', 'passed'),
        row('drifted', 'failed'),
        row('flaky', 'passed'),
      ]),
    ],
    list,
  )
  assert.equal(Unsound.failed(found), false)
  assert.equal(
    Unsound.report(found),
    [
      'oracle: the solution passes on 2 of 2 sound tasks',
      'unsound, set apart: 2 of 4 tasks:',
      '  drifted failed: its solution installs drifted without a version. https://example.com/issues/drifted',
      '  flaky passed: its solution installs flaky without a version. https://example.com/issues/flaky',
      '',
    ].join('\n'),
  )
  const none = Unsound.check([run('solved', [row('one', 'passed')])], {})
  assert.equal(Unsound.failed(none), false)
  assert.equal(Unsound.report(none), 'oracle: the solution passes on 1 of 1 sound task\n')
})

test('the oracle check fails when the solution of a sound task fails or errors', () => {
  const found = Unsound.check(
    [
      run('solved', [
        row('one', 'failed'),
        row('two', 'errored'),
        row('three', 'passed'),
        row('four', 'failed', {
          failure: { at: 1, kind: 'agent_timeout', message: 'the solution ran 1800 s' },
        }),
        row('drifted', 'failed'),
      ]),
    ],
    list,
  )
  assert.equal(Unsound.failed(found), true)
  assert.equal(
    Unsound.report(found),
    [
      'oracle: the solution passes on 1 of 4 sound tasks, and not on:',
      '  four failed (agent_timeout: the solution ran 1800 s)',
      '  one failed',
      '  two errored (verifier: no test ran)',
      'unsound, set apart: 1 of 5 tasks:',
      '  drifted failed: its solution installs drifted without a version. https://example.com/issues/drifted',
      '',
    ].join('\n'),
  )
  assert.equal(Unsound.failed(Unsound.check([run('solved', [row('drifted', 'failed')])], {})), true)
})

test('the oracle check reads a run as it stands after its reruns, and every attempt of a task', () => {
  const first = run('solved', [
    row('one', 'errored'),
    row('two', 'passed'),
    row('two', 'failed', { index: 2 }),
    row('three', 'passed'),
    row('three', 'errored', { index: 2 }),
  ])
  const again = run('again', [
    row('one', 'passed', { retryOf: { attempt: 'one1', run: 'solved' } }),
    row('three', 'passed', { index: 2, retryOf: { attempt: 'three2', run: 'solved' } }),
  ])
  assert.equal(
    Unsound.report(Unsound.check([first], {})),
    [
      'oracle: the solution passes on 0 of 3 sound tasks, and not on:',
      '  one errored (verifier: no test ran)',
      '  three errored 1/2 (verifier: no test ran)',
      '  two failed 1/2',
      '',
    ].join('\n'),
  )
  const found = Unsound.check([first, again], {})
  assert.equal(Unsound.failed(found), true)
  assert.equal(
    Unsound.report(found),
    ['oracle: the solution passes on 2 of 3 sound tasks, and not on:', '  two failed 1/2', ''].join(
      '\n',
    ),
  )
})

test('the oracle check counts a newer version of a listed task as sound, and says so', () => {
  const found = Unsound.check(
    [run('solved', [row('drifted', 'passed', { version: 'drifted-2' }), row('one', 'passed')])],
    list,
  )
  assert.equal(Unsound.failed(found), false)
  assert.equal(
    Unsound.report(found),
    [
      'oracle: the solution passes on 2 of 2 sound tasks',
      'note: drifted is listed as unsound at ' +
        checksum('drifted').slice(0, 19) +
        ', and the run holds it at ' +
        checksum('drifted-2').slice(0, 19) +
        ', which counts as sound',
      '',
    ].join('\n'),
  )
})

test('the oracle check refuses a run that an agent made', () => {
  assert.throws(
    () =>
      Unsound.check(
        [
          run('solved', [row('one', 'passed')]),
          run('model', [row('one', 'passed', { agent: haiku })]),
        ],
        list,
      ),
    (error: Error) =>
      error.name === 'Unsound.InvalidError' &&
      error.message ===
        'model is not an oracle run: the check reads runs made with --oracle, where each task ran its own solution',
  )
})

test('the list of this checkout names tasks of datasets that import knows, each once', async () => {
  const file = Path.join(import.meta.dirname, '..', 'unsound.json')
  const own = Unsound.parse(await Fs.readFile(file, 'utf8'), file)
  assert.deepEqual(await unsoundList(undefined), own)
  for (const [dataset, entries] of Object.entries(own)) {
    assert.ok(Catalog.find(dataset), dataset + ' is a dataset that import knows')
    assert.equal(new Set(entries.map((each) => each.task)).size, entries.length)
    assert.deepEqual(
      entries.map((each) => each.task),
      entries.map((each) => each.task).sort(),
    )
  }
  await assert.rejects(
    unsoundList(Path.join(import.meta.dirname, 'no-such-list.json')),
    /^Error: the list of unsound tasks .*no-such-list\.json cannot be read: /,
  )
})
