import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Command from '../cli/Scorecard.ts'
import * as Result from '../src/Result.ts'
import * as Scorecard from '../src/Scorecard.ts'

type Given = { cancelled?: true; outcome?: Result.Attempt['outcome']; usd?: number }

const row = (arm: string, at: string, given: Given = {}): Result.Attempt => {
  const [task, index] = at.split('#')
  const outcome = given.cancelled ? 'errored' : (given.outcome ?? 'passed')
  const failure: Result.Failure = given.cancelled
    ? { at: 0, kind: 'cancelled', message: 'the run was cancelled' }
    : { at: 0, kind: 'environment', message: 'the slot did not start' }
  return {
    agent: { id: arm, model: 'model', provider: 'claude' },
    ...(outcome === 'errored' ? { failure } : {}),
    finishedAt: 0,
    id: arm + '-' + at,
    index: Number(index),
    outcome,
    reward: outcome === 'errored' ? null : Number(outcome === 'passed'),
    sandbox: null,
    session: arm + '-' + at,
    startedAt: 0,
    task: { checksum: 'sha256:' + task, name: 'set/' + task },
    timing: {},
    usage:
      given.usd === undefined
        ? null
        : {
            cacheWriteTokens: 0,
            cachedTokens: 0,
            costUsd: given.usd,
            inputTokens: 0,
            modelCalls: 2,
            outputTokens: 100,
            toolCalls: 0,
          },
  }
}

const run = (
  id: string,
  arms: readonly string[],
  results: readonly Result.Attempt[],
): Scorecard.Run => ({
  agents: arms.map((arm) => ({ id: arm, model: 'model', provider: 'claude', thinking: 'high' })),
  attempts: 3,
  eval: { name: 'toy', version: 'digest-1' },
  id,
  name: 'toy run',
  nanocode: { hands: ['hand-1'], harness: 'harness-1' },
  results,
  state: 'finished',
})

const options = { command: 'nanoeval scorecard', draws: 200, reference: 'b', seed: 1 }

const arm = (card: Scorecard.Card, label: string) => card.arms.find((one) => one.label === label)!

test('the matched set holds the task#attempts with a verdict in every arm', () => {
  const card = Scorecard.build(
    [
      run(
        'r1',
        ['a', 'b'],
        [
          row('a', 't1#1'),
          row('a', 't1#2', { outcome: 'failed' }),
          row('a', 't2#1'),
          row('a', 't3#1', { outcome: 'errored' }),
          row('b', 't1#1'),
          row('b', 't2#1', { cancelled: true }),
          row('b', 't3#1'),
        ],
      ),
    ],
    options,
  )
  assert.deepEqual(card.matched, { attempts: 2, tasks: 2 })
  assert.deepEqual(card.tasks, [
    { attempts: 1, name: 'set/t1', passed: [1, 1] },
    { attempts: 1, name: 'set/t3', passed: [0, 1] },
  ])
  const a = arm(card, 'a')
  assert.deepEqual(
    [a.matched, a.passed, a.failed, a.errored, a.unmatched, a.cancelled],
    [2, 1, 0, 1, 2, 0],
  )
  const b = arm(card, 'b')
  assert.deepEqual(
    [b.matched, b.passed, b.failed, b.errored, b.unmatched, b.cancelled],
    [2, 2, 0, 0, 0, 1],
  )
  assert.equal(a.passRate.value, 0.5)
  assert.equal(a.against!.passRateDifference.value, -0.5)
  assert.equal(b.against, null)
  assert.match(Scorecard.text(card), /^matched set: 2 task#attempts of 2 tasks, reference b\n/)
})

test('a cancelled row is no verdict, and an errored row is one', () => {
  assert.equal(Scorecard.verdict(row('a', 't1#1', { cancelled: true })), false)
  assert.equal(Scorecard.verdict(row('a', 't1#1', { outcome: 'errored' })), true)
  assert.equal(Scorecard.verdict(row('a', 't1#1', { outcome: 'failed' })), true)
  assert.throws(
    () =>
      Scorecard.build(
        [run('r1', ['a', 'b'], [row('a', 't1#1'), row('b', 't1#1', { cancelled: true })])],
        options,
      ),
    /the matched set is empty/,
  )
})

test('a row that no runner took is no verdict and is counted apart from a cancelled one', () => {
  const none = (kind: Result.FailureKind, message: string): Result.Attempt => ({
    ...row('b', 't2#1', { outcome: 'errored' }),
    failure: { at: 0, kind, message },
  })
  const named = none('unscheduled', 'no runner of the run could take the row for 600 s')
  const earlier = none('environment', Result.unscheduledPrefix + '600 s')
  assert.equal(Scorecard.verdict(named), false)
  assert.equal(Scorecard.verdict(earlier), false)
  assert.equal(Scorecard.verdict(none('environment', 'the slot did not start')), true)
  for (const lost of [named, earlier]) {
    const card = Scorecard.build(
      [
        run(
          'r1',
          ['a', 'b'],
          [
            row('a', 't1#1'),
            row('a', 't2#1'),
            row('a', 't3#1'),
            row('b', 't1#1'),
            lost,
            row('b', 't3#1', { cancelled: true }),
          ],
        ),
      ],
      options,
    )
    const [a, b] = card.arms as [Scorecard.Arm, Scorecard.Arm]
    assert.deepEqual(
      [a.matched, a.unmatched, a.cancelled, a.unscheduled, a.errored],
      [1, 2, 0, 0, 0],
    )
    assert.deepEqual(
      [b.matched, b.unmatched, b.cancelled, b.unscheduled, b.errored],
      [1, 0, 1, 1, 0],
    )
    assert.match(Scorecard.text(card), /, cancelled 1, unscheduled 1\n/)
    assert.match(Scorecard.html(card), /<th[^>]*>Unscheduled<\/th>/)
  }
})

const mixed = () => {
  const outcomes: Result.Attempt['outcome'][] = ['passed', 'failed', 'passed', 'passed', 'failed']
  return run(
    'r1',
    ['a', 'b'],
    ['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((task, at) =>
      [1, 2, 3].flatMap((index) => [
        row('a', task + '#' + index, { outcome: outcomes[(at * index) % 5]!, usd: 0.5 + at }),
        row('b', task + '#' + index, { outcome: outcomes[(at + index) % 5]!, usd: 1 + index }),
      ]),
    ),
  )
}

test('the same rows, seed and draws give the same scorecard', () => {
  const one = Scorecard.build([mixed()], options)
  const two = Scorecard.build([mixed()], options)
  assert.deepEqual(one, two)
  assert.equal(JSON.stringify(one), JSON.stringify(two))
  assert.equal(Scorecard.html(one), Scorecard.html(two))
  const cells = [
    [[{ passed: true, usd: 1 }], [{ passed: false, usd: 1 }], [{ passed: true, usd: 2 }]],
    [[{ passed: false, usd: 1 }], [{ passed: true, usd: 3 }], [{ passed: true, usd: 2 }]],
  ]
  assert.deepEqual(
    Scorecard.bootstrap(cells, { draws: 50, seed: 7 }),
    Scorecard.bootstrap(cells, { draws: 50, seed: 7 }),
  )
  assert.notDeepEqual(
    Scorecard.bootstrap(cells, { draws: 50, seed: 7 }),
    Scorecard.bootstrap(cells, { draws: 50, seed: 8 }),
  )
  assert.equal(Scorecard.mulberry32(1)(), Scorecard.mulberry32(1)())
  assert.notEqual(Scorecard.mulberry32(1)(), Scorecard.mulberry32(2)())
})

test('the interval leaves out the same share of draws at each end, by hand', () => {
  const upTo = (count: number) => Array.from({ length: count }, (_, at) => count - at)
  assert.deepEqual(Scorecard.interval(upTo(40)), { high: 39, low: 2 })
  assert.deepEqual(Scorecard.interval(upTo(2000)), { high: 1950, low: 51 })
  assert.deepEqual(Scorecard.interval([3]), { high: 3, low: 3 })
  assert.deepEqual(Scorecard.interval([...upTo(38), Infinity, NaN]), { high: null, low: 2 })
})

test('arms that pass every attempt at one cost have intervals of no width', () => {
  const card = Scorecard.build(
    [
      run(
        'r1',
        ['a', 'b'],
        ['t1#1', 't1#2', 't2#1', 't3#1'].flatMap((at) => [
          row('a', at, { usd: 0.5 }),
          row('b', at, { usd: 0.25 }),
        ]),
      ),
    ],
    options,
  )
  const a = arm(card, 'a')
  assert.deepEqual(a.passRate, { high: 1, low: 1, value: 1 })
  assert.deepEqual(a.usdPerPass, { high: 0.5, low: 0.5, value: 0.5 })
  assert.equal(a.usdPerAttempt, 0.5)
  assert.equal(a.modelCallsPerAttempt, 2)
  assert.equal(a.outputTokensPerAttempt, 100)
  assert.deepEqual(a.against, {
    passRateDifference: { high: 0, low: 0, value: 0 },
    usdPerPassRatio: { high: 2, low: 2, value: 2 },
  })
})

test('two tasks of one attempt draw a pass rate of 0, 1/2 or 1, by hand', () => {
  const rows = [
    row('a', 't1#1', { usd: 1 }),
    row('a', 't2#1', { outcome: 'failed', usd: 1 }),
    row('b', 't1#1', { usd: 1 }),
    row('b', 't2#1', { usd: 1 }),
  ]
  const card = Scorecard.build([run('r1', ['a', 'b'], rows)], { ...options, draws: 2000 })
  const a = arm(card, 'a')
  assert.deepEqual(a.passRate, { high: 1, low: 0, value: 0.5 })
  assert.deepEqual(a.against!.passRateDifference, { high: 0, low: -1, value: -0.5 })
  assert.deepEqual(a.usdPerPass, { high: null, low: 1, value: 2 })
  assert.deepEqual(arm(card, 'b').passRate, { high: 1, low: 1, value: 1 })
  const drawn = Scorecard.bootstrap([[[{ passed: true, usd: 1 }], [{ passed: false, usd: 1 }]]], {
    draws: 2000,
    seed: 1,
  }).map((draw) => draw[0]!)
  assert.ok(drawn.every((draw) => [0, 0.5, 1].includes(draw.passRate)))
  const share = (rate: number) => drawn.filter((draw) => draw.passRate === rate).length / 2000
  assert.ok(Math.abs(share(0.5) - 1 / 2) < 0.05, 'half of the draws hold both tasks')
  assert.ok(Math.abs(share(0) - 1 / 4) < 0.05, 'a quarter of the draws hold the failed task twice')
  assert.ok(drawn.every((draw) => (draw.passRate === 0) === (draw.usdPerPass === Infinity)))
})

test('an arm with a model call of no cost shows no cost, and a row of no call costs nothing', () => {
  const unpriced = row('a', 't1#1', { usd: 1 })
  const card = Scorecard.build(
    [
      run(
        'r1',
        ['a', 'b'],
        [
          { ...unpriced, usage: { ...unpriced.usage!, costUsd: undefined } },
          row('b', 't1#1', { usd: 1 }),
          row('a', 't2#1', { usd: 1 }),
          row('b', 't2#1'),
        ],
      ),
    ],
    options,
  )
  const a = arm(card, 'a')
  assert.deepEqual([a.uncosted, a.usdPerAttempt, a.usdPerPass], [1, null, null])
  assert.equal(a.against!.usdPerPassRatio, null)
  assert.deepEqual([arm(card, 'b').uncosted, arm(card, 'b').usdPerAttempt], [0, 0.5])
})

test('the rows of an excluded task are in no count', () => {
  const rows = ['t1#1', 't2#1', 't2#2'].flatMap((at) => [row('a', at), row('b', at)])
  const card = Scorecard.build([run('r1', ['a', 'b'], rows)], {
    ...options,
    exclude: { digest: 'abc', file: 'left-out.txt', names: ['t2', 'set/t9'] },
  })
  assert.deepEqual(card.matched, { attempts: 1, tasks: 1 })
  assert.equal(arm(card, 'a').excluded, 2)
  assert.deepEqual(card.excluded, {
    digest: 'abc',
    file: 'left-out.txt',
    tasks: [
      { name: 't2', rows: 4 },
      { name: 'set/t9', rows: 0 },
    ],
  })
  assert.match(Scorecard.html(card), /left-out\.txt \(sha256 <code>abc<\/code>\)/)
})

test('arms of several runs of one eval digest are compared, each under its run', () => {
  const one = run('r1', ['a'], [row('a', 't1#1'), row('a', 't2#1', { outcome: 'failed' })])
  const two = run('r2', ['a', 'b'], [row('a', 't1#1'), row('b', 't1#1'), row('b', 't2#1')])
  const card = Scorecard.build([one, two], options)
  assert.deepEqual(
    card.arms.map((found) => [found.label, found.run, found.matched, found.unmatched]),
    [
      ['a@r1', 'r1', 1, 1],
      ['a@r2', 'r2', 1, 0],
      ['b', 'r2', 1, 1],
    ],
  )
  assert.deepEqual(
    card.runs.map((found) => found.arms),
    [['a@r1'], ['a@r2', 'b']],
  )
  assert.match(Scorecard.html(card), /The arms come from 2 runs that share this eval digest/)
  assert.doesNotMatch(
    Scorecard.html(Scorecard.build([two], options)),
    /runs that share this eval digest/,
  )
  assert.throws(
    () => Scorecard.build([one, { ...two, eval: { name: 'toy', version: 'digest-2' } }], options),
    /a scorecard compares arms of one eval digest/,
  )
})

test('what a scorecard cannot be built from is an error', () => {
  const rows = [row('a', 't1#1'), row('b', 't1#1')]
  const build = (given: Partial<Scorecard.build.Options>, results = rows) =>
    Scorecard.build([run('r1', ['a', 'b'], results)], { ...options, ...given })
  assert.throws(() => build({ reference: 'c' }), /no arm is named c: the arms are a, b/)
  assert.throws(() => build({ draws: 0 }), /the draws are a whole number above zero/)
  assert.throws(() => build({ seed: 1.5 }), /the seed is a whole number/)
  assert.throws(() => build({}, [...rows, row('a', 't1#1')]), /two rows of arm a for set\/t1#1/)
  assert.throws(() => build({}, [...rows, row('c', 't1#1')]), /a row of arm c/)
  assert.throws(() => Scorecard.build([], options), /a scorecard needs a run/)
  assert.throws(
    () => Scorecard.build([run('r1', ['a', 'b'], rows), run('r1', ['a', 'b'], rows)], options),
    /run r1 is named twice/,
  )
  assert.ok(
    (() => {
      try {
        build({ reference: 'c' })
      } catch (error) {
        return error instanceof Scorecard.InvalidError
      }
      return false
    })(),
  )
})

test('the page is one file with no outside asset and holds the whole spec of an arm', () => {
  const results = [row('<a>', 't1#1', { usd: 1 }), row('b', 't1#1', { usd: 1 })]
  const given = run('r1', ['<a>', 'b'], results)
  const card = Scorecard.build(
    [
      {
        ...given,
        agents: [{ ...given.agents[0]!, briefFinish: true, cellYieldMs: 120000 }, given.agents[1]!],
      },
    ],
    { ...options, command: 'nanoeval scorecard --ref b', commit: 'abc123' },
  )
  const page = Scorecard.html(card)
  assert.match(page, /^<!doctype html>/)
  assert.doesNotMatch(page, /https?:|src=|href=|<script|url\(|@import/)
  assert.doesNotMatch(page, /<a>/)
  assert.match(page, /&lt;a&gt;/)
  assert.match(page, /briefFinish=true cellYieldMs=120000/)
  assert.match(page, /<td>claude<\/td><td>model<\/td><td>high<\/td>/)
  assert.match(page, /harness-1<\/td><td>hand-1/)
  assert.match(page, /<pre>nanoeval scorecard --ref b<\/pre>/)
  assert.match(page, /nanoeval commit <code>abc123<\/code>/)
  assert.match(page, /of 200 draws of a task-clustered bootstrap with seed 1/)
  assert.deepEqual(arm(card, '<a>').spec, {
    briefFinish: true,
    cellYieldMs: 120000,
    id: '<a>',
    model: 'model',
    provider: 'claude',
    thinking: 'high',
  })
})

test('the command reads the list of excluded tasks and writes both files', async () => {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'scorecard-'))
  try {
    const file = Path.join(directory, 'left out.txt')
    await Fs.writeFile(file, 't2\n\n  t3  \nt2\n')
    const exclude = await Command.exclusion(file)
    assert.deepEqual(exclude.names, ['t2', 't3'])
    assert.equal(
      exclude.digest,
      Crypto.createHash('sha256').update('t2\n\n  t3  \nt2\n').digest('hex'),
    )
    await assert.rejects(Command.exclusion(Path.join(directory, 'none.txt')), /cannot be read/)
    const out = Path.join(directory, 'out', 'card')
    const line = Command.command({
      draws: 2000,
      exclude: file,
      out,
      reference: 'b',
      runs: ['r1', 'r2'],
      seed: 1,
      url: 'http://127.0.0.1:8787',
    })
    assert.equal(
      line,
      "nanoeval scorecard --url http://127.0.0.1:8787 --run r1 --run r2 --ref b --exclude-tasks '" +
        file +
        "' --seed 1 --draws 2000 --out " +
        out,
    )
    const card = Scorecard.build(
      [run('r1', ['a', 'b'], [row('a', 't1#1'), row('b', 't1#1'), row('a', 't2#1')])],
      { ...options, command: line, exclude },
    )
    const files = await Command.write(card, out)
    assert.deepEqual(JSON.parse(await Fs.readFile(files.json, 'utf8')), card)
    assert.equal(await Fs.readFile(files.html, 'utf8'), Scorecard.html(card))
    assert.equal(Command.whole(undefined, 'draws'), 2000)
    assert.equal(Command.whole(undefined, 'seed'), 1)
    assert.equal(Command.whole('7', 'seed'), 7)
    assert.throws(() => Command.whole('1e3', 'draws'), /--draws is a whole number, not 1e3/)
  } finally {
    await Fs.rm(directory, { force: true, recursive: true })
  }
})
