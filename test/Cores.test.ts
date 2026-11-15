import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Cores from '../sandbox/Cores.ts'

const threads = [4, 5, 6, 7]

test('count is the declared CPUs of a task as whole threads, at most what the runner has', () => {
  assert.equal(Cores.count(1, 4), 1)
  assert.equal(Cores.count(0.5, 4), 1)
  assert.equal(Cores.count(2.5, 4), 3)
  assert.equal(Cores.count(64, 4), 4)
})

test('grant gives a verifier threads that no other verifier holds', () => {
  const first = Cores.grant({ count: 1, held: [], others: 0, threads })
  assert.deepEqual(first, [4])
  const second = Cores.grant({ count: 2, held: [first!], others: 0, threads })
  assert.deepEqual(second, [5, 6])
  assert.deepEqual(Cores.free(threads, [first!, second!]), [7])
  assert.equal(Cores.grant({ count: 2, held: [first!, second!], others: 0, threads }), undefined)
  assert.deepEqual(Cores.grant({ count: 2, held: [second!], others: 0, threads }), [4, 7])
})

test('grant leaves the rows that hold no threads what their declared vCPUs need', () => {
  assert.deepEqual(Cores.grant({ count: 1, held: [], others: 3, threads }), [4])
  assert.equal(Cores.grant({ count: 2, held: [], others: 3, threads }), undefined)
  assert.equal(Cores.grant({ count: 1, held: [[4]], others: 3, threads }), undefined)
  assert.deepEqual(Cores.grant({ count: 4, held: [], others: 0, threads }), threads)
})

test('rows in flight at one declared vCPU a thread never make a verifier wait', () => {
  const rows = [1, 1, 2]
  for (let verifying = 0; verifying < rows.length; verifying++) {
    const held: number[][] = []
    for (let index = 0; index <= verifying; index++) {
      const others = Cores.needed(rows.slice(verifying + 1), 1)
      const granted = Cores.grant({ count: rows[index]!, held, others, threads })
      assert.ok(granted, 'row ' + index + ' of ' + (verifying + 1) + ' verifiers')
      held.push(granted)
    }
    assert.equal(new Set(held.flat()).size, held.flat().length, 'no thread is held twice')
  }
})

test('needed is the threads that declared vCPUs take at the bound of the runner', () => {
  assert.equal(Cores.needed([], 1), 0)
  assert.equal(Cores.needed([1, 1, 2], 1), 4)
  assert.equal(Cores.needed([1, 1, 1], 2), 2)
  assert.equal(Cores.needed([1], 0.5), 2)
})

test('above one vCPU a thread a verifier waits until the others fit beside it', () => {
  const seven = Cores.needed([1, 1, 1, 1, 1, 1, 1], 2)
  const six = Cores.needed([1, 1, 1, 1, 1, 1], 2)
  assert.equal(Cores.grant({ count: 1, held: [], others: seven, threads }), undefined)
  assert.deepEqual(Cores.grant({ count: 1, held: [], others: six, threads }), [4])
})

test('weight counts a verifier for the vCPUs its whole threads stand for', () => {
  assert.equal(Cores.weight({ count: 1, declared: 1, perThread: 1 }), 1)
  assert.equal(Cores.weight({ count: 1, declared: 1, perThread: 2 }), 2)
  assert.equal(Cores.weight({ count: 4, declared: 8, perThread: 1 }), 8)
  assert.equal(Cores.weight({ count: 1, declared: 1, perThread: 0.5 }), 1)
})

test('refusal names what a runner that reserves threads cannot have', () => {
  const own = [4, 5, 6, 7]
  assert.equal(Cores.refusal({ own, peers: [], perThread: 1, reserves: true }), undefined)
  assert.equal(Cores.refusal({ own, peers: [], perThread: null, reserves: false }), undefined)
  assert.match(Cores.refusal({ own, peers: [], perThread: null, reserves: true })!, /--slots-only/)
  assert.match(
    Cores.refusal({ own: undefined, peers: [], perThread: 1, reserves: true })!,
    /does not say which ones/,
  )
})

test('refusal surfaces another runner on the same threads, from either side', () => {
  const own = [4, 5, 6, 7]
  const beside = { slots: 2, threads: [0, 1, 2, 3] }
  const over = { slots: 2, threads: [7, 8] }
  const floating = { slots: 2 }
  const reserving = { verifyCores: true as const }
  assert.equal(Cores.refusal({ own, peers: [beside], perThread: 1, reserves: true }), undefined)
  assert.match(
    Cores.refusal({ own, peers: [beside, over], perThread: 1, reserves: true })!,
    /1 other runner of this machine/,
  )
  assert.match(
    Cores.refusal({ own, peers: [over, floating], perThread: 1, reserves: true })!,
    /2 other runners of this machine/,
  )
  assert.equal(Cores.refusal({ own, peers: [over], perThread: 1, reserves: false }), undefined)
  assert.match(
    Cores.refusal({ own, peers: [{ ...over, ...reserving }], perThread: 1, reserves: false })!,
    /another runner of this machine reserves/,
  )
  assert.equal(
    Cores.refusal({ own, peers: [{ ...beside, ...reserving }], perThread: 1, reserves: false }),
    undefined,
  )
})
