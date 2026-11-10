import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTask } from '../cli/nanoeval.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Config from '../src/Config.ts'
import * as Task from '../src/Task.ts'

const manifest = (extra = '') => `schema_version = "1.1"
[task]
name = "suite/example"
[agent]
timeout_sec = 60.0
[verifier]
timeout_sec = 30.0
[environment]
cpus = 1
memory_mb = 256
storage_mb = 128
${extra}`

const source = (toml: string, extra: Record<string, string> = {}): Task.Source => ({
  files: Object.fromEntries(
    Object.entries({
      'environment/Dockerfile': 'FROM alpine:3.21\n',
      'instruction.md': 'Do the thing.\n',
      'solution/solve.sh': 'echo secret\n',
      'task.toml': toml,
      'tests/test.sh': 'echo 1 > /logs/verifier/reward.txt\n',
      ...extra,
    }).map(([path, text]) => [path, Bytes.fromText(text)]),
  ),
})

test('the fixture tasks load as Harbor schema 1.1 tasks', async () => {
  const task = await loadTask('tasks/extract-todos')
  assert.equal(task.name, 'nanoeval/extract-todos')
  assert.equal(task.agent.timeoutSec, 300)
  assert.equal(task.verifier.timeoutSec, 30)
  assert.deepEqual(task.environment, {
    allowInternet: true,
    cpus: 1,
    env: {},
    memoryMb: 256,
    storageMb: 128,
  })
  assert.match(task.checksum, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(task.files).sort(), [
    'environment/Dockerfile',
    'environment/notes.md',
    'tests/test.sh',
  ])
  assert.ok(task.executable.includes('tests/test.sh'))
  assert.deepEqual(Task.parse(JSON.parse(JSON.stringify(task))), task)
})

test('a task ships its environment and tests, and never its solution', async () => {
  const task = await Task.load(source(manifest()))
  assert.deepEqual(Object.keys(task.files).sort(), ['environment/Dockerfile', 'tests/test.sh'])
  assert.equal(task.instruction, 'Do the thing.\n')
})

test('a task that names an image ships only its tests', async () => {
  const task = await Task.load(
    source(manifest('docker_image = "alpine:3.21"\nbuild_timeout_sec = 900.0\n')),
  )
  assert.deepEqual(Object.keys(task.files), ['tests/test.sh'])
  assert.equal(task.environment.dockerImage, 'alpine:3.21')
  assert.equal(task.environment.buildTimeoutSec, 900)
  assert.deepEqual(Task.parse(JSON.parse(JSON.stringify(task))), task)
  await assert.rejects(Task.load(source(manifest('build_timeout_sec = 0\n'))), Task.InvalidError)
})

test('a solution is shipped only when asked for, and only an oracle run takes it', async () => {
  const toml = manifest('[solution.env]\nMODE = "reference"\n')
  const plain = await Task.load(source(toml))
  assert.equal(plain.solution, undefined)
  assert.ok(!('solution/solve.sh' in plain.files))

  const solved = await Task.load(source(toml), { solution: true })
  assert.deepEqual(solved.solution, { env: { MODE: 'reference' } })
  assert.deepEqual(Object.keys(solved.files).sort(), [
    'environment/Dockerfile',
    'solution/solve.sh',
    'tests/test.sh',
  ])
  assert.deepEqual(Task.parse(JSON.parse(JSON.stringify(solved))), solved)
  assert.throws(
    () => Task.parse({ ...plain, files: { ...plain.files, 'solution/solve.sh': 'eA==' } }),
    Task.InvalidError,
  )

  const unsolved = source(toml)
  delete unsolved.files['solution/solve.sh']
  await assert.rejects(Task.load(unsolved, { solution: true }), Task.InvalidError)

  const config = {
    agents: [{ id: 'oracle', model: 'solution', provider: 'oracle' }],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    limits: { attachSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'example',
    sandbox: {
      backend: 'docker',
      docker: 'keep',
      limits: 'enforce',
      max: 1,
      network: 'host',
      provider: 'local',
      slots: 4,
      timeoutSec: 3600,
    },
    tasks: [solved],
  }
  const model = { id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' }
  assert.equal(Config.parse(config).agents[0]!.provider, 'oracle')
  assert.throws(() => Config.parse({ ...config, tasks: [plain] }), Config.InvalidError)
  assert.throws(() => Config.parse({ ...config, agents: [model] }), Config.InvalidError)
  assert.throws(
    () => Config.parse({ ...config, agents: [...config.agents, model] }),
    Config.InvalidError,
  )
})

test('the checksum covers package files and changes with their contents', async () => {
  const first = await Task.load(source(manifest()))
  const same = await Task.load(source(manifest(), { 'notes/ignored.txt': 'x' }))
  const changed = await Task.load(source(manifest(), { 'tests/test.sh': 'echo 0\n' }))
  assert.equal(first.checksum, same.checksum)
  assert.notEqual(first.checksum, changed.checksum)
})

test('invalid and unsupported tasks are refused by name', async () => {
  await assert.rejects(Task.load({ files: {} }), Task.InvalidError)
  await assert.rejects(
    Task.load(source(manifest().replace('"1.1"', '"2.0"'))),
    Task.UnsupportedError,
  )
  await assert.rejects(Task.load(source(manifest('gpus = 1\n'))), Task.UnsupportedError)
  await assert.rejects(
    Task.load(source(manifest('custom_docker_compose = true\n'))),
    Task.UnsupportedError,
  )
  await assert.rejects(
    Task.load(source(manifest().replace('memory_mb = 256', 'memory_mb = "big"'))),
    Task.InvalidError,
  )
  assert.throws(() => Task.parse({ name: 'x' }), Task.InvalidError)
})

test('a run configuration is validated and tasks without internet are refused', async () => {
  const task = await Task.load(source(manifest()))
  const config = {
    agents: [{ id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' }],
    attempts: 2,
    budget: { sandboxUsd: 0 },
    limits: { attachSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'example',
    sandbox: {
      backend: 'docker',
      docker: 'keep',
      limits: 'enforce',
      max: 1,
      network: 'host',
      provider: 'local',
      slots: 4,
      timeoutSec: 3600,
    },
    tasks: [task],
  }
  assert.equal(Config.parse(config).attempts, 2)
  assert.throws(() => Config.parse({ ...config, attempts: 0 }), Config.InvalidError)
  assert.throws(() => Config.parse({ ...config, agents: [] }), Config.InvalidError)
  assert.throws(
    () => Config.parse({ ...config, sandbox: { ...config.sandbox, provider: 'modal' } }),
    Config.InvalidError,
  )
  assert.throws(
    () => Config.parse({ ...config, agents: [config.agents[0], config.agents[0]] }),
    Config.InvalidError,
  )

  const offline = await Task.load(source(manifest('allow_internet = false\n')))
  assert.throws(() => Config.parse({ ...config, tasks: [offline] }), Task.UnsupportedError)
})

test('a slot network is one its backend has, and private by default on a local machine', async () => {
  const task = await Task.load(source(manifest()))
  const config = (backend: string, network: string) => ({
    agents: [{ id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' }],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    limits: { attachSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'example',
    sandbox: {
      backend,
      docker: 'keep',
      limits: 'enforce',
      max: 1,
      network,
      provider: 'local',
      slots: 4,
      timeoutSec: 3600,
    },
    tasks: [task],
  })
  for (const [backend, network] of [
    ['dir', 'host'],
    ['docker', 'bridge'],
    ['docker', 'host'],
    ['docker', 'private'],
    ['krun', 'host'],
    ['krun', 'private'],
  ] as const)
    assert.equal(Config.parse(config(backend, network)).sandbox.network, network)
  for (const [backend, network] of [
    ['dir', 'bridge'],
    ['dir', 'private'],
    ['docker', 'none'],
    ['krun', 'bridge'],
  ] as const)
    assert.throws(() => Config.parse(config(backend, network)), Config.InvalidError)

  assert.equal(Config.network({ backend: 'docker', provider: 'local' }), 'private')
  assert.equal(Config.network({ backend: 'krun', provider: 'local' }), 'private')
  assert.equal(Config.network({ backend: 'dir', provider: 'local' }), 'host')
  assert.equal(Config.network({ backend: 'docker', provider: 'e2b' }), 'bridge')
})

test('a task may answer with its final message and ask for a judge', async () => {
  const extension = (body: string) => manifest('[metadata.nanoeval]\n' + body)
  const plain = await Task.load(source(manifest()))
  assert.equal(plain.verifier.finalMessage, undefined)
  assert.equal(plain.verifier.judge, undefined)

  const judged = await Task.load(source(extension('final_message = true\njudge = true')))
  assert.equal(judged.verifier.finalMessage, true)
  assert.equal(judged.verifier.judge, true)
  assert.deepEqual(Task.parse(JSON.parse(JSON.stringify(judged))), judged)
  assert.equal((await Task.load(source(extension('judge = false')))).verifier.judge, undefined)

  await assert.rejects(Task.load(source(extension('judge = "yes"'))), Task.InvalidError)
  await assert.rejects(
    Task.load(source(extension('final_message = true')), { solution: true }),
    /has no solution\/final_message.txt/,
  )
  const oracle = await Task.load(
    source(extension('final_message = true'), { 'solution/final_message.txt': 'forty-two' }),
    { solution: true },
  )
  assert.equal(
    Bytes.toText(Bytes.fromBase64(oracle.files['solution/final_message.txt']!)),
    'forty-two',
  )
})

test('a task of the earlier Harbor format, with version in place of schema_version, loads', async () => {
  const earlier = manifest().replace('schema_version = "1.1"', 'version = "1.0"')
  assert.equal((await Task.load(source(earlier))).name, 'suite/example')
  for (const refused of ['version = "0.9"', 'schema_version = "2.0"', 'schema_version = "1.0"'])
    await assert.rejects(
      Task.load(source(manifest().replace('schema_version = "1.1"', refused))),
      Task.UnsupportedError,
    )
})
