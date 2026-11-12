import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Store from '../sandbox/Store.ts'
import * as Bootstrap from '../src/Bootstrap.ts'
import * as Config from '../src/Config.ts'
import * as E2b from '../src/E2b.ts'

function temporary(): string {
  return Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-remote-'))
}

function partial(bytes: Uint8Array, breaks: boolean): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream({
    async pull(controller) {
      if (!sent) controller.enqueue(bytes.subarray(0, breaks ? 100_000 : bytes.length))
      else if (breaks) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        controller.error(new Error('the connection was reset'))
      } else controller.close()
      sent = true
    },
  })
}

function sha256(bytes: Uint8Array): string {
  return Crypto.createHash('sha256').update(bytes).digest('hex')
}

test('a runner picks microVMs where the machine has KVM and namespaces where it has root', () => {
  assert.equal(Config.backend('auto', { kvm: true, ns: true }), 'krun')
  assert.equal(Config.backend('auto', { kvm: false, ns: true }), 'ns')
  assert.equal(Config.backend('auto', { kvm: false, ns: false }), undefined)
  assert.equal(Config.backend('ns', { kvm: true, ns: true }), 'ns')
  assert.equal(Config.backend('krun', { kvm: false, ns: true }), 'krun')
  assert.equal(Config.kind('auto'), 'disk')
  assert.equal(Config.kind('ns'), 'disk')
  assert.equal(Config.kind('dir'), 'dir')
  assert.equal(Config.network({ backend: 'ns' }), 'private')
})

test('a sandbox lifetime is the longest its slots can stay busy, after its setup', () => {
  const task = (agent: number, verifier: number, judge?: true) => ({
    agent: { timeoutSec: agent },
    verifier: { env: {}, timeoutSec: verifier, ...(judge ? { judge } : {}) },
  })
  const config = (slots: number, max: number) => ({
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    sandbox: { max, slots } as Config.Config['sandbox'],
  })
  const row = 600 + 900 + 300
  assert.equal(Config.rowSec(config(4, 1).limits, task(900, 300)), row)
  assert.equal(
    Config.rowSec(config(4, 1).limits, { ...task(900, 300), setupTimeoutSec: 1200 }),
    1200 + 900 + 300,
    'a task that names a longer setup is given it',
  )
  assert.equal(Config.lifetimeSec(config(4, 1), [task(900, 300)]), 600 + row)
  assert.equal(
    Config.lifetimeSec(
      config(2, 1),
      [1, 2, 3, 4, 5].map(() => task(900, 300)),
    ),
    600 + 3 * row,
  )
  assert.equal(
    Config.lifetimeSec(
      config(2, 2),
      [1, 2, 3, 4, 5].map(() => task(900, 300)),
    ),
    600 + 2 * row,
  )
  assert.equal(
    Config.lifetimeSec(config(1, 0), [task(60, 30, true)]),
    600 + 600 + 60 + 3 * 30,
    'a judged verifier runs twice around the judge',
  )
  assert.equal(
    Config.lifetimeSec(config(2, 1), [task(3000, 0), task(1000, 0), task(1000, 0), task(1000, 0)]),
    600 + 3 * 1600,
    'the longest rows are placed first, each on the slot that is free soonest',
  )
})

test('the answer of a paid sandbox request becomes a handle', () => {
  assert.deepEqual(
    E2b.handle({
      envdAccessToken: 'secret',
      envdVersion: '0.10.0',
      sandboxID: 'i3x9abc',
      templateID: 'base',
    }),
    { envdVersion: '0.10.0', home: '/home/user/.nanoeval', id: 'i3x9abc', token: 'secret' },
  )
  assert.throws(() => E2b.handle({ sandboxID: '' }), E2b.RequestError)
  assert.throws(() => E2b.handle({ sandboxID: 'a/b' }), E2b.RequestError)
})

test('a download that breaks is resumed from the bytes it has', async () => {
  const root = temporary()
  const bytes = Crypto.randomBytes(300_000)
  const name = sha256(bytes)
  const requests: string[] = []
  let cut = 2
  const store = Store.remote({
    base: 'https://worker.example/v1/blobs',
    fetch: async (_input, init) => {
      const range = new Headers(init?.headers).get('range')
      requests.push(range ?? 'whole')
      const from = range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0
      const rest = bytes.subarray(from)
      const breaks = cut-- > 0
      return new Response(partial(rest, breaks), { status: from ? 206 : 200 })
    },
    resumeMs: 1,
    token: 'secret',
  })
  const cache = Path.join(root, 'cache')
  Fs.mkdirSync(Path.join(cache, 'blobs'), { recursive: true })
  const file = await Store.ensure([store], { blob: { bytes: bytes.length, digest: name }, cache })
  assert.ok(Fs.readFileSync(file).equals(bytes))
  assert.deepEqual(requests, ['whole', 'bytes=100000-', 'bytes=200000-'])

  const whole: string[] = []
  let failed = false
  const ignoring = Store.remote({
    base: 'https://worker.example/v1/blobs',
    fetch: async (_input, init) => {
      whole.push(new Headers(init?.headers).get('range') ?? 'whole')
      const breaks = !failed
      failed = true
      return new Response(partial(bytes, breaks))
    },
    resumeMs: 1,
    token: 'secret',
  })
  const again = Path.join(root, 'again')
  assert.equal(await ignoring.fetch(name, again), true)
  assert.ok(
    Fs.readFileSync(again).equals(bytes),
    'a server that ignores the range is read from the start',
  )
  assert.deepEqual(whole, ['whole', 'bytes=100000-'])
  Fs.rmSync(root, { force: true, recursive: true })
})

test('the bootstrap of a remote sandbox checks the runtime and starts its runner as root', async () => {
  const root = temporary()
  const stage = Path.join(root, 'stage')
  Fs.mkdirSync(stage)
  Fs.writeFileSync(
    Path.join(stage, Bootstrap.files.runner),
    "import * as Fs from 'node:fs'\n" +
      'Fs.writeFileSync(process.env.NANOEVAL_CACHE + ".started", JSON.stringify({ argv: process.argv.slice(2), krun: process.env.NANOEVAL_KRUN, hand: process.env.NANOEVAL_NANOCODE }))\n',
  )
  const archive = Path.join(root, 'runtime.tgz')
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status, 0)
  const bytes = Fs.readFileSync(archive)
  const seen: (string | undefined)[] = []
  const server = Http.createServer((request, response) => {
    seen.push(request.headers.authorization, request.url)
    response.end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const bin = Path.join(root, 'bin')
  Fs.mkdirSync(bin)
  Fs.writeFileSync(Path.join(bin, 'sudo'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })
  const start = (home: string, digest: string) => {
    Fs.mkdirSync(home, { recursive: true })
    const file = Path.join(home, Bootstrap.files.script)
    Fs.writeFileSync(
      file,
      Bootstrap.script({
        home,
        run: 'run-1',
        runtime: { bytes: bytes.length, digest },
        token: 'runner-token',
        url,
      }),
    )
    return bash(file, bin + ':' + process.env['PATH'])
  }
  const home = Path.join(root, 'home')
  const started = await start(home, sha256(bytes))
  assert.equal(started.status, 0, started.stderr)
  assert.deepEqual(seen, ['Bearer runner-token', '/v1/runs/run-1/runner/blobs/' + sha256(bytes)])
  assert.deepEqual(JSON.parse(Fs.readFileSync(Path.join(home, 'cache.started'), 'utf8')), {
    argv: ['runner', '--detach', '--config', Path.join(home, Bootstrap.files.config)],
    hand: Path.join(home, 'cache', 'runtime', sha256(bytes), Bootstrap.files.hand),
    krun: Path.join(home, 'cache', 'runtime', sha256(bytes), Bootstrap.files.tools),
  })

  const refused = await start(Path.join(root, 'other'), 'f'.repeat(64))
  assert.notEqual(refused.status, 0)
  assert.ok(
    !Fs.existsSync(Path.join(root, 'other', 'cache', 'runtime', 'f'.repeat(64))),
    'a runtime that does not match is not unpacked',
  )
  server.close()
  Fs.rmSync(root, { force: true, recursive: true })
})

function bash(file: string, path: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [file], {
      env: { ...process.env, PATH: path },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('exit', (status) => resolve({ status, stderr }))
  })
}
