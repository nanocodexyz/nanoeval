import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Import from '../cli/Import.ts'
import type * as Dataset from '../datasets/Dataset.ts'
import * as Converter from '../sandbox/Converter.ts'
import * as Store from '../sandbox/Store.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Eval from '../src/Eval.ts'

const greeting = Path.resolve(import.meta.dirname, '../tasks/write-greeting')
const stepMs = 50
const storageMb = 128
const temporary = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-import-'))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function* imaged(images: readonly string[]): AsyncIterable<Dataset.Case> {
  const base = await Import.readDirectory(greeting)
  for (const [index, image] of images.entries())
    yield {
      ...base,
      files: {
        ...base.files,
        'task.toml': Bytes.fromText(
          Bytes.toText(base.files['task.toml']!) + 'docker_image = "' + image + '"\n',
        ),
      },
      id: 'task-' + index,
    }
}

function world(waits: Record<string, number> = {}) {
  const root = temporary()
  const seen = { converted: [] as string[], most: 0, now: 0 }
  const options: Import.Options = {
    cache: Path.join(root, 'cache'),
    converter: {
      async convert(environment, disk) {
        seen.converted.push(environment.image!)
        seen.most = Math.max(seen.most, ++seen.now)
        await pause(waits[environment.image!] ?? stepMs)
        seen.now--
        if (environment.image!.startsWith('broken')) throw new Error('no such image')
        Fs.writeFileSync(disk, environment.image!)
        return {
          architecture: 'amd64',
          cmd: [],
          digest: 'sha256:' + environment.image,
          entrypoint: [],
          env: [Converter.defaultPath],
          user: '',
          workdir: '',
        }
      },
      format: 'fake',
      name: 'fake',
      pack: async (disk, file) => Fs.copyFileSync(disk, file),
      unpack: async (file, disk) => Fs.copyFileSync(file, disk),
    },
    format: 'disk',
    freeDiskMb: async () => Infinity,
    store: Store.directory(Path.join(root, 'store')),
  }
  const scratch = () =>
    Fs.readdirSync(Path.join(options.cache, 'scratch'), { withFileTypes: true }).map(
      (entry) => entry.name,
    )
  return { options, root, scratch, seen }
}

const digest = async (tasks: readonly Eval.Task[]) =>
  Eval.versionDigest({
    dataset: 'local',
    entries: await Promise.all(
      tasks.map(async (task) => ({ digest: await Eval.taskDigest(task), id: task.id })),
    ),
    source: {},
  })

test('an import converts as many tasks at once as its jobs, and its rows are those of one that converts them in turn', async () => {
  const images = ['a', 'b', 'c', 'd', 'e', 'f']
  const waits = Object.fromEntries(
    images.map((image, index) => [image, stepMs * (images.length - index)]),
  )
  const turn = world(waits)
  const first = await Import.cases(imaged(images), turn.options)
  assert.equal(turn.seen.most, 1)
  assert.deepEqual(turn.seen.converted, images)

  const lines: string[] = []
  const many = world(waits)
  const second = await Import.cases(imaged(images), {
    ...many.options,
    jobs: 3,
    log: (line) => lines.push(line.split(':')[0]!),
  })
  assert.equal(many.seen.most, 3)
  assert.notDeepEqual(lines, [...lines].sort(), 'a later task ended before an earlier one')
  assert.deepEqual(
    second.tasks.map((task) => task.id),
    images.map((_, index) => 'task-' + index),
  )
  assert.deepEqual(second.tasks, first.tasks)
  assert.equal(await digest(second.tasks), await digest(first.tasks))
  assert.deepEqual(
    second.timings.map((timing) => [timing.id, timing.reused]),
    first.timings.map((timing) => [timing.id, timing.reused]),
  )
  assert.deepEqual(many.scratch(), [])

  const again = await Import.cases(imaged(images), { ...many.options, jobs: 3 })
  assert.ok(again.timings.every((timing) => timing.reused))
  assert.deepEqual(again.tasks, first.tasks)
  for (const made of [turn, many]) Fs.rmSync(made.root, { recursive: true })
})

test('tasks of one image that are imported at once convert it once', async () => {
  const { options, root, seen } = world()
  const imported = await Import.cases(imaged(['same', 'same', 'other', 'same']), {
    ...options,
    jobs: 4,
  })
  assert.deepEqual([...seen.converted].sort(), ['other', 'same'])
  assert.deepEqual(imported.timings.map((timing) => timing.reused).sort(), [
    false,
    false,
    true,
    true,
  ])
  assert.equal(imported.timings[2]!.reused, false)
  const disks = imported.tasks.map((task) =>
    task.environment.kind === 'disk' ? task.environment.disk.digest : '',
  )
  assert.equal(disks[0], disks[1])
  assert.equal(disks[0], disks[3])
  assert.notEqual(disks[0], disks[2])
  Fs.rmSync(root, { recursive: true })
})

test('a conversion that fails ends the import once the ones beside it ended, and starts no other', async () => {
  const waits = { broken: stepMs, slow: stepMs * 5 }
  const failed = world(waits)
  await assert.rejects(
    Import.cases(imaged(['slow', 'broken', 'c', 'd']), { ...failed.options, jobs: 2 }),
    /^Error: task-1: no such image$/,
  )
  assert.deepEqual([...failed.seen.converted].sort(), ['broken', 'slow'])
  assert.deepEqual(failed.scratch(), [])
  const after = await Import.cases(imaged(['slow']), failed.options)
  assert.deepEqual(
    after.timings.map((timing) => timing.reused),
    [true],
    'the conversion beside the failed one was kept',
  )

  const kept = world(waits)
  const refused: string[] = []
  const imported = await Import.cases(imaged(['slow', 'broken', 'c', 'd']), {
    ...kept.options,
    jobs: 2,
    refused: (id) => refused.push(id),
  })
  assert.deepEqual(refused, ['task-1'])
  assert.deepEqual(
    imported.tasks.map((task) => task.id),
    ['task-0', 'task-2', 'task-3'],
  )
  assert.deepEqual(
    imported.timings.map((timing) => timing.id),
    ['task-0', 'task-2', 'task-3'],
  )
  for (const made of [failed, kept]) Fs.rmSync(made.root, { recursive: true })
})

test('a conversion waits while the disk has no room for its environment beside the ones being written', async () => {
  const images = ['a', 'b', 'c', 'd', 'e']
  const two = world()
  const imported = await Import.cases(imaged(images), {
    ...two.options,
    freeDiskMb: async () => storageMb * 2,
    jobs: images.length,
  })
  assert.equal(two.seen.most, 2)
  assert.equal(imported.tasks.length, images.length)

  const none = world()
  await Import.cases(imaged(images), {
    ...none.options,
    freeDiskMb: async () => 0,
    jobs: images.length,
  })
  assert.equal(none.seen.most, 1, 'a conversion alone is not held back')
  assert.equal(none.seen.converted.length, images.length)
  for (const made of [two, none]) Fs.rmSync(made.root, { recursive: true })
})
