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
    cpusOf: () => 1,
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
      claim: first!.claim,
      ending: 'expired',
      id: 'a00001',
      limit: 2,
      now: 1001,
      usage: '{"costUsd":0.5}',
    }),
    'requeued',
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
    Ledger.finish(sql, {
      claim: null,
      id: 'a00002',
      now: 1002,
      result: result('a00002', 'passed'),
    }),
    false,
  )

  const [second] = claim(sql, { now: 2000, runner: 2 })
  assert.equal(second!.claims, 2)
  assert.equal(second!.session, '0123456789abcdef-a00001-2')
  assert.notEqual(second!.claim, first!.claim)
  assert.equal(
    Ledger.requeue(sql, {
      claim: second!.claim,
      ending: 'expired',
      id: 'a00001',
      limit: 2,
      now: 4000,
    }),
    'ended',
  )
  assert.equal(Ledger.get(sql, 'a00001')!.phase, 'claimed')
  assert.equal(Ledger.held(sql, { claim: second!.claim!, id: 'a00001' }), undefined)
  assert.deepEqual(
    Ledger.claims(sql).map((entry) => [entry.n, entry.runner, entry.ending, entry.ended_at]),
    [
      [1, 1, 'expired', 1001],
      [2, 2, 'expired', 4000],
    ],
  )
  assert.deepEqual(Ledger.lostUsage(sql), [{ attempt: 'a00001', usage: '{"costUsd":0.5}' }])
})

test('a claim whose session lost its turn goes back with what the session answered, within the claims of its row', () => {
  const sql = open([{ agent: 'agent', n: 1, task: 'small' }])
  const said = 'the session answered 404 for the turn'
  const [first] = claim(sql, { now: 0 })
  Ledger.update(sql, 'a00001', { phase: 'run' })
  Ledger.explain(sql, { claim: first!.claim!, error: said })
  assert.equal(Ledger.claims(sql)[0]!.ended_at, null)
  assert.equal(
    Ledger.requeue(sql, {
      claim: first!.claim,
      ending: 'forgotten',
      id: 'a00001',
      limit: 2,
      now: 500,
    }),
    'requeued',
  )
  assert.equal(Ledger.get(sql, 'a00001')!.phase, 'unclaimed')
  assert.equal(Ledger.held(sql, { claim: first!.claim!, id: 'a00001' }), undefined)

  const [second] = claim(sql, { now: 600 })
  assert.equal(second!.session, '0123456789abcdef-a00001-2')
  Ledger.explain(sql, { claim: second!.claim!, error: said })
  assert.equal(
    Ledger.requeue(sql, {
      claim: second!.claim,
      ending: 'forgotten',
      id: 'a00001',
      limit: 2,
      now: 900,
    }),
    'ended',
  )
  assert.equal(Ledger.get(sql, 'a00001')!.phase, 'claimed')
  assert.equal(
    Ledger.held(sql, { claim: second!.claim!, id: 'a00001' }),
    undefined,
    'the runner of a claim that ended holds its row no more',
  )
  assert.equal(
    Ledger.finish(sql, {
      claim: second!.claim,
      id: 'a00001',
      now: 901,
      result: result('a00001', 'errored'),
    }),
    true,
  )
  const claims = Ledger.claims(sql)
  assert.deepEqual(
    claims.map((entry) => [entry.n, entry.ending, entry.phase, entry.ended_at, entry.error]),
    [
      [1, 'forgotten', 'run', 500, said],
      [2, 'forgotten', 'claimed', 900, said],
    ],
  )
  assert.deepEqual(claims.map(Ledger.lost), [true, true])
  assert.deepEqual(Ledger.lostUsage(sql), [])

  const other = open([{ agent: 'agent', n: 1, task: 'small' }])
  const [only] = claim(other)
  Ledger.finish(other, {
    claim: only!.claim,
    id: 'a00001',
    now: 1,
    result: result('a00001', 'passed'),
  })
  assert.deepEqual(
    Ledger.claims(other).map((entry) => [entry.ending, entry.error, Ledger.lost(entry)]),
    [['finished', null, false]],
  )
})

test('a row is finished once, and a stale runner cannot finish or extend it', () => {
  const sql = open([{ agent: 'agent', n: 1, task: 'small' }])
  const [row] = claim(sql)
  assert.equal(
    Ledger.finish(sql, {
      claim: row!.claim,
      id: row!.id,
      now: 10,
      result: result(row!.id, 'passed'),
    }),
    true,
  )
  assert.equal(
    Ledger.finish(sql, {
      claim: row!.claim,
      id: row!.id,
      now: 11,
      result: result(row!.id, 'failed'),
    }),
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
  assert.equal(
    Ledger.requeue(sql, { claim: row!.claim, ending: 'expired', id: row!.id, limit: 3, now: 5000 }),
    'stale',
  )
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

test('a runner that overcommits counts what its machine uses and what its starting rows declare', () => {
  const rows = [
    { memoryMb: 2048, starting: false },
    { memoryMb: 4096, starting: false },
    { memoryMb: 8192, starting: true },
  ]
  const running = rows.slice(0, 2)
  const machine = (availableMb: number) => ({ availableMb, memoryMb: 16000 })
  assert.equal(Admission.held(rows), 14336)
  assert.equal(Admission.held(rows, machine(13000)), 3000 + 8192)
  assert.equal(Admission.held(running, machine(13000)), 3000)
  assert.equal(Admission.held(running, machine(17000)), 0)
  assert.equal(Admission.held([], machine(2000)), 0)

  const capacity = { memoryMb: 12800, slots: 160 }
  const declared = { memoryMb: Admission.held(running), running: 2 }
  const used = (availableMb: number) => ({
    memoryMb: Admission.held(running, machine(availableMb)),
    running: 2,
  })
  assert.equal(Admission.admits(declared, capacity, 8192), false)
  assert.equal(Admission.admits(used(13000), capacity, 8192), true)
  assert.equal(Admission.offer(used(13000), capacity).memoryMb, 9800)
  assert.equal(Admission.admits(used(11392), capacity, 8192), true)
  assert.equal(Admission.admits(used(11391), capacity, 8192), false)
  assert.equal(Admission.offer(used(3000), capacity).memoryMb, 0)
  assert.equal(
    Admission.admits(
      { memoryMb: Admission.held(rows, machine(13000)), running: 3 },
      capacity,
      2048,
    ),
    false,
  )
  assert.deepEqual(
    Admission.fill(
      [{ cpus: 1, item: 'whole', memoryMb: 16000 }],
      Admission.offer({ memoryMb: Admission.held([], machine(2000)), running: 0 }, capacity),
    ),
    ['whole'],
  )

  const mean = 2899
  const hundred = Array.from({ length: 100 }, () => ({ memoryMb: mean, starting: false }))
  const admitted = { memoryMb: 309060, slots: 160 }
  const free = (load: number) =>
    Math.floor(Admission.offer({ memoryMb: load, running: 100 }, admitted).memoryMb / mean)
  assert.equal(free(Admission.held(hundred)), 6)
  assert.equal(free(Admission.held(hundred, { availableMb: 285031, memoryMb: 386326 })), 71)
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
        { cpus: 1, item: 'a', memoryMb: 512 },
        { cpus: 1, item: 'b', memoryMb: 512 },
        { cpus: 1, item: 'c', memoryMb: 256 },
      ],
      { capacityMb: 768, memoryMb: 768, slots: 4 },
    ),
    ['a', 'c'],
  )
  assert.deepEqual(
    Admission.fill([{ cpus: 1, item: 'huge', memoryMb: 4096 }], {
      capacityMb: 768,
      memoryMb: 768,
      slots: 4,
    }),
    ['huge'],
  )
  const mixed = [
    { cpus: 1, item: 'small', memoryMb: 256 },
    { cpus: 1, item: 'whole', memoryMb: 768 },
    { cpus: 1, item: 'huge', memoryMb: 4096 },
  ]
  assert.deepEqual(
    Admission.fill(mixed, { capacityMb: 768, memoryMb: 768, slots: 4 }),
    ['whole'],
    'an empty runner takes a row that needs all of it before rows that others can take',
  )
  assert.deepEqual(
    Admission.fill(mixed, { capacityMb: 768, memoryMb: 512, slots: 3 }),
    ['small'],
    'a runner that is not empty takes what fits, in order',
  )
  assert.deepEqual(
    Admission.fill(mixed.slice(0, 1), { capacityMb: 768, memoryMb: 768, slots: 4 }),
    ['small'],
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

test('a slot with less memory than its task asks for scores only what its limit did not kill', () => {
  const base = { ctrf: false, log: 'the log', memoryMb: 8192, now: 5, timeoutSec: 30 }
  const short = { code: 1, files: [], memoryMb: 6000, oom: 2, reward: 0 }
  const killed = Verdict.verifier({ ...base, facts: short })
  assert.equal(killed.reward, null)
  assert.equal(killed.failure!.kind, 'environment')
  assert.equal(
    killed.failure!.message,
    'the slot had 6000 MB of the 8192 MB the task asks for, and that limit killed 2 of its processes',
  )
  assert.equal(
    Verdict.verifier({ ...base, facts: { ...short, code: 124 } }).failure!.kind,
    'environment',
    'a verifier that ran out of time in such a slot is not blamed either',
  )
  assert.deepEqual(Verdict.verifier({ ...base, facts: { ...short, code: 0, reward: 1 } }), {
    reward: 1,
  })
  assert.deepEqual(
    Verdict.verifier({ ...base, facts: { code: 1, files: [], memoryMb: 6000, reward: 0 } }),
    { reward: 0 },
    'less memory without a kill changes nothing',
  )
  assert.deepEqual(
    Verdict.verifier({ ...base, facts: { code: 1, files: [], oom: 2, reward: 0 } }),
    { reward: 0 },
    'a kill at the memory the task asks for is the task',
  )
})

test('a runner takes a row only while the timeouts of the row end before its sandbox does', () => {
  const life = { endsAt: 3_600_000, startedAt: 0 }
  const fits = (now: number, rowSec: number) => Admission.fits({ life, now, rowSec, setupSec: 600 })
  assert.ok(
    Admission.fits({ life: undefined, now: 1e12, rowSec: 1e6, setupSec: 600 }),
    'a machine without an end takes any row',
  )
  assert.ok(fits(1_200_000, 2400), 'a row that ends with the sandbox is taken')
  assert.ok(!fits(1_200_001, 2400), 'and one that ends a moment after it is not')
  assert.ok(!fits(3_000_000, 900), 'however short the row is')
  assert.ok(
    fits(600_000, 7800),
    'a row that no part of the sandbox covers is taken while it is new',
  )
  assert.ok(!fits(600_001, 7800), 'and not once the setup time of the sandbox has passed')
  assert.ok(Admission.outlives(life, 3601))
  assert.ok(!Admission.outlives(life, 3600))
})

test('as many runners begin with a row that needs a whole machine as the share of the work such rows are', () => {
  const share = { otherSec: 119_000, wholeSec: 33_000 }
  assert.ok(Admission.wholeFirst({ ...share, holders: 0, runners: 6 }))
  assert.ok(Admission.wholeFirst({ ...share, holders: 1, runners: 6 }))
  assert.ok(!Admission.wholeFirst({ ...share, holders: 2, runners: 6 }), 'two of six runners')
  assert.ok(Admission.wholeFirst({ ...share, holders: 0, runners: 1 }), 'a lone runner')
  assert.ok(!Admission.wholeFirst({ holders: 0, otherSec: 100, runners: 6, wholeSec: 0 }))
  assert.ok(
    Admission.wholeFirst({ holders: 5, otherSec: 0, runners: 6, wholeSec: 100 }),
    'every runner once only such rows are left',
  )
  const mixed = [
    { cpus: 1, item: 'whole', memoryMb: 768 },
    { cpus: 1, item: 'small', memoryMb: 256 },
    { cpus: 1, item: 'huge', memoryMb: 4096 },
  ]
  const empty = { capacityMb: 768, memoryMb: 768, slots: 4 }
  assert.deepEqual(Admission.fill(mixed, empty), ['whole'])
  assert.deepEqual(
    Admission.fill(mixed, { ...empty, wholeLast: true }),
    ['small'],
    'an empty runner beyond that share takes the rows others can take too',
  )
  assert.deepEqual(
    Admission.fill([mixed[0]!, mixed[2]!], { ...empty, wholeLast: true }),
    ['whole'],
    'and a row that needs all of it when nothing else is left for it',
  )
})

test('rows are claimed longest timeouts first, every attempt of a longer task before a shorter one, and only those the runner accepts', () => {
  const sql = open([
    { agent: 'agent', n: 1, task: 'small' },
    { agent: 'agent', n: 1, task: 'big' },
    { agent: 'agent', n: 2, task: 'large' },
    { agent: 'agent', n: 1, task: 'large' },
  ])
  const seconds: Record<string, number> = { big: 300, large: 900, small: 300 }
  assert.deepEqual(
    Ledger.queue(sql).map((row) => row.id),
    ['a00001', 'a00002', 'a00004', 'a00003'],
  )
  assert.deepEqual(
    Ledger.queue(sql, (task) => seconds[task]!).map((row) => row.id),
    ['a00004', 'a00003', 'a00001', 'a00002'],
  )
  const claimed = Ledger.claim(sql, {
    accepts: (row) => row.task !== 'large',
    cpusOf: () => 1,
    leaseMs: 1000,
    memoryOf: (task) => memory[task]!,
    now: 0,
    offer: { capacityMb: 2048, memoryMb: 2048, slots: 2 },
    run: '0123456789abcdef',
    runner: 1,
    secOf: (task) => seconds[task]!,
    token: () => 'token-' + ++tokens,
  })
  assert.deepEqual(
    claimed.map((row) => row.id),
    ['a00001', 'a00002'],
  )
})

test('a row that asks for more than a runner admits runs alone with the memory its machine has free', () => {
  const runner = { capacityMb: 6364 }
  assert.equal(Admission.alone({ ...runner, availableMb: 7400, requestedMb: 2048 }), 2048)
  assert.equal(Admission.alone({ ...runner, availableMb: 7400, requestedMb: 8192 }), 7400)
  assert.equal(Admission.alone({ ...runner, availableMb: 9000, requestedMb: 8192 }), 8192)
  assert.equal(
    Admission.alone({ ...runner, availableMb: 5000, requestedMb: 8192 }),
    6364,
    'never less than the runner admits',
  )
  assert.equal(
    Admission.alone({ ...runner, availableMb: undefined, requestedMb: 8192 }),
    6364,
    'a capacity the operator named, or a machine that does not say what is free, keeps the capacity',
  )
})

test('a claim that ends retried is remembered, so an attempt is retried once', () => {
  const sql = open([{ agent: 'agent', n: 1, task: 'small' }])
  const [row] = claim(sql)
  assert.equal(Ledger.retried(sql, row!.id), false)
  assert.equal(
    Ledger.requeue(sql, {
      claim: row!.claim,
      ending: 'retried',
      id: row!.id,
      limit: row!.claims + 1,
      now: 10,
    }),
    'requeued',
  )
  assert.equal(Ledger.get(sql, row!.id)!.phase, 'unclaimed')
  assert.equal(Ledger.retried(sql, row!.id), true)
  assert.deepEqual(
    Ledger.claims(sql, row!.id).map((entry) => [entry.ending, Ledger.lost(entry)]),
    [['retried', false]],
  )
  const [again] = claim(sql, { now: 20 })
  assert.equal(again!.claims, 2)
  assert.equal(Ledger.retried(sql, again!.id), true)
})

test('an attempt is retried within the claims of its row, so a run of one claim retries nothing', () => {
  const sql = open([
    { agent: 'agent', n: 1, task: 'small' },
    { agent: 'agent', n: 2, task: 'small' },
  ])
  const [row, other] = claim(sql)
  assert.equal(Ledger.retriable(sql, { id: 'a00009', limit: 3 }), false)
  assert.equal(Ledger.retriable(sql, { id: row!.id, limit: 1 }), false)
  assert.equal(Ledger.retriable(sql, { id: row!.id, limit: 2 }), true)
  assert.equal(
    Ledger.requeue(sql, { claim: row!.claim, ending: 'retried', id: row!.id, limit: 1, now: 10 }),
    'ended',
    'the ledger gives no row back past the claims of the run, whatever ended its claim',
  )
  assert.equal(Ledger.get(sql, row!.id)!.phase, 'claimed')
  assert.equal(
    Ledger.requeue(sql, {
      claim: other!.claim,
      ending: 'retried',
      id: other!.id,
      limit: 3,
      now: 10,
    }),
    'requeued',
  )
  const [again] = claim(sql, { now: 20 })
  assert.equal(again!.id, other!.id)
  assert.equal(
    Ledger.retriable(sql, { id: again!.id, limit: 3 }),
    false,
    'a row that was retried is not retried again, with claims left',
  )
  assert.equal(
    Ledger.requeue(sql, {
      claim: again!.claim,
      ending: 'expired',
      id: again!.id,
      limit: 3,
      now: 30,
    }),
    'requeued',
  )
  const [last] = claim(sql, { now: 40 })
  assert.equal(last!.claims, 3)
  assert.equal(
    Ledger.requeue(sql, { claim: last!.claim, ending: 'expired', id: last!.id, limit: 3, now: 50 }),
    'ended',
  )
  assert.equal(
    Ledger.claims(sql, last!.id).length,
    3,
    'no row is claimed more often than the run allows',
  )
})

test('a runner admits rows against the vCPUs their tasks declare, and a row wider than its bound runs alone', () => {
  const capacity = { cpus: 8, memoryMb: 4096, slots: 16 }
  assert.deepEqual(Admission.offer({ cpus: 5, memoryMb: 1024, running: 2 }, capacity), {
    capacityMb: 4096,
    cpus: { capacity: 8, free: 3 },
    memoryMb: 3072,
    slots: 3,
  })
  assert.equal(
    Admission.offer({ cpus: 8, memoryMb: 1024, running: 3 }, capacity).slots,
    0,
    'a runner whose vCPUs are all declared offers no slot',
  )
  assert.equal(
    Admission.offer({ cpus: 11, memoryMb: 1024, running: 8 }, capacity).slots,
    0,
    'nor does one that a Worker before this bound took over it',
  )
  assert.equal(
    Admission.offer({ cpus: 2, memoryMb: 0, running: 2 }, { ...capacity, slots: 4 }).slots,
    2,
    'the slot count stays the most rows at once',
  )
  assert.equal(
    Admission.offer({ cpus: 0, memoryMb: 0, running: 0 }, { ...capacity, cpus: 1 }).slots,
    1,
    'a runner with nothing in flight offers a slot whatever its bound',
  )
  assert.equal(
    Admission.offer({ memoryMb: 0, running: 0 }, { memoryMb: 4096, slots: 8 }).cpus,
    undefined,
    'a runner that counts no vCPUs offers a plain count',
  )
  const rows = [
    { cpus: 4, item: 'four', memoryMb: 256 },
    { cpus: 2, item: 'two', memoryMb: 256 },
    { cpus: 1, item: 'one', memoryMb: 256 },
    { cpus: 1, item: 'other', memoryMb: 256 },
    { cpus: 1, item: 'last', memoryMb: 256 },
  ]
  const offer = { capacityMb: 4096, memoryMb: 4096, slots: 8 }
  assert.deepEqual(
    Admission.fill(rows, { ...offer, cpus: { capacity: 8, free: 8 } }),
    ['four', 'two', 'one', 'other'],
    'a row of four vCPUs takes four of the eight, and the fifth row waits for one',
  )
  assert.deepEqual(
    Admission.fill(rows, { ...offer, cpus: { capacity: 8, free: 3 } }),
    ['two', 'one'],
    'a row that waits for vCPUs is passed over for the rows behind it that fit, as one that waits for memory is',
  )
  assert.deepEqual(
    Admission.fill(rows, { ...offer, cpus: { capacity: 2, free: 2 } }),
    ['four'],
    'a row that declares more vCPUs than the bound is admitted when nothing else is in flight, and takes all of it',
  )
  assert.deepEqual(
    Admission.fill(rows.slice(0, 1), { ...offer, cpus: { capacity: 1, free: 1 } }),
    ['four'],
    'so on a bound of one it still runs',
  )
  assert.deepEqual(
    Admission.fill(rows, { ...offer, cpus: { capacity: 2, free: 1 } }),
    ['one'],
    'and it waits until the whole bound is free',
  )
  assert.deepEqual(
    Admission.fill(rows, { ...offer, cpus: { capacity: 8, free: 0 } }),
    [],
    'nothing is admitted while no vCPU is free',
  )
  assert.deepEqual(
    Admission.fill(rows, { ...offer, slots: 3 }),
    ['four', 'two', 'one'],
    'an offer without vCPUs is a plain count of rows',
  )
  assert.deepEqual(
    Admission.fill(rows, { ...offer, cpus: { capacity: 48, free: 48 }, slots: 2 }),
    ['four', 'two'],
    'the slots of an offer bound the rows whatever vCPUs are free',
  )
})

test('rows are claimed by the vCPUs of their tasks when the offer of the runner counts them', () => {
  const wide: Record<string, number> = { big: 4, large: 2, small: 1 }
  const claimWide = (free: number) => {
    const sql = open([
      { agent: 'a', n: 1, task: 'big' },
      { agent: 'a', n: 1, task: 'large' },
      { agent: 'a', n: 1, task: 'small' },
    ])
    return Ledger.claim(sql, {
      cpusOf: (task) => wide[task]!,
      leaseMs: 1000,
      memoryOf: () => 1,
      now: 0,
      offer: { capacityMb: 768, cpus: { capacity: 4, free }, memoryMb: 768, slots: 4 },
      run: '0123456789abcdef',
      runner: 1,
      token: () => 'token-' + ++tokens,
    }).map((row) => row.task)
  }
  assert.deepEqual(claimWide(4), ['big'])
  assert.deepEqual(claimWide(3), ['large', 'small'])
  assert.deepEqual(claimWide(1), ['small'])
  assert.deepEqual(claimWide(0), [])
})

test('a row that holds several slots is admitted by its weight, and alone on an idle runner when it outweighs it', () => {
  const offer = { capacityMb: 8192, memoryMb: 8192, slots: 12 }
  const picker = (item: string) => ({ cpus: 1, item, memoryMb: 512, slots: 6 })
  assert.deepEqual(
    Admission.fill([picker('a'), picker('b'), picker('c')], offer),
    ['a', 'b'],
    'a 12-slot runner takes two picker rows of six slots, not twelve rows',
  )
  assert.deepEqual(
    Admission.fill([picker('a'), { cpus: 1, item: 'plain', memoryMb: 512 }], {
      ...offer,
      slots: 7,
    }),
    ['a', 'plain'],
  )
  assert.deepEqual(
    Admission.fill([picker('a'), picker('b')], { capacityMb: 8192, memoryMb: 8192, slots: 1 }),
    ['a'],
    'an idle one-slot runner still takes one picker row alone',
  )
  assert.deepEqual(
    Admission.fill([picker('a')], { capacityMb: 8192, memoryMb: 4096, slots: 4 }),
    [],
    'a busy runner does not take a row heavier than its free slots',
  )
  assert.deepEqual(
    Admission.fill([{ cpus: 1, item: 'big', memoryMb: 2048, slots: 6 }], {
      capacityMb: 8192,
      memoryMb: 8192,
      slots: 12,
    }),
    ['big'],
    'the memory of a heavy row is clamped to the runner, so it is never starved',
  )
})

test('a claim that ended writes nothing to its row, and the row starts again from nothing', () => {
  const sql = open([{ agent: 'agent', n: 1, task: 'task' }])
  const [first] = claim(sql)
  Ledger.update(sql, first!.id, { failure: '{"at":1,"kind":"agent","message":"x"}', phase: 'run' })
  const held = Ledger.held(sql, { claim: first!.claim!, id: first!.id })!
  assert.equal(Ledger.current(sql, held)!.id, first!.id)

  assert.equal(
    Ledger.requeue(sql, {
      claim: first!.claim,
      ending: 'released',
      id: first!.id,
      limit: 3,
      now: 100,
    }),
    'requeued',
  )
  const requeued = Ledger.get(sql, first!.id)!
  assert.deepEqual(
    [requeued.claim, requeued.failure, requeued.phase, requeued.session, requeued.timing],
    [null, null, 'unclaimed', null, '{}'],
  )
  assert.equal(
    Ledger.current(sql, held),
    undefined,
    'the row of the claim that ended is not its row',
  )
  assert.equal(
    Ledger.finish(sql, {
      claim: held.claim,
      id: held.id,
      now: 101,
      result: result(held.id, 'errored'),
    }),
    false,
    'a request of the claim that ended does not finish the row that went back',
  )
  assert.equal(Ledger.get(sql, first!.id)!.phase, 'unclaimed')
  assert.equal(
    Ledger.requeue(sql, {
      claim: held.claim,
      ending: 'expired',
      id: held.id,
      limit: 3,
      now: 102,
    }),
    'stale',
  )

  const [second] = claim(sql)
  assert.equal(second!.id, first!.id)
  assert.equal(second!.claims, 2)
  assert.equal(Ledger.current(sql, held), undefined, 'nor is the row that another claim holds')
  assert.equal(
    Ledger.finish(sql, {
      claim: held.claim,
      id: held.id,
      now: 103,
      result: result(held.id, 'errored'),
    }),
    false,
  )
  assert.equal(
    Ledger.requeue(sql, {
      claim: held.claim,
      ending: 'released',
      id: held.id,
      limit: 3,
      now: 104,
    }),
    'stale',
    'and it takes the row from no later claim',
  )
  assert.equal(Ledger.held(sql, { claim: second!.claim!, id: second!.id })!.claims, 2)
  assert.deepEqual(
    Ledger.claims(sql, first!.id).map((entry) => entry.ending),
    ['released', null],
  )
})
