import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Payment from '../src/Payment.ts'
import * as Retry from '../src/Retry.ts'

test('a failure of the machine or of the way to the model is retried, a verdict or a budget never', () => {
  const disk =
    'claude-code exited with 1: nanoeval-krun: output was not written: No space left on device (os error 28)'
  assert.equal(
    Retry.infrastructure({ failure: { kind: 'agent', message: disk }, statuses: [] }),
    'the slot ran out of disk',
  )
  assert.equal(
    Retry.infrastructure({
      failure: {
        kind: 'environment',
        message: 'Converter.ConvertError: the converter failed at unpack: No space left on device',
      },
      statuses: [],
    }),
    'the slot ran out of disk',
  )
  const relay =
    'codex-cli exited with 1: unexpected status 530 <unknown status code>: error code: 530, url: https://worker.example/v1/runs/r/model/a00001'
  assert.equal(
    Retry.infrastructure({ failure: { kind: 'agent', message: relay }, statuses: [] }),
    'the model endpoint was not reached',
  )
  assert.equal(
    Retry.infrastructure({
      failure: { kind: 'agent', message: 'the turn failed' },
      statuses: [200, 530],
    }),
    'the model endpoint was not reached',
  )
  assert.equal(
    Retry.infrastructure({
      failure: { kind: 'agent', message: 'the turn failed' },
      statuses: [200, 500],
    }),
    undefined,
  )
  assert.equal(
    Retry.infrastructure({
      failure: { kind: 'verifier', message: 'exited with 1' },
      statuses: [530],
    }),
    undefined,
  )
  for (const kind of ['budget', 'agent_timeout', 'cancelled'] as const)
    assert.equal(
      Retry.infrastructure({ failure: { kind, message: disk }, statuses: [530] }),
      undefined,
    )
})

test('a refused payment waits longer each time, within the notice of a lease and the wait of the run', () => {
  const input = {
    leaseSec: 60,
    now: 1_000_000,
    pollMs: 250,
    refusedAt: 1_000_000,
    stepRetries: 3,
    waitSec: 600,
  }
  assert.equal(Payment.pause({ ...input, kind: 'passing', tries: 0 }), 250)
  assert.equal(Payment.pause({ ...input, kind: 'passing', tries: 2 }), 1000)
  assert.equal(Payment.pause({ ...input, kind: 'passing', tries: 3 }), undefined)
  assert.equal(Payment.pause({ ...input, kind: 'spent', tries: 0 }), 250)
  assert.equal(Payment.pause({ ...input, kind: 'spent', tries: 4 }), 4000)
  assert.equal(Payment.pause({ ...input, kind: 'spent', tries: 20 }), 60_000)
  assert.equal(Payment.pause({ ...input, kind: 'spent', now: 1_590_000, tries: 20 }), 10_000)
  assert.equal(Payment.pause({ ...input, kind: 'spent', now: 1_600_000, tries: 0 }), undefined)
})

test('an agent that never started counts as an error of its slot and is retried', () => {
  const timeout = {
    at: 5,
    kind: 'agent_timeout' as const,
    message: 'the agent did not finish within 1800 s',
  }
  const stall = Retry.stalled({ failure: timeout, oomKills: 2, statuses: [] })
  assert.deepEqual(stall, {
    at: 5,
    kind: 'environment',
    message:
      'the agent never reached its model and its slot had 2 OOM kills: the agent did not finish within 1800 s',
  })
  assert.equal(Retry.infrastructure({ failure: stall!, statuses: [] }), 'the agent never started')
  assert.equal(Retry.stalled({ failure: timeout, oomKills: 2, statuses: [200] }), undefined)
  assert.equal(Retry.stalled({ failure: timeout, statuses: [] }), undefined)
  assert.equal(
    Retry.stalled({ failure: { ...timeout, kind: 'agent' }, oomKills: 2, statuses: [] }),
    undefined,
  )
  assert.equal(
    Retry.infrastructure({
      failure: {
        kind: 'environment',
        message: Retry.queued + ': it was still queued after 1800 s, with no hand attached',
      },
      statuses: [],
    }),
    'the agent never started',
  )
})

test('an attempt whose every model request the relay failed is an error of the way to the model and is retried', () => {
  const timeout = {
    at: 5,
    kind: 'agent_timeout' as const,
    message: 'the agent did not finish within 900 s',
  }
  const relay = Retry.unanswered({ at: 9, failure: timeout, statuses: [530, 530, 502] })
  assert.deepEqual(relay, {
    at: 5,
    kind: 'environment',
    message:
      'the model endpoint never answered the agent: its 3 model requests were answered 530, 502: the agent did not finish within 900 s',
  })
  assert.equal(
    Retry.infrastructure({ failure: relay!, statuses: [530, 530, 502] }),
    'the model endpoint was not reached',
  )
  assert.deepEqual(Retry.unanswered({ at: 9, statuses: [530] }), {
    at: 9,
    kind: 'environment',
    message: 'the model endpoint never answered the agent: its 1 model requests were answered 530',
  })
  assert.equal(Retry.unanswered({ at: 9, failure: timeout, statuses: [530, 200] }), undefined)
  assert.equal(Retry.unanswered({ at: 9, failure: timeout, statuses: [530, 500] }), undefined)
  assert.equal(Retry.unanswered({ at: 9, failure: timeout, statuses: [] }), undefined)
  for (const kind of ['budget', 'cancelled'] as const)
    assert.equal(
      Retry.unanswered({ at: 9, failure: { ...timeout, kind }, statuses: [530] }),
      undefined,
    )
  assert.equal(
    Retry.infrastructure({
      failure: {
        kind: 'agent',
        message: 'codex-cli exited with 1: unexpected status 530: error code: 1016',
      },
      statuses: [],
    }),
    'the model endpoint was not reached',
  )
})

test('a session that is answered nothing but refusals is ended when the wait of the run is over', () => {
  const spent = { at: 1_000, message: 'The wallet holds 0 of the 3 its channel needs now.' }
  const held = [
    { at: 1_000, refusal: 'spent' as const, status: 402 },
    { at: 9_000, refusal: 'spent' as const, status: 402 },
  ]
  assert.equal(Retry.refused({ now: 15_999, requests: held, spent, waitSec: 15 }), undefined)
  assert.deepEqual(Retry.refused({ now: 16_000, requests: held, spent, waitSec: 15 }), {
    at: 16_000,
    kind: 'budget',
    message:
      'the run ended the turn: its model request was answered 402 after the payment was refused for 15 s: The wallet holds 0 of the 3 its channel needs now.',
  })
  assert.ok(
    Retry.refused({ now: 16_000, requests: held, spent, waitSec: 15 })!.message.startsWith(
      Retry.refusedPrefix,
    ),
  )
  const late = [
    { at: 500, status: 200 },
    { at: 15_500, refusal: 'spent' as const, status: 402 },
  ]
  assert.equal(
    Retry.refused({ now: 16_000, requests: late, spent, waitSec: 15 })?.kind,
    'budget',
    'a row first refused late in the wait of the run ends with it',
  )
  assert.equal(
    Retry.refused({ now: 16_000, requests: held, waitSec: 15 }),
    undefined,
    'a refusal that a paid request of another row ended is not final',
  )
  assert.equal(
    Retry.refused({
      now: 16_000,
      requests: [...held, { at: 15_900, status: 200 }],
      spent,
      waitSec: 15,
    }),
    undefined,
  )
  assert.equal(Retry.refused({ now: 16_000, requests: [], spent, waitSec: 15 }), undefined)

  const passing = (at: number) => ({ at, refusal: 'passing' as const, status: 402 })
  assert.equal(
    Retry.refused({ now: 99_000, requests: [passing(1_000), passing(15_999)], waitSec: 15 }),
    undefined,
  )
  assert.deepEqual(
    Retry.refused({
      now: 99_000,
      requests: [{ at: 0, status: 200 }, passing(1_000), passing(8_000), passing(16_000)],
      waitSec: 15,
    }),
    {
      at: 99_000,
      kind: 'agent',
      message:
        'the run ended the turn: its last 3 model requests were answered 402 and nothing else for 15 s',
    },
  )
  assert.equal(
    Retry.refused({
      now: 99_000,
      requests: [
        { at: 1_000, status: 401 },
        { at: 9_000, status: 403 },
        { at: 30_000, status: 404 },
      ],
      waitSec: 15,
    })?.message,
    'the run ended the turn: its last 3 model requests were answered 401, 403, 404 and nothing else for 29 s',
  )
  assert.equal(
    Retry.refused({ now: 9_999_000, requests: [{ at: 1_000, status: 404 }], waitSec: 15 }),
    undefined,
    'one refusal says nothing of a turn that asks nothing more, however long it goes on',
  )
  for (const status of [400, 408, 409, 413, 422, 429, 500, 502, 529, 530])
    assert.equal(
      Retry.refused({
        now: 99_000,
        requests: [
          { at: 1_000, status },
          { at: 30_000, status },
        ],
        waitSec: 15,
      }),
      undefined,
      'a ' + status + ' is about one request or passes, and the session decides',
    )
  assert.equal(
    Retry.refused({
      now: 99_000,
      requests: [
        { at: 1_000, status: 401 },
        { at: 2_000, status: 500 },
        { at: 30_000, status: 401 },
      ],
      waitSec: 15,
    }),
    undefined,
  )
})
