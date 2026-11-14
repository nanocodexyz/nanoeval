import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Budget from '../src/Budget.ts'

const waitMs = 60_000

test('a model request is admitted while what is spent and what is in flight leave room', () => {
  const ask = (input: Partial<Budget.admit.Input>) =>
    Budget.admit({
      flights: 0,
      largestUsd: 0.01,
      limitUsd: 1,
      spentUsd: 0,
      waitMs,
      waitedMs: 0,
      ...input,
    })
  assert.deepEqual(ask({}), { state: 'admitted' })
  assert.deepEqual(ask({ spentUsd: 1 }), { reason: 'spent', state: 'refused' })
  assert.deepEqual(ask({ limitUsd: 0 }), { reason: 'spent', state: 'refused' })
  assert.deepEqual(ask({ spentUsd: 0.999999 }), { state: 'admitted' })
  assert.deepEqual(ask({ flights: 3, spentUsd: 0.96 }), { state: 'admitted' })
  assert.deepEqual(ask({ flights: 3, spentUsd: 0.97 }), { state: 'waiting' })
  assert.deepEqual(ask({ flights: 3, spentUsd: 0.97, waitedMs: waitMs }), {
    reason: 'held',
    state: 'refused',
  })
  assert.deepEqual(
    ask({ flights: 40, largestUsd: 0, spentUsd: 0.5 }),
    { state: 'admitted' },
    'responses that carry no cost reserve nothing',
  )
  assert.deepEqual(
    ask({ flights: 1, largestUsd: undefined }),
    { state: 'waiting' },
    'before a response has ended nothing says what one costs, so one request is in flight',
  )
  assert.deepEqual(ask({ flights: 1, largestUsd: undefined, waitedMs: waitMs }), {
    state: 'admitted',
  })
  assert.equal(Budget.held({ flights: 0, largestUsd: 5, limitUsd: 1, spentUsd: 0.99 }), false)
  assert.equal(Budget.held({ flights: 1, largestUsd: 0.01, limitUsd: 1, spentUsd: 0.99 }), true)
  assert.equal(
    Budget.held({ flights: 1, largestUsd: undefined, limitUsd: 1, spentUsd: 0.99 }),
    false,
  )
})

test('a request counts as in flight only for the object that admitted it and the claim it was admitted for', () => {
  const flight = { claim: 2, instance: 'first' }
  assert.equal(Budget.flying(flight, { claim: 2, instance: 'first' }), true)
  assert.equal(
    Budget.flying(flight, { claim: 2, instance: 'second' }),
    false,
    'an object that started again holds no request of the one before it',
  )
  assert.equal(Budget.flying(flight, { claim: 3, instance: 'first' }), false)
  assert.equal(Budget.flying(flight, { claim: undefined, instance: 'first' }), false)
})

type Flown = { cost: number; excess: number; rows: number; spent: number }

function run(input: {
  cost(request: number, row: number): number
  limitUsd: number
  ms(request: number): number
  rows: number
}): Flown {
  const pollMs = 250
  let spent = 0
  let largest: number | undefined
  let requests = 0
  let cost = 0
  let excess = 0
  let ended = 0
  const flights = new Map<number, number>()
  const events: { at: number; run(at: number): void }[] = []
  const later = (at: number, work: (at: number) => void) => events.push({ at, run: work })
  const ask = (row: number, asked: number, at: number): void => {
    const admission = Budget.admit({
      flights: flights.size,
      largestUsd: largest,
      limitUsd: input.limitUsd,
      spentUsd: spent,
      waitMs,
      waitedMs: at - asked,
    })
    if (admission.state === 'refused') {
      ended++
      return
    }
    if (admission.state === 'waiting') {
      later(at + pollMs, (now) => ask(row, asked, now))
      return
    }
    const id = requests++
    cost = input.cost(id, row)
    excess = [...flights.values()].reduce(
      (sum, other) => sum + Math.max(0, other - (largest ?? 0)),
      0,
    )
    flights.set(id, cost)
    const own = cost
    later(at + input.ms(id), (now) => {
      flights.delete(id)
      spent += own
      largest = Math.max(largest ?? 0, own)
      later(now + 1, (next) => ask(row, next, next))
    })
  }
  for (let row = 0; row < input.rows; row++) later(0, (at) => ask(row, at, at))
  while (events.length) {
    events.sort((left, right) => left.at - right.at)
    const next = events.shift()!
    next.run(next.at)
  }
  assert.equal(ended, input.rows, 'every row ends with a refused request')
  return { cost, excess, rows: input.rows, spent }
}

test('a run passes its model budget by less than one request, however many rows ask at once', () => {
  for (const rows of [1, 2, 12, 64, 500]) {
    const flat = run({ cost: () => 0.004, limitUsd: 0.1, ms: (id) => 300 + (id % 7) * 900, rows })
    assert.ok(flat.spent >= 0.1 && flat.spent < 0.1 + 0.004 + 1e-9, rows + ': ' + flat.spent)

    const tiny = run({ cost: () => 0.004, limitUsd: 0.003, ms: () => 2_000, rows })
    assert.ok(Math.abs(tiny.spent - 0.004) < 1e-9, 'one request alone learns the first cost')

    const mixed = run({
      cost: (id) => (id === 0 ? 0.02 : 0.001 + (id % 5) * 0.004),
      limitUsd: 0.5,
      ms: (id) => 200 + (id % 11) * 700,
      rows,
    })
    assert.ok(mixed.spent >= 0.5 && mixed.spent < 0.5 + 0.02 + 1e-9, rows + ': ' + mixed.spent)
  }
})

test('requests that cost more than any before them pass the budget by what they cost more', () => {
  for (const rows of [2, 12, 64]) {
    const growing = run({
      cost: (id) => 0.001 * (1 + Math.floor(id / rows)),
      limitUsd: 0.2,
      ms: () => 1_000,
      rows,
    })
    assert.ok(growing.spent >= 0.2)
    assert.ok(
      growing.spent < 0.2 + growing.cost + growing.excess + 1e-9,
      rows + ': ' + JSON.stringify(growing),
    )
  }
  const slow = run({ cost: () => 0.004, limitUsd: 0.003, ms: () => waitMs + 5_000, rows: 12 })
  assert.ok(
    Math.abs(slow.spent - 12 * 0.004) < 1e-9,
    'a first response slower than the wait lets the first request of each row go',
  )
})
