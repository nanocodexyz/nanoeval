import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Cpus from '../sandbox/Cpus.ts'
import * as Pressure from '../sandbox/Pressure.ts'
import * as Admission from '../src/Admission.ts'

const file = (some: string) =>
  'some ' + some + ' avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'

test('the CPU pressure of a machine is the some avg10 and avg60 of its pressure file, and none where the file is missing', async () => {
  assert.deepEqual(Pressure.parse(file('avg10=12.77 avg60=22.98')), { avg10: 12.77, avg60: 22.98 })
  assert.deepEqual(Pressure.parse(file('avg10=0.00 avg60=0.00')), { avg10: 0, avg60: 0 })
  assert.equal(Pressure.parse('full avg10=1.00 avg60=1.00 avg300=1.00 total=1\n'), undefined)
  assert.equal(Pressure.parse(''), undefined)
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-pressure-'))
  Fs.writeFileSync(Path.join(root, 'cpu'), file('avg10=3.10 avg60=1.25'))
  assert.deepEqual(await Pressure.read(Path.join(root, 'cpu')), { avg10: 3.1, avg60: 1.25 })
  assert.equal(
    await Pressure.read(Path.join(root, 'none')),
    undefined,
    'a machine that does not report its pressure has no reading: the vCPU bound alone admits',
  )
})

test('the policy is what is named over the defaults of the measurements', () => {
  assert.deepEqual(Pressure.policy(undefined), { admit: 10, ceiling: 2, hold: 25, intervalSec: 10 })
  assert.equal(Pressure.defaults.intervalSec, Pressure.shortWindowSec)
  assert.deepEqual(Pressure.policy({ ceiling: 1.5, hold: 40 }), {
    admit: 10,
    ceiling: 1.5,
    hold: 40,
    intervalSec: 10,
  })
})

test('above the vCPU bound a row is admitted while pressure allows: it starts under the bounds, crosses hold, and comes back', () => {
  const threads = 48
  const bound = Cpus.vcpus(threads, { held: 0, perThread: Cpus.cpusPerThread })
  const ceiling = Cpus.vcpus(threads, { held: 0, perThread: Pressure.defaults.ceiling })
  const policy = Pressure.defaults
  const readings: [sec: number, avg10: number, avg60: number][] = [
    [0, 0, 0],
    [5, 0.5, 0.1],
    [10, 2, 0.4],
    [20, 9, 2],
    [30, 26, 6],
    [40, 31, 11],
    [50, 20, 12],
    [60, 4, 10],
    [70, 1, 9.99],
    [75, 1, 9],
    [80, 0.5, 8],
  ]
  let cpus = bound - 1
  let lastAt: number | undefined
  const seen: string[] = []
  for (const [sec, avg10, avg60] of readings) {
    const decided = Pressure.decide({
      bound,
      ceiling,
      cpus,
      lastAt,
      now: sec * 1000,
      policy,
      reading: { avg10, avg60 },
    })
    seen.push(sec + ' ' + cpus + ' ' + (decided.regime ?? 'bound') + (decided.over ? ' over' : ''))
    if (decided.over) lastAt = sec * 1000
    if (decided.over || decided.regime === undefined) cpus++
  }
  assert.deepEqual(seen, [
    '0 47 bound',
    '5 48 pressure over',
    '10 49 pressure',
    '20 49 pressure over',
    '30 50 hold',
    '40 50 hold',
    '50 50 wait',
    '60 50 wait',
    '70 50 pressure over',
    '75 51 pressure',
    '80 51 pressure over',
  ])
})

test('the ceiling ends admission by pressure, a hold is said before it, and a bound that is the ceiling admits nothing above itself', () => {
  const input = { bound: 48, ceiling: 96, lastAt: undefined, now: 0, policy: Pressure.defaults }
  const calm = { avg10: 0, avg60: 0 }
  assert.deepEqual(Pressure.decide({ ...input, cpus: 95, reading: calm }), {
    over: true,
    regime: 'pressure',
  })
  assert.deepEqual(Pressure.decide({ ...input, cpus: 96, reading: calm }), {
    over: false,
    regime: 'ceiling',
  })
  assert.deepEqual(Pressure.decide({ ...input, cpus: 96, reading: { avg10: 25.01, avg60: 0 } }), {
    over: false,
    regime: 'hold',
  })
  assert.deepEqual(Pressure.decide({ ...input, cpus: 60, reading: { avg10: 25, avg60: 9.99 } }), {
    over: true,
    regime: 'pressure',
  })
  assert.deepEqual(Pressure.decide({ ...input, ceiling: 48, cpus: 48, reading: calm }), {
    over: false,
    regime: 'ceiling',
  })
  assert.deepEqual(
    Pressure.decide({ ...input, cpus: 47, reading: { avg10: 90, avg60: 90 } }),
    { over: false },
    'under the vCPU bound the bound admits, whatever the pressure',
  )
  assert.deepEqual(
    Pressure.decide({
      ...input,
      cpus: 48,
      policy: { ...Pressure.defaults, intervalSec: 0 },
      lastAt: 0,
      reading: calm,
    }),
    { over: true, regime: 'pressure' },
  )
})

test('the offer above the bound is one row, counted against the ceiling and taken at the bound', () => {
  const capacity = { cpus: 48, memoryMb: 100_000, slots: 96 }
  const load = { cpus: 50, memoryMb: 20_000, running: 50 }
  assert.equal(Admission.offer(load, capacity).slots, 0, 'the bound admits nothing')
  const offer = Pressure.offer(Admission.offer(load, { ...capacity, cpus: 96 }), 48)
  assert.deepEqual(offer, {
    capacityMb: 100_000,
    cpus: { capacity: 48, free: 46 },
    memoryMb: 80_000,
    slots: 1,
  })
  const rows = [
    { cpus: 4, item: 'wide', memoryMb: 1000 },
    { cpus: 1, item: 'narrow', memoryMb: 1000 },
  ]
  assert.deepEqual(Admission.fill(rows, offer), ['wide'])
  assert.equal(
    Pressure.offer(Admission.offer({ ...load, running: 96 }, { ...capacity, cpus: 96 }), 48).slots,
    0,
    'the slots of the runner stay the most rows at once',
  )
})

test('a change of regime is one line, and a claim is marked with its pressure and its vCPUs in flight', () => {
  const facts = {
    bound: 48,
    ceiling: 96,
    cpus: 52,
    policy: Pressure.defaults,
    reading: { avg10: 31.2, avg60: 8 },
  }
  assert.equal(
    Pressure.line('hold', facts),
    'admission above the vCPU bound: held, some avg10 is over 25 % (52 declared vCPUs in flight, bound 48, ceiling 96, some avg10 31.20 % avg60 8.00 %)',
  )
  assert.match(Pressure.line('pressure', facts), /: CPU pressure admits a row every 10 s \(/)
  assert.match(Pressure.line('wait', facts), /: waits, some avg60 is not under 10 % \(/)
  assert.match(Pressure.line('ceiling', facts), /: at the ceiling of 96 declared vCPUs \(/)
  assert.deepEqual(
    Pressure.marks({ at: 7, cpus: 52, over: true, reading: { avg10: 3.1, avg60: 0 } }),
    [
      { at: 7, name: 'attempt.claim.over' },
      { at: 7, name: 'attempt.claim.some10.3.10' },
      { at: 7, name: 'attempt.claim.some60.0.00' },
      { at: 7, name: 'attempt.claim.vcpus.52' },
    ],
  )
  assert.deepEqual(Pressure.marks({ at: 7, cpus: 3, over: false, reading: undefined }), [
    { at: 7, name: 'attempt.claim.vcpus.3' },
  ])
  assert.deepEqual(Pressure.marks({ at: 7, cpus: undefined, over: false, reading: undefined }), [])
})
