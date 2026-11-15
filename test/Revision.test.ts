import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, before, test } from 'node:test'
import { workerVariables } from '../cli/nanoeval.ts'
import * as Revision from '../cli/Revision.ts'
import * as Proxy from '../src/Proxy.ts'

let directory: string

before(() => {
  directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-revision-'))
})

after(() => {
  Fs.rmSync(directory, { force: true, recursive: true })
})

function git(repository: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-C', repository, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function repository(name: string): string {
  const path = Path.join(directory, name)
  Fs.mkdirSync(Path.join(path, 'src'), { recursive: true })
  git(path, 'init', '--quiet', '--initial-branch', 'master')
  Fs.writeFileSync(Path.join(path, '.gitignore'), 'target/\n')
  Fs.writeFileSync(Path.join(path, 'src', 'one.rs'), 'one\n')
  Fs.writeFileSync(Path.join(path, 'src', 'two.rs'), 'two\n')
  git(path, 'add', '.')
  git(path, 'commit', '--quiet', '-m', 'first')
  return path
}

test('what is built follows from what is named, and pinned builds nothing', () => {
  assert.deepEqual(Revision.plan({}), { hand: undefined, package: undefined })
  assert.deepEqual(Revision.plan({ nanocode: 'pinned' }), { hand: undefined, package: undefined })
  assert.deepEqual(Revision.plan({ nanocode: 'abc' }), {
    hand: 'abc',
    package: { nanocodeTs: 'master', sdk: 'abc' },
  })
  assert.deepEqual(Revision.plan({ nanocode: 'abc', nanocodeTs: 'pinned' }), {
    hand: 'abc',
    package: undefined,
  })
  assert.deepEqual(Revision.plan({ nanocode: 'abc', nanocodeTs: 'def', sdk: 'pinned' }), {
    hand: 'abc',
    package: { nanocodeTs: 'def', sdk: undefined },
  })
  assert.deepEqual(Revision.plan({ nanocode: 'abc', nanocodeTs: 'def', sdk: '123' }), {
    hand: 'abc',
    package: { nanocodeTs: 'def', sdk: '123' },
  })
  assert.deepEqual(Revision.plan({ nanocodeTs: 'def' }), {
    hand: undefined,
    package: { nanocodeTs: 'def', sdk: undefined },
  })
  assert.throws(() => Revision.plan({ nanocode: 'abc', nanocodeTs: 'pinned', sdk: 'abc' }), {
    name: 'Revision.PlanError',
  })
})

test('a revision is named by its commit, and a checkout with changes by the commit and the changes', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(Revision.id(commit), '0123456789ab')
  assert.equal(Revision.id(commit, 'fedcba9876543210fedc'), '0123456789ab+fedcba987654')
  assert.equal(Revision.profileDirectory('release'), 'release')
  assert.equal(Revision.profileDirectory('dev'), 'debug')
})

test('the lab imports the tasks of a selection that it does not hold yet', () => {
  assert.deepEqual(Revision.missing([], {}), {})
  assert.equal(Revision.missing(['a'], {}), undefined)
  assert.deepEqual(Revision.missing(['a'], { only: ['a', 'b'] }), { only: ['b'] })
  assert.equal(Revision.missing(['a', 'b'], { only: ['a'] }), undefined)
  assert.deepEqual(Revision.missing(['a'], { limit: 2 }), { limit: 2 })
  assert.equal(Revision.missing(['a', 'b'], { limit: 2 }), undefined)
})

test('the command line loads no payment client, so a runner starts as fast as it did', () => {
  const probe = [
    "import { registerHooks } from 'node:module'",
    'const seen = new Set()',
    'registerHooks({ resolve(specifier, context, next) { seen.add(specifier); return next(specifier, context) } })',
    'await import(process.argv[1])',
    'console.log(JSON.stringify([...seen]))',
  ].join('\n')
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', probe, Path.resolve(import.meta.dirname, '../cli/nanoeval.ts')],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  const loaded = JSON.parse(result.stdout) as string[]
  assert.ok(loaded.includes('./Revision.ts'))
  assert.deepEqual(
    loaded.filter((specifier) => /^(mppx|viem)(\/|$)/.test(specifier)),
    [],
  )
})

test('the variables that serve a provider are the ones the Worker takes its key from', () => {
  const variables = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'TEMPO_GATEWAY_URL',
    'TEMPO_KEY',
  ]
  for (const provider of ['claude', 'codex'] as const)
    assert.deepEqual(
      variables.filter((name) => Proxy.key({ [name]: 'value' }, provider) !== undefined).sort(),
      [...Revision.keys[provider]].sort(),
    )
})

test('a local Worker is handed the model variables of the environment and no other', () => {
  const handed = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'NANOEVAL_REPLY_LIMIT',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'TEMPO_GATEWAY_URL',
    'TEMPO_KEY',
    'WORKERS_AI_ACCOUNT_ID',
    'WORKERS_AI_GATEWAY_URL',
    'WORKERS_AI_TOKEN',
  ]
  const set = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, name]))
  assert.deepEqual(workerVariables(set([...handed, 'HOME', 'TEMPO_PRIVATE_KEY'])), set(handed))
  for (const provider of ['claude', 'codex'] as const)
    for (const name of Revision.keys[provider]) assert.ok(handed.includes(name), name)
  assert.deepEqual(
    workerVariables({ OPENAI_API_KEY: 'key', OPENAI_BASE_URL: '', WORKERS_AI_ACCOUNT_ID: 'id' }),
    { OPENAI_API_KEY: 'key', WORKERS_AI_ACCOUNT_ID: 'id' },
  )
})

test('an evaluation is refused when no credential serves an agent or the judge', () => {
  const claude = { id: 'haiku', provider: 'claude' as const }
  const codex = { id: 'luna', provider: 'codex' as const }
  const cli = { id: 'cli', provider: 'codex-cli' as const }
  Revision.credentials({
    agents: [{ id: 'oracle', provider: 'oracle' }],
    logins: {},
    variables: {},
  })
  Revision.credentials({ agents: [claude], logins: {}, variables: { ANTHROPIC_API_KEY: 'k' } })
  Revision.credentials({ agents: [claude, codex, cli], logins: {}, variables: { TEMPO_KEY: 'k' } })
  Revision.credentials({ agents: [codex, cli], logins: { codex: 'auth.json' }, variables: {} })
  assert.throws(
    () =>
      Revision.credentials({
        agents: [claude, codex],
        logins: { codex: 'auth.json' },
        variables: {},
      }),
    /no model credential serves the agent haiku: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN or TEMPO_KEY, or name --claude-login FILE/,
  )
  assert.throws(
    () =>
      Revision.credentials({ agents: [cli], logins: {}, variables: { ANTHROPIC_API_KEY: 'k' } }),
    /the agent cli: set OPENAI_API_KEY or TEMPO_KEY, or name --codex-login FILE/,
  )
  assert.throws(
    () =>
      Revision.credentials({
        agents: [claude],
        judge: { provider: 'codex' },
        logins: {},
        variables: { ANTHROPIC_AUTH_TOKEN: 'k' },
      }),
    /serves the judge/,
  )
})

test('the Worker takes a built package by an alias for each of its entries, and names its build', async () => {
  const built = Path.join(directory, 'package')
  Fs.mkdirSync(Path.join(built, 'dist'), { recursive: true })
  Fs.writeFileSync(
    Path.join(built, 'package.json'),
    JSON.stringify({
      exports: {
        '.': { default: './dist/index.js', types: './dist/index.d.ts' },
        './cloudflare': { default: './dist/cloudflare/index.js' },
        './nanocode_wasm.wasm': './dist/nanocode_wasm.wasm',
      },
      name: 'nanocode-ts',
    }),
  )
  Fs.writeFileSync(
    Path.join(built, 'dist', 'nanocode-wasm.json'),
    JSON.stringify({ fingerprint: '0123abcd' }),
  )
  assert.deepEqual(await Revision.wrangler({}), { arguments: [], vars: {} })
  assert.deepEqual(await Revision.wrangler({ NANOEVAL_NANOCODE_TS: built }), {
    arguments: [
      '--alias',
      'nanocode-ts:' + Path.join(built, 'dist/index.js'),
      '--alias',
      'nanocode-ts/cloudflare:' + Path.join(built, 'dist/cloudflare/index.js'),
    ],
    vars: { NANOCODE_TS_REVISION: 'nanocode-ts wasm 0123abcd' },
  })
  assert.deepEqual(
    (
      await Revision.wrangler({
        NANOEVAL_NANOCODE_TS: built,
        NANOEVAL_NANOCODE_TS_REVISION: 'nanocode-ts a on nanocode b',
      })
    ).vars,
    { NANOCODE_TS_REVISION: 'nanocode-ts a on nanocode b' },
  )
  await assert.rejects(Revision.wrangler({ NANOEVAL_NANOCODE_TS: directory }), {
    name: 'Revision.SourceError',
  })
})

test('the variables of a build name the hand and the package for a runner and a Worker', () => {
  assert.equal(Revision.environment({}), '')
  assert.equal(
    Revision.environment({
      hand: {
        cached: true,
        label: 'nanocode 0123',
        path: '/lab/hands/0123-release/nanocode',
        seconds: 1,
      },
      package: { cached: false, label: "it's", path: '/lab/packages/a-on-b', seconds: 2 },
    }),
    [
      "export NANOEVAL_NANOCODE='/lab/hands/0123-release/nanocode'",
      "export NANOEVAL_NANOCODE_REVISION='nanocode 0123'",
      "export NANOEVAL_NANOCODE_TS='/lab/packages/a-on-b'",
      "export NANOEVAL_NANOCODE_TS_REVISION='it'\\''s'",
    ].join('\n'),
  )
})

test('a branch, a commit and a checkout with uncommitted changes become the same tree to build', async () => {
  const origin = repository('origin')
  const first = git(origin, 'rev-parse', 'HEAD')
  const tree = Path.join(directory, 'tree')
  const options = { repository: origin, tree }

  const branch = await Revision.resolve('master', options)
  assert.deepEqual(branch, { commit: first, id: first.slice(0, 12) })
  assert.deepEqual(await Revision.resolve(first.slice(0, 9), options), branch)
  await assert.rejects(Revision.resolve('no-such-branch', options), {
    name: 'Revision.SourceError',
  })
  await Revision.sync(tree, branch)
  assert.equal(Fs.readFileSync(Path.join(tree, 'src', 'one.rs'), 'utf8'), 'one\n')
  Fs.mkdirSync(Path.join(tree, 'target'))
  Fs.writeFileSync(Path.join(tree, 'target', 'kept'), 'a build output')

  const clean = await Revision.resolve(origin, options)
  assert.deepEqual(clean, branch)

  Fs.writeFileSync(Path.join(origin, 'src', 'one.rs'), 'one, changed\n')
  Fs.rmSync(Path.join(origin, 'src', 'two.rs'))
  Fs.writeFileSync(Path.join(origin, 'src', 'three.rs'), 'three\n')
  Fs.mkdirSync(Path.join(origin, 'target'))
  Fs.writeFileSync(Path.join(origin, 'target', 'ignored'), 'never copied')
  const dirty = await Revision.resolve(origin, options)
  assert.equal(dirty.commit, first)
  assert.match(dirty.id, new RegExp('^' + first.slice(0, 12) + '\\+[0-9a-f]{12}$'))
  assert.deepEqual(dirty.dirty?.untracked, ['src/three.rs'])
  assert.equal((await Revision.resolve(origin, options)).id, dirty.id)
  await Revision.sync(tree, dirty)
  assert.equal(Fs.readFileSync(Path.join(tree, 'src', 'one.rs'), 'utf8'), 'one, changed\n')
  assert.equal(Fs.existsSync(Path.join(tree, 'src', 'two.rs')), false)
  assert.equal(Fs.readFileSync(Path.join(tree, 'src', 'three.rs'), 'utf8'), 'three\n')
  assert.equal(Fs.existsSync(Path.join(tree, 'target', 'ignored')), false)
  assert.equal(Fs.readFileSync(Path.join(tree, 'target', 'kept'), 'utf8'), 'a build output')
  assert.equal(git(origin, 'status', '--porcelain').split('\n').length, 3)

  Fs.writeFileSync(Path.join(origin, 'src', 'three.rs'), 'three, again\n')
  assert.notEqual((await Revision.resolve(origin, options)).id, dirty.id)

  await Revision.sync(tree, branch)
  assert.equal(Fs.readFileSync(Path.join(tree, 'src', 'one.rs'), 'utf8'), 'one\n')
  assert.equal(Fs.readFileSync(Path.join(tree, 'src', 'two.rs'), 'utf8'), 'two\n')
  assert.equal(Fs.existsSync(Path.join(tree, 'src', 'three.rs')), false)
  assert.equal(Fs.readFileSync(Path.join(tree, 'target', 'kept'), 'utf8'), 'a build output')
})

test('one evaluation holds a lab, and a second waits until it is released', async () => {
  const lab = Path.join(directory, 'lab')
  const free = { waiting: () => assert.fail('the lab was free'), what: 'free' }
  const first = await Revision.hold(lab, { ...free, what: 'first' })
  let waited: readonly Revision.Ticket[] | undefined
  let second: Revision.Held | undefined
  const pending = Revision.hold(lab, {
    waiting: (ahead) => {
      waited = ahead
    },
    what: 'second',
  }).then((held) => {
    second = held
  })
  while (!waited) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(
    waited.map((ticket) => [ticket.what, ticket.pid]),
    [['first', process.pid]],
  )
  assert.equal(second, undefined)
  await first.release()
  await pending
  await second!.release()
  await (await Revision.hold(lab, free)).release()
  assert.deepEqual(Fs.readdirSync(Path.join(lab, 'queue')), ['gate'])
})

test('evaluations take a lab in the order in which they asked for it, and one that died is passed over', async () => {
  const lab = Path.join(directory, 'lab-queue')
  const first = await Revision.hold(lab, { waiting: () => assert.fail('free'), what: 'a' })
  const order: string[] = []
  const pending: Promise<void>[] = []
  for (const [at, what] of ['b', 'c', 'd', 'e'].entries()) {
    let ahead: string[] | undefined
    pending.push(
      Revision.hold(lab, {
        waiting: (tickets) => {
          ahead = tickets.map((ticket) => ticket.what)
        },
        what,
      }).then(async (held) => {
        order.push(what)
        await new Promise((resolve) => setTimeout(resolve, 30))
        await held.release()
      }),
    )
    while (!ahead) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(ahead, ['a', 'b', 'c', 'd'].slice(0, at + 1))
  }
  await first.release()
  await Promise.all(pending)
  assert.deepEqual(order, ['b', 'c', 'd', 'e'])

  Fs.writeFileSync(Path.join(lab, 'queue', '7.json'), JSON.stringify({ pid: 1, what: 'died' }))
  const next = await Revision.hold(lab, {
    waiting: () => assert.fail('nobody holds it'),
    what: 'f',
  })
  assert.deepEqual(Fs.readdirSync(Path.join(lab, 'queue')).sort(), ['8.json', 'gate'])
  await next.release()
})

test('progress is one stamped line a phase and a row counter, and nothing when it is quiet', () => {
  const counts = { active: 2, errored: 0, failed: 0, passed: 0, total: 9, unclaimed: 7 }
  const later = { active: 2, errored: 0, failed: 1, passed: 1, total: 9, unclaimed: 5 }
  let now = 1_000
  const written: string[] = []
  const options = { now: () => now, write: (text: string) => void written.push(text) }
  const plain = Revision.progress({ ...options, live: false, quiet: false })
  plain.line('hand: building')
  now += 61_000
  plain.line('worker: starting')
  plain.rows(counts)
  plain.rows(counts)
  now += 14_500
  plain.rows(later)
  plain.settle()
  assert.deepEqual(written, [
    '[0:00] hand: building\n',
    '[1:01] worker: starting\n',
    '[1:01] rows: 0 of 9 ended, 2 running, 7 waiting\n',
    '[1:15] rows: 2 of 9 ended (1 passed, 1 failed, 0 errored), 2 running, 5 waiting\n',
  ])

  written.length = 0
  now = 0
  const live = Revision.progress({ ...options, live: true, quiet: false })
  live.rows(counts)
  now = 2_000
  live.rows(counts)
  live.line('runner: gone')
  live.rows(later)
  live.settle()
  live.settle()
  const erase = '\r\u001b[K'
  assert.deepEqual(written, [
    erase + '[0:00] rows: 0 of 9 ended, 2 running, 7 waiting',
    erase + '[0:02] rows: 0 of 9 ended, 2 running, 7 waiting',
    erase + '[0:02] runner: gone\n',
    erase + '[0:02] rows: 2 of 9 ended (1 passed, 1 failed, 0 errored), 2 running, 5 waiting',
    '\n',
  ])

  written.length = 0
  const quiet = Revision.progress({ ...options, live: true, quiet: true })
  quiet.line('hand: building')
  quiet.rows(counts)
  quiet.settle()
  assert.deepEqual(written, [])
  assert.equal(Revision.clock(3_725_999), '62:05')
})

test('a nanocode whose hand a slot cannot start is refused when it is named', async () => {
  const origin = repository('nanocode-old')
  const old = git(origin, 'rev-parse', 'HEAD')
  Fs.writeFileSync(
    Path.join(origin, 'src', 'cli.rs'),
    'Argument::flag("x").long("own-processes")\n',
  )
  git(origin, 'add', '.')
  git(origin, 'commit', '--quiet', '-m', 'second')
  const tree = Path.join(directory, 'tree-old')
  const at = (spec: string) => Revision.resolve(spec, { repository: origin, tree })
  await Revision.startable(tree, await at('master'))
  await assert.rejects(Revision.startable(tree, await at(old)), {
    message:
      'nanocode ' +
      old.slice(0, 12) +
      ' cannot be the hand of a slot: a slot starts its hand with --own-processes, so that a command that exhausts the memory of the slot ends alone, and nanocode knows that option from 5f8b457de on. A hand without it ends at once and every row is an error: name a revision from 5f8b457de on',
    name: 'Revision.SourceError',
  })
  const checkout = Path.join(directory, 'checkout-old')
  git(directory, 'clone', '--quiet', origin, checkout)
  git(checkout, 'checkout', '--quiet', '--detach', old)
  Fs.writeFileSync(Path.join(checkout, 'src', 'one.rs'), 'flag own-processes\n')
  await Revision.startable(tree, await at(checkout))
})

test('the lab remembers the settings of its runs, and the latest quick run on the pinned builds is the standard of the next', async () => {
  const lab = Path.join(directory, 'lab-recorded')
  assert.deepEqual(await Revision.recorded(lab), [])
  const pins = { hand: 'nanocode-cli-1234567', harness: 'nanocode-ts build-abcdef0' }
  const pinned = { hands: [pins.hand], harness: pins.harness }
  const settings = {
    agents: [{ id: 'luna', model: 'gpt-6-luna', provider: 'codex' as const }],
    attempts: 3,
    modelUsd: 1,
    slots: 2,
  }
  const runs: Revision.Recorded[] = [
    { eval: { name: 'bench', version: 'a' }, id: 'old', nanocode: pinned },
    { eval: { name: 'bench', version: 'a' }, id: 'pins', nanocode: pinned, quick: true, settings },
    {
      eval: { name: 'bench', version: 'a' },
      id: 'again',
      nanocode: pinned,
      quick: true,
      rerun: true,
      settings,
    },
    {
      cancelled: true,
      eval: { name: 'bench', version: 'a' },
      id: 'stopped',
      nanocode: pinned,
      quick: true,
      settings,
    },
    { eval: { name: 'bench', version: 'a' }, id: 'plain', nanocode: pinned, settings },
    {
      eval: { name: 'bench', version: 'b' },
      id: 'built',
      nanocode: { hands: ['nanocode 0123456789ab'], harness: pins.harness },
      quick: true,
      settings,
    },
    { eval: { name: 'other', version: 'c' }, id: 'other', nanocode: pinned, quick: true, settings },
  ]
  Fs.mkdirSync(lab, { recursive: true })
  Fs.writeFileSync(
    Path.join(lab, 'runs.jsonl'),
    runs.map((run) => JSON.stringify(run) + '\n').join(''),
  )
  const read = await Revision.recorded(lab)
  assert.deepEqual(read, runs)
  assert.equal(Revision.standard(read, { eval: 'bench', pins })?.id, 'pins')
  assert.equal(Revision.standard(read.slice(0, 1), { eval: 'bench', pins }), undefined)
  assert.equal(Revision.standard(read, { eval: 'none', pins }), undefined)
  assert.deepEqual(Revision.quick, { attempts: 3, eval: 'terminal-bench-2.1', subset: 'quick' })
})

test('a served lab answers reads from the Worker of the evaluation that runs, and refuses a write', async () => {
  const lab = Path.join(directory, 'lab-served')
  Fs.mkdirSync(lab, { recursive: true })
  const seen: string[] = []
  const worker = Http.createServer((request, response) => {
    seen.push(request.method + ' ' + request.url + ' ' + request.headers.authorization)
    response.writeHead(request.url === '/v1/runs/none' ? 404 : 200, {
      'content-type': 'application/json',
    })
    response.end(JSON.stringify({ url: request.url }))
  })
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + (worker.address() as AddressInfo).port
  Fs.writeFileSync(Path.join(lab, 'worker.wanted'), JSON.stringify({ pid: process.pid }))
  const lines: string[] = []
  const served = await Revision.serve({
    lab,
    log: (line) => void lines.push(line),
    logins: {},
    pollMs: 10,
    stopSec: 30,
  })
  const ask = (path: string, init: RequestInit = {}) =>
    fetch(served.url + path, { ...init, headers: { authorization: 'Bearer t' } })
  const none = await ask('/v1/runs')
  assert.equal(none.status, 503)
  assert.equal(none.headers.get('retry-after'), '1')
  assert.match(await none.text(), /no Worker answers for the lab at this moment/)
  Fs.writeFileSync(Path.join(lab, 'worker.json'), JSON.stringify({ pid: process.pid, url }))
  const read = await ask('/v1/runs?limit=2')
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), { url: '/v1/runs?limit=2' })
  assert.equal((await ask('/v1/runs/none')).status, 404)
  assert.equal((await ask('/v1/blobs/abc', { method: 'HEAD' })).status, 200)
  for (const method of ['POST', 'DELETE', 'PUT']) {
    const refused = await ask('/v1/runs/one/cancel', { method })
    assert.equal(refused.status, 405)
    assert.match(await refused.text(), new RegExp('the lab is served to be read: ' + method))
  }
  assert.deepEqual(seen, [
    'GET /v1/runs?limit=2 Bearer t',
    'GET /v1/runs/none Bearer t',
    'HEAD /v1/blobs/abc Bearer t',
  ])
  Fs.writeFileSync(Path.join(lab, 'worker.json'), JSON.stringify({ pid: 2 ** 22 + 1, url }))
  assert.equal((await ask('/v1/runs')).status, 503)
  await served.close()
  await new Promise<void>((resolve) => worker.close(() => resolve()))
  assert.deepEqual(lines, [])
  assert.equal(Fs.readFileSync(Path.join(lab, 'token'), 'utf8').trim().length, 64)
})

test('a served lab that cannot read what an evaluation wrote stops the Worker it was starting and gives up its lock', async () => {
  const lab = Path.join(directory, 'lab-unread')
  Fs.mkdirSync(lab, { recursive: true })
  const wanted = Path.join(lab, 'worker.wanted')
  const held = () =>
    spawnSync('flock', ['--nonblock', Path.join(lab, 'worker.lock'), 'true']).status === 1
  const until = async (what: string, met: () => boolean) => {
    for (const since = Date.now(); !met(); ) {
      if (Date.now() - since > 120_000) assert.fail('timed out waiting for ' + what)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const lines: string[] = []
  const served = await Revision.serve({
    lab,
    log: (line) => void lines.push(line),
    logins: {},
    pollMs: 10,
    stopSec: 30,
  })
  await until('the served lab to hold the lock for a Worker of its own', held)
  Fs.writeFileSync(wanted, '')
  await until('the served lab to give up the lock', () => !held())
  assert.equal(
    spawnSync('pgrep', ['-f', '--', '--state ' + Path.join(lab, 'worker') + '( |$)']).status,
    1,
    'the Worker that the served lab was starting is gone',
  )
  await served.close()
  assert.ok(lines.length > 0)
  for (const line of lines)
    assert.match(line, /^the lab has no Worker of its own: \S+worker\.wanted holds no JSON: /)
  assert.equal(held(), false)
})

test('a process that does not stop when it is asked to is killed once its time to stop is over', async () => {
  const lines: string[] = []
  const log = (line: string) => void lines.push(line)
  const deaf = spawn('sh', ['-c', 'trap "" TERM; echo deaf; while :; do sleep 1; done'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => deaf.stdout.once('data', resolve))
  await Revision.stop(deaf, { log, stopSec: 0.2, what: 'the child' })
  assert.equal(deaf.signalCode, 'SIGKILL')
  assert.deepEqual(lines, ['the child did not stop within 0.2 s of SIGTERM, and was killed'])
  const willing = spawn('sh', ['-c', 'sh -c \'trap "" TERM; echo $$; exec sleep 600\' & wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const left = Number(await new Promise((resolve) => willing.stdout.once('data', resolve)))
  await Revision.stop(willing, { log, stopSec: 60, what: 'the child' })
  assert.equal(willing.signalCode, 'SIGTERM')
  assert.equal(lines.length, 1)
  for (const since = Date.now(); ; ) {
    try {
      process.kill(left, 0)
    } catch {
      break
    }
    if (Date.now() - since > 60_000)
      assert.fail('what a stopped process left in its group is killed with it')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
})

test('a port that is kept is one a server listens on, again after it stopped, while it is kept', async () => {
  const kept = await Revision.port()
  for (const _ of [1, 2]) {
    const server = Http.createServer((_, response) => void response.end('here'))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(kept.port, '127.0.0.1', resolve)
    })
    assert.equal(await (await fetch('http://127.0.0.1:' + kept.port)).text(), 'here')
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  kept.release()
})

test('a build whose command is not on the PATH says so, and what a unit takes its PATH from', () => {
  const command = ['cargo', 'build', '--locked']
  assert.equal(
    Revision.ended(command, { code: 101, cwd: '/lab/source/nanocode' }),
    'cargo build --locked in /lab/source/nanocode exited with 101',
  )
  assert.equal(
    Revision.ended(command, { code: 'SIGKILL', cwd: '/lab/source/nanocode' }),
    'cargo build --locked in /lab/source/nanocode ended with SIGKILL',
  )
  assert.equal(
    Revision.ended(command, { code: 'spawn cargo ENOENT', cwd: '/lab/source/nanocode' }),
    'cargo is not on the PATH of this command, which ran cargo build --locked in /lab/source/nanocode: install it, or start the command with a PATH that holds it. A systemd unit takes its PATH from its EnvironmentFile and not from the profile of a shell',
  )
})
