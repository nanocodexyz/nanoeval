import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Admission from '../src/Admission.ts'
import * as Ledger from '../src/Ledger.ts'
import type * as Result from '../src/Result.ts'
import * as Sql from '../src/Sql.ts'
import * as Verdict from '../src/Verdict.ts'
import * as Rows from './Rows.ts'

const memory: Record<string, number> = { big: 512, large: 512, small: 256 }

function open(seeds: Ledger.Seed[]): Sql.Sql {
  const sql = Rows.database()
  Sql.setup(sql, Ledger.tables)
  Ledger.create(sql, seeds)
  return sql
}

let tokens = 0
const claim = (
  sql: Sql.Sql,
  input: { now?: number; offer?: Partial<Admission.Offer>; runner?: number } = {},
) =>
  Ledger.claim(sql, {
    leaseMs: 1000,
    memoryOf: (task) => memory[task]!,
    now: input.now ?? 0,
    offer: { capacityMb: 768, memoryMb: 768, slots: 4, ...input.offer },
    run: '0123456789abcdef',
    runner: input.runner ?? 1,
    token: () => 'token-' + ++tokens,
  })

const result = (id: string, outcome: Result.Attempt['outcome']): Result.Attempt => ({
  agent: { id: 'agent', model: 'model', provider: 'claude' },
  finishedAt: 1,
  id,
  index: 1,
  outcome,
  reward: outcome === 'errored' ? null : outcome === 'passed' ? 1 : 0,
  sandbox: null,
  session: 'session',
  startedAt: 0,
  task: { checksum: 'sha256:0', name: 'task' },
  timing: {},
  usage: null,
})

test('rows are claimed first fit by memory, each under a lease and a token', () => {
  const sql = open([
    { agent: 'agent', n: 1, task: 'big' },
    { agent: 'agent', n: 1, task: 'large' },
    { agent: 'agent', n: 1, task: 'small' },
    { agent: 'agent', n: 2, task: 'small' },
  ])
  const first = claim(sql)
  assert.deepEqual(
    first.map((row) => [row.id, row.phase, row.runner, row.claims, row.lease_until]),
    [
      ['a00001', 'claimed', 1, 1, 1000],
      ['a00003', 'claimed', 1, 1, 1000],
    ],
  )
  assert.equal(first[0]!.slot, '01234567-a00001-1')
  assert.equal(first[0]!.session, '0123456789abcdef-a00001-1')
  assert.notEqual(first[0]!.claim, first[1]!.claim)
  assert.equal(JSON.parse(first[0]!.timing).environmentSetup.startedAt, 0)

  assert.deepEqual(claim(sql, { offer: { memoryMb: 0 }, runner: 2 }), [])
  assert.deepEqual(
    claim(sql, { offer: { slots: 1 }, runner: 2 }).map((row) => row.id),
    ['a00002'],
  )
  assert.deepEqual(
    claim(sql, { offer: { capacityMb: 128, memoryMb: 128 }, runner: 3 }).map((row) => row.id),
    ['a00004'],
  )
  assert.deepEqual(claim(sql, { runner: 3 }), [])
  assert.equal(Ledger.claims(sql).length, 4)
})

test('a heartbeat extends a lease only for the runner and the token that hold it', () => {
  const sql = open([{ agent: 'agent', n: 1, task: 'small' }])
  const [row] = claim(sql)
  const held = { claim: row!.claim!, id: row!.id }
  assert.deepEqual(Ledger.heartbeat(sql, { held: [held], leaseMs: 1000, now: 500, runner: 1 }), [])
  assert.equal(Ledger.get(sql, row!.id)!.lease_until, 1500)
  assert.deepEqual(Ledger.heartbeat(sql, { held: [held], leaseMs: 1000, now: 600, runner: 2 }), [
    row!.id,
  ])
  assert.deepEqual(
    Ledger.heartbeat(sql, {
      held: [{ claim: 'stale', id: row!.id }],
      leaseMs: 1000,
      now: 600,
      runner: 1,
    }),
    [row!.id],
  )
  assert.equal(Ledger.get(sql, row!.id)!.lease_until, 1500)
  assert.equal(Ledger.held(sql, { claim: 'stale', id: row!.id }), undefined)
  assert.equal(Ledger.held(sql, held)!.id, row!.id)
})

test('a lost lease makes the row claimable again, a bounded number of times, and never scores', () => {
  const sql = open([{ agent: 'agent', n: 1, task: 'small' }])
  const [first] = claim(sql, { now: 0 })
  assert.deepEqual(Ledger.expired(sql, 1000), [])
  assert.deepEqual(
    Ledger.expired(sql, 1001).map((row) => row.id),
    ['a00001'],
  )
  assert.equal(
    Ledger.requeue(sql, {
      ending: 'expired',
      id: 'a00001',
      limit: 2,
      now: 1001,
      usage: '{"costUsd":0.5}',
    }),
    true,
  )
  const waiting = Ledger.get(sql, 'a00001')!
  assert.deepEqual(
    [
      waiting.phase,
      waiting.runner,
      waiting.claim,
      waiting.lease_until,
      waiting.session,
      waiting.claims,
    ],
    ['unclaimed', null, null, null, null, 1],
  )
  assert.equal(waiting.result, null)
  assert.equal(Ledger.held(sql, { claim: first!.claim!, id: 'a00001' }), undefined)
  assert.equal(
    Ledger.finish(sql, { id: 'a00002', now: 1002, result: result('a00002', 'passed') }),
    false,
  )

  const [second] = claim(sql, { now: 2000, runner: 2 })
  assert.equal(second!.claims, 2)
  assert.equal(second!.session, '0123456789abcdef-a00001-2')
  assert.notEqual(second!.claim, first!.claim)
  assert.equal(Ledger.requeue(sql, { ending: 'expired', id: 'a00001', limit: 2, now: 4000 }), false)
  assert.equal(Ledger.get(sql, 'a00001')!.phase, 'claimed')
  assert.deepEqual(
    Ledger.claims(sql).map((entry) => [entry.n, entry.runner, entry.ending, entry.ended_at]),
    [
      [1, 1, 'expired', 1001],
      [2, 2, 'expired', 4000],
    ],
  )
  assert.deepEqual(Ledger.lostUsage(sql), ['{"costUsd":0.5}'])
})

test('a row is finished once, and a stale runner cannot finish or extend it', () => {
  const sql = open([{ agent: 'agent', n: 1, task: 'small' }])
  const [row] = claim(sql)
  assert.equal(
    Ledger.finish(sql, { id: row!.id, now: 10, result: result(row!.id, 'passed') }),
    true,
  )
  assert.equal(
    Ledger.finish(sql, { id: row!.id, now: 11, result: result(row!.id, 'failed') }),
    false,
  )
  const done = Ledger.get(sql, row!.id)!
  assert.equal(done.phase, 'done')
  assert.equal((JSON.parse(done.result!) as Result.Attempt).outcome, 'passed')
  assert.equal(Ledger.held(sql, { claim: row!.claim!, id: row!.id }), undefined)
  assert.deepEqual(
    Ledger.heartbeat(sql, {
      held: [{ claim: row!.claim!, id: row!.id }],
      leaseMs: 1000,
      now: 20,
      runner: 1,
    }),
    [row!.id],
  )
  assert.equal(Ledger.requeue(sql, { ending: 'expired', id: row!.id, limit: 3, now: 5000 }), false)
  assert.deepEqual(Ledger.expired(sql, 5000), [])
  assert.deepEqual(
    Ledger.claims(sql).map((entry) => entry.ending),
    ['finished'],
  )
})

test('a rerun has one row for each attempt it retries, pointing at it', () => {
  const attempts: Ledger.retries.Parent[] = [
    { agent: 'agent', id: 'a00001', n: 1, outcome: 'passed', task: 'small' },
    { agent: 'agent', id: 'a00002', n: 1, outcome: 'failed', task: 'big' },
    { agent: 'agent', id: 'a00003', n: 2, outcome: 'errored', task: 'small' },
    { agent: 'agent', id: 'a00004', n: 2, task: 'big' },
  ]
  const parent = { attempts, run: 'parent-run' }
  assert.deepEqual(Ledger.retries(parent, 'unpassed'), [
    { agent: 'agent', n: 1, origin: { attempt: 'a00002', run: 'parent-run' }, task: 'big' },
    { agent: 'agent', n: 2, origin: { attempt: 'a00003', run: 'parent-run' }, task: 'small' },
  ])
  assert.deepEqual(
    Ledger.retries(parent, 'failed').map((seed) => seed.origin!.attempt),
    ['a00002'],
  )
  assert.deepEqual(
    Ledger.retries(parent, 'errored').map((seed) => seed.origin!.attempt),
    ['a00003'],
  )

  const sql = open(Ledger.retries(parent, 'unpassed'))
  assert.deepEqual(
    Ledger.all(sql).map((row) => [row.id, row.task, row.n, JSON.parse(row.origin!)]),
    [
      ['a00001', 'big', 1, { attempt: 'a00002', run: 'parent-run' }],
      ['a00002', 'small', 2, { attempt: 'a00003', run: 'parent-run' }],
    ],
  )
})

test('a runner offers what its machine has free, and nothing while its disk is short', () => {
  const capacity = { memoryMb: 768, slots: 4 }
  assert.deepEqual(Admission.offer({ memoryMb: 256, running: 1 }, capacity), {
    capacityMb: 768,
    memoryMb: 512,
    slots: 3,
  })
  const floor = { ...capacity, freeDiskMb: 1000 }
  assert.equal(Admission.offer({ freeDiskMb: 2000, memoryMb: 0, running: 0 }, floor).slots, 1)
  assert.equal(
    Admission.offer({ freeDiskMb: 2000, memoryMb: 0, running: 1, starting: 1 }, floor).slots,
    0,
  )
  assert.equal(Admission.offer({ freeDiskMb: 500, memoryMb: 0, running: 0 }, floor).slots, 0)
  assert.equal(Admission.starved({ freeDiskMb: 500, memoryMb: 0, running: 0 }, floor), true)
  assert.equal(Admission.starved({ freeDiskMb: 500, memoryMb: 0, running: 1 }, floor), false)
  assert.equal(Admission.starved({ freeDiskMb: 500, memoryMb: 0, running: 0 }, capacity), false)
  assert.deepEqual(
    Admission.fill(
      [
        { item: 'a', memoryMb: 512 },
        { item: 'b', memoryMb: 512 },
        { item: 'c', memoryMb: 256 },
      ],
      { capacityMb: 768, memoryMb: 768, slots: 4 },
    ),
    ['a', 'c'],
  )
  assert.deepEqual(
    Admission.fill([{ item: 'huge', memoryMb: 4096 }], {
      capacityMb: 768,
      memoryMb: 768,
      slots: 4,
    }),
    ['huge'],
  )
})

test('a verifier is scored only when it reported, and an infrastructure failure is no score', () => {
  const base = { ctrf: false, log: 'the log', now: 5, timeoutSec: 30 }
  assert.deepEqual(Verdict.verifier({ ...base, facts: { code: 0, files: [], reward: 1 } }), {
    reward: 1,
  })
  assert.deepEqual(Verdict.verifier({ ...base, facts: { code: 1, files: [], reward: 0 } }), {
    reward: 0,
  })
  const silent = Verdict.verifier({ ...base, facts: { code: 3, files: [], reward: null } })
  assert.equal(silent.reward, null)
  assert.equal(silent.failure!.kind, 'verifier')
  const late = Verdict.verifier({ ...base, facts: { code: 124, files: [], reward: 0 } })
  assert.deepEqual([late.reward, late.failure!.kind], [null, 'verifier_timeout'])
  const unreported = Verdict.verifier({
    ...base,
    ctrf: true,
    facts: { code: 0, files: ['reward.txt'], reward: 0 },
  })
  assert.equal(unreported.reward, null)
  assert.match(unreported.failure!.message, /its tests did not run/)
  assert.deepEqual(
    Verdict.verifier({
      ...base,
      ctrf: true,
      facts: { code: 0, files: ['ctrf.json', 'reward.txt'], reward: 0 },
    }),
    { reward: 0 },
  )
  const timeout: Result.Failure = { at: 1, kind: 'agent_timeout', message: 'late' }
  assert.deepEqual(
    Verdict.verifier({ ...base, earlier: timeout, facts: { code: 0, files: [], reward: 0 } }),
    { failure: timeout, reward: 0 },
  )
})
