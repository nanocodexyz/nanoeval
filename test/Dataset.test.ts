import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Zlib from 'node:zlib'
import * as Import from '../cli/Import.ts'
import { readTask } from '../cli/nanoeval.ts'
import * as Catalog from '../datasets/Catalog.ts'
import * as Csv from '../datasets/Csv.ts'
import * as Dataset from '../datasets/Dataset.ts'
import * as GpqaDiamond from '../datasets/GpqaDiamond.ts'
import * as HarborHub from '../datasets/HarborHub.ts'
import * as HealthBench from '../datasets/HealthBench.ts'
import * as PythonRandom from '../datasets/PythonRandom.ts'
import * as Source from '../datasets/Source.ts'
import * as SweBench from '../datasets/SweBench.ts'
import * as Zip from '../datasets/Zip.ts'
import * as Store from '../sandbox/Store.ts'
import * as Config from '../src/Config.ts'
import * as Eval from '../src/Eval.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Judge from '../src/Judge.ts'
import * as Tar from '../src/Tar.ts'
import * as Task from '../src/Task.ts'
import * as Rows from './Rows.ts'

const fixtures = Path.join(import.meta.dirname, 'fixtures/datasets')
const fixture = (name: string) => Fs.readFileSync(Path.join(fixtures, name), 'utf8')
const temporary = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-dataset-'))

const adapter = (cases: Dataset.Case[]): Dataset.Adapter => ({
  async *cases(context) {
    const ids = Dataset.select(
      cases.map((item) => item.id),
      context,
    )
    for (const item of cases) if (ids.includes(item.id)) yield item
  },
  description: 'a fixture',
  name: 'fixture',
  proof: 'unit tests',
  source: { kind: 'fixture', revision: '1' },
  state: 'verified',
})

const run = (tasks: Task.Task[], extra: Partial<Config.Config> = {}) => {
  const config = Config.parse({
    agents: [{ id: 'agent', model: 'model', provider: 'claude' }],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'fixture' },
    limits: { attachSec: 1, claims: 1, leaseSec: 1, setupSec: 1, stepRetries: 0 },
    name: 'run',
    sandbox: {
      backend: 'krun',
      max: 1,
      network: 'host',
      pollMs: 1,
      provider: 'local',
      slots: 1,
      timeoutSec: 60,
    },
    ...extra,
  })
  Config.check(
    config,
    tasks.map((task) => Rows.row(task)),
  )
  return config
}

async function registry(options: { tamper?: boolean } = {}) {
  const source = await readTask('tasks/write-greeting')
  const digest = await Task.checksum(source.files)
  const pack = (files: Record<string, Uint8Array>) =>
    Zlib.gzipSync(
      Tar.pack(
        Object.entries(files).map(([path, data]) => ({
          data,
          executable: source.executable?.includes(path) ?? false,
          path,
        })),
      ),
    )
  const archive = pack(
    options.tamper
      ? { ...source.files, 'instruction.md': Bytes.fromText('Do something else.\n') }
      : source.files,
  )
  const version = 'ab'.repeat(32)
  const requests: string[] = []
  const store = (root: string, online = true): Source.Store => ({
    async fetch(url, init) {
      requests.push(url)
      const { pathname, searchParams } = new URL(url)
      if (!online || init?.headers?.['apikey'] !== HarborHub.hub.key)
        return new Response('', { status: 503 })
      if (pathname === '/rest/v1/dataset_version')
        return Response.json(
          searchParams.get('content_hash') === 'eq.' + version ? [{ id: 'version-1' }] : [],
        )
      if (pathname === '/rest/v1/dataset_version_task')
        return Response.json([
          {
            task_version: {
              archive_path: 'fixture/write-greeting/' + digest + '/dist.tar.gz',
              content_hash: digest,
              package: { name: 'write-greeting' },
            },
          },
        ])
      if (
        pathname ===
        '/storage/v1/object/packages/fixture/write-greeting/' + digest + '/dist.tar.gz'
      )
        return new Response(archive)
      return new Response('', { status: 404 })
    },
    root,
  })
  const create = (tasks: string) =>
    HarborHub.create({
      description: 'a fixture',
      name: 'fixture',
      package: 'fixture/suite',
      proof: 'unit tests',
      state: 'verified',
      tasks,
      version,
    })
  return { create, digest, requests, source, store }
}

function encrypted(name: string, contents: Uint8Array, password: string): Uint8Array {
  const table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    return value >>> 0
  })
  const keys = [0x12345678, 0x23456789, 0x34567890]
  const update = (byte: number) => {
    keys[0] = (table[(keys[0]! ^ byte) & 0xff]! ^ (keys[0]! >>> 8)) >>> 0
    keys[1] = (Math.imul((keys[1]! + (keys[0]! & 0xff)) >>> 0, 134775813) + 1) >>> 0
    keys[2] = (table[(keys[2]! ^ (keys[1]! >>> 24)) & 0xff]! ^ (keys[2]! >>> 8)) >>> 0
  }
  for (const byte of Bytes.fromText(password)) update(byte)
  const checksum = Zlib.crc32(contents)
  const plain = Buffer.concat([Buffer.alloc(11, 7), Buffer.from([checksum >>> 24]), contents])
  const data = Buffer.from(
    plain.map((byte) => {
      const mask = (keys[2]! | 2) & 0xffff
      update(byte)
      return byte ^ ((Math.imul(mask, mask ^ 1) >>> 8) & 0xff)
    }),
  )
  const file = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(1, 6)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(contents.length, 22)
  local.writeUInt16LE(file.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(1, 8)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(contents.length, 24)
  central.writeUInt16LE(file.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + file.length, 12)
  end.writeUInt32LE(local.length + file.length + data.length, 16)
  return Buffer.concat([local, file, data, central, file, end])
}

test('a registry dataset is imported by digest, byte for byte, and then from the cache', async () => {
  const hub = await registry()
  const root = temporary()
  const out = Path.join(root, 'out')
  const pinned = hub.create(HarborHub.tasksDigest([hub.digest]))

  const manifest = await Dataset.write(pinned, {
    out,
    store: hub.store(Path.join(root, 'sources')),
  })
  assert.deepEqual(manifest.tasks, [
    { checksum: 'sha256:' + hub.digest, id: 'write-greeting', name: 'nanoeval/write-greeting' },
  ])
  assert.equal(manifest.source['tasks'], 'sha256:' + HarborHub.tasksDigest([hub.digest]))
  const imported = await readTask(Path.join(out, 'write-greeting'))
  assert.deepEqual(imported.files, hub.source.files)
  assert.deepEqual(imported.executable, hub.source.executable)
  assert.deepEqual(JSON.parse(Fs.readFileSync(Path.join(out, 'dataset.json'), 'utf8')), manifest)

  const before = hub.requests.filter((url) => url.includes('/storage/')).length
  await Dataset.write(pinned, { out, store: hub.store(Path.join(root, 'sources')) })
  assert.equal(hub.requests.filter((url) => url.includes('/storage/')).length, before)
  Fs.rmSync(root, { recursive: true })
})

test('a registry dataset is refused when its task list or an archive does not match the pin', async () => {
  const root = temporary()
  const hub = await registry()
  await assert.rejects(
    Dataset.write(hub.create('00'.repeat(32)), {
      out: Path.join(root, 'a'),
      store: hub.store(root),
    }),
    HarborHub.DigestError,
  )
  const tampered = await registry({ tamper: true })
  await assert.rejects(
    Dataset.write(tampered.create(HarborHub.tasksDigest([tampered.digest])), {
      out: Path.join(root, 'b'),
      store: tampered.store(Path.join(root, 'other')),
    }),
    /unpacks to sha256:/,
  )
  await assert.rejects(
    Dataset.write(hub.create(HarborHub.tasksDigest([hub.digest])), {
      out: Path.join(root, 'c'),
      store: hub.store(Path.join(root, 'offline'), false),
    }),
    Source.FetchError,
  )
  Fs.rmSync(root, { recursive: true })
})

test('a download is kept under its digest and refused when it does not match', async () => {
  const root = temporary()
  const bytes = Bytes.fromText('pinned\n')
  let fetched = 0
  const store: Source.Store = {
    fetch: async () => {
      fetched++
      return new Response('pinned\n')
    },
    root,
  }
  const sha256 = Source.sha256(bytes)
  for (let count = 0; count < 2; count++)
    assert.equal(
      Bytes.toText(await Source.download(store, { sha256, url: 'https://example.test/a' })),
      'pinned\n',
    )
  assert.equal(fetched, 1)
  await assert.rejects(
    Source.download(store, { sha256: '00'.repeat(32), url: 'https://example.test/a' }),
    Source.StaleError,
  )
  Fs.rmSync(root, { recursive: true })
})

test('a SWE-bench instance becomes a task in its official image with a hidden gold patch', async () => {
  const row = JSON.parse(fixture('swe-bench-row.json')) as Record<string, unknown>
  const item = SweBench.task(row, await Dataset.assets('swe-bench'))
  assert.equal(item.id, 'psf__requests-0001')

  const task = await Task.load(item)
  assert.equal(task.name, 'swe-bench-verified/psf__requests-0001')
  assert.equal(
    task.environment.dockerImage,
    'swebench/sweb.eval.x86_64.psf_1776_requests-0001:latest',
  )
  assert.equal(task.instruction, row['problem_statement'])
  assert.deepEqual(Object.keys(task.files).sort(), [
    'tests/grade.py',
    'tests/instance.json',
    'tests/test.sh',
  ])
  assert.deepEqual(JSON.parse(Bytes.toText(item.files['tests/instance.json']!)), row)
  assert.ok(!task.instruction.includes('gold-line'))

  const oracle = await Task.load(item, { solution: true })
  assert.equal(Bytes.toText(Bytes.fromBase64(oracle.files['solution/patch.diff']!)), row['patch'])
  assert.throws(() => SweBench.task({ ...row, test_patch: '' }, {}), Dataset.SelectionError)
})

test('GPQA rows keep the seed-zero choice order of the authors and answer in the final message', async () => {
  const random = PythonRandom.seedZero()
  const orders = Array.from({ length: 6 }, () => {
    const values = [0, 1, 2, 3]
    random.shuffle(values)
    return values.join('')
  })
  assert.deepEqual(orders, ['2013', '0132', '0213', '1032', '2031', '3120'])

  const rows = Csv.parse(fixture('gpqa.csv'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!['Question'], 'Which option is\n"quoted", and right?')
  const [first, second] = GpqaDiamond.tasks(rows, await Dataset.assets('gpqa-diamond'))
  assert.equal(first!.id, 'recFixture0001')
  assert.match(
    Bytes.toText(first!.files['instruction.md']!),
    /\(A\) wrong two\n\(B\) wrong zero\n\(C\) wrong one\n\(D\) right\n/,
  )
  assert.deepEqual(JSON.parse(Bytes.toText(first!.files['tests/case.json']!)), {
    correct_answer: 'D',
    record_id: 'recFixture0001',
  })
  assert.equal(JSON.parse(Bytes.toText(second!.files['tests/case.json']!)).correct_answer, 'C')

  const task = await Task.load(first!, { solution: true })
  assert.equal(task.verifier.finalMessage, true)
  assert.equal(task.verifier.judge, undefined)
  assert.equal(task.environment.dockerImage, 'python:3.12-slim')
  assert.equal(
    Bytes.toText(Bytes.fromBase64(task.files[Task.finalMessagePath]!)),
    'The correct answer is (D)\n',
  )
  assert.ok(!Bytes.toText(first!.files['instruction.md']!).includes('correct answer is (D)'))
  assert.throws(
    () => GpqaDiamond.tasks([{ ...rows[0]!, 'Canary String': 'none' }], {}),
    Dataset.SelectionError,
  )
  assert.throws(() => Csv.parse('a,b\n"open'), Csv.FormatError)
})

test('an encrypted archive member opens with its password only', () => {
  const contents = Bytes.fromText('Record ID,Question\nrec1,why\n')
  const archive = encrypted('dataset/example.csv', contents, 'a-published-password')
  assert.deepEqual(
    Zip.extract(archive, { member: 'dataset/example.csv', password: 'a-published-password' }),
    contents,
  )
  assert.throws(
    () => Zip.extract(archive, { member: 'dataset/example.csv', password: 'another' }),
    Zip.ArchiveError,
  )
  assert.throws(() => Zip.extract(archive, { member: 'dataset/example.csv' }), Zip.ArchiveError)
  assert.throws(
    () => Zip.extract(archive, { member: 'missing', password: 'a-published-password' }),
    Zip.ArchiveError,
  )
})

test('a HealthBench case of one message is judged, and a run of it must name a judge', async () => {
  const rows = HealthBench.parse(fixture('healthbench.jsonl'))
  assert.deepEqual(rows.map(HealthBench.single), [true, false])
  const item = HealthBench.task(rows[0]!, await Dataset.assets('healthbench-professional'))
  const task = await Task.load(item)
  assert.equal(task.verifier.finalMessage, true)
  assert.equal(task.verifier.judge, true)
  assert.equal(task.instruction, 'What is the first step?')
  const hidden = JSON.parse(Bytes.toText(item.files['tests/case.json']!))
  assert.equal(hidden.rubric_items.length, 2)
  assert.equal(hidden.physician_response, undefined)
  assert.throws(() => HealthBench.task(rows[1]!, {}), Dataset.SelectionError)

  assert.throws(() => run([task]), /must name a judge/)
  assert.deepEqual(run([task], { judge: { model: 'model', provider: 'codex' } }).judge, {
    model: 'model',
    provider: 'codex',
  })
  assert.throws(
    () => run([task], { judge: { model: 'model', provider: 'oracle' as 'codex' } }),
    Config.InvalidError,
  )
})

test('a limit takes the first tasks in the order of their ids, at import as in a run', () => {
  const [single, several] = HealthBench.parse(fixture('healthbench.jsonl'))
  const ids = ['c', '1', '9', '2'].map((digit) => digit.repeat(32))
  const rows = [{ ...several!, id: '0'.repeat(32) }, ...ids.map((id) => ({ ...single!, id }))]
  const entries = [...ids].sort().map((id) => ({ id }))
  for (const selection of [{}, { limit: 2 }, { limit: 1, only: [ids[0]!, ids[2]!] }])
    assert.deepEqual(
      HealthBench.select(rows, selection).map((row) => row.id),
      Eval.select(entries, selection).map((entry) => entry.id),
    )
  assert.deepEqual(
    HealthBench.select(rows, { limit: 2 }).map((row) => row.id),
    [ids[1], ids[3]],
  )
  assert.deepEqual(Dataset.select(ids, { only: [ids[0]!, ids[1]!] }), [ids[1], ids[0]])
  assert.throws(() => Dataset.select(ids, { only: ['absent'] }), Dataset.SelectionError)
  assert.throws(() => HealthBench.select(rows, { only: [rows[0]!.id] }), Dataset.SelectionError)
})

test('a dataset is imported as eval rows with its files kept apart in a blob store', async () => {
  const root = temporary()
  const [first] = GpqaDiamond.tasks(
    Csv.parse(fixture('gpqa.csv')),
    await Dataset.assets('gpqa-diamond'),
  )
  const compose: Dataset.Case = {
    files: {
      ...first!.files,
      'environment/docker-compose.yaml': Bytes.fromText('services: {}\n'),
    },
    id: 'compose',
  }
  const manifest = await Dataset.write(adapter([first!, compose]), {
    out: root,
    store: Source.create(root),
  })
  assert.deepEqual(
    manifest.tasks.map((entry) => entry.id),
    ['compose', 'recFixture0001'],
  )

  const store = Store.directory(Path.join(root, 'store'))
  const options: Import.Options = {
    cache: Path.join(root, 'cache'),
    converter: {
      convert: () => Promise.reject(new Error('a dir environment is not converted')),
      format: 'none',
      name: 'none',
      pack: () => Promise.reject(new Error('a dir environment is not packed')),
      unpack: () => Promise.reject(new Error('a dir environment is not unpacked')),
    },
    format: 'dir',
    store,
  }
  const imported = await Import.cases(
    adapter([first!]).cases({ store: Source.create(root) }),
    options,
  )
  const [row] = imported.tasks
  assert.equal(row!.id, 'recFixture0001')
  assert.equal(row!.name, 'gpqa-diamond/recFixture0001')
  assert.equal(row!.checksum, manifest.tasks[1]!.checksum)
  assert.equal(row!.environment.kind, 'dir')
  assert.equal(row!.verifier.finalMessage, true)
  assert.equal(row!.solution?.finalMessage, true)
  assert.deepEqual(Eval.parse(JSON.parse(JSON.stringify(row))), row)
  assert.deepEqual(
    imported.timings.map((timing) => [timing.id, timing.convertMs, timing.reused]),
    [['recFixture0001', 0, false]],
  )

  const cache = Path.join(root, 'runner-cache')
  Fs.mkdirSync(Path.join(cache, 'blobs'), { recursive: true })
  const read = async (blob: Eval.Blob) =>
    Fs.readFileSync(await Store.ensure([store], { blob, cache }))
  assert.equal(
    Bytes.toText(await read(row!.instruction)),
    Bytes.toText(first!.files['instruction.md']!),
  )
  const tests = Tar.unpack(await read(row!.tests)).map((entry) => entry.path)
  assert.deepEqual(
    tests,
    Object.keys(first!.files)
      .filter((path) => path.startsWith('tests/'))
      .sort(),
  )
  const solution = Tar.unpack(await read(row!.solution!.archive)).map((entry) => entry.path)
  assert.ok(solution.includes('solution/solve.sh'))
  assert.ok(solution.every((path) => path.startsWith('solution/')))

  await assert.rejects(
    Import.cases(adapter([compose]).cases({ store: Source.create(root) }), options),
    Task.UnsupportedError,
  )
  await assert.rejects(
    Dataset.write(
      { ...adapter([first!]), source: { kind: 'fixture', revision: '2' } },
      {
        out: root,
        store: Source.create(root),
      },
    ),
    Dataset.ManifestError,
  )
  Fs.rmSync(root, { recursive: true })
})

test('a judge request names its prompts, and the answer keeps their order', () => {
  const requests = Judge.parse(
    JSON.stringify({
      requests: [
        { id: 'a', prompt: 'first' },
        { id: 'b.2', prompt: 'second' },
      ],
    }),
  )
  assert.deepEqual(requests, [
    { id: 'a', prompt: 'first' },
    { id: 'b.2', prompt: 'second' },
  ])
  assert.deepEqual(JSON.parse(Judge.answer(requests, ['yes', 'no'])), {
    responses: [
      { id: 'a', text: 'yes' },
      { id: 'b.2', text: 'no' },
    ],
  })
  for (const invalid of [
    'not json',
    '{}',
    '{"requests":[]}',
    '{"requests":[{"id":"a b","prompt":"p"}]}',
    '{"requests":[{"id":"a","prompt":" "}]}',
    '{"requests":[{"id":"a","prompt":"p"},{"id":"a","prompt":"q"}]}',
  ])
    assert.throws(() => Judge.parse(invalid), Judge.RequestError)
})

test('every dataset names its pinned source and says what was run', () => {
  const names = Catalog.adapters.map((entry) => entry.name)
  assert.equal(new Set(names).size, names.length)
  for (const entry of Catalog.adapters) {
    assert.match(entry.name, /^[a-z0-9][a-z0-9.-]*$/)
    assert.ok(entry.proof && entry.description)
    assert.ok(Object.values(entry.source).some((value) => /[0-9a-f]{40}/.test(value)))
    assert.equal(Catalog.find(entry.name), entry)
  }
})
