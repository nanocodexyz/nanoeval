import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTask } from '../cli/nanoeval.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Config from '../src/Config.ts'
import * as Eval from '../src/Eval.ts'
import * as Task from '../src/Task.ts'
import * as Rows from './Rows.ts'

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
    eval: { name: 'example' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'example',
    sandbox: {
      backend: 'krun',
      max: 1,
      network: 'host',
      pollMs: 250,
      provider: 'local',
      slots: 4,
      timeoutSec: 3600,
    },
  }
  const model = { id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' }
  const parsed = Config.parse(config)
  assert.equal(parsed.agents[0]!.provider, 'oracle')
  Config.check(parsed, [Rows.row(solved)])
  assert.throws(() => Config.check(parsed, [Rows.row(plain)]), Config.InvalidError)
  assert.throws(() => Config.check(parsed, [Rows.row(solved, 'dir')]), Config.InvalidError)
  assert.throws(() => Config.check(parsed, []), Config.InvalidError)
  Config.check(Config.parse({ ...config, agents: [model] }), [Rows.row(plain)])
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
    Task.load(source(manifest(), { 'environment/docker-compose.yaml': 'services: {}\n' })),
    Task.UnsupportedError,
  )
  const converted = manifest().replace(
    '[agent]',
    '[metadata]\ncustom_docker_compose = true\n[agent]',
  )
  assert.equal((await Task.load(source(converted))).name, 'suite/example')
  await assert.rejects(
    Task.load(source(manifest().replace('memory_mb = 256', 'memory_mb = "big"'))),
    Task.InvalidError,
  )
  await assert.rejects(
    Task.load(source(manifest('mcp_servers = [{ name = "docs" }]\n'))),
    Task.UnsupportedError,
  )
  assert.equal((await Task.load(source(manifest('mcp_servers = []\n')))).name, 'suite/example')
  assert.throws(() => Task.parse({ name: 'x' }), Task.InvalidError)
})

test('a verifier that names a test report is expected to write it', async () => {
  const plain = await Task.load(source(manifest()))
  assert.equal(plain.verifier.ctrf, undefined)
  const reporting = await Task.load(
    source(manifest(), {
      'tests/test.sh':
        'pytest --ctrf /logs/verifier/ctrf.json; echo $? > /logs/verifier/reward.txt\n',
    }),
  )
  assert.equal(reporting.verifier.ctrf, true)
  assert.deepEqual(Task.parse(JSON.parse(JSON.stringify(reporting))), reporting)
})

test('a run configuration is validated and tasks without internet are refused', async () => {
  const task = await Task.load(source(manifest()))
  const config = {
    agents: [{ id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' }],
    attempts: 2,
    budget: { sandboxUsd: 0 },
    eval: { name: 'example', version: '0123456789ab' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'example',
    sandbox: {
      backend: 'krun',
      max: 1,
      network: 'host',
      pollMs: 250,
      provider: 'local',
      slots: 4,
      timeoutSec: 3600,
    },
  }
  assert.equal(Config.parse(config).attempts, 2)
  assert.deepEqual(Config.parse(config).eval, { name: 'example', version: '0123456789ab' })
  assert.equal(Config.parse(config).sandbox.disks, 'keep')
  assert.equal(
    Config.parse({ ...config, sandbox: { ...config.sandbox, disks: 'remove' } }).sandbox.disks,
    'remove',
  )
  assert.throws(
    () => Config.parse({ ...config, sandbox: { ...config.sandbox, disks: 'all' } }),
    Config.InvalidError,
  )
  assert.equal(Config.parse({ ...config, sandbox: { ...config.sandbox, max: 0 } }).sandbox.max, 0)
  assert.throws(() => Config.parse({ ...config, attempts: 0 }), Config.InvalidError)
  assert.throws(() => Config.parse({ ...config, agents: [] }), Config.InvalidError)
  assert.throws(() => Config.parse({ ...config, eval: { name: 'Example' } }), Eval.InvalidError)
  assert.throws(
    () => Config.parse({ ...config, limits: { ...config.limits, claims: 0 } }),
    Config.InvalidError,
  )
  assert.throws(
    () => Config.parse({ ...config, rerun: { run: 'not-a-run', select: 'failed' } }),
    Config.InvalidError,
  )
  assert.deepEqual(
    Config.parse({
      ...config,
      rerun: { run: '01234567-89ab-cdef-0123-456789abcdef', select: 'errored' },
    }).rerun,
    { run: '01234567-89ab-cdef-0123-456789abcdef', select: 'errored' },
  )
  assert.throws(
    () => Config.parse({ ...config, sandbox: { ...config.sandbox, provider: 'modal' } }),
    Config.InvalidError,
  )
  assert.throws(
    () => Config.parse({ ...config, agents: [config.agents[0], config.agents[0]] }),
    Config.InvalidError,
  )

  const offline = await Task.load(source(manifest('allow_internet = false\n')))
  Config.check(Config.parse(config), [Rows.row(task)])
  assert.throws(
    () => Config.check(Config.parse(config), [Rows.row(offline)]),
    Config.UnsupportedError,
  )
})

test('a slot network is one its backend has, and private by default for microVMs', async () => {
  const config = (backend: string, network: string) => ({
    agents: [{ id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' }],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'example' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'example',
    sandbox: {
      backend,
      max: 1,
      network,
      pollMs: 250,
      provider: 'local',
      slots: 4,
      timeoutSec: 3600,
    },
  })
  for (const [backend, network] of [
    ['dir', 'host'],
    ['krun', 'host'],
    ['krun', 'private'],
  ] as const)
    assert.equal(Config.parse(config(backend, network)).sandbox.network, network)
  for (const [backend, network] of [
    ['dir', 'bridge'],
    ['dir', 'private'],
    ['container', 'host'],
    ['krun', 'bridge'],
  ] as const)
    assert.throws(() => Config.parse(config(backend, network)), Config.InvalidError)

  assert.equal(Config.network({ backend: 'krun' }), 'private')
  assert.equal(Config.network({ backend: 'dir' }), 'host')
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

test('a task closes the network of its agent, of its verifier or of both', async () => {
  const phases = async (toml: string) => {
    const row = Rows.row(await Task.load(source(toml)))
    assert.deepEqual(Eval.parse(JSON.parse(JSON.stringify(row))).network, row.network)
    return [row.network, Eval.offline(row)]
  }
  const agent = (mode: string) => (toml: string) =>
    toml.replace('[agent]\n', '[agent]\nnetwork_mode = "' + mode + '"\n')
  const verifier = (mode: string) => (toml: string) =>
    toml.replace('[verifier]\n', '[verifier]\nnetwork_mode = "' + mode + '"\n')

  assert.deepEqual(await phases(manifest()), [{ allowInternet: true }, []])
  const both = [{ allowInternet: false }, ['agent', 'verifier']]
  assert.deepEqual(await phases(manifest('allow_internet = false\n')), both)
  assert.deepEqual(await phases(manifest('network_mode = "no-network"\n')), both)
  assert.deepEqual(await phases(manifest('allow_internet = false\nnetwork_mode = "public"\n')), [
    { allowInternet: true },
    [],
  ])
  assert.deepEqual(await phases(agent('no-network')(manifest())), [
    { allowInternet: false, verifierInternet: true },
    ['agent'],
  ])
  assert.deepEqual(await phases(verifier('public')(manifest('allow_internet = false\n'))), [
    { allowInternet: false, verifierInternet: true },
    ['agent'],
  ])
  assert.deepEqual(await phases(verifier('no-network')(manifest())), [
    { allowInternet: true, verifierInternet: false },
    ['verifier'],
  ])
  assert.deepEqual(
    await phases(agent('public')(verifier('public')(manifest('allow_internet = false\n')))),
    [{ allowInternet: true }, []],
  )
  assert.deepEqual(
    Eval.parse({
      ...Rows.row(await Task.load(source(manifest()))),
      network: { allowInternet: true, verifierInternet: true },
    }).network,
    { allowInternet: true },
  )

  await assert.rejects(Task.load(source(manifest('network_mode = "allowlist"\n'))), {
    name: 'Task.UnsupportedError',
  })
  await assert.rejects(Task.load(source(agent('allowlist')(manifest()))), {
    name: 'Task.UnsupportedError',
  })
  await assert.rejects(Task.load(source(manifest('allowed_hosts = ["example.com"]\n'))), {
    name: 'Task.UnsupportedError',
  })
  await assert.rejects(Task.load(source(manifest('network_mode = "private"\n'))), {
    name: 'Task.InvalidError',
  })

  const mode = (value: string) =>
    manifest().replace('[verifier]\n', '[verifier]\nenvironment_mode = "' + value + '"\n')
  await Task.load(source(mode('shared')))
  await Task.load(source(mode('same')))
  await assert.rejects(Task.load(source(mode('separate'))), { name: 'Task.UnsupportedError' })
  await assert.rejects(Task.load(source(manifest() + '[verifier.environment]\ncpus = 1\n')), {
    name: 'Task.UnsupportedError',
  })
})

test('only krun slots on a private network run a task that closes its network', async () => {
  const config = (backend: string, network: string) =>
    Config.parse({
      agents: [{ id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' }],
      attempts: 1,
      budget: { sandboxUsd: 0 },
      eval: { name: 'example' },
      limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
      name: 'example',
      sandbox: {
        backend,
        max: 1,
        network,
        pollMs: 250,
        provider: 'local',
        slots: 4,
        timeoutSec: 60,
      },
    })
  const closes = (toml: string) => Task.load(source(toml))
  const offline = await closes(manifest('allow_internet = false\n'))
  const judged = await closes(
    manifest().replace('[verifier]\n', '[verifier]\nnetwork_mode = "no-network"\n'),
  )
  for (const task of [offline, judged]) {
    Config.check(config('krun', 'private'), [Rows.row(task)])
    assert.throws(() => Config.check(config('krun', 'host'), [Rows.row(task)]), {
      message: /which only krun slots on a private network enforce/,
      name: 'Config.UnsupportedError',
    })
    assert.throws(() => Config.check(config('dir', 'host'), [Rows.row(task, 'dir')]), {
      name: 'Config.UnsupportedError',
    })
  }
})
