import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as Path from 'node:path'
import { test } from 'node:test'
import type * as Compare from '../src/Compare.ts'
import * as Loop from '../src/Loop.ts'
import type * as Result from '../src/Result.ts'

const machine: Loop.Machine = { backend: 'krun', threads: 48 }
const arms = ['fx=fx-chat:qwen', 'pi=pi-chat:qwen']

const row = (
  agent: string,
  task: string,
  index: number,
  given: {
    at?: [startedAt: number, finishedAt: number]
    kind?: Result.FailureKind
    outcome: Result.Attempt['outcome']
  },
): Result.Attempt => ({
  agent: { id: agent, model: 'claude-haiku-4-5', provider: 'claude' },
  ...(given.kind ? { failure: { at: 1, kind: given.kind, message: 'it ended' } } : {}),
  finishedAt: given.at?.[1] ?? 2000,
  id: agent + task + index,
  index,
  outcome: given.outcome,
  reward: given.outcome === 'errored' ? null : given.outcome === 'passed' ? 1 : 0,
  sandbox: null,
  session: 's',
  startedAt: given.at?.[0] ?? 1000,
  task: { checksum: 'sha256:' + task, name: 'suite/' + task },
  timing: {},
  usage: null,
})

const run = (id: string, name: string, attempts: readonly Result.Attempt[]): Compare.Run => ({
  attempts,
  eval: { name: 'suite', version: 'a'.repeat(64) },
  id,
  name,
  state: 'finished',
})

const tasks = ['t1', 't2', 't3', 't4', 't5', 't6']
const twice = (
  agent: string,
  outcome: (task: string, index: number) => Result.Attempt['outcome'],
) =>
  tasks.flatMap((task) =>
    [1, 2].map((index) => row(agent, task, index, { outcome: outcome(task, index) })),
  )
const steady = twice('b', (task, index) => (task === 't2' && index === 2 ? 'failed' : 'passed'))
const main = run('b0000000-0000-4000-8000-000000000000', 'main', [
  ...twice('a', () => 'passed'),
  ...steady,
])
const change = run('c0000000-0000-4000-8000-000000000000', 'change', [
  ...twice('a', () => 'failed'),
  ...steady,
  row('c', 't1', 1, { at: [1000, 61_000], outcome: 'passed' }),
  row('c', 't1', 2, { kind: 'verifier', outcome: 'errored' }),
])

test('a loop takes what is not named from the machine and from the subset of an hour', () => {
  assert.deepEqual(Loop.settings({ agent: arms }, machine), {
    attempts: '3',
    backend: 'krun',
    baseline: ['previous'],
    eval: 'terminal-bench-2.1',
    'fail-on': ['regression'],
    slots: '48',
    subset: ['hourly'],
  })
  assert.deepEqual(
    Loop.settings(
      {
        agent: arms,
        attempts: '2',
        backend: 'dir',
        baseline: ['main'],
        eval: 'samples',
        'fail-on': ['lost'],
        slots: '4',
        subset: ['ten-minute'],
      },
      { backend: 'dir', threads: 5 },
    ),
    {},
  )
  assert.deepEqual(
    Loop.settings({ oracle: true, task: ['tasks/one'] }, { ...machine, backend: 'ns' }),
    {
      attempts: '3',
      backend: 'ns',
      baseline: ['previous'],
      'fail-on': ['regression'],
      slots: '48',
    },
  )
  for (const chosen of [{ only: ['fix-git'] }, { 'only-file': ['names.txt'] }, { limit: '8' }])
    assert.equal(Loop.settings({ agent: arms, ...chosen }, machine).subset, undefined)
})

test('a loop says in one line what it runs and what it took by itself', () => {
  const given = { agent: arms }
  assert.equal(
    Loop.said(given, Loop.settings(given, machine)),
    'loop: terminal-bench-2.1, the subset hourly, 3 attempts a task, 2 arms (fx, pi), 48 krun slots, one for each thread of this machine, against the run before this one where the lab has one, exit 3 on regression',
  )
  const named = {
    agent: ['fx=fx-chat:qwen'],
    attempts: '1',
    backend: 'dir',
    baseline: ['main'],
    slots: '1',
    subset: ['ten-minute'],
  }
  assert.equal(
    Loop.said(named, Loop.settings(named, machine)),
    'loop: terminal-bench-2.1, the subset ten-minute, 1 attempt a task, 1 arm (fx), 1 dir slot, against main, exit 3 on regression',
  )
})

test('a loop is refused without arms, with the option of another flow, and where its slots would be directories that nobody named', () => {
  const refused = (given: Loop.Given, on = machine) => {
    try {
      Loop.settings(given, on)
    } catch (error) {
      assert.ok(error instanceof Loop.RefusedError)
      return error.message
    }
    return undefined
  }
  assert.equal(
    refused({}),
    'nanoeval loop takes its arms from --agent ID=HARNESS:MODEL, one for each, or --oracle',
  )
  assert.equal(
    refused({ agent: arms, rerun: 'main', serve: true }),
    'nanoeval loop makes a new run and waits for it: leave out --rerun and --serve',
  )
  assert.match(
    refused({ agent: arms }, { backend: 'dir', threads: 5 })!,
    /^this machine has no \/dev\/kvm and this command is not root, .*: name --backend dir to run the rows so$/,
  )
  assert.equal(refused({ agent: arms, backend: 'dir' }, { backend: 'dir', threads: 5 }), undefined)
})

test('a baseline named by a word is the latest finished run of that name', () => {
  const listed = [
    { id: 'four', name: 'main', state: 'running' },
    { id: 'three', name: 'main', state: 'finished' },
    { id: 'two', name: 'other', state: 'finished' },
    { id: 'one', name: 'main', state: 'finished' },
  ]
  assert.equal(Loop.named('main', listed), 'three')
  assert.equal(Loop.named('other', listed), 'two')
  assert.equal(Loop.named('none', listed), undefined)
})

test('the scorecard holds every arm with pass@k and its verdict, and the rows, the time and the infrastructure errors of the loop', () => {
  const card = Loop.scorecard(change, { baseline: [main], prices: {}, slots: 5, wallSec: 125 })
  assert.deepEqual(
    card.arms.map((arm) => [
      arm.agent,
      arm.passed,
      arm.rows,
      arm.passMicro,
      arm.passAtK,
      arm.rated,
    ]),
    [
      ['a', 0, 12, 0, { '1': 0, '2': 0 }, { '1': 6, '2': 6 }],
      ['b', 11, 12, 11 / 12, { '1': 5.5 / 6, '2': 1 }, { '1': 6, '2': 6 }],
      ['c', 1, 2, 1, { '1': 1 }, { '1': 1 }],
    ],
  )
  const [a, b, c] = card.arms
  assert.equal(a!.against!.verdict, 'regression')
  assert.deepEqual(
    [a!.against!.down, a!.against!.up, a!.against!.tasks, a!.against!.lost],
    [6, 0, 6, []],
  )
  assert.ok(Math.abs(a!.against!.worse - (1 / 6) ** 6) < 1e-12)
  assert.deepEqual(
    { ...b!.against, better: 1, worse: 1 },
    { better: 1, down: 0, gained: [], lost: [], tasks: 6, up: 0, verdict: 'none', worse: 1 },
  )
  assert.equal(c!.against, null)
  assert.deepEqual(c!.errors.infrastructure, { verifier: 1 })
  assert.deepEqual(card.loop, {
    agentErrors: 0,
    cancelled: 0,
    infrastructureErrors: 1,
    infrastructureRate: 1 / 26,
    rows: 26,
    runSec: 60,
    slots: 5,
    wallSec: 125,
  })
  assert.deepEqual(card.baseline, { names: ['main'], runs: [main.id] })
  assert.equal(card.verdict, 'regression')
  assert.deepEqual([card.run, card.name, card.eval.name], [change.id, 'change', 'suite'])
  assert.equal(
    Loop.text(card),
    [
      '| Arm | Harness | Model | Passed | Pass micro | Pass macro | pass@2 | USD a pass | Cost | Input tokens (cached) | Output tokens | Wall time | Infrastructure errors | Agent or model errors | Cancelled | Against the baseline |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| a | nanocode | claude-haiku-4-5 | 0/12 | 0.0% of 12 | 0.0% over 6 | 0.0% | no model usage | no model usage | not recorded | not recorded | 1 s | 0 | 0 | 0 | regression, 6 down and 0 up of 6 |',
      '| b | nanocode | claude-haiku-4-5 | 11/12 | 91.7% of 12 | 91.7% over 6 | 100.0% | no model usage | no model usage | not recorded | not recorded | 1 s | 0 | 0 | 0 | no change beyond noise, 0 down and 0 up of 6 |',
      '| c | nanocode | claude-haiku-4-5 | 1/2 | 100.0% of 1 | 100.0% over 1 | not rated | no model usage | no model usage | not recorded | not recorded | 1 min 0 s | 1 or 50.0% of its rows (verifier 1) | 0 | 0 | not in the baseline |',
      'loop: 26 rows of 3 arms in 2 min 5 s from the start of the command, the run 1 min 0 s from its first start to its last end on 5 slots, infrastructure errors 1 or 3.8% of the rows, agent or model errors 0',
      'verdict: regression against main (b0000000); regression: a; no change beyond noise: b; not in the baseline: c',
      '',
    ].join('\n'),
  )
})

test('an improvement is the verdict only when no arm regressed, and a run without a baseline has none', () => {
  const better = Loop.scorecard(main, { baseline: [change], prices: {}, slots: 1, wallSec: 1 })
  assert.deepEqual(
    better.arms.map((arm) => arm.against?.verdict),
    ['improvement', 'none'],
  )
  assert.equal(better.verdict, 'improvement')
  assert.match(
    Loop.text(better),
    /\nverdict: improvement against change \(c0000000\); improvement: a; no change beyond noise: b\n$/,
  )
  const crossed = (id: string, good: string) =>
    run(id + '0000000-0000-4000-8000-000000000000', 'crossed', [
      ...twice('a', () => (good === 'a' ? 'passed' : 'failed')),
      ...twice('b', () => (good === 'b' ? 'passed' : 'failed')),
    ])
  const both = Loop.scorecard(crossed('e', 'a'), {
    baseline: [crossed('f', 'b')],
    prices: {},
    slots: 1,
    wallSec: 1,
  })
  assert.deepEqual(
    both.arms.map((arm) => arm.against?.verdict),
    ['improvement', 'regression'],
  )
  assert.equal(both.verdict, 'regression')
  assert.match(
    Loop.text(both),
    /\nverdict: regression against crossed \(f0000000\); regression: b; improvement: a\n$/,
  )
  const first = Loop.scorecard(main, { baseline: [], prices: {}, slots: 1, wallSec: 1 })
  assert.equal(first.baseline, null)
  assert.equal(first.verdict, null)
  assert.deepEqual(
    first.arms.map((arm) => arm.against),
    [null, null],
  )
  assert.match(Loop.text(first), /\| no baseline \|\n/)
  assert.match(Loop.text(first), /\nverdict: none, the run has no baseline\n$/)
  const apart = run('d0000000-0000-4000-8000-000000000000', 'apart', [
    row('z', 't1', 1, { outcome: 'passed' }),
  ])
  const strangers = Loop.scorecard(apart, { baseline: [main], prices: {}, slots: 1, wallSec: 1 })
  assert.equal(strangers.verdict, null)
  assert.match(
    Loop.text(strangers),
    /\nverdict: none, the baseline main holds none of these arms\n$/,
  )
})

test('the command refuses a loop it cannot make in one line, before it starts anything', () => {
  const cli = Path.resolve(import.meta.dirname, '../cli/nanoeval.ts')
  const loop = (...words: string[]) =>
    spawnSync(process.execPath, [cli, 'loop', ...words], {
      encoding: 'utf8',
      env: { HOME: process.env['HOME'], PATH: process.env['PATH'] },
    })
  const bare = loop()
  assert.equal(
    bare.stderr,
    'nanoeval: nanoeval loop takes its arms from --agent ID=HARNESS:MODEL, one for each, or --oracle\n',
  )
  assert.equal(bare.status, 1)
  const quick = loop('--quick', '--agent', arms[0]!)
  assert.equal(quick.stderr, 'nanoeval: --quick is an option of nanoeval revision\n')
  assert.equal(quick.status, 1)
  const served = loop('--serve', '--agent', arms[0]!)
  assert.equal(
    served.stderr,
    'nanoeval: nanoeval loop makes a new run and waits for it: leave out --serve\n',
  )
  assert.equal(served.status, 1)
})
