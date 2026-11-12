import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as Atif from '../src/Atif.ts'
import * as Sql from '../src/Sql.ts'
import * as Timeline from '../src/Timeline.ts'
import * as Rows from './Rows.ts'

function open(): Sql.Sql {
  const sql = Rows.database()
  Sql.setup(sql, Timeline.tables)
  return sql
}

test('marks are kept in the order of their time, with what they belong to', () => {
  const sql = open()
  Timeline.add(sql, { at: 2000, attempt: 'a00001', name: 'attempt.claimed', runner: 1 })
  Timeline.add(sql, { at: 1000, ms: 12.4, name: 'run.created' })
  Timeline.add(sql, { at: 1500, ms: 900, name: 'sandbox.create', sandbox: 1 })
  assert.deepEqual(Timeline.all(sql), [
    { at: 1000, ms: 12, name: 'run.created' },
    { at: 1500, ms: 900, name: 'sandbox.create', sandbox: 1 },
    { at: 2000, attempt: 'a00001', name: 'attempt.claimed', runner: 1 },
  ])
})

test('the marks of a runner are moved onto the clock of the run', () => {
  const sql = open()
  Timeline.report(sql, {
    attempt: 'a00001',
    receivedAt: 50_000,
    report: {
      marks: [
        { at: 9_000, ms: 400, name: 'attempt.disk' },
        { at: 9_500, name: 'attempt.up' },
      ],
      sentAt: 10_000,
    },
    runner: 2,
  })
  assert.deepEqual(Timeline.all(sql), [
    { at: 49_000, attempt: 'a00001', ms: 400, name: 'attempt.disk', runner: 2 },
    { at: 49_500, attempt: 'a00001', name: 'attempt.up', runner: 2 },
  ])
})

test('a report is refused unless every mark has a name, a time and no negative span', () => {
  assert.equal(Timeline.valid({ marks: [{ at: 1, name: 'runner.start' }], sentAt: 2 }), true)
  assert.equal(Timeline.valid({ marks: [], sentAt: 2 }), true)
  assert.equal(Timeline.valid(undefined), false)
  assert.equal(Timeline.valid({ marks: [{ at: 1, name: 'runner.start' }] }), false)
  assert.equal(Timeline.valid({ marks: [{ at: 1, name: 'Runner start' }], sentAt: 2 }), false)
  assert.equal(Timeline.valid({ marks: [{ at: 'now', name: 'runner.start' }], sentAt: 2 }), false)
  assert.equal(
    Timeline.valid({ marks: [{ at: 1, ms: -1, name: 'runner.start' }], sentAt: 2 }),
    false,
  )
})

test('the start of a run is the first of each mark after its creation', () => {
  const marks: Timeline.Mark[] = [
    { at: 1000, name: 'run.created' },
    { at: 1900, name: 'sandbox.create', sandbox: 1 },
    { at: 4000, name: 'runner.hello', runner: 1 },
    { at: 4100, attempt: 'a00002', name: 'attempt.claimed' },
    { at: 4050, attempt: 'a00001', name: 'attempt.claimed' },
    { at: 5000, attempt: 'a00001', name: 'attempt.environment' },
    { at: 5600, attempt: 'a00001', name: 'attempt.agent' },
    { at: 5700, attempt: 'a00001', name: 'attempt.model' },
    { at: 9000, attempt: 'a00002', name: 'attempt.verdict' },
  ]
  const start = Timeline.start(marks, 1000)
  assert.deepEqual(start, {
    agentMs: 4600,
    claimMs: 3050,
    environmentMs: 4000,
    modelMs: 4700,
    runnerMs: 3000,
    sandboxMs: 900,
    verdictMs: 8000,
  })
  assert.equal(
    Timeline.summary(start),
    'sandbox +0.90 s, runner +3.00 s, claim +3.05 s, environment +4.00 s, agent +4.60 s, model request +4.70 s, verdict +8.00 s',
  )
  assert.deepEqual(Timeline.start([], 1000), {})
  assert.equal(Timeline.summary({}), '')
})

test('the first model request of a session starts where its first call began', () => {
  const event = (
    at: number,
    type: string,
    payload: Record<string, unknown>,
  ): Atif.SessionEvent => ({
    created_at: at,
    event: { event: { payload, type }, source: 'agent' },
    request_id: 'attempt',
    seq: at,
  })
  assert.equal(
    Timeline.modelRequest([
      event(100, 'run.started', {}),
      event(160, 'model.call.completed', { duration_ns: 40_000_000 }),
      event(300, 'model.call.completed', { duration_ns: 90_000_000 }),
    ]),
    120,
  )
  assert.equal(Timeline.modelRequest([event(100, 'run.started', {})]), undefined)
})

test('the table lists each mark by its offset from the creation of the run', () => {
  assert.equal(
    Timeline.table(
      [
        { at: 1000, ms: 12, name: 'run.created' },
        { at: 2500, attempt: 'a00001', name: 'attempt.claimed', runner: 1 },
      ],
      1000,
    ),
    '    +0.000       12 ms  run.created\n    +1.500              attempt.claimed           a00001 runner 1',
  )
})
