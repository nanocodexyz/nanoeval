import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, before, test } from 'node:test'
import { loadTask } from '../cli/nanoeval.ts'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Tar from '../src/Tar.ts'

const token = 'test-token'
const script = Fs.readFileSync(new URL('../sandbox/slot.sh', import.meta.url))
let root: string
let server: Sandboxd.Server

before(async () => {
  root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-sandboxd-'))
  server = await Sandboxd.start({ execTimeoutMs: 30_000, host: '127.0.0.1', port: 0, root, token })
})

after(async () => {
  await server.close()
  Fs.rmSync(root, { force: true, recursive: true })
})

const wait = async (read: () => Promise<Slot.Phase>): Promise<Slot.Phase> => {
  for (let tries = 0; tries < 200; tries++) {
    const phase = await read()
    if (phase !== 'running' && phase !== 'none') return phase
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the slot phase did not finish')
}

test('the local provider creates, drives and removes a sandbox', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  assert.equal(created.expiresAt, null)
  assert.ok(created.handle.home.startsWith(root))

  const sandbox = provider.connect(created.handle)
  await sandbox.write(created.handle.home + '/nested/file.txt', Bytes.fromText('hello'))
  assert.deepEqual(await sandbox.exec('cat nested/file.txt; echo warn >&2; exit 3'), {
    exitCode: 3,
    stderr: 'warn\n',
    stdout: 'hello',
  })
  await assert.rejects(Sandbox.run(sandbox, 'echo broken >&2; exit 9'), Sandbox.CommandError)
  await assert.rejects(
    sandbox.write('/etc/nanoeval-escape', Bytes.fromText('x')),
    Local.RequestError,
  )

  await provider.kill(created.handle)
  assert.ok(!Fs.existsSync(created.handle.home))
  await assert.rejects(sandbox.exec('true'), Local.RequestError)
  await assert.rejects(
    Local.create({ token: 'wrong', url: server.url }).create({
      metadata: {},
      template: undefined,
      timeoutSec: 60,
    }),
    Local.RequestError,
  )
})

test('shell quoting keeps arguments whole', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  const value = 'it\'s a "test" $HOME \\ \n end'
  const output = await Sandbox.run(
    provider.connect(created.handle),
    'printf %s ' + Sandbox.quote(value),
  )
  assert.equal(output, value)
  await provider.kill(created.handle)
})

test('slots in one sandbox verify their own workspaces with the dir backend', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  const sandbox = provider.connect(created.handle)
  const slots = Slot.create({ home: created.handle.home })
  await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(created.handle.home + '/slots'))
  await sandbox.write(slots.script, script)

  const capabilities = JSON.parse(await Sandbox.run(sandbox, slots.probe())) as Sandbox.Capabilities
  assert.ok(capabilities.cpus >= 1)
  assert.ok(capabilities.memory_mb > 0)
  assert.equal(typeof capabilities.kvm, 'boolean')
  assert.equal(capabilities.ca_bundle, false)
  assert.equal(capabilities.slot_env, false)
  assert.deepEqual(Slot.parseStatus(await Sandbox.run(sandbox, slots.status())), {
    setup: 'none',
    slots: {},
  })

  const task = await loadTask('tasks/extract-todos')
  const archive = Tar.pack(
    Object.entries(task.files).map(([path, data]) => ({
      data: Bytes.fromBase64(data),
      executable: task.executable.includes(path),
      path,
    })),
  )
  for (const slot of ['right', 'wrong']) {
    await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(created.handle.home + '/slots/' + slot))
    await sandbox.write(slots.taskFile(slot), archive)
    await Sandbox.run(
      sandbox,
      slots.up(slot, {
        backend: 'dir',
        cpus: 1,
        image: undefined,
        limits: 'none',
        memoryMb: 256,
        network: 'host',
        storageMb: 1024,
      }),
    )
  }
  const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  for (const slot of ['right', 'wrong'])
    assert.equal(await wait(async () => (await status()).slots[slot]!.up), 'exit:0')

  const work = (slot: string) => created.handle.home + '/slots/' + slot + '/work'
  assert.equal(await Sandbox.run(sandbox, 'ls ' + Sandbox.quote(work('right'))), 'notes.md\n')
  await sandbox.write(
    work('right') + '/todos.txt',
    Bytes.fromText('publish benchmarks\nverify trajectories\n'),
  )
  await sandbox.write(work('wrong') + '/todos.txt', Bytes.fromText('nothing\n'))

  for (const slot of ['right', 'wrong']) await Sandbox.run(sandbox, slots.verify(slot, 30))
  assert.equal(await wait(async () => (await status()).slots['right']!.verify), 'exit:0')
  assert.equal(await wait(async () => (await status()).slots['wrong']!.verify), 'exit:1')
  const final = await status()
  assert.equal(final.slots['right']!.reward, 1)
  assert.equal(final.slots['wrong']!.reward, 0)
  assert.equal(
    await Sandbox.run(sandbox, slots.log('right', 'verify', 4096)),
    'todos.txt is correct\n',
  )
  assert.equal(Slot.exit(final.slots['wrong']!.verify), 1)

  await Sandbox.run(sandbox, slots.down('right'))
  assert.deepEqual(Object.keys((await status()).slots), ['wrong'])
  await assert.rejects(
    Sandbox.run(
      sandbox,
      slots.up('Bad Slot', {
        backend: 'dir',
        cpus: 1,
        image: undefined,
        limits: 'none',
        memoryMb: 1,
        network: 'host',
        storageMb: 1024,
      }),
    ),
    Sandbox.CommandError,
  )
  await provider.kill(created.handle)
  assert.ok(!Fs.existsSync(created.handle.home))
})

test('a slot runs the task solution in its workspace before the verifier', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  const sandbox = provider.connect(created.handle)
  const slots = Slot.create({ home: created.handle.home })
  await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(created.handle.home + '/slots/solved'))
  await sandbox.write(slots.script, script)

  const task = await loadTask('tasks/extract-todos', { solution: true })
  await sandbox.write(
    slots.taskFile('solved'),
    Tar.pack(
      Object.entries(task.files).map(([path, data]) => ({
        data: Bytes.fromBase64(data),
        executable: task.executable.includes(path),
        path,
      })),
    ),
  )
  const up = slots.up('solved', {
    backend: 'dir',
    cpus: 1,
    image: undefined,
    limits: 'none',
    memoryMb: 256,
    network: 'host',
    storageMb: 1024,
  })
  await assert.rejects(Sandbox.run(sandbox, slots.solve('solved', 30)), Sandbox.CommandError)
  await Sandbox.run(sandbox, up)
  const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  assert.equal(await wait(async () => (await status()).slots['solved']!.up), 'exit:0')
  assert.equal((await status()).slots['solved']!.solve, 'none')

  await Sandbox.run(sandbox, slots.solve('solved', 30))
  assert.equal(await wait(async () => (await status()).slots['solved']!.solve), 'exit:0')
  await Sandbox.run(sandbox, slots.verify('solved', 30))
  assert.equal(await wait(async () => (await status()).slots['solved']!.verify), 'exit:0')
  assert.equal((await status()).slots['solved']!.reward, 1)
  await provider.kill(created.handle)
})

test('taking a slot down ends the work it still runs', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  const sandbox = provider.connect(created.handle)
  const slots = Slot.create({ home: created.handle.home })
  await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(created.handle.home + '/slots/busy'))
  await sandbox.write(slots.script, script)
  await sandbox.write(
    slots.taskFile('busy'),
    Tar.pack([
      {
        data: Bytes.fromText('#!/bin/sh\nsleep 300.125\n'),
        executable: true,
        path: 'tests/test.sh',
      },
    ]),
  )
  await Sandbox.run(
    sandbox,
    slots.up('busy', {
      backend: 'dir',
      cpus: 1,
      image: undefined,
      limits: 'none',
      memoryMb: 1,
      network: 'host',
      storageMb: 1024,
    }),
  )
  const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  assert.equal(await wait(async () => (await status()).slots['busy']!.up), 'exit:0')

  await Sandbox.run(sandbox, slots.verify('busy', 300))
  const sleeping = async () => (await sandbox.exec('pgrep -f "sleep 300.12[5]"')).stdout.trim()
  for (let tries = 0; tries < 100 && !(await sleeping()); tries++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.notEqual(await sleeping(), '')
  assert.equal((await status()).slots['busy']!.verify, 'running')

  await Sandbox.run(sandbox, slots.down('busy'))
  for (let tries = 0; tries < 100 && (await sleeping()); tries++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await sleeping(), '')
  await provider.kill(created.handle)
})
