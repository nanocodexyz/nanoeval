import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Net from 'node:net'
import * as Path from 'node:path'
import { loadTask } from '../cli/nanoeval.ts'
import * as Converter from '../sandbox/Converter.ts'
import * as Host from '../sandbox/Host.ts'
import type * as Config from '../src/Config.ts'
import * as Local from '../src/Local.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Krun from './Krun.ts'

export const fixture = 'test/fixtures/fixed-port'
const port = 5329

export function relays(root: string): string[] {
  const resolved = Fs.realpathSync(root)
  return spawnSync('ps', ['-eo', 'args='])
    .stdout.toString()
    .split('\n')
    .filter(
      (line) => line.startsWith(resolved + Path.sep) && line.includes('/rt/nanoeval-net host '),
    )
}

function read(host: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    const socket = Net.connect({ host, port })
    const done = () => {
      socket.destroy()
      resolve(text.trim())
    }
    socket.setTimeout(timeoutMs, done)
    socket.on('data', (chunk: Buffer) => (text += chunk.toString()))
    socket.on('error', done)
    socket.on('close', done)
  })
}

export async function isolation(options: isolation.Options): Promise<void> {
  const { backend, network } = options
  const provider = Local.create(options.sandboxd)
  const created = await provider.create({ metadata: {}, template: undefined, timeoutSec: 600 })
  const home = created.handle.home
  const sandbox = provider.connect(created.handle)
  const slots = Slot.create({ home })
  const quiet = 'quiet-' + created.handle.id.slice(0, 8)
  const serving = 'serving-' + created.handle.id.slice(0, 8)
  const token = 'token-of-' + serving
  const status = async () => Slot.parseStatus(await Sandbox.run(sandbox, slots.status()))
  const wait = async (read: () => Promise<Slot.Phase>) => {
    for (const started = Date.now(); Date.now() - started < 600_000; ) {
      const phase = await read()
      if (phase !== 'running' && phase !== 'none') return phase
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('the slot phase did not finish')
  }
  const inside = (slot: string, command: string) =>
    sandbox.exec(
      'cd ' +
        Sandbox.quote(home + '/slots/' + slot) +
        ' && ' +
        Sandbox.quote(home + '/rt/krun/nanoeval-krun') +
        ' exec --socket vm.sock --cwd /app -- sh -c ' +
        Sandbox.quote(command),
    )
  const answer = async (slot: string, address: string) =>
    (await inside(slot, 'nc -w 2 ' + address + ' ' + port + ' </dev/null')).stdout.trim()

  try {
    await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(home + '/slots'))
    await sandbox.write(slots.script, Fs.readFileSync('sandbox/slot.sh'))
    await Sandbox.run(sandbox, slots.setup({ backend, network, runtime: Slot.runtime }))
    assert.equal(await wait(async () => (await status()).setup), 'exit:0')
    const capabilities = JSON.parse(
      await Sandbox.run(sandbox, slots.probe()),
    ) as Sandbox.Capabilities
    assert.equal(capabilities.network, network)

    const task = await loadTask(fixture)
    const disk = home + '/disk'
    await Host.describe(
      disk,
      await Converter.create({
        home: home + '/converter',
        layers: Converter.defaultLayers(home),
      }).convert(
        { context: fixture + '/environment', storageMb: task.environment.storageMb },
        disk + '.ext4',
      ),
    )
    for (const slot of [quiet, serving]) {
      await Sandbox.run(sandbox, 'mkdir -p ' + Sandbox.quote(home + '/slots/' + slot))
      await Sandbox.run(
        sandbox,
        slots.up(slot, {
          backend,
          cpus: task.environment.cpus,
          disk,
          memoryMb: task.environment.memoryMb,
          network,
          storageMb: task.environment.storageMb,
        }),
      )
    }
    for (const slot of [quiet, serving])
      assert.equal(await wait(async () => (await status()).slots[slot]!.up), 'exit:0')

    await inside(
      serving,
      'echo ' +
        token +
        ' >/tmp/token; setsid nc -lk -p ' +
        port +
        ' -e cat /tmp/token >/dev/null 2>&1 &',
    )
    for (let tries = 0; (await answer(serving, '127.0.0.1')) !== token; tries++) {
      assert.ok(tries < 50, 'the serving slot reaches its own listener')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    assert.notEqual(
      await answer(quiet, '127.0.0.1'),
      token,
      'a slot reached the listener of another slot on its loopback',
    )
    const gateway = (await inside(quiet, "ip route | awk '/^default/ { print $3 }'")).stdout.trim()
    if (network === 'private') assert.ok(gateway, 'a private slot has a default route')
    for (const address of [gateway].filter(Boolean)) {
      assert.notEqual(
        await answer(quiet, address),
        token,
        'a slot reached the listener of another slot at ' + address,
      )
      assert.notEqual(
        await read(address, 2_000),
        token,
        'the host reached the listener of a slot at ' + address,
      )
    }
    assert.notEqual(
      await read('127.0.0.1', 2_000),
      token,
      'the listener of a slot is bound on the loopback of the host',
    )
    assert.notEqual(
      (await inside(quiet, 'wget -q -T 5 -O /dev/null http://127.0.0.1:' + options.hostPort + '/'))
        .exitCode,
      0,
      'a slot reached a listener on the loopback of the host',
    )
    assert.equal(
      (await inside(quiet, 'wget -q -T 20 -O /dev/null https://example.com/')).exitCode,
      0,
      'a slot resolves a name and reaches it over HTTPS',
    )
  } finally {
    await provider.kill(created.handle)
  }
  const root = Path.dirname(home)
  assert.deepEqual(relays(root), [], 'no relay outlives its sandbox')
  assert.deepEqual(Krun.machines(root), [], 'no microVM outlives its sandbox')
  assert.ok(!Fs.existsSync(home), 'no sandbox directory outlives its sandbox')
}

export declare namespace isolation {
  type Options = {
    backend: 'krun'
    hostPort: number
    network: Config.Config['sandbox']['network']
    sandboxd: { token: string; url: string }
  }
}
