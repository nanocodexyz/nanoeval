import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Import from '../cli/Import.ts'
import { client, importEval, loadTask } from '../cli/nanoeval.ts'
import * as Disks from '../sandbox/Disks.ts'
import * as Prune from '../sandbox/Prune.ts'
import * as Store from '../sandbox/Store.ts'
import type * as Eval from '../src/Eval.ts'
import * as Rows from './Rows.ts'

const greeting = Path.resolve(import.meta.dirname, '../tasks/write-greeting')
const temporary = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-prune-'))

function worker(evals: Record<string, readonly Eval.Task[][]>): Prune.Api {
  return {
    eval: async (reference) => {
      const [name, version] = reference.split('@')
      return { tasks: evals[name!]![Number(version)]! }
    },
    evals: async () => ({ evals: Object.keys(evals).map((name) => ({ name })) }),
    versions: async (name) => ({
      versions: evals[name]!.map((_, index) => ({ digest: String(index) })),
    }),
  }
}

async function fixture() {
  const root = temporary()
  const directory = Path.join(root, 'store')
  const store = Store.directory(directory)
  const add = (text: string) => Store.addBytes(store, { bytes: Buffer.from(text), scratch: root })
  const base = Rows.row(await loadTask(greeting))
  const blobs = {
    disk: await add('a disk'),
    files: await add('environment files'),
    instruction: await add('an instruction'),
    later: await add('the disk of a later version'),
    solution: await add('a solution'),
    tests: await add('tests'),
  }
  const disk = (blob: Eval.Blob): Eval.Environment =>
    base.environment.kind === 'disk' ? { ...base.environment, disk: blob } : base.environment
  const first: Eval.Task = {
    ...base,
    environment: disk(blobs.disk),
    instruction: blobs.instruction,
    solution: { archive: blobs.solution, env: {} },
    tests: blobs.tests,
  }
  const second: Eval.Task = { ...first, environment: disk(blobs.later) }
  const third: Eval.Task = {
    ...base,
    environment: { files: blobs.files, kind: 'dir' },
    instruction: blobs.instruction,
    tests: blobs.tests,
  }
  const api = worker({ files: [[third]], images: [[first], [second]] })
  const lines: string[] = []
  return {
    add,
    api,
    blobs,
    directory,
    lines,
    options: (remove: boolean): Prune.store.Options => ({
      allowEmpty: false,
      api,
      log: (line) => lines.push(line),
      remove,
      root: directory,
    }),
    prefix: (blob: Eval.Blob) => Path.join(directory, 'sha256', blob.digest.slice(0, 2)),
    root,
    store,
  }
}

test('a prune lists the blobs no eval version names and removes them only when asked', async () => {
  const lab = await fixture()
  const orphans = [await lab.add('left by an import'), await lab.add('left by another')].sort(
    (left, right) => (left.digest < right.digest ? -1 : 1),
  )
  const references = await Prune.referenced(lab.api)
  assert.deepEqual(
    [...references.digests].sort(),
    Object.values(lab.blobs)
      .map((blob) => blob.digest)
      .sort(),
  )
  assert.equal(references.evals, 2)
  assert.equal(references.versions, 3)

  const listed = await Prune.store(lab.options(false))
  assert.deepEqual(
    listed.unreferenced.map((entry) => [entry.kind, entry.name, entry.bytes]),
    orphans.map((blob) => ['blob', blob.digest, blob.bytes]),
  )
  assert.equal(listed.kept.length, 6)
  assert.equal(listed.missing, 0)
  const bytes = orphans[0]!.bytes + orphans[1]!.bytes
  const kept = Object.values(lab.blobs).reduce((sum, blob) => sum + blob.bytes, 0)
  assert.deepEqual(lab.lines, [
    'referenced: 6 blobs by 3 versions of 2 evals, 0 of them not in this store',
    'unreferenced blob ' + orphans[0]!.digest + ' ' + orphans[0]!.bytes + ' bytes',
    'unreferenced blob ' + orphans[1]!.digest + ' ' + orphans[1]!.bytes + ' bytes',
    'total: 2 unreferenced, ' + bytes + ' bytes; 6 kept, ' + kept + ' bytes',
  ])
  for (const blob of orphans) assert.equal(await lab.store.has(blob.digest), true)
  assert.equal(Fs.existsSync(Path.join(lab.directory, 'lock')), false)

  lab.lines.length = 0
  const removed = await Prune.store(lab.options(true))
  assert.equal(removed.removed, true)
  assert.deepEqual(lab.lines.slice(1), [
    'removed blob ' + orphans[0]!.digest + ' ' + orphans[0]!.bytes + ' bytes',
    'removed blob ' + orphans[1]!.digest + ' ' + orphans[1]!.bytes + ' bytes',
    'total: 2 removed, ' + bytes + ' bytes; 6 kept, ' + kept + ' bytes',
  ])
  for (const blob of orphans) assert.equal(await lab.store.has(blob.digest), false)
  for (const blob of Object.values(lab.blobs)) assert.equal(await lab.store.has(blob.digest), true)
  assert.deepEqual((await Prune.store(lab.options(true))).unreferenced, [])
  Fs.rmSync(lab.root, { force: true, recursive: true })
})

test('a prune removes what a dead import staged and leaves what it does not know', async () => {
  const lab = await fixture()
  const prefix = lab.prefix(lab.blobs.disk)
  const short = Path.basename(prefix)
  const staged = lab.blobs.disk.digest + '.4242-0a1b2c3d'
  const misplaced = (short === 'ff' ? '0' : 'f').repeat(64)
  Fs.writeFileSync(Path.join(prefix, staged), 'half a disk')
  Fs.writeFileSync(Path.join(prefix, 'notes.txt'), 'not ours')
  Fs.writeFileSync(Path.join(prefix, misplaced), 'under the wrong prefix')
  Fs.writeFileSync(Path.join(lab.directory, 'sha256', 'README'), 'not ours')

  const listed = await Prune.store(lab.options(false))
  assert.deepEqual(
    listed.unreferenced.map((entry) => [entry.kind, entry.name, entry.bytes]),
    [['staged', short + '/' + staged, 11]],
  )
  assert.deepEqual(listed.unknown.map((entry) => entry.name).sort(), [
    'README',
    short + '/' + misplaced,
    short + '/notes.txt',
  ])
  assert.ok(lab.lines.includes('unreferenced staged ' + short + '/' + staged + ' 11 bytes'))
  assert.ok(lab.lines.includes('unknown ' + short + '/notes.txt'))

  await Prune.store(lab.options(true))
  assert.deepEqual(
    Fs.readdirSync(prefix).sort(),
    [lab.blobs.disk.digest, misplaced, 'notes.txt'].sort(),
  )
  assert.equal(Fs.existsSync(Path.join(lab.directory, 'sha256', 'README')), true)
  Fs.rmSync(lab.root, { force: true, recursive: true })
})

test('a removal is refused while an import holds the store', async () => {
  const lab = await fixture()
  const orphan = await lab.add('left by an import')
  const first = await lab.store.hold()
  const second = await lab.store.hold()
  await assert.rejects(Prune.store(lab.options(true)), Store.LockedError)
  assert.equal(await lab.store.has(orphan.digest), true)
  assert.equal((await Prune.store(lab.options(false))).unreferenced.length, 1)
  await first.release()
  await assert.rejects(Prune.store(lab.options(true)), Store.LockedError)
  await second.release()
  assert.equal((await Prune.store(lab.options(true))).unreferenced.length, 1)
  assert.equal(await lab.store.has(orphan.digest), false)
  Fs.rmSync(lab.root, { force: true, recursive: true })
})

test('a removal that would empty the store is refused unless it is allowed', async () => {
  const lab = await fixture()
  const prefixes = () => Fs.readdirSync(Path.join(lab.directory, 'sha256')).length
  const before = prefixes()
  const none = { ...lab.options(true), api: worker({}) }
  await assert.rejects(Prune.store(none), (error: Error) => {
    assert.ok(error instanceof Prune.EmptyError)
    assert.match(error.message, /lists no eval/)
    return true
  })
  const other = {
    ...lab.options(true),
    api: worker({ other: [[Rows.row(await loadTask(greeting))]] }),
  }
  await assert.rejects(Prune.store(other), (error: Error) => {
    assert.ok(error instanceof Prune.EmptyError)
    assert.match(error.message, /the 1 evals of the Worker name no blob/)
    return true
  })
  for (const blob of Object.values(lab.blobs)) assert.equal(await lab.store.has(blob.digest), true)
  lab.lines.length = 0
  await Prune.store({ ...none, remove: false })
  assert.equal(
    lab.lines.at(-1),
    'no blob of this store is referenced: --remove is refused without --allow-empty',
  )
  assert.equal(prefixes(), before)
  await assert.rejects(
    Prune.store({ ...none, root: Path.join(lab.root, 'absent') }),
    Prune.MissingError,
  )
  assert.equal(Fs.existsSync(Path.join(lab.root, 'absent')), false)

  const emptied = await Prune.store({ ...none, allowEmpty: true })
  assert.equal(emptied.unreferenced.length, 6)
  for (const blob of Object.values(lab.blobs)) assert.equal(await lab.store.has(blob.digest), false)
  assert.deepEqual((await Prune.store(none)).unreferenced, [])
  Fs.rmSync(lab.root, { force: true, recursive: true })
})

test('what an import wrote is named by its version and is kept', async () => {
  const root = temporary()
  const directory = Path.join(root, 'store')
  const versions: Eval.Task[][] = []
  const api: ReturnType<typeof client> = {
    ...client({ token: 'unused', url: 'http://127.0.0.1:9' }),
    putVersion: async (name, body) => {
      versions.push([...body.tasks])
      return {
        name,
        version: {
          createdAt: 0,
          dataset: body.dataset,
          digest: '0'.repeat(64),
          parent: null,
          source: body.source,
          tasks: body.tasks.length,
        },
      }
    },
  }
  await importEval(api, {
    backend: 'dir',
    cache: Path.join(root, 'cache'),
    cases: Import.directories([greeting]),
    dataset: 'local',
    layers: Path.join(root, 'layers'),
    name: 'local',
    source: {},
    store: Store.directory(directory),
  })
  const pruned = await Prune.store({
    allowEmpty: false,
    api: worker({ local: versions }),
    log: () => {},
    remove: true,
    root: directory,
  })
  assert.deepEqual(pruned.unreferenced, [])
  assert.equal(pruned.kept.length, 4)
  assert.equal(pruned.missing, 0)
  Fs.rmSync(root, { force: true, recursive: true })
})

test('a runner short of disk removes the disks of its run that none of its rows uses', () => {
  const mark = '.run-r1'
  const names = [
    'aa.ext4',
    'aa.run-r1',
    'aa.use',
    'bb.ext4',
    'bb.run-r1',
    'cc.ext4',
    'cc.run-r2',
    'dd.ext4',
    'ee.run-r1',
    'mounts.lock',
  ]
  assert.deepEqual(Disks.idle(names, { held: new Set(['bb']), mark }), ['aa'])
  assert.deepEqual(Disks.idle(names, { held: new Set(), mark }), ['aa', 'bb'])
  assert.deepEqual(Disks.idle([], { held: new Set(), mark }), [])
})
