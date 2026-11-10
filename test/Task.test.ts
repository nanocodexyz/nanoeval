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
