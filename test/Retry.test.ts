import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Payment from '../src/Payment.ts'
import * as Retry from '../src/Retry.ts'
import * as Verdict from '../src/Verdict.ts'

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

test('a verifier that leaves reward.txt without a reward is retried as an environment error, one that writes none is not', () => {
  const base = { ctrf: false, log: 'tests ran', now: 5, timeoutSec: 60 }
  const empty = Verdict.verifier({
    ...base,
    facts: { code: 0, files: ['reward.txt'], reward: null },
  })
  assert.deepEqual(empty, {
    failure: {
      at: 5,
      kind: 'environment',
      message: 'the verifier left reward.txt without a reward after it exited with 0: tests ran',
    },
    reward: null,
  })
  assert.equal(
    Retry.infrastructure({ failure: empty.failure!, statuses: [] }),
    'the verifier left an empty reward',
  )
  const none = Verdict.verifier({ ...base, facts: { code: 3, files: [], reward: null } })
  assert.equal(none.failure?.kind, 'verifier')
  assert.equal(Retry.infrastructure({ failure: none.failure!, statuses: [] }), undefined)
  assert.equal(
    Verdict.verifier({
      ...base,
      facts: { code: 124, files: ['reward.txt'], reward: null },
    }).failure?.kind,
    'verifier_timeout',
  )
})

test('a limited answer waits twice as long for each of the step retries of the run, at least as long as its provider names, and never past the deadline of the attempt', () => {
  const input = { deadlineAt: 2_000_000, now: 1_000_000, pollMs: 250, stepRetries: 3 }
  assert.equal(Retry.pause({ ...input, tries: 0 }), 250)
  assert.equal(Retry.pause({ ...input, tries: 2 }), 1000)
  assert.equal(Retry.pause({ ...input, tries: 3 }), 2000)
  assert.equal(Retry.pause({ ...input, tries: 20 }), 2000)
  assert.equal(Retry.pause({ ...input, stepRetries: 0, tries: 20 }), 250)
  assert.equal(Retry.pause({ ...input, retryAfterMs: 7000, tries: 0 }), 7000)
  assert.equal(Retry.pause({ ...input, retryAfterMs: 1000, tries: 6 }), 2000)
  assert.equal(Retry.pause({ ...input, retryAfterMs: 90_000, tries: 20 }), 90_000)
  assert.equal(Retry.pause({ ...input, now: 1_997_999, tries: 20 }), 2000)
  assert.equal(Retry.pause({ ...input, now: 1_998_000, tries: 20 }), undefined)
  assert.equal(Retry.pause({ ...input, now: 1_999_000, tries: 0 }), 250)
  assert.equal(Retry.pause({ ...input, now: 1_999_000, retryAfterMs: 1000, tries: 0 }), undefined)
  assert.equal(Retry.pause({ ...input, now: 2_000_001, tries: 0 }), undefined)
  assert.equal(Retry.pause({ ...input, paceMs: 3000, tries: 0 }), 3000)
  assert.equal(Retry.pause({ ...input, paceMs: 3000, tries: 20 }), 3000)
  assert.equal(Retry.pause({ ...input, paceMs: 3000, retryAfterMs: 7000, tries: 1 }), 7000)
  assert.equal(Retry.pause({ ...input, now: 1_997_000, paceMs: 3000, tries: 0 }), undefined)
  assert.equal(Retry.after('3', 0), 3000)
  assert.equal(Retry.after('0.5', 0), 500)
  assert.equal(Retry.after('Sun, 15 Nov 2026 00:00:30 GMT', Date.UTC(2026, 10, 15)), 30_000)
  for (const header of [null, '', ' ', '0', '-1', 'soon', 'Sun, 15 Nov 2026 00:00:00 GMT'])
    assert.equal(Retry.after(header, Date.UTC(2026, 10, 15, 0, 1)), undefined, String(header))
})

test('an attempt that ends on limited answers is an error of the model provider and is retried', () => {
  const gaveUp = { at: 5, kind: 'agent' as const, message: 'pi exited with 0: 429 rate reached' }
  const requests = [
    { status: 200 },
    { again: true, status: 429, waitMs: 1000 },
    { again: true, status: 503, waitMs: 500 },
    { status: 429 },
  ]
  const limited = Retry.throttled({ failure: gaveUp, requests })
  assert.deepEqual(limited, {
    at: 5,
    kind: 'environment',
    message:
      'the model provider limited the agent: its last 3 model requests were answered 429, 503, and the run waited 2 s before it asked again: pi exited with 0: 429 rate reached',
  })
  assert.equal(
    Retry.infrastructure({ failure: limited!, statuses: [200, 429, 503, 429] }),
    'the model provider limited its requests',
  )
  assert.equal(
    Retry.throttled({ failure: { ...gaveUp, kind: 'agent_timeout' }, requests })?.kind,
    'environment',
  )
  assert.equal(
    Retry.throttled({ failure: gaveUp, requests: [...requests, { status: 200 }] }),
    undefined,
  )
  const askedAgain = requests.slice(0, 3)
  assert.equal(
    Retry.throttled({ failure: { ...gaveUp, kind: 'agent_timeout' }, requests: askedAgain }),
    undefined,
    'an agent whose time ended while the run asked its provider again was not told of a limit',
  )
  assert.equal(Retry.throttled({ failure: gaveUp, requests: askedAgain })?.kind, 'environment')
  assert.equal(Retry.throttled({ failure: gaveUp, requests: [{ status: 500 }] }), undefined)
  assert.equal(Retry.throttled({ failure: gaveUp, requests: [] }), undefined)
  assert.equal(Retry.throttled({ requests }), undefined)
  for (const kind of ['budget', 'cancelled', 'environment', 'verifier'] as const)
    assert.equal(Retry.throttled({ failure: { ...gaveUp, kind }, requests }), undefined)
})
