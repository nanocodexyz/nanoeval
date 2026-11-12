import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { test } from 'node:test'
import { loadTask } from '../cli/nanoeval.ts'
import * as Converter from '../sandbox/Converter.ts'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Local from '../src/Local.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Tar from '../src/Tar.ts'
import * as Guest from './Guest.ts'

const token = 'test-token'
const hosted = process.getuid?.() !== 0

const wait = async (read: () => Promise<Slot.Phase>): Promise<Slot.Phase> => {
  for (const started = Date.now(); Date.now() - started < 600_000; ) {
    const phase = await read()
    if (phase !== 'running' && phase !== 'none') return phase
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the slot phase did not finish')
}

test(
  'an ns slot runs the solution and the verifier in namespaces of its own',
  { skip: (hosted ? Guest.missing() : undefined) ?? false },
  async () => {
    const out = Path.resolve('output/test-ns')
    Fs.rmSync(out, { force: true, recursive: true })
    Fs.mkdirSync(out, { recursive: true })
    const guest = hosted
      ? await Guest.start({ cpus: 2, forwards: [], home: Path.join(out, 'guest'), memoryMb: 4096 })
      : undefined
    const seen = (file: string) => (guest ? Guest.inside(file) : file)
    const server = await Sandboxd.start({
      ...(guest ? { env: guest.variables, machine: guest.machine } : {}),
      execTimeoutMs: 120_000,
      host: '127.0.0.1',
      port: 0,
      root: guest ? Guest.root + '/sandboxes' : Path.join(out, 'sandboxes'),
      token,
    })
    const provider = Local.create({ token, url: server.url })
    const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 60 })
    const home = created.handle.home
    const sandbox = provider.connect(created.handle)
    const slots = Slot.create({ home })
    const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
    const cache = home + '/cache'
    const cached = (command: string) => 'NANOEVAL_CACHE=' + Sandbox.quote(cache) + ' ' + command
    const inside = (command: string) =>
      sandbox.exec(
        'cd ' +
          Sandbox.quote(home + '/slots/ns') +
          ' && ' +
          Sandbox.quote(home + '/rt/krun/nanoeval-krun') +
          ' exec --socket vm.sock --cwd /app -- sh -c ' +
          Sandbox.quote(command),
      )
    const text = (value: string) => new TextEncoder().encode(value)

    try {
      await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(home + '/slots/ns'))
      await sandbox.write(slots.script, Fs.readFileSync('sandbox/slot.sh'))
      await Sandbox.run(
        sandbox,
        'umask 077 && ' +
          cached(slots.setup({ backend: 'ns', network: 'private', runtime: Slot.runtime })),
      )
      assert.equal(
        await wait(async () => (await status()).setup),
        'exit:0',
        await Sandbox.run(sandbox, slots.log('-', 'setup', 4096)),
      )
      const capabilities = JSON.parse(
        await Sandbox.run(sandbox, slots.probe()),
      ) as Sandbox.Capabilities
      assert.equal(capabilities.ns, true)
      assert.equal(capabilities.backend, 'ns')
      assert.equal(capabilities.network, 'private')

      const task = await loadTask('tasks/extract-todos', { solution: true })
      await sandbox.write(
        slots.taskFile('ns'),
        Tar.pack(
          Object.entries(task.files).map(([path, data]) => ({
            data: Bytes.fromBase64(data),
            executable: task.executable.includes(path),
            path,
          })),
        ),
      )
      const staged = Path.join(out, 'disk')
      const meta = await Converter.create({
        home: Path.join(out, 'converter'),
        layers: Converter.defaultLayers(out),
      }).convert(
        { context: 'tasks/extract-todos/environment', storageMb: task.environment.storageMb },
        staged + '.ext4',
      )
      const disk = cache + '/disks/fixture'
      await Sandbox.run(
        sandbox,
        'mkdir -p ' +
          Sandbox.quote(cache + '/disks') +
          ' && cp ' +
          Sandbox.quote(seen(staged + '.ext4')) +
          ' ' +
          Sandbox.quote(disk + '.ext4'),
      )
      await sandbox.write(disk + '.env', text(meta.env.map((line) => line + '\n').join('')))
      await sandbox.write(disk + '.user', text(meta.user + '\n'))
      await sandbox.write(disk + '.workdir', text(meta.workdir + '\n'))
      await Sandbox.run(
        sandbox,
        'umask 077 && ulimit -c 0 && ' +
          cached(
            slots.up('ns', {
              backend: 'ns',
              cpus: task.environment.cpus,
              disk,
              memoryMb: task.environment.memoryMb,
              network: 'private',
              storageMb: task.environment.storageMb,
            }),
          ),
      )
      assert.equal(
        await wait(async () => (await status()).slots['ns']!.up),
        'exit:0',
        await Sandbox.run(sandbox, slots.log('ns', 'up', 4096)),
      )

      assert.deepEqual(await inside('ls; ls -d /tests /solution; echo warn >&2; exit 7'), {
        exitCode: 7,
        stderr:
          'ls: /tests: No such file or directory\nls: /solution: No such file or directory\nwarn\n',
        stdout: 'notes.md\n',
      })
      assert.equal(
        (await inside('if (: </dev/tty) 2>/dev/null; then echo terminal; else echo none; fi'))
          .stdout,
        'none\n',
      )
      assert.match(
        (
          await sandbox.exec(
            'cd ' +
              Sandbox.quote(home + '/slots/ns') +
              ' && ' +
              Sandbox.quote(home + '/rt/krun/nanoeval-krun') +
              ' exec --socket vm.sock -- cat /proc/self/status',
          )
        ).stdout,
        /^SigIgn:\t0{16}$/m,
        'a command in a slot starts with no signal ignored',
      )
      assert.equal((await inside('echo $$; id -u')).stdout.split('\n')[1], '0')
      assert.deepEqual(
        await sandbox.exec(
          'cd ' +
            Sandbox.quote(home + '/slots/ns') +
            ' && ' +
            Sandbox.quote(home + '/rt/krun/nanoeval-krun') +
            ' exec --socket vm.sock --cwd /app --user 65534 -- sh -c ' +
            Sandbox.quote(
              'id -u; stat -c %a /; cat notes.md >/dev/null; test -x /opt/nanoeval/nanocode',
            ),
        ),
        { exitCode: 0, stderr: '', stdout: '65534\n755\n' },
        'a user of the image reaches the root, its files and the hand, whatever umask started the runner',
      )
      assert.equal(
        (await inside('ulimit -c; ulimit -c unlimited && ulimit -c')).stdout,
        '0\nunlimited\n',
        'a slot may raise its core limit, whatever limit the runner was started with',
      )
      assert.notEqual((await inside('mknod /tmp/disk b 8 0')).exitCode, 0)
      assert.notEqual((await inside('echo 1 >/proc/sys/kernel/panic')).exitCode, 0)
      assert.notEqual((await inside('mount -t tmpfs none /mnt')).exitCode, 0)
      assert.equal((await inside('ls /.nanoeval/io')).stdout, '')
      if (capabilities.cgroup)
        assert.equal(
          (await inside('cat /sys/fs/cgroup/memory.max')).stdout,
          task.environment.memoryMb * 1024 * 1024 + '\n',
        )

      await Sandbox.run(sandbox, slots.solve('ns', 30))
      assert.equal(await wait(async () => (await status()).slots['ns']!.solve), 'exit:0')
      await Sandbox.run(sandbox, slots.verify('ns', 30))
      assert.equal(await wait(async () => (await status()).slots['ns']!.verify), 'exit:0')
      assert.equal((await status()).slots['ns']!.reward, 1)
      assert.equal((await status()).slots['ns']!.oom, capabilities.cgroup ? 0 : null)
      assert.equal((await inside('ls /tests')).stdout, 'test.sh\n')

      const disks = async () =>
        (await Sandbox.run(sandbox, 'ls ' + Sandbox.quote(cache + '/disks')))
          .split('\n')
          .filter((name) => name.endsWith('.ext4') || name.endsWith('.mnt'))
      const prune = (mode: string) =>
        Sandbox.run(sandbox, cached('bash ' + Sandbox.quote(slots.script) + ' prune ' + mode))
      assert.deepEqual(await disks(), ['fixture.ext4', 'fixture.mnt'])
      assert.match(await prune('dry-run'), /^used disk .*\.ext4$/m)
      assert.match(await prune('remove'), /^kept disk .*\.ext4$/m)
      assert.deepEqual(await disks(), ['fixture.ext4', 'fixture.mnt'])
      await Sandbox.run(
        sandbox,
        'cp ' + Sandbox.quote(disk + '.ext4') + ' ' + Sandbox.quote(cache + '/disks/idle.ext4'),
      )
      await Sandbox.run(sandbox, cached(slots.drop(disk)))
      await Sandbox.run(sandbox, cached(slots.drop(cache + '/disks/idle')))
      assert.deepEqual(
        await disks(),
        ['fixture.ext4', 'fixture.mnt'],
        'drop removes a disk that no slot holds and keeps one that a slot holds',
      )
      assert.notEqual(
        (await sandbox.exec(cached(slots.drop(home + '/slots/ns/upper')))).exitCode,
        0,
        'drop removes disks of the cache only',
      )

      await Sandbox.run(sandbox, cached(slots.down('ns', 'remove')))
      assert.deepEqual(await disks(), [], 'the disk is unmounted and removed with its last slot')
      assert.deepEqual((await status()).slots, {})
      assert.equal(
        (await Sandbox.run(sandbox, "grep -c '/fixture.mnt ' /proc/mounts || true")).trim(),
        '0',
      )
    } finally {
      await provider.kill(created.handle)
      await server.close()
      guest?.close()
    }
  },
)
