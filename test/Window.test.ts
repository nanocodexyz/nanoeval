import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Window from '../src/Window.ts'

const before = [
  'at 1000000',
  'threads 2-3',
  'cpu0 100 0 50 800 50 0 0 0 0 0',
  'cpu1 100 0 50 800 50 0 0 0 0 0',
  'cpu2 100 0 50 800 50 0 0 0 0 0',
  'cpu3 100 0 50 800 50 0 0 0 0 0',
  'some avg10=1.00 avg60=2.00 avg300=3.00 total=5000000',
  'own 4000000',
  'guest cpu 10 0 10 100 0 0 0 4 0 0',
].join('\n')

const after = [
  'at 1002000',
  'threads 2-3',
  'cpu0 300 0 50 800 50 0 0 0 0 0',
  'cpu1 100 0 50 1000 50 0 0 0 0 0',
  'cpu2 300 0 50 800 50 0 0 0 0 0',
  'cpu3 200 0 50 900 50 0 0 0 0 0',
  'some avg10=1.00 avg60=2.00 avg300=3.00 total=5300000',
  'own 6400000',
  'guest cpu 150 0 30 120 0 0 0 24 0 0',
].join('\n')

test('load reads the busy share of the threads a verifier ran on, not of the machine', () => {
  assert.deepEqual(Window.load({ after, before }), {
    busy: 0.75,
    endedAt: 1002000,
    own: 0.6,
    pressure: 0.15,
    startedAt: 1000000,
    steal: 0.1,
    threads: [2, 3],
  })
})

test('load keeps the wait for threads and says when they were reserved', () => {
  const found = Window.load({ after, before, reserved: true, waitMs: 1200 })
  assert.equal(found?.reserved, true)
  assert.equal(found?.waitMs, 1200)
})

test('load leaves out what a machine or a guest does not report', () => {
  const bare = (text: string) =>
    text
      .split('\n')
      .filter((line) => /^(at|threads|cpu)/.test(line))
      .join('\n')
  assert.deepEqual(Window.load({ after: bare(after), before: bare(before) }), {
    busy: 0.75,
    endedAt: 1002000,
    startedAt: 1000000,
    threads: [2, 3],
  })
  const short = (text: string) => text.replace(/^guest .*$/m, 'guest cpu 10 0 10 100')
  assert.equal(Window.load({ after: short(after), before: short(before) })?.steal, undefined)
})

test('load reads the threads at the end of the window, and no share of a window without time', () => {
  const moved = Window.load({ after: after.replace('threads 2-3', 'threads 0'), before })
  assert.deepEqual(moved?.threads, [0])
  assert.equal(moved?.busy, 1)
  const still = Window.load({ after: before, before })
  assert.equal(still?.busy, undefined)
  assert.equal(still?.pressure, undefined)
})

test('load is nothing when a snapshot is missing or names no thread', () => {
  assert.equal(Window.load({ after: '', before }), undefined)
  assert.equal(Window.load({ after, before: 'at 5\n' }), undefined)
  assert.equal(Window.load({ after: after.replace('threads 2-3', 'threads x'), before }), undefined)
  assert.equal(Window.load({ after: before, before: after }), undefined)
})

test('list and ranges read and write the thread lists of the kernel', () => {
  assert.deepEqual(Window.list('0-2,5,7-8'), [0, 1, 2, 5, 7, 8])
  assert.equal(Window.list('0-2,'), undefined)
  assert.equal(Window.ranges([8, 0, 1, 2, 5, 7]), '0-2,5,7-8')
  assert.equal(Window.ranges([3]), '3')
})

test('text names the threads, the load of others, the steal, the pressure and the wait', () => {
  assert.equal(
    Window.text({ ...Window.load({ after, before, reserved: true, waitMs: 1200 })! }),
    'verify_cpus=2-3 reserved (busy 75.0 %, others 15.0 %, steal 10.0 %, pressure 15.0 %, waited 1.2 s, 2.0 s)',
  )
  assert.equal(
    Window.text({ endedAt: 1500, startedAt: 1000, threads: [0, 1, 2, 3] }),
    'verify_cpus=0-3 (0.5 s)',
  )
})
