import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, before, test } from 'node:test'
import { loadTask } from '../cli/nanoeval.ts'
import * as Converter from '../sandbox/Converter.ts'
import * as Host from '../sandbox/Host.ts'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Tar from '../src/Tar.ts'
import * as Krun from './Krun.ts'

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

const wait = async (read: () => Promise<Slot.Phase>, tries = 200): Promise<Slot.Phase> => {
  for (; tries > 0; tries--) {
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
  assert.equal(capabilities.network, 'none')
  assert.equal(capabilities.slot_env, false)
  assert.equal(capabilities.slot_forward, false)
  const empty = Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  assert.ok(empty.disk_mb > 0)
  assert.deepEqual(empty, { disk_mb: empty.disk_mb, setup: 'none', slots: {} })
  assert.throws(() => Slot.parseStatus('{"setup":"none","slots":{}}'))

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
  assert.equal(
    await Sandbox.run(sandbox, slots.log('right', 'verify', 5)),
    'nanoeval-slot: the last 5 of the 21 bytes of this log follow\nrect\n',
  )
  assert.equal(Slot.exit(final.slots['wrong']!.verify), 1)

  await Sandbox.run(sandbox, slots.down('right', 'keep'))
  assert.deepEqual(Object.keys((await status()).slots), ['wrong'])
  await assert.rejects(
    Sandbox.run(
      sandbox,
      slots.up('Bad Slot', {
        backend: 'dir',
        cpus: 1,
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

test('a slot lists and returns every file its verifier wrote', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  const sandbox = provider.connect(created.handle)
  const slots = Slot.create({ home: created.handle.home })
  await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(created.handle.home + '/slots/files'))
  await sandbox.write(slots.script, script)
  await sandbox.write(
    slots.taskFile('files'),
    Tar.pack([
      {
        data: Bytes.fromText(
          [
            '#!/bin/sh',
            'logs=$NANOEVAL_VERIFIER_LOGS',
            'mkdir -p "$logs/nested"',
            'printf \'{}\' >"$logs/ctrf.json"',
            'printf \'\\377\\000\\376\' >"$logs/nested/data.bin"',
            'ln -s /etc/passwd "$logs/link"',
            'printf \'1\\n\' >"$logs/reward.txt"',
            '',
          ].join('\n'),
        ),
        executable: true,
        path: 'tests/test.sh',
      },
    ]),
  )
  assert.equal(await Sandbox.run(sandbox, slots.files('files')), '')
  await Sandbox.run(
    sandbox,
    slots.up('files', {
      backend: 'dir',
      cpus: 1,
      memoryMb: 1,
      network: 'host',
      storageMb: 1024,
    }),
  )
  const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  assert.equal(await wait(async () => (await status()).slots['files']!.up), 'exit:0')
  await Sandbox.run(sandbox, slots.verify('files', 30))
  assert.equal(await wait(async () => (await status()).slots['files']!.verify), 'exit:0')

  assert.deepEqual(Slot.parseFiles(await Sandbox.run(sandbox, slots.files('files'))), [
    { bytes: 2, path: 'ctrf.json' },
    { bytes: 3, path: 'nested/data.bin' },
    { bytes: 2, path: 'reward.txt' },
  ])
  assert.deepEqual(
    [...Bytes.fromBase64(await Sandbox.run(sandbox, slots.file('files', 'nested/data.bin')))],
    [0xff, 0x00, 0xfe],
  )
  for (const path of ['link', '../verify.log', 'missing.txt'])
    await assert.rejects(Sandbox.run(sandbox, slots.file('files', path)), Sandbox.CommandError)
  assert.throws(() => Slot.parseFiles('12 no-tab\n'))
  await provider.kill(created.handle)
})

test('pruning removes the environment disks that no microVM holds', async () => {
  const cache = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-cache-'))
  const base = Path.join(cache, 'disks', 'disk-128')
  const files = ['.ext4', '.env', '.user', '.workdir'].map((suffix) => base + suffix)
  Fs.mkdirSync(Path.dirname(base), { recursive: true })
  for (const file of files) Fs.writeFileSync(file, '')
  const prune = (...mode: string[]) =>
    execFileSync('bash', ['sandbox/slot.sh', 'prune', ...mode], {
      env: { ...process.env, NANOEVAL_CACHE: cache },
    }).toString()
  const holder = spawn('flock', ['-s', base + '.use', 'sleep', '300.25'])
  try {
    for (let tries = 0; tries < 100 && !Fs.existsSync(base + '.use'); tries++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(prune('dry-run'), 'used disk ' + base + '.ext4\n')
    assert.equal(prune(), 'kept disk ' + base + '.ext4\n')
    assert.ok(files.every((file) => Fs.existsSync(file)))
  } finally {
    const exited = new Promise((resolve) => holder.once('exit', resolve))
    holder.kill('SIGKILL')
    await exited
    spawnSync('pkill', ['-KILL', '-f', 'sleep 300.2[5]'])
  }
  assert.equal(prune('dry-run'), 'unused disk ' + base + '.ext4\n')
  assert.ok(files.every((file) => Fs.existsSync(file)))
  assert.equal(prune(), 'removed disk ' + base + '.ext4\n')
  assert.ok(files.every((file) => !Fs.existsSync(file)))
  assert.equal(prune(), '')
  Fs.rmSync(cache, { force: true, recursive: true })
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

  await Sandbox.run(sandbox, slots.down('busy', 'keep'))
  for (let tries = 0; tries < 100 && (await sleeping()); tries++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await sleeping(), '')
  await provider.kill(created.handle)
})

test('deleting a sandbox ends the work its slots still run', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  const sandbox = provider.connect(created.handle)
  const slots = Slot.create({ home: created.handle.home })
  await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(created.handle.home + '/slots/left'))
  await sandbox.write(slots.script, script)
  await sandbox.write(
    slots.taskFile('left'),
    Tar.pack([
      {
        data: Bytes.fromText('#!/bin/sh\nsleep 300.375\n'),
        executable: true,
        path: 'tests/test.sh',
      },
    ]),
  )
  await Sandbox.run(
    sandbox,
    slots.up('left', {
      backend: 'dir',
      cpus: 1,
      memoryMb: 1,
      network: 'host',
      storageMb: 1024,
    }),
  )
  const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  assert.equal(await wait(async () => (await status()).slots['left']!.up), 'exit:0')
  await Sandbox.run(sandbox, slots.verify('left', 300))
  const sleeping = () => execFileSync('pgrep', ['-f', 'sleep 300.37[5]']).toString().trim()
  const idle = () => {
    try {
      return sleeping() === ''
    } catch {
      return true
    }
  }
  for (let tries = 0; tries < 100 && idle(); tries++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(!idle())

  await provider.kill(created.handle)
  for (let tries = 0; tries < 100 && !idle(); tries++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(idle())
})

test('a slot refuses a network its backend does not have', async () => {
  const provider = Local.create({ token, url: server.url })
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
  const sandbox = provider.connect(created.handle)
  const slots = Slot.create({ home: created.handle.home })
  await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(created.handle.home + '/slots/alone'))
  await sandbox.write(slots.script, script)
  await sandbox.write(slots.taskFile('alone'), Tar.pack([]))
  await Sandbox.run(
    sandbox,
    slots.up('alone', {
      backend: 'dir',
      cpus: 1,
      memoryMb: 256,
      network: 'private',
      storageMb: 1024,
    }),
  )
  const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  assert.equal(await wait(async () => (await status()).slots['alone']!.up), 'exit:2')
  assert.match(
    await Sandbox.run(sandbox, slots.log('alone', 'up', 4096)),
    /the dir backend has no private network/,
  )
  await provider.kill(created.handle)
})

test(
  'a krun slot runs the solution and the verifier in a microVM',
  { skip: Krun.missing() ?? false },
  async () => {
    const provider = Local.create({ token, url: server.url })
    const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
    const home = created.handle.home
    const sandbox = provider.connect(created.handle)
    const slots = Slot.create({ home })
    const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
    const cache = home + '/cache'
    const cached = (command: string) => 'NANOEVAL_CACHE=' + Sandbox.quote(cache) + ' ' + command
    const guest = (command: string) =>
      sandbox.exec(
        'cd ' +
          Sandbox.quote(home + '/slots/vm') +
          ' && ' +
          Sandbox.quote(home + '/rt/krun/nanoeval-krun') +
          ' exec --socket vm.sock --cwd /app -- sh -c ' +
          Sandbox.quote(command),
      )

    try {
      await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(home + '/slots/vm'))
      await sandbox.write(slots.script, script)
      await Sandbox.run(
        sandbox,
        cached(slots.setup({ backend: 'krun', network: 'host', runtime: Slot.runtime })),
      )
      assert.equal(await wait(async () => (await status()).setup, 12_000), 'exit:0')
      const capabilities = JSON.parse(
        await Sandbox.run(sandbox, slots.probe()),
      ) as Sandbox.Capabilities
      assert.equal(capabilities.krun, true)

      const task = await loadTask('tasks/extract-todos', { solution: true })
      await sandbox.write(
        slots.taskFile('vm'),
        Tar.pack(
          Object.entries(task.files).map(([path, data]) => ({
            data: Bytes.fromBase64(data),
            executable: task.executable.includes(path),
            path,
          })),
        ),
      )
      const disk = cache + '/disks/fixture'
      Fs.mkdirSync(cache + '/disks', { recursive: true })
      await Host.describe(
        disk,
        await Converter.create({
          home: cache + '/converter',
          layers: Converter.defaultLayers(cache),
        }).convert(
          { context: 'tasks/extract-todos/environment', storageMb: task.environment.storageMb },
          disk + '.ext4',
        ),
      )
      await Sandbox.run(
        sandbox,
        cached(
          slots.up('vm', {
            backend: 'krun',
            cpus: task.environment.cpus,
            disk,
            memoryMb: task.environment.memoryMb,
            network: 'host',
            storageMb: task.environment.storageMb,
          }),
        ),
      )
      assert.equal(await wait(async () => (await status()).slots['vm']!.up, 2_400), 'exit:0')
      assert.equal(Krun.machines(root).length, 1)

      assert.deepEqual(await guest('nproc; ls; ls -d /tests /solution; echo warn >&2; exit 7'), {
        exitCode: 7,
        stderr:
          'ls: /tests: No such file or directory\nls: /solution: No such file or directory\nwarn\n',
        stdout: '1\nnotes.md\n',
      })
      assert.equal((await guest('cat /proc/sys/kernel/pid_max')).stdout, '32768\n')
      assert.equal(
        (await guest('if (: </dev/tty) 2>/dev/null; then echo terminal; else echo none; fi'))
          .stdout,
        'none\n',
      )
      const memoryKb = Number((await guest("awk '/MemTotal/ { print $2 }' /proc/meminfo")).stdout)
      assert.ok(memoryKb > 0 && memoryKb < 2 * task.environment.memoryMb * 1024, memoryKb + ' kB')

      await Sandbox.run(sandbox, slots.solve('vm', 30))
      assert.equal(await wait(async () => (await status()).slots['vm']!.solve), 'exit:0')
      await Sandbox.run(sandbox, slots.verify('vm', 30))
      assert.equal(await wait(async () => (await status()).slots['vm']!.verify), 'exit:0')
      assert.equal((await status()).slots['vm']!.reward, 1)
      assert.equal((await guest('ls /tests')).stdout, 'test.sh\n')

      const disks = () => Fs.readdirSync(cache + '/disks').filter((name) => name.endsWith('.ext4'))
      const prune = (mode: string) =>
        Sandbox.run(sandbox, cached('bash ' + Sandbox.quote(slots.script) + ' prune ' + mode))
      assert.equal(disks().length, 1)
      assert.match(await prune('dry-run'), /^used disk .*\.ext4$/m)
      assert.match(await prune('remove'), /^kept disk .*\.ext4$/m)
      assert.equal(disks().length, 1)

      await Sandbox.run(sandbox, cached(slots.down('vm', 'remove')))
      assert.deepEqual(Krun.machines(root), [])
      assert.deepEqual(disks(), [])
      assert.deepEqual((await status()).slots, {})
    } finally {
      await provider.kill(created.handle)
    }
    assert.deepEqual(Krun.machines(root), [])
  },
)
