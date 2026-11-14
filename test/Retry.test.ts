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
