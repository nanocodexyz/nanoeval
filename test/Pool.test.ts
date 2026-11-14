import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Pool from '../src/Pool.ts'
import type * as Sandbox from '../src/Sandbox.ts'
import * as Sql from '../src/Sql.ts'
import * as Rows from './Rows.ts'

const capabilities: Sandbox.Capabilities = {
  arch: 'x86_64',
  backend: 'ns',
  bwrap: false,
  ca_bundle: false,
  cgroup: true,
  cpus: 2,
  kernel: '6.1',
  krun: false,
  kvm: false,
  memory_mb: 512,
  network: 'private',
  ns: true,
  slot_env: false,
  slot_forward: false,
  userns: true,
}

const spec: Pool.Spec = {
  backend: 'ns',
  kind: 'sandbox',
  network: 'private',
  provider: 'gateway',
  runtime: 'a'.repeat(64),
  template: 'base',
}

function open(): Sql.Sql {
  const sql = Rows.database()
  Sql.setup(sql, Pool.tables)
  return sql
}

const enroll = (sql: Sql.Sql, input: Partial<Pool.enroll.Input> = {}) =>
  Pool.enroll(sql, {
    expiresAt: 1_000_000,
    handle: { home: '/root/.nanoeval', id: 'sandbox-1' },
    idleSec: 60,
    leaseSec: 30,
    noticeSec: 10,
    now: 0,
    paidUntil: 100_000,
    run: 'run-a',
    spec,
    token: 'secret',
    usd: 1,
    ...input,
  })

const take = (sql: Sql.Sql, input: Partial<Pool.take.Input> = {}) =>
  Pool.take(sql, {
    holding: () => true,
    lifetimeSec: 100,
    now: 20_000,
    run: 'run-b',
    wanted: spec,
    ...input,
  })

test('a sandbox serves one run at a time, and only the run that has it gives it back', () => {
  const sql = open()
  const member = enroll(sql)
  assert.equal(member.state, 'assigned')
  assert.equal(take(sql), undefined, 'the run that opened it still has it')
  assert.equal(Pool.settle(sql, { id: member.id, now: 10_000, run: 'run-x' }), false)
  assert.equal(Pool.settle(sql, { capabilities, id: member.id, now: 10_000, run: 'run-a' }), true)
  assert.equal(Pool.get(sql, member.id)!.idle_until, 70_000)

  assert.equal(
    take(sql, { holding: () => false, now: 20_001 }),
    undefined,
    'its runner has not asked for a run within its notice',
  )
  const taken = take(sql, { holding: () => false })
  assert.deepEqual(taken, {
    capabilities,
    expiresAt: 1_000_000,
    handle: { home: '/root/.nanoeval', id: 'sandbox-1' },
    id: member.id,
    paidUntil: 100_000,
  })
  assert.equal(take(sql, { run: 'run-c' }), undefined, 'a taken sandbox is taken once')
  assert.equal(Pool.get(sql, member.id)!.runs, 2)

  assert.equal(Pool.assign(sql, { assignment: '{}', id: member.id, run: 'run-c' }), false)
  assert.equal(
    Pool.assign(sql, { assignment: '{"run":"run-b"}', id: member.id, run: 'run-b' }),
    true,
  )
  assert.equal(Pool.get(sql, member.id)!.assignment, '{"run":"run-b"}')

  Pool.served(sql, { id: member.id, now: 30_000, run: 'run-b' })
  const served = Pool.get(sql, member.id)!
  assert.equal(served.assignment, null, 'its runner is not handed the run it finished again')
  assert.equal(served.state, 'assigned', 'a sandbox is idle only once its run settles it')
  assert.equal(take(sql, { now: 31_000, run: 'run-c' }), undefined)

  assert.equal(Pool.end(sql, { error: 'lost', id: member.id, run: 'run-a' }), false)
  assert.equal(
    Pool.settle(sql, { id: member.id, idleSec: 5, now: 40_000, paidUntil: 90_000, run: 'run-b' }),
    true,
  )
  const idle = Pool.get(sql, member.id)!
  assert.deepEqual(
    [idle.state, idle.idle_until, idle.paid_until, idle.run],
    ['idle', 45_000, 90_000, null],
  )
  assert.equal(Pool.end(sql, { error: 'lost', id: member.id }), true)
  assert.equal(Pool.get(sql, member.id)!.state, 'failed')
  assert.equal(take(sql, { now: 41_000 }), undefined)
})

test('a kept sandbox is taken only while its idle time, its lease and its lifetime cover the run', () => {
  const sql = open()
  const member = enroll(sql)
  Pool.settle(sql, { capabilities, id: member.id, now: 0, run: 'run-a' })
  assert.equal(take(sql, { now: 60_000 }), undefined, 'the idle time ended')
  assert.equal(take(sql, { lifetimeSec: 2000, now: 10_000 }), undefined, 'it ends before the run')
  assert.equal(take(sql, { wanted: { ...spec, template: 'desktop' } }), undefined)
  assert.equal(take(sql, { wanted: { ...spec, runtime: 'b'.repeat(64) } }), undefined)
  assert.equal(take(sql, { wanted: { ...spec, backend: 'dir' } }), undefined)
  assert.equal(take(sql, { wanted: { ...spec, kind: 'machine', provider: null } }), undefined)
  assert.equal(take(sql, { wanted: { ...spec, backend: 'auto' } })!.id, member.id)

  const lapsing = enroll(sql, { paidUntil: 30_000, run: 'run-d' })
  Pool.settle(sql, { capabilities, id: lapsing.id, now: 0, run: 'run-d' })
  assert.equal(
    take(sql, { now: 20_000, run: 'run-e' }),
    undefined,
    'what is paid of its lease is no more than the notice a renewal is given',
  )
  assert.equal(take(sql, { now: 19_999, run: 'run-e' })!.id, lapsing.id)

  const first = enroll(sql, { run: 'run-f' })
  const second = enroll(sql, { run: 'run-g' })
  Pool.settle(sql, { capabilities, id: first.id, now: 15_000, run: 'run-f' })
  Pool.settle(sql, { capabilities, id: second.id, now: 15_000, run: 'run-g' })
  assert.equal(
    take(sql, { holding: (id) => id === second.id, run: 'run-h' })!.id,
    second.id,
    'a runner that is waiting now is taken before one that asked a moment ago',
  )
})

test('the pool renews an idle sandbox inside its idle time and closes it when that or the lease ends', () => {
  const sql = open()
  const member = enroll(sql, { paidUntil: 20_000 })
  const holding = () => true
  assert.deepEqual(Pool.due(sql, { holding, now: 15_000 }), [], 'a run still has it')
  assert.equal(Pool.wakeAt(sql), undefined)
  Pool.settle(sql, { capabilities, id: member.id, now: 0, run: 'run-a' })

  assert.equal(Pool.wakeAt(sql), 10_000)
  assert.deepEqual(Pool.due(sql, { holding, now: 5000 }), [])
  const first = Pool.due(sql, { holding, now: 10_000 })
  assert.deepEqual(
    first.map((due) => due.action),
    ['renew'],
  )
  assert.equal(Pool.renewal(first[0]!.member, 300), 30)
  Pool.renewed(sql, { id: member.id, paidUntil: 50_000 })

  assert.equal(Pool.wakeAt(sql), 40_000)
  const second = Pool.due(sql, { holding, now: 40_000 })
  assert.equal(Pool.renewal(second[0]!.member, 300), 10, 'only to the end of the idle time')
  Pool.renewed(sql, { id: member.id, paidUntil: 59_400 })

  assert.equal(Pool.wakeAt(sql), 49_400)
  const third = Pool.due(sql, { holding, now: 49_400 })
  assert.equal(
    Pool.renewal(third[0]!.member, 300),
    1,
    'a whole second covers what is left, so the pool and not the lease ends the sandbox',
  )
  Pool.renewed(sql, { id: member.id, paidUntil: 60_400 })

  assert.equal(Pool.wakeAt(sql), 60_000)
  assert.deepEqual(Pool.due(sql, { holding, now: 59_999 }), [])
  const last = Pool.due(sql, { holding, now: 60_000 })
  assert.deepEqual(
    last.map((due) => [due.action, due.reason]),
    [['close', 'the idle time ended']],
  )
  assert.equal(Pool.end(sql, { id: member.id }), true)
  assert.equal(Pool.get(sql, member.id)!.state, 'closed')
  assert.deepEqual(Pool.due(sql, { holding, now: 70_000 }), [])
  assert.equal(Pool.wakeAt(sql), undefined)

  const refused = enroll(sql, { paidUntil: 20_000, run: 'run-b' })
  Pool.settle(sql, { capabilities, id: refused.id, now: 0, run: 'run-b' })
  Pool.unrenewed(sql, { error: 'the gateway refused renew', id: refused.id })
  assert.equal(Pool.wakeAt(sql), 20_000)
  assert.deepEqual(
    Pool.due(sql, { holding, now: 15_000 }),
    [],
    'a refused renewal is not asked again',
  )
  assert.deepEqual(
    Pool.due(sql, { holding, now: 20_000 }).map((due) => [due.action, due.reason]),
    [['close', 'the lease ended']],
  )
  assert.equal(Pool.get(sql, refused.id)!.error, 'the gateway refused renew')
})

test('a standing runner of a machine is idle again by its own word and is closed when it stops asking', () => {
  const sql = open()
  const machine: Pool.Spec = {
    ...spec,
    kind: 'machine',
    provider: null,
    runtime: null,
    template: null,
  }
  const wanted: Pool.Wanted = { ...machine, backend: 'auto' }
  const member = Pool.enroll(sql, {
    idleSec: 0,
    noticeSec: 10,
    now: 0,
    spec: machine,
    token: 't',
    usd: 0,
  })
  assert.equal(member.state, 'idle')
  assert.equal(take(sql, { wanted }), undefined, 'it has not said what its machine can do')
  Pool.seen(sql, { capabilities, id: member.id, now: 1000 })
  assert.equal(
    take(sql, { wanted: spec }),
    undefined,
    'a run that leases sandboxes takes no machine',
  )
  const taken = take(sql, { now: 2000, wanted })!
  assert.deepEqual([taken.id, taken.handle], [member.id, null])
  Pool.assign(sql, { assignment: '{}', id: member.id, run: 'run-b' })
  Pool.served(sql, { id: member.id, now: 3000, run: 'run-a' })
  assert.equal(Pool.get(sql, member.id)!.state, 'assigned', 'only the run it served frees it')
  Pool.served(sql, { id: member.id, now: 3000, run: 'run-b' })
  const idle = Pool.get(sql, member.id)!
  assert.deepEqual([idle.state, idle.run, idle.assignment], ['idle', null, null])

  assert.equal(Pool.wakeAt(sql), 13_001)
  assert.deepEqual(Pool.due(sql, { holding: () => true, now: 20_000 }), [])
  assert.deepEqual(Pool.due(sql, { holding: () => false, now: 13_000 }), [])
  assert.deepEqual(
    Pool.due(sql, { holding: () => false, now: 13_001 }).map((due) => due.action),
    ['close'],
  )
})

test('a machine has a member for each run it serves and one more that stands by', () => {
  const sql = open()
  const machine: Pool.Spec = {
    ...spec,
    kind: 'machine',
    provider: null,
    runtime: null,
    template: null,
  }
  const wanted: Pool.Wanted = { ...machine, backend: 'auto' }
  const stand = (name: string | undefined, now: number) => {
    const member = Pool.enroll(sql, {
      idleSec: 0,
      ...(name === undefined ? {} : { machine: name }),
      noticeSec: 10,
      now,
      spec: machine,
      token: 't',
      usd: 0,
    })
    Pool.seen(sql, { capabilities, id: member.id, now })
    return member
  }
  const holding = (...ids: number[]) => ({ holding: (id: number) => ids.includes(id) })

  const first = stand('one', 0)
  assert.equal(take(sql, { now: 1000, run: 'run-a', wanted })!.id, first.id)
  const second = stand('one', 1000)
  assert.equal(
    take(sql, { now: 2000, run: 'run-a', wanted }),
    undefined,
    'a run that has a member of a machine is not handed another member of it',
  )
  assert.equal(
    take(sql, { now: 2000, run: 'run-b', wanted })!.id,
    second.id,
    'a run that is created while the machine has a run is handed the member that stands by',
  )
  const third = stand('one', 2000)
  const other = stand('two', 2000)
  assert.equal(
    take(sql, { now: 3000, run: 'run-a', wanted })!.id,
    other.id,
    'a member of another machine is one more runner of the run',
  )

  assert.deepEqual(
    Pool.due(sql, { ...holding(third.id), now: 60_000 }).map((due) => due.member.id),
    [other.id],
    'a member with a run stays while a member of its machine asks for one',
  )
  assert.equal(Pool.wakeAt(sql), 12_001)
  assert.deepEqual(
    Pool.due(sql, { ...holding(), now: 12_000 }).map((due) => due.member.id),
    [],
    'and for the notice after the last of them asked',
  )
  assert.deepEqual(
    Pool.due(sql, { ...holding(), now: 12_001 }).map((due) => [due.member.id, due.reason]),
    [
      [first.id, 'the runner stopped asking for a run while it had one'],
      [second.id, 'the runner stopped asking for a run while it had one'],
      [third.id, 'the runner stopped asking for a run'],
      [other.id, 'the runner stopped asking for a run while it had one'],
    ],
  )

  assert.equal(Pool.leaves(Pool.get(sql, first.id)!), true, 'a runner leaves with its run')
  assert.equal(Pool.end(sql, { id: first.id }), true)
  assert.equal(Pool.get(sql, first.id), undefined, 'a runner that left is no member any more')
  assert.equal(Pool.end(sql, { error: 'lost', id: second.id }), true)
  assert.equal(Pool.get(sql, second.id)!.state, 'failed')

  const sandbox = enroll(sql)
  assert.equal(Pool.leaves(sandbox), false, 'only its run gives a sandbox back')
  assert.deepEqual(
    Pool.due(sql, { ...holding(third.id, other.id), now: 500_000 }),
    [],
    "a sandbox that a run has is the run's to end",
  )
})

test('the members of a pool made before machines were named stay, and one with a run that asks no more is closed', () => {
  const sql = Rows.database()
  sql.run(Pool.tables[0]!.replace(/,\s+machine TEXT/, ''))
  sql.run(
    `INSERT INTO members (state, spec, token, capabilities, created_at, seen_at, idle_sec, notice_sec, usd, run, runs)
      VALUES ('assigned', ?, 't', ?, 0, 5000, 0, 60, 0, 'run-a', 1), ('idle', ?, 't', ?, 0, 5000, 0, 60, 0, NULL, 3),
        ('closed', ?, 't', ?, 0, 5000, 0, 60, 0, NULL, 2)`,
    ...Array.from({ length: 3 }, () => [
      JSON.stringify({ ...spec, kind: 'machine', provider: null, runtime: null, template: null }),
      JSON.stringify(capabilities),
    ]).flat(),
  )
  Pool.setup(sql)
  Pool.setup(sql)
  assert.deepEqual(
    Pool.all(sql).map((member) => [member.id, member.state, member.machine]),
    [
      [1, 'assigned', null],
      [2, 'idle', null],
      [3, 'closed', null],
    ],
  )
  assert.equal(Pool.wakeAt(sql), 65_001)
  const due = Pool.due(sql, { holding: (id) => id === 2, now: 65_001 })
  assert.deepEqual(
    due.map((entry) => [entry.member.id, entry.action]),
    [[1, 'close']],
    'the member whose runner was stopped with a run is closed, and the one that asks stays',
  )
  assert.equal(Pool.end(sql, { id: 1 }), true)
  assert.deepEqual(
    Pool.all(sql).map((member) => member.id),
    [2],
    'the runners that left before are no members either',
  )
})

test('what the pool pays is kept by member', () => {
  const sql = open()
  Pool.pay(sql, { at: 1, detail: '{"description":"compute.renew"}', member: 1, usd: 0.004 })
  Pool.pay(sql, { at: 2, detail: '{"description":"compute.terminate"}', member: 1, usd: 0.0001 })
  Pool.pay(sql, { at: 3, detail: '{"description":"compute.terminate"}', member: 2, usd: 0.0001 })
  assert.ok(Math.abs(Pool.spent(sql, 1) - 0.0041) < 1e-12)
  assert.ok(Math.abs(Pool.spent(sql) - 0.0042) < 1e-12)
  assert.equal(Pool.payments(sql).length, 3)
})
