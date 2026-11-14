import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Disks from '../sandbox/Disks.ts'

const hex = (character: string) => character.repeat(64)
const script = Path.resolve(import.meta.dirname, '../sandbox/slot.sh')

function cache() {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-disks-'))
  Fs.mkdirSync(Path.join(root, 'disks'))
  Fs.mkdirSync(Path.join(root, 'blobs'))
  return root
}

function file(path: string, at: number, bytes = 1) {
  Fs.writeFileSync(path, Buffer.alloc(bytes))
  Fs.utimesSync(path, at / 1000, at / 1000)
}

const day = 24 * 3600 * 1000
const now = Date.now()

function seeded() {
  const root = cache()
  const disk = (name: string, at: number, used?: number) => {
    file(Path.join(root, 'disks', name + '.ext4'), at)
    file(Path.join(root, 'disks', name + '.use'), at, 0)
    if (used !== undefined) file(Path.join(root, 'disks', name + '.workdir'), used)
  }
  disk(hex('a'), now - 9 * day, now - day)
  disk(hex('b'), now - 5 * day)
  disk(hex('c'), now - 8 * day)
  disk('other', now - 7 * day)
  Fs.writeFileSync(Path.join(root, 'disks', hex('b') + '.run-earlier'), '')
  file(Path.join(root, 'blobs', hex('d')), now - 6 * day)
  file(Path.join(root, 'blobs', hex('e')), now - 2 * day)
  file(Path.join(root, 'blobs', hex('f') + '.999999999-0a0b0c0d'), now - 3 * day)
  file(Path.join(root, 'blobs', hex('f') + '.' + process.pid + '-0a0b0c0d'), now - 4 * day)
  file(Path.join(root, 'blobs', 'notes.txt'), now - 10 * day)
  return root
}

test('the cache lists disks by their last use and blobs by theirs, oldest first, without what rows hold', async () => {
  const root = seeded()
  const ordered = Disks.order(await Disks.cached(root), new Set([hex('c'), hex('e')]))
  assert.deepEqual(
    ordered.map((entry) => [entry.kind, entry.name.slice(0, 5)]),
    [
      ['disk', 'other'],
      ['blob', 'ddddd'],
      ['disk', 'bbbbb'],
      ['staged', 'fffff'],
      ['disk', 'aaaaa'],
    ],
  )
})

test('a runner short of disk removes what no row needs, oldest first, until it has enough', async () => {
  const root = seeded()
  const dropped: string[] = []
  const lines: string[] = []
  let left = 3
  const removed = await Disks.collect({
    cache: root,
    async drop(prefix) {
      dropped.push(Path.basename(prefix))
      Fs.rmSync(prefix + '.ext4')
      return Disks.forget(prefix)
    },
    held: new Set([hex('c'), hex('e')]),
    log: (line) => lines.push(line),
    short: async () => left-- > 0,
  })
  assert.deepEqual(
    removed.map((entry) => entry.name.slice(0, 5)),
    ['other', 'ddddd', 'bbbbb'],
  )
  assert.deepEqual(dropped, ['other', hex('b')])
  assert.equal(lines.length, 3)
  assert.deepEqual(Fs.readdirSync(Path.join(root, 'disks')).sort(), [
    hex('a') + '.ext4',
    hex('a') + '.use',
    hex('a') + '.workdir',
    hex('c') + '.ext4',
    hex('c') + '.use',
  ])
  assert.deepEqual(Fs.readdirSync(Path.join(root, 'blobs')).sort(), [
    hex('e'),
    hex('f') + '.' + process.pid + '-0a0b0c0d',
    hex('f') + '.999999999-0a0b0c0d',
    'notes.txt',
  ])
})

test('a disk that its owner keeps, such as one a slot uses, stays with its files', async () => {
  const root = seeded()
  const removed = await Disks.collect({
    cache: root,
    drop: async (prefix) => Disks.forget(prefix),
    held: new Set(),
    log: () => {},
    short: async () => true,
  })
  assert.deepEqual(
    removed.map((entry) => entry.kind),
    ['blob', 'staged', 'blob'],
  )
  assert.equal(
    Fs.readdirSync(Path.join(root, 'disks')).filter((name) => name.endsWith('.ext4')).length,
    4,
  )
  assert.ok(Fs.existsSync(Path.join(root, 'disks', hex('b') + '.run-earlier')))
})

test('a runner with enough disk removes nothing', async () => {
  const root = seeded()
  const removed = await Disks.collect({
    cache: root,
    drop: async () => assert.fail('nothing is dropped'),
    held: new Set(),
    log: () => {},
    short: async () => false,
  })
  assert.deepEqual(removed, [])
})

test('slot.sh keeps a disk that a slot holds and removes the rest', async () => {
  const root = seeded()
  const use = Path.join(root, 'disks', hex('b') + '.use')
  const holder = spawn('flock', ['-s', use, 'sleep', '60'], { stdio: 'ignore' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    const removed = await Disks.collect({
      cache: root,
      async drop(prefix) {
        execFileSync('bash', [script, 'drop', prefix], {
          env: { ...process.env, NANOEVAL_CACHE: root, NANOEVAL_HOME: Path.join(root, 'home') },
        })
        return Disks.forget(prefix)
      },
      held: new Set(),
      log: () => {},
      short: async () => true,
    })
    assert.deepEqual(
      removed.filter((entry) => entry.kind === 'disk').map((entry) => entry.name.slice(0, 5)),
      ['ccccc', 'other', 'aaaaa'],
    )
    assert.deepEqual(Fs.readdirSync(Path.join(root, 'disks')).sort(), [
      hex('b') + '.ext4',
      hex('b') + '.run-earlier',
      hex('b') + '.use',
    ])
  } finally {
    holder.kill()
  }
})
