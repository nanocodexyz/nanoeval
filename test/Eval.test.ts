import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Eval from '../src/Eval.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Sql from '../src/Sql.ts'
import * as Task from '../src/Task.ts'
import * as Rows from './Rows.ts'

const source = (name: string, extra = ''): Task.Source => ({
  files: Object.fromEntries(
    Object.entries({
      'environment/Dockerfile': 'FROM alpine:3.21\n',
      'instruction.md': 'Do the thing.\n',
      'solution/solve.sh': 'echo secret\n',
      'task.toml':
        'schema_version = "1.1"\n[task]\nname = "suite/' +
        name +
        '"\n[agent]\ntimeout_sec = 60.0\n[verifier]\ntimeout_sec = 30.0\n[environment]\ncpus = 1\nmemory_mb = 256\nstorage_mb = 128\n' +
        extra,
      'tests/test.sh': 'echo 1 > /logs/verifier/reward.txt\n',
    }).map(([path, text]) => [path, Bytes.fromText(text)]),
  ),
})

const task = async (name: string, extra = '') =>
  Rows.row(await Task.load(source(name, extra), { solution: true }))

function open(): Sql.Sql {
  const sql = Rows.database()
  Sql.setup(sql, Eval.tables)
  return sql
}

test('a version is named by a digest over its tasks, and importing again changes nothing', async () => {
  const sql = open()
  const [a, b] = [await task('a'), await task('b')]
  const pins = { dataset: 'suite', source: { revision: '1' } }
  const first = await Eval.put(sql, { ...pins, now: 1, tasks: [a, b] })
  assert.match(first.digest, /^[0-9a-f]{64}$/)
  assert.equal(first.tasks, 2)
  assert.equal(first.parent, null)

  const again = await Eval.put(sql, { ...pins, now: 2, tasks: [b, a] })
  assert.equal(again.digest, first.digest)
  assert.equal(again.createdAt, 1)
  assert.equal(Eval.versions(sql).length, 1)
  assert.deepEqual(
    Eval.entries(sql, first.digest).map((entry) => entry.id),
    ['suite-a', 'suite-b'],
  )
  assert.deepEqual(Eval.tasks(sql, first.digest, { only: ['suite-b'] }), [b])
  assert.equal(
    first.digest,
    await Eval.versionDigest({
      dataset: 'suite',
      entries: [
        { digest: await Eval.taskDigest(b), id: 'suite-b' },
        { digest: await Eval.taskDigest(a), id: 'suite-a' },
      ],
      source: { revision: '1' },
    }),
  )
})

test('importing more tasks makes a new version and the old one stays readable', async () => {
  const sql = open()
  const [a, b, c] = [await task('a'), await task('b'), await task('c')]
  const pins = { dataset: 'suite', source: { revision: '1' } }
  const first = await Eval.put(sql, { ...pins, now: 1, tasks: [a, b] })
  const changed = { ...b, agent: { timeoutSec: 120 } }
  const second = await Eval.put(sql, { ...pins, now: 2, tasks: [changed, c] })

  assert.notEqual(second.digest, first.digest)
  assert.equal(second.parent, first.digest)
  assert.equal(second.tasks, 3)
  assert.equal(Eval.version(sql)!.digest, second.digest)
  assert.equal(Eval.version(sql, first.digest.slice(0, 12))!.digest, first.digest)
  assert.deepEqual(Eval.tasks(sql, first.digest), [a, b])
  assert.deepEqual(Eval.tasks(sql, second.digest), [a, changed, c])
  assert.equal(Eval.version(sql, 'ffffffffffff'), undefined)

  const alone = await Eval.put(sql, { ...pins, base: null, now: 3, tasks: [c] })
  assert.equal(alone.parent, null)
  assert.equal(alone.tasks, 1)
  assert.deepEqual(Eval.tasks(sql, second.digest).length, 3)
})

test('an eval holds one dataset from one source, and a selection names tasks it has', async () => {
  const sql = open()
  const a = await task('a')
  const first = await Eval.put(sql, {
    dataset: 'suite',
    now: 1,
    source: { revision: '1' },
    tasks: [a],
  })
  await assert.rejects(
    Eval.put(sql, { dataset: 'suite', now: 2, source: { revision: '2' }, tasks: [a] }),
    Eval.InvalidError,
  )
  await assert.rejects(
    Eval.put(sql, { dataset: 'other', now: 2, source: { revision: '1' }, tasks: [a] }),
    Eval.InvalidError,
  )
  await assert.rejects(
    Eval.put(sql, { base: 'abcdef012345', dataset: 'suite', now: 2, source: {}, tasks: [a] }),
    Eval.NotFoundError,
  )
  await assert.rejects(
    Eval.put(sql, { dataset: 'suite', now: 2, source: { revision: '1' }, tasks: [a, a] }),
    Eval.InvalidError,
  )
  assert.throws(() => Eval.tasks(sql, first.digest, { only: ['absent'] }), Eval.NotFoundError)
  assert.deepEqual(Eval.tasks(sql, first.digest, { limit: 1 }), [a])
})

test('a task row is validated, and its solution is kept apart', async () => {
  const a = await task('a')
  assert.deepEqual(Eval.parse(JSON.parse(JSON.stringify(a))), a)
  assert.throws(() => Eval.parse({ ...a, tests: { bytes: 1, digest: 'short' } }), Eval.InvalidError)
  assert.throws(() => Eval.parse({ ...a, id: 'a/b' }), Eval.InvalidError)
  assert.throws(() => Eval.parse({ ...a, environment: { kind: 'container' } }), Eval.InvalidError)
  assert.throws(() => Eval.parse({ ...a, env: { 'bad name': 'x' } }), Eval.InvalidError)

  const withSolution = Eval.blobs(a, { solution: true }).map((blob) => blob.digest)
  const without = Eval.blobs(a, { solution: false }).map((blob) => blob.digest)
  assert.equal(withSolution.length, 4)
  assert.equal(without.length, 3)
  assert.ok(!without.includes(a.solution!.archive.digest))
  assert.equal(Eval.withoutSolution(a).solution, undefined)
  assert.notEqual(await Eval.taskDigest(a), await Eval.taskDigest(Eval.withoutSolution(a)))
})

test('an eval reference is a name with an optional digest', () => {
  assert.deepEqual(Eval.reference('terminal-bench-2.1'), { name: 'terminal-bench-2.1' })
  assert.deepEqual(Eval.reference('local@0123456789ab'), { name: 'local', version: '0123456789ab' })
  assert.throws(() => Eval.reference('Local'), Eval.InvalidError)
  assert.throws(() => Eval.reference('local@xyz'), Eval.InvalidError)
  assert.throws(() => Eval.reference('local@0123'), Eval.InvalidError)
  assert.equal(Eval.canonical({ b: 1, a: [2, { d: 3, c: undefined }] }), '{"a":[2,{"d":3}],"b":1}')
})
