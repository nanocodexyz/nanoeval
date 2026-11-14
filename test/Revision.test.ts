import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, before, test } from 'node:test'
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
  const first = await Revision.hold(lab, () => assert.fail('the lab was free'))
  let waited = false
  let second: Revision.Held | undefined
  const pending = Revision.hold(lab, () => {
    waited = true
  }).then((held) => {
    second = held
  })
  while (!waited) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(second, undefined)
  await first.release()
  await pending
  await second!.release()
  await (await Revision.hold(lab, () => assert.fail('the lab was released'))).release()
})
