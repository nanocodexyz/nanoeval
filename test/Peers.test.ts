import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Cpus from '../sandbox/Cpus.ts'
import * as Peers from '../sandbox/Peers.ts'

function cache(files: Record<string, string>): string {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-peers-'))
  Fs.mkdirSync(Peers.directory(root), { recursive: true })
  for (const [name, content] of Object.entries(files))
    Fs.writeFileSync(Path.join(Peers.directory(root), name), content)
  return root
}

const range = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index)

test('a runner writes its slots and its threads under the cache, one file for each run it serves', async () => {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-peers-'))
  const file = Peers.file({ cache: root, pid: 41, run: 'run-a' })
  assert.equal(file, Path.join(root, 'runners', '41.run-a.json'))
  await Peers.write(file, { slots: 72, threads: range(12, 47) })
  assert.deepEqual(await Peers.others({ alive: () => true, cache: root, pid: 7 }), [
    { slots: 72, threads: range(12, 47) },
  ])
  assert.deepEqual(await Peers.others({ alive: () => true, cache: root, pid: 41 }), [])
})

test('the file of a runner whose process is gone is passed over, and so is one that does not parse', async () => {
  const root = cache({
    '11.run-a.json': JSON.stringify({ slots: 24 }),
    '12.run-a.json': JSON.stringify({ slots: 48 }),
    '13.run-b.json': '{"slots":',
    '14.run-b.json': JSON.stringify({ slots: 0 }),
    'notes.txt': JSON.stringify({ slots: 9 }),
  })
  assert.deepEqual(await Peers.others({ alive: (pid) => pid !== 12, cache: root, pid: 1 }), [
    { slots: 24 },
  ])
  assert.deepEqual(
    await Peers.others({ alive: () => true, cache: Path.join(root, 'none'), pid: 1 }),
    [],
    'no runner has written under this cache',
  )
})

test('a runner that serves several runs on the same slots counts once, by its largest count', async () => {
  const root = cache({
    '11.run-a.json': JSON.stringify({ slots: 24 }),
    '11.run-b.json': JSON.stringify({ slots: 40 }),
    '11.run-c.json': JSON.stringify({ slots: 8 }),
  })
  assert.deepEqual(await Peers.others({ alive: () => true, cache: root, pid: 1 }), [{ slots: 40 }])
})

test('the process of this very test is alive and a process id that no process has is not', () => {
  assert.equal(Peers.alive(process.pid), true)
  assert.equal(Peers.alive(2 ** 31 - 1), false)
})

test('the slots of another runner count on the threads the two share', () => {
  assert.equal(Peers.held(range(0, 47), [{ slots: 72, threads: range(0, 47) }]), 72)
  assert.equal(Peers.held(range(24, 47), [{ slots: 48, threads: range(0, 23) }]), 0)
  assert.equal(
    Peers.held(range(12, 47), [{ slots: 96, threads: range(0, 47) }]),
    72,
    'three quarters of its threads are shared',
  )
  assert.equal(Peers.held(range(0, 47), [{ slots: 24 }]), 24, 'a runner that names no threads')
  assert.equal(Peers.held(undefined, [{ slots: 24, threads: range(0, 11) }]), 24)
  assert.equal(
    Peers.held(range(0, 47), [
      { slots: 24, threads: range(0, 11) },
      { slots: 36, threads: range(12, 47) },
    ]),
    60,
  )
  assert.equal(Peers.held(range(0, 47), []), 0)
})

test('a second runner on the threads of the first has what is left of two a thread', () => {
  const threads = range(0, 47)
  const first = { slots: Cpus.slots(threads.length, 0), threads }
  assert.equal(first.slots, 96)
  assert.equal(Cpus.slots(threads.length, Peers.held(threads, [first])), 1)
  assert.equal(
    Cpus.slots(threads.length, Peers.held(threads, [{ slots: 72, threads }])),
    24,
    'a first runner that was given 72',
  )
  assert.equal(
    Cpus.slots(24, Peers.held(range(24, 47), [{ slots: 48, threads: range(0, 23) }])),
    48,
    'two runners that are pinned apart each have their own threads',
  )
})
