import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Budget from '../src/Budget.ts'
import * as Gateway from '../src/Gateway.ts'
import * as Opening from '../src/Opening.ts'

const limits = { leaseSec: 60, setupSec: 1200 }
const cap =
  'Gateway.RefusedError: the gateway refused create with 429: you have reached the maximum number of concurrent sandboxes'

test('a create the provider refuses for now passes, another refusal does not', () => {
  for (const status of [402, 408, 429, 500, 502, 503])
    assert.equal(Opening.passing(new Gateway.RefusedError(status, 'refused')), true, String(status))
  for (const status of [400, 401, 403, 404, 409, 422])
    assert.equal(
      Opening.passing(new Gateway.RefusedError(status, 'refused')),
      false,
      String(status),
    )
  assert.equal(Opening.passing(new Gateway.UnpricedError(429, 'no price')), true)
  assert.equal(Opening.passing(new Gateway.UnpricedError(400, 'no price')), false)
  assert.equal(Opening.passing(new Budget.ExceededError('spent')), false)
  assert.equal(
    Opening.passing(new Gateway.RequestError('unanswered, may have been charged')),
    false,
  )
  assert.equal(Opening.passing(new Error('the runner did not start')), false)
})

test('the pause before the next create doubles from the notice up to the setup limit', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((pauses) => Opening.pauseMs(pauses, limits) / 1000),
    [0, 60, 120, 240, 480, 960, 1200, 1200],
  )
})

test('refusals for a cap never stop a run that has sandboxes, and are asked again with a growing pause', () => {
  let state: Opening.Failed | undefined
  const asked: number[] = []
  let now = 128_000
  for (; now <= 3_600_000; now += 2000) {
    state = Opening.seen(state, { now, stranded: false })
    const action = Opening.next(state, { limits, now })
    assert.notEqual(action, 'end')
    if (action !== 'open') continue
    asked.push(now / 1000)
    state = Opening.failed(state, { at: now, message: cap, passing: true })
  }
  assert.deepEqual(asked, [128, 130, 190, 310, 550, 1030, 1990, 3190])
  assert.equal(state!.strikes, 0)
  assert.equal(state!.failures, 8)
  const view = Opening.view(state!, { limits, now })
  assert.deepEqual(
    [view.closed, view.endsAt, view.failures, view.since, view.nextAt],
    [false, null, 8, 128_000, 3_190_000 + 1_200_000],
  )
})

test('a run left with no sandbox asks at once, and ends its rows after the setup limit alone', () => {
  let state: Opening.Failed | undefined
  for (const at of [128_000, 130_000, 190_000, 310_000, 550_000, 1_030_000, 1_990_000, 3_190_000])
    state = Opening.failed(state, { at, message: cap, passing: true })
  const asked: number[] = []
  let ended: number | undefined
  for (let now = 3_660_000; ended === undefined; now += 2000) {
    state = Opening.seen(state, { now, stranded: true })
    const action = Opening.next(state, { limits, now })
    if (action === 'end') ended = now
    if (action !== 'open') continue
    asked.push((now - 3_660_000) / 1000)
    state = Opening.failed(state, { at: now, message: cap, passing: true })
  }
  assert.deepEqual(asked, [0, 60, 180, 420, 900])
  assert.equal(ended, 3_660_000 + 1_202_000)
  assert.equal(Opening.endsAt(state!, limits), 3_660_000 + 1_200_000)
  assert.match(
    Opening.ended(state!, { limits, now: ended }),
    /^no sandbox could be opened for 1200 s with no other left to take the row, in 13 tries, the last of which ended with: Gateway.RefusedError: .* 429/,
  )
})

test('a pause that the provider names is kept when it is the longer one', () => {
  const named = new Gateway.RefusedError(429, 'refused', 300)
  assert.equal(Opening.retryAfterSec(named), 300)
  assert.equal(Opening.retryAfterSec(new Gateway.UnpricedError(429, 'no price', 45)), 45)
  assert.equal(Opening.retryAfterSec(new Error('the runner did not start')), undefined)
  let state = Opening.failed(undefined, {
    at: 1000,
    message: cap,
    passing: true,
    retryAfterSec: 300,
  })
  assert.equal(Opening.next(state, { limits, now: 300_000 }), 'wait')
  assert.equal(Opening.next(state, { limits, now: 301_000 }), 'open')
  state = Opening.failed(state, { at: 301_000, message: cap, passing: true, retryAfterSec: 5 })
  assert.equal(
    Opening.nextAt(state, limits),
    361_000,
    'the pause of the run is the longer one here',
  )
  state = Opening.failed(state, { at: 361_000, message: cap, passing: true })
  assert.equal(state.retryAt, undefined)
})

test('a sandbox that serves again forgets that the run was alone, not the pauses', () => {
  let state = Opening.failed(undefined, { at: 1000, message: cap, passing: true })
  state = Opening.seen(state, { now: 2000, stranded: true })!
  assert.equal(state.alone, 2000)
  state = Opening.failed(state, { at: 2000, message: cap, passing: true })
  state = Opening.seen(state, { now: 4000, stranded: false })!
  assert.equal(state.alone, undefined)
  assert.equal(state.pauses, 2)
  assert.equal(Opening.next(state, { limits, now: 4000 }), 'wait')
  assert.equal(Opening.next(state, { limits, now: 62_000 }), 'open')
  assert.equal(Opening.seen(undefined, { now: 1, stranded: true }), undefined)
})

test('two failures in a row that do not pass close the opening, for the setup limit', () => {
  const broken = 'Sandbox.CommandError: the sandbox command exited with 1'
  let state = Opening.failed(undefined, { at: 1000, message: broken, passing: false })
  assert.equal(
    Opening.next(Opening.seen(state, { now: 1500, stranded: true }), { limits, now: 1500 }),
    'open',
  )
  state = Opening.failed(Opening.seen(state, { now: 1500, stranded: true }), {
    at: 2000,
    message: broken,
    passing: false,
  })
  assert.equal(state.strikes, 2)
  assert.equal(Opening.next(state, { limits, now: 2500 }), 'end')
  assert.equal(Opening.ended(state, { limits, now: 2500 }), broken)
  const serving = Opening.seen(state, { now: 2500, stranded: false })!
  assert.equal(Opening.next(serving, { limits, now: 2500 }), 'wait')
  assert.equal(Opening.view(serving, { limits, now: 2500 }).closed, true)
  assert.equal(Opening.next(serving, { limits, now: 1_202_000 }), 'wait')
  assert.equal(
    Opening.next(serving, { limits, now: 1_203_000 }),
    'open',
    'an hour later the failures say nothing of the provider any more',
  )
  const later = Opening.seen(serving, { now: 3_600_000, stranded: true })!
  assert.equal(Opening.next(later, { limits, now: 3_600_000 }), 'open')
  const passed = Opening.failed(state, { at: 3000, message: cap, passing: true })
  assert.equal(passed.strikes, 0, 'a refusal that passes is no failure in a row')
})
