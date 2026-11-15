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
  await Peers.write(file, { cpus: 36, slots: 72, threads: range(12, 47) })
  assert.deepEqual(await Peers.others({ alive: () => true, cache: root, pid: 7 }), [
    { cpus: 36, slots: 72, threads: range(12, 47) },
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

test('the slots and the vCPUs of another runner count on the threads the two share', () => {
  assert.deepEqual(Peers.held(range(0, 47), [{ cpus: 48, slots: 72, threads: range(0, 47) }]), {
    cpus: 48,
    slots: 72,
  })
  assert.deepEqual(Peers.held(range(24, 47), [{ cpus: 24, slots: 48, threads: range(0, 23) }]), {
    cpus: 0,
    slots: 0,
  })
  assert.deepEqual(
    Peers.held(range(12, 47), [{ cpus: 48, slots: 96, threads: range(0, 47) }]),
    { cpus: 36, slots: 72 },
    'three quarters of its threads are shared',
  )
  assert.deepEqual(
    Peers.held(range(0, 47), [{ slots: 24 }]),
    { cpus: 24, slots: 24 },
    'a runner that names no threads, and counts no vCPUs: each of its slots is one at least',
  )
  assert.deepEqual(Peers.held(undefined, [{ cpus: 12, slots: 24, threads: range(0, 11) }]), {
    cpus: 12,
    slots: 24,
  })
  assert.deepEqual(
    Peers.held(range(0, 47), [
      { cpus: 12, slots: 24, threads: range(0, 11) },
      { slots: 36, threads: range(12, 47) },
    ]),
    { cpus: 48, slots: 60 },
  )
  assert.deepEqual(Peers.held(range(0, 47), []), { cpus: 0, slots: 0 })
})

test('a second runner on the threads of the first has what is left of two slots and of one vCPU a thread', () => {
  const threads = range(0, 47)
  const first = {
    cpus: Cpus.vcpus(threads.length, { held: 0, perThread: Cpus.cpusPerThread }),
    slots: Cpus.slots(threads.length, 0),
    threads,
  }
  assert.deepEqual([first.cpus, first.slots], [48, 96])
  const left = Peers.held(threads, [first])
  assert.equal(Cpus.slots(threads.length, left.slots), 1)
  assert.equal(Cpus.vcpus(threads.length, { held: left.cpus, perThread: 1 }), 1)
  assert.equal(
    Cpus.slots(threads.length, Peers.held(threads, [{ slots: 72, threads }]).slots),
    24,
    'a first runner that was given 72',
  )
  const apart = Peers.held(range(24, 47), [{ cpus: 24, slots: 48, threads: range(0, 23) }])
  assert.deepEqual(
    [Cpus.slots(24, apart.slots), Cpus.vcpus(24, { held: apart.cpus, perThread: 1 })],
    [48, 24],
    'two runners that are pinned apart each have their own threads',
  )
})
