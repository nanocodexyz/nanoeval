import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Cloudflare from '../src/Cloudflare.ts'
import * as Sandbox from '../src/Sandbox.ts'

type Call = { cmd: string[]; options: Record<string, unknown> | undefined }

const bytes = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer

function container(script: (call: Call, stdin: Uint8Array) => Promise<Cloudflare.ExecOutput> | Cloudflare.ExecOutput) {
  const calls: Call[] = []
  const state = { destroyed: 0, idleMs: [] as number[], running: false, started: [] as unknown[] }
  const fake: Cloudflare.Container = {
    get running() {
      return state.running
    },
    async destroy() {
      state.destroyed++
      state.running = false
    },
    async exec(cmd, options) {
      const call = { cmd, options: options as Record<string, unknown> | undefined }
      calls.push(call)
      const chunks: Uint8Array[] = []
      let closed: () => void = () => {}
      const done = new Promise<void>((resolve) => (closed = resolve))
      const stdin = options?.stdin === 'pipe'
        ? new WritableStream<Uint8Array>({ close: () => closed(), write: (chunk) => void chunks.push(chunk) })
        : null
      if (!stdin) closed()
      return {
        kill() {},
        async output() {
          await done
          if (options?.signal?.aborted) throw new Error('aborted')
          return script(call, Buffer.concat(chunks))
        },
        stdin,
      }
    },
    async setInactivityTimeout(ms) {
      state.idleMs.push(ms)
    },
    start(options) {
      state.started.push(options)
      state.running = true
    },
  }
  return { calls, fake, state }
}

const ok = { exitCode: 0, stderr: bytes(''), stdout: bytes('') }

test('a sandbox starts its container, waits for it to answer, and expires when the run said', async () => {
  let tries = 0
  const box = container((call) => {
    if (call.cmd[0] === '/bin/true' && ++tries < 3) throw new Error('container not ready')
    return ok
  })
  const served = Cloudflare.serve(box.fake, { now: () => 1_000, pollMs: 1, sleep: async () => {} })
  const opened: Array<[string, string | undefined]> = []
  const provider = Cloudflare.create({
    id: () => 'nanoeval-1',
    now: () => 1_000,
    sandbox: (id, instance) => (opened.push([id, instance]), served),
  })
  assert.equal(provider.name, 'cloudflare')
  const created = await provider.create({
    metadata: { run: 'r1' },
    template: 'standard-4',
    timeoutSec: 3_600,
  })
  assert.deepEqual(created, {
    expiresAt: 3_601_000,
    handle: { home: '/root/.nanoeval', id: 'nanoeval-1', instance: 'standard-4' },
  })
  assert.deepEqual(opened, [['nanoeval-1', 'standard-4']])
  assert.deepEqual(box.state.started, [{ enableInternet: true, env: { run: 'r1' } }])
  assert.equal(tries, 3)
  assert.deepEqual(box.state.idleMs, [3_600_000])
  await provider.kill(created.handle)
  assert.equal(box.state.destroyed, 1)
  await provider.kill(created.handle)
  assert.equal(box.state.destroyed, 1)
})

test('a container that never answers fails the start with the last error', async () => {
  let clock = 0
  const box = container(() => {
    throw new Error('no route to the container')
  })
  const served = Cloudflare.serve(box.fake, {
    now: () => clock,
    pollMs: 10,
    readyMs: 30,
    sleep: async (ms) => void (clock += ms),
  })
  await assert.rejects(
    served.start({ expiresAt: 1, metadata: {} }),
    /did not answer a command within 30 ms: no route to the container/,
  )
})

test('exec runs bash -l -c and returns its exit code and output as text', async () => {
  const box = container((call) => ({
    exitCode: 3,
    stderr: bytes('warn\n'),
    stdout: bytes('ran ' + call.cmd.at(-1)),
  }))
  const provider = Cloudflare.create({ sandbox: () => Cloudflare.serve(box.fake) })
  const sandbox = provider.connect({ home: Cloudflare.home, id: 'x' })
  assert.deepEqual(await sandbox.exec('echo hi'), { exitCode: 3, stderr: 'warn\n', stdout: 'ran echo hi' })
  assert.deepEqual(box.calls[0]!.cmd, ['/bin/bash', '-l', '-c', 'echo hi'])
  await assert.rejects(Sandbox.run(sandbox, 'false'), /exited with 3: warn/)
})

test('a command past its time limit ends with 124 instead of hanging the run', async () => {
  const box = container(async (call) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if ((call.options?.['signal'] as AbortSignal).aborted) throw new Error('aborted')
    return ok
  })
  const output = await Cloudflare.serve(box.fake, { execMs: 5 }).exec('sleep 100')
  assert.equal(output.exitCode, Cloudflare.timedOutCode)
  assert.match(output.stderr, /past 5 ms/)
})

test('write streams the bytes to stdin of a shell that makes the directory', async () => {
  const written = new Map<string, string>()
  const box = container((call, stdin) => {
    written.set(call.cmd.at(-1)!, Buffer.from(stdin).toString())
    return call.cmd.at(-1) === '/ro/x' ? { exitCode: 1, stderr: bytes('Read-only file system'), stdout: bytes('') } : ok
  })
  const sandbox = Cloudflare.create({ sandbox: () => Cloudflare.serve(box.fake) }).connect({
    home: Cloudflare.home,
    id: 'x',
  })
  await sandbox.write('/root/.nanoeval/bootstrap.sh', new TextEncoder().encode('#!/bin/sh\necho ok\n'))
  assert.equal(written.get('/root/.nanoeval/bootstrap.sh'), '#!/bin/sh\necho ok\n')
  assert.equal(box.calls[0]!.options?.['stdin'], 'pipe')
  assert.deepEqual(box.calls[0]!.cmd.slice(0, 2), ['/bin/sh', '-c'])
  await assert.rejects(sandbox.write('/ro/x', new Uint8Array([1])), /writing \/ro\/x exited with 1: Read-only/)
})
