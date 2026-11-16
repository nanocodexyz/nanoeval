import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Overlay from '../src/Overlay.ts'
import * as Search from '../src/Search.ts'

const space = Search.parseSpace({
  dimensions: [
    { dim: 'subagents', name: 'subagents', values: [null, { subagents: false }] },
    { dim: 'finish', harnesses: ['claude'], name: 'brief', values: [null, { briefFinish: true }] },
    {
      dim: 'context',
      harnesses: ['claude'],
      name: 'clearing',
      values: [null, { toolResultClearing: { atLeastTokens: 20000, keep: 3 } }],
    },
    { dim: 'retries', name: 'retries', values: [null, { finishRetries: 1 }, { finishRetries: 2 }] },
    { dim: 'prompt', name: 'prompt', pending: true, values: [null, { promptStyle: 'terse' }] },
  ],
  format: 'nanoeval-space/1',
  harnesses: ['claude', 'claude-direct'],
  model: 'claude-opus-5-5',
  slug: 'opus55',
  thinking: ['medium', 'high'],
})

const baseline: Overlay.Overlay = {
  dims: [],
  evidence: [],
  format: 'nanoeval-overlay/1',
  harness: 'claude',
  hypothesis: 'baseline',
  id: 'opus55-g0-00',
  levers: { subagents: false },
  model: 'claude-opus-5-5',
  parent: null,
  pending: {},
  thinking: 'high',
}

test('a generation is the same for the same seed and differs for another', () => {
  const input = { gen: 1, n: 8, parents: [baseline], seed: 's1' }
  assert.deepEqual(Search.generate(space, input), Search.generate(space, input))
  assert.notDeepEqual(
    Search.generate(space, input).candidates.map((overlay) => Search.key(overlay)),
    Search.generate(space, { ...input, seed: 's2' }).candidates.map((overlay) =>
      Search.key(overlay),
    ),
  )
})

test('candidates are named by generation, distinct, and none repeats a parent or a seen overlay', () => {
  const first = Search.generate(space, { gen: 1, n: 6, parents: [baseline], seed: 's' })
  assert.deepEqual(
    first.candidates.map((overlay) => overlay.id),
    [
      'opus55-g1-01',
      'opus55-g1-02',
      'opus55-g1-03',
      'opus55-g1-04',
      'opus55-g1-05',
      'opus55-g1-06',
    ],
  )
  const keys = first.candidates.map((overlay) => Search.key(overlay))
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(!keys.includes(Search.key(baseline)))
  const second = Search.generate(space, {
    gen: 2,
    n: 50,
    parents: [baseline],
    seed: 's',
    seen: first.candidates,
  })
  for (const overlay of second.candidates) assert.ok(!keys.includes(Search.key(overlay)))
  assert.equal(second.candidates.length + first.candidates.length, first.pool)
})

test('every candidate reads as an overlay and keeps claude-only levers off other harnesses', () => {
  const { candidates } = Search.generate(space, { gen: 1, n: 50, parents: [baseline], seed: 'x' })
  for (const overlay of candidates) {
    assert.deepEqual(Overlay.parse(JSON.parse(JSON.stringify(overlay))), overlay)
    assert.equal(overlay.model, 'claude-opus-5-5')
    assert.equal(overlay.parent, baseline.id)
    if (Search.runnable(overlay)) assert.equal(Overlay.compile(overlay).id, overlay.id)
    else assert.throws(() => Overlay.compile(overlay), Overlay.PendingError)
    if (overlay.harness !== 'claude') {
      assert.equal(overlay.levers.briefFinish, undefined)
      assert.equal(overlay.levers.toolResultClearing, undefined)
    }
  }
  assert.ok(candidates.some((overlay) => overlay.pending['promptStyle'] === 'terse'))
  assert.ok(candidates.some((overlay) => overlay.harness === 'claude-direct'))
  assert.ok(candidates.some((overlay) => overlay.thinking === 'medium'))
})

test('a candidate the agent config refuses is reported, not written', () => {
  const codex = Search.parseSpace({
    dimensions: [{ dim: 'finish', name: 'brief', values: [null, { briefFinish: true }] }],
    format: 'nanoeval-space/1',
    harnesses: ['codex'],
    model: 'gpt-6-luna',
    slug: 'luna',
    thinking: ['high'],
  })
  const generated = Search.generate(codex, {
    gen: 1,
    n: 4,
    parents: [{ ...baseline, harness: 'codex', id: 'luna-g0-00', levers: {}, model: 'gpt-6-luna' }],
    seed: 's',
  })
  assert.deepEqual(generated.candidates, [])
  assert.equal(generated.refused.length, 1)
})

test('crossover mixes the settings of two parents', () => {
  const other: Overlay.Overlay = {
    ...baseline,
    id: 'opus55-g0-01',
    levers: { briefFinish: true, finishRetries: 2 },
    thinking: 'medium',
  }
  const { candidates } = Search.generate(space, {
    gen: 1,
    n: 200,
    parents: [baseline, other],
    seed: 'c',
  })
  const crossed = candidates.filter((overlay) => overlay.hypothesis.startsWith('crossover of'))
  assert.ok(crossed.length)
  for (const overlay of crossed) assert.ok(overlay.dims.length)
})

test('a parent setting a lever the space does not cover is refused', () => {
  assert.throws(
    () =>
      Search.generate(space, {
        gen: 1,
        n: 2,
        parents: [{ ...baseline, levers: { leanCells: true } }],
        seed: 's',
      }),
    (error: unknown) => error instanceof Search.InvalidError && /leanCells/.test(error.message),
  )
})

test('a plan runs the baseline first and leaves out pending and foreign overlays', () => {
  const pending = { ...baseline, id: 'opus55-g1-01', pending: { promptStyle: 'terse' } }
  const runnable = { ...baseline, id: 'opus55-g1-02', thinking: 'medium' }
  assert.deepEqual(
    Search.members([runnable, pending, baseline], baseline).map((overlay) => overlay.id),
    ['opus55-g0-00', 'opus55-g1-02'],
  )
  assert.throws(
    () => Search.members([{ ...runnable, model: 'gpt-6-luna' }], baseline),
    Search.InvalidError,
  )
  assert.throws(() => Search.members([runnable], pending), /pending levers/)
})

test('a space refuses two dimensions that set one lever, and levers on the wrong side of pending', () => {
  const shape = (dimensions: unknown[]) => ({
    dimensions,
    format: 'nanoeval-space/1',
    harnesses: ['claude'],
    model: 'm',
    slug: 'm',
    thinking: ['high'],
  })
  assert.throws(
    () =>
      Search.parseSpace(
        shape([
          { dim: 'retries', name: 'a', values: [null, { finishRetries: 1 }] },
          { dim: 'retries', name: 'b', values: [null, { finishRetries: 2 }] },
        ]),
      ),
    /finishRetries is set by both a and b/,
  )
  assert.throws(
    () =>
      Search.parseSpace(
        shape([{ dim: 'prompt', name: 'p', values: [null, { promptStyle: 'x' }] }]),
      ),
    /mark the dimension pending/,
  )
  assert.throws(
    () =>
      Search.parseSpace(
        shape([{ dim: 'retries', name: 'r', pending: true, values: [null, { finishRetries: 1 }] }]),
      ),
    /a lever the Worker takes/,
  )
})
