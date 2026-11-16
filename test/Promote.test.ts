import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as Compare from '../src/Compare.ts'
import * as Promote from '../src/Promote.ts'
import type * as Result from '../src/Result.ts'

type Given = { cancelled?: true; passed?: boolean; usd?: number }

const row = (arm: string, at: string, given: Given = {}): Result.Attempt => {
  const [task, index] = at.split('#')
  const outcome = given.cancelled ? 'errored' : given.passed === false ? 'failed' : 'passed'
  return {
    agent: { id: arm, model: 'model', provider: 'claude' },
    ...(given.cancelled
      ? { failure: { at: 0, kind: 'cancelled', message: 'the run was cancelled' } }
      : {}),
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
    usage: {
      cacheWriteTokens: 0,
      cachedTokens: 0,
      costUsd: given.usd ?? 1,
      inputTokens: 0,
      modelCalls: 2,
      outputTokens: 100,
      toolCalls: 0,
    },
  }
}

const grid = (arm: string, tasks: number, repeats: number, given: (task: number) => Given) =>
  Array.from({ length: tasks }, (_, task) =>
    Array.from({ length: repeats }, (_, at) => row(arm, 't' + task + '#' + (at + 1), given(task))),
  ).flat()

const run = (id: string, attempts: readonly Result.Attempt[]): Compare.Run => ({
  attempts,
  eval: { name: 'toy', version: 'digest-1' },
  id,
  name: 'toy run',
  state: 'finished',
})

const options = { baseline: 'base', draws: 200, seed: 1 }

const verdicts = (cells: readonly Promote.Cell[]) =>
  Object.fromEntries(
    cells.map((cell) => [cell.id, 'why' in cell ? cell.verdict + ' ' + cell.why : cell.verdict]),
  )

test('a candidate is scored against the baseline of its own run', () => {
  const cells = Promote.cells(
    [
      run('r1', [
        ...grid('base', 6, 3, (task) => ({ passed: task < 3 })),
        ...grid('better', 6, 3, () => ({})),
        ...grid('worse', 6, 3, () => ({ passed: false })),
        ...grid('cheaper', 6, 3, (task) => ({ passed: task < 3, usd: 0.5 })),
        ...grid('same', 6, 3, (task) => ({ passed: task < 3 })),
      ]),
    ],
    options,
  )
  assert.deepEqual(verdicts(cells), {
    better: 'win',
    cheaper: 'tie',
    same: 'none',
    worse: 'loss',
  })
  const better = cells.find((cell) => cell.id === 'better') as Promote.Scored
  assert.equal(better.passRate, 1)
  assert.equal(better.baseline.passRate, 0.5)
  assert.equal(better.lead.value, 0.5)
  assert.equal(better.usdPerPass, 1)
  assert.equal(better.baseline.usdPerPass, 2)
  assert.equal(better.tasks, 6)
  assert.equal(better.repeats, 3)
  const cheaper = cells.find((cell) => cell.id === 'cheaper') as Promote.Scored
  assert.equal(cheaper.ratio?.value, 0.5)
  assert.equal(cheaper.ratio?.high, 0.5)
})

test('an arm of another run, fewer than three attempts or an unmatched row is missing', () => {
  const cells = Promote.cells(
    [
      run('r1', [
        ...grid('base', 4, 3, () => ({ passed: false })),
        ...grid('unmatched', 4, 3, (task) => (task === 0 ? { cancelled: true } : {})),
      ]),
      run('r2', grid('elsewhere', 4, 3, () => ({}))),
      run('r3', [...grid('base', 4, 1, () => ({ passed: false })), ...grid('once', 4, 1, () => ({}))]),
    ],
    options,
  )
  assert.deepEqual(verdicts(cells), {
    elsewhere: 'missing run',
    once: 'missing repeats',
    unmatched: 'missing unmatched',
  })
  const unmatched = cells.find((cell) => cell.id === 'unmatched') as Promote.Scored
  assert.deepEqual(unmatched.unmatched, { baseline: 3, run: 0 })
})

test('a run without the baseline arm and a run named twice are refused', () => {
  const only = run('r1', grid('other', 2, 3, () => ({})))
  assert.throws(() => Promote.cells([only], options), Promote.InvalidError)
  const both = run('r1', [...grid('base', 2, 3, () => ({})), ...grid('other', 2, 3, () => ({}))])
  assert.throws(() => Promote.cells([both, both], options), Promote.InvalidError)
})

test('stage A keeps the front first, then the best ranked, up to the survivors', () => {
  const cells = Promote.cells(
    [
      run('r1', [
        ...grid('base', 4, 1, (task) => ({ passed: task < 2 })),
        ...grid('high', 4, 1, (task) => ({ passed: task < 4, usd: 3 })),
        ...grid('cheap', 4, 1, (task) => ({ passed: task < 2, usd: 0.25 })),
        ...grid('middle', 4, 1, (task) => ({ passed: task < 3, usd: 2 })),
        ...grid('dear', 4, 1, (task) => ({ passed: task < 2, usd: 4 })),
      ]),
      run('r2', grid('elsewhere', 4, 1, () => ({}))),
    ],
    options,
  )
  const ids = (found: readonly Promote.Measured[]) => found.map((one) => one.id)
  const two = Promote.select(cells, { stage: 'A', survivors: 2 })
  assert.deepEqual(ids(two.ranked), ['high', 'middle', 'cheap', 'dear'])
  assert.deepEqual(ids(two.front), ['high', 'middle', 'cheap'])
  assert.deepEqual(ids(two.survivors), ['high', 'middle'])
  const four = Promote.select(cells, { stage: 'A', survivors: 4 })
  assert.deepEqual(ids(four.survivors), ['high', 'middle', 'cheap', 'dear'])
  assert.throws(() => Promote.select(cells, { stage: 'A', survivors: 0 }), Promote.InvalidError)
})

test('stage B promotes a win or a cheaper tie', () => {
  const cells = Promote.cells(
    [
      run('r1', [
        ...grid('base', 6, 3, (task) => ({ passed: task < 3 })),
        ...grid('better', 6, 3, () => ({})),
        ...grid('worse', 6, 3, () => ({ passed: false })),
        ...grid('cheaper', 6, 3, (task) => ({ passed: task < 3, usd: 0.5 })),
        ...grid('same', 6, 3, (task) => ({ passed: task < 3 })),
        ...grid('once', 6, 1, () => ({})),
      ]),
    ],
    options,
  )
  const promoted = Promote.select(cells, { stage: 'B' })
  assert.deepEqual(
    promoted.survivors.map((one) => one.id),
    ['better', 'cheaper'],
  )
  assert.match(Promote.text(cells), /^arm +run +verdict/)
  assert.match(Promote.text(cells), /better +r1 +win/)
})
