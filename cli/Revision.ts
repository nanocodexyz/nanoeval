import { type ChildProcess, spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Net from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import type * as Dataset from '../datasets/Dataset.ts'
import type * as Config from '../src/Config.ts'
import * as Installed from '../src/Installed.ts'
import * as Pins from '../src/Pins.ts'

export class BuildError extends Error {
  override name = 'Revision.BuildError'
}

export class CredentialError extends Error {
  override name = 'Revision.CredentialError'
}

export class PlanError extends Error {
  override name = 'Revision.PlanError'
}

export class SourceError extends Error {
  override name = 'Revision.SourceError'
}

export const pinned = 'pinned'

export const keys = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'TEMPO_KEY'],
  codex: ['OPENAI_API_KEY', 'TEMPO_KEY'],
} as const

export const repositories = {
  nanocode: 'https://github.com/nanocodexyz/nanocode',
  nanocodeTs: 'https://github.com/nanocodexyz/nanocode-ts',
}

const flockConflict = 1
const logTail = 4000
const root = Path.resolve(import.meta.dirname, '..')
const cli = Path.join(root, 'cli', 'nanoeval.ts')

export type Plan = {
  hand: string | undefined
  package: { nanocodeTs: string; sdk: string | undefined } | undefined
}

export type Source = {
  commit: string
  dirty?: { from: string; patch: string; untracked: string[] }
  id: string
}

export type Built = { cached: boolean; label: string; path: string; seconds: number }

export type Builds = { hand?: Built; package?: Built }

export type Held = { release(): Promise<void> }

export type Runner = { exit(): number | null; log: string }

export type Lab = {
  builds: Builds
  close(): Promise<void>
  directory: string
  record(entry: Record<string, unknown>): Promise<void>
  runner(run: string, env: Record<string, string>): Promise<Runner>
  token: string
  url: string
}

export function defaultLab(env: Record<string, string | undefined> = process.env): string {
  return (
    env['NANOEVAL_LAB'] ??
    Path.join(env['XDG_DATA_HOME'] ?? Path.join(Os.homedir(), '.local', 'share'), 'nanoeval', 'lab')
  )
}

export function plan(input: { nanocode?: string; nanocodeTs?: string; sdk?: string }): Plan {
  const hand =
    input.nanocode === undefined || input.nanocode === pinned ? undefined : input.nanocode
  const nanocodeTs = input.nanocodeTs ?? (hand === undefined ? pinned : 'master')
  if (nanocodeTs === pinned) {
    if (input.sdk !== undefined)
      throw new PlanError(
        '--sdk names what a nanocode-ts revision is built against: name --nanocode-ts',
      )
    return { hand, package: undefined }
  }
  const sdk = input.sdk === pinned ? undefined : (input.sdk ?? hand)
  return { hand, package: { nanocodeTs, sdk } }
}

export function id(commit: string, change?: string): string {
  return Pins.short(commit) + (change ? '+' + Pins.short(change) : '')
}

export function profileDirectory(profile: string): string {
  return profile === 'dev' ? 'debug' : profile
}

export function aliases(
  directory: string,
  manifest: { exports?: unknown; name?: unknown },
): string[] {
  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.exports !== 'object' ||
    !manifest.exports
  )
    throw new SourceError(directory + ' holds no package with exports')
  return Object.entries(manifest.exports as Record<string, unknown>).flatMap(([subpath, entry]) => {
    const file =
      typeof entry === 'string' ? entry : (entry as { default?: unknown } | null)?.default
    return typeof file === 'string' && /\.[cm]?js$/.test(file)
      ? [
          '--alias',
          Path.posix.join(manifest.name as string, subpath) + ':' + Path.join(directory, file),
        ]
      : []
  })
}

export function missing(
  held: readonly string[],
  selection: Dataset.Selection,
): Dataset.Selection | undefined {
  if (selection.only?.length) {
    const only = selection.only.filter((wanted) => !held.includes(wanted))
    return only.length ? { only } : undefined
  }
  if (selection.limit !== undefined)
    return held.length >= selection.limit ? undefined : { limit: selection.limit }
  return held.length ? undefined : {}
}

export function credentials(input: {
  agents: readonly Pick<Config.Agent, 'id' | 'provider'>[]
  judge?: Pick<Config.Judge, 'provider'>
  logins: { claude?: string; codex?: string }
  variables: Record<string, string | undefined>
}): void {
  const wanted = new Map<keyof typeof keys, string[]>()
  for (const agent of input.agents) {
    if (agent.provider === 'oracle') continue
    const provider = Installed.is(agent.provider)
      ? Installed.releases[agent.provider].provider
      : agent.provider
    wanted.set(provider, [...(wanted.get(provider) ?? []), 'the agent ' + agent.id])
  }
  if (input.judge)
    wanted.set(input.judge.provider, [...(wanted.get(input.judge.provider) ?? []), 'the judge'])
  for (const [provider, users] of wanted) {
    if (input.logins[provider] || keys[provider].some((name) => input.variables[name])) continue
    throw new CredentialError(
      'no model credential serves ' +
        users.join(' and ') +
        ': set ' +
        keys[provider].join(' or ') +
        ', or name --' +
        provider +
        '-login FILE',
    )
  }
}

export function environment(builds: Builds): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  return [
    ...(builds.hand
      ? [
          'export NANOEVAL_NANOCODE=' + quote(builds.hand.path),
          'export NANOEVAL_NANOCODE_REVISION=' + quote(builds.hand.label),
        ]
      : []),
    ...(builds.package
      ? [
          'export NANOEVAL_NANOCODE_TS=' + quote(builds.package.path),
          'export NANOEVAL_NANOCODE_TS_REVISION=' + quote(builds.package.label),
        ]
      : []),
  ].join('\n')
}

async function exists(path: string): Promise<boolean> {
  return Fs.stat(path).then(
    () => true,
    () => false,
  )
}

async function tail(file: string): Promise<string> {
  const text = await Fs.readFile(file, 'utf8').catch(() => '')
  return text.slice(-logTail)
}

async function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: Uint8Array; log?: string },
): Promise<string> {
  const log = options.log ? await Fs.open(options.log, 'a') : undefined
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.input ? 'pipe' : 'ignore', log ? log.fd : 'pipe', log ? log.fd : 'pipe'],
  })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk))
  if (options.input) child.stdin!.end(options.input)
  const code = await new Promise<number | string>((resolve) => {
    child.once('error', (error) => resolve(error.message))
    child.once('close', (exit, signal) => resolve(exit ?? signal ?? 1))
  })
  await log?.close()
  if (code !== 0)
    throw new BuildError(
      [command, ...args].join(' ') +
        ' in ' +
        options.cwd +
        (typeof code === 'number' ? ' exited with ' + code : ' ended with ' + code) +
        ':\n' +
        (options.log ? await tail(options.log) : Buffer.concat(errors).toString().slice(-logTail)),
    )
  return Buffer.concat(chunks).toString()
}

async function flock(file: string, wait: boolean): Promise<ChildProcess | undefined> {
  const child = spawn(
    'flock',
    [...(wait ? [] : ['--nonblock']), file, 'sh', '-c', 'echo held && exec cat'],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const held = await new Promise<boolean | Error>((resolve) => {
    child.stdout!.once('data', () => resolve(true))
    child.once('error', (error) =>
      resolve(new BuildError('flock of util-linux did not start: ' + error.message)),
    )
    child.once('close', (code) =>
      resolve(
        code === flockConflict
          ? false
          : new BuildError(file + ' was not locked: flock exited with ' + code),
      ),
    )
  })
  if (held instanceof Error) throw held
  return held ? child : undefined
}

export async function hold(lab: string, waiting: () => void): Promise<Held> {
  await Fs.mkdir(lab, { recursive: true })
  const file = Path.join(lab, 'lock')
  let child = await flock(file, false)
  if (!child) {
    waiting()
    child = await flock(file, true)
  }
  const ended = new Promise<void>((resolve) => child!.once('close', () => resolve()))
  return {
    release: async () => {
      child!.stdin!.end()
      await ended
    },
  }
}

async function git(tree: string, args: readonly string[], input?: Uint8Array): Promise<string> {
  return (
    await run('git', ['-C', tree, ...args], { cwd: tree, ...(input ? { input } : {}) })
  ).trim()
}

export async function resolve(
  spec: string,
  options: { repository: string; tree: string },
): Promise<Source> {
  if (!(await exists(Path.join(options.tree, '.git')))) {
    await Fs.mkdir(options.tree, { recursive: true })
    await git(options.tree, ['init', '--quiet'])
  }
  const checkout = Path.resolve(spec)
  if ((await exists(spec)) && (await Fs.stat(spec)).isDirectory()) {
    const commit = await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const patch = await run('git', ['-C', checkout, 'diff', '--binary', 'HEAD'], { cwd: checkout })
    const untracked = (await git(checkout, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean)
      .sort()
    await git(options.tree, ['fetch', '--quiet', checkout, 'HEAD'])
    if (!patch && !untracked.length) return { commit, id: id(commit) }
    const hash = Crypto.createHash('sha256').update(patch)
    for (const path of untracked)
      hash.update(path + '\0').update(await Fs.readFile(Path.join(checkout, path)))
    return {
      commit,
      dirty: { from: checkout, patch, untracked },
      id: id(commit, hash.digest('hex')),
    }
  }
  await git(options.tree, [
    'fetch',
    '--quiet',
    options.repository,
    '+refs/heads/*:refs/remotes/origin/*',
  ])
  for (const name of ['refs/remotes/origin/' + spec, spec]) {
    const commit = await git(options.tree, [
      'rev-parse',
      '--verify',
      '--quiet',
      name + '^{commit}',
    ]).catch(() => '')
    if (commit) return { commit, id: id(commit) }
  }
  throw new SourceError(
    spec + ' is neither a directory nor a branch, tag or commit of ' + options.repository,
  )
}

export async function sync(tree: string, source: Source): Promise<void> {
  await git(tree, ['checkout', '--quiet', '--force', '--detach', source.commit])
  await git(tree, ['clean', '--quiet', '-fd'])
  if (!source.dirty) return
  if (source.dirty.patch)
    await git(tree, ['apply', '--whitespace=nowarn', '-'], Buffer.from(source.dirty.patch))
  for (const path of source.dirty.untracked)
    await Fs.cp(Path.join(source.dirty.from, path), Path.join(tree, path), {
      recursive: true,
      verbatimSymlinks: true,
    })
}

async function cached(directory: string): Promise<Built | undefined> {
  const text = await Fs.readFile(Path.join(directory, 'build.json'), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const build = JSON.parse(text) as { label: string; path: string; seconds: number }
  return {
    cached: true,
    label: build.label,
    path: Path.join(directory, build.path),
    seconds: build.seconds,
  }
}

async function finish(
  directory: string,
  build: { label: string; path: string; seconds: number; sources: Record<string, Source> },
): Promise<Built> {
  await Fs.writeFile(
    Path.join(directory, 'build.json'),
    JSON.stringify(
      {
        ...build,
        builtAt: new Date().toISOString(),
        sources: Object.fromEntries(
          Object.entries(build.sources).map(([name, source]) => [
            name,
            {
              commit: source.commit,
              id: source.id,
              ...(source.dirty ? { from: source.dirty.from } : {}),
            },
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
  )
  return {
    cached: false,
    label: build.label,
    path: Path.join(directory, build.path),
    seconds: build.seconds,
  }
}

export async function build(options: build.Options): Promise<Builds> {
  const { lab, log } = options
  const planned = plan(options)
  const trees = {
    nanocode: Path.join(lab, 'source', 'nanocodex'),
    nanocodeTs: Path.join(lab, 'source', 'nanocode-ts'),
  }
  const logs = Path.join(lab, 'logs')
  await Fs.mkdir(logs, { recursive: true })
  const builds: Builds = {}
  const nanocode = (spec: string) =>
    resolve(spec, { repository: options.repositories.nanocode, tree: trees.nanocode })

  const source = planned.hand === undefined ? undefined : await nanocode(planned.hand)
  if (source) {
    const directory = Path.join(lab, 'hands', source.id + '-' + options.profile)
    builds.hand = await cached(directory)
    if (builds.hand) log('hand: ' + builds.hand.label + ', built before in ' + directory)
    else {
      const file = Path.join(logs, 'hand-' + source.id + '-' + options.profile + '.log')
      log(
        'hand: building nanocode ' +
          source.id +
          ' with the ' +
          options.profile +
          ' profile, log in ' +
          file,
      )
      const started = Date.now()
      const target = Path.join(lab, 'target')
      await sync(trees.nanocode, source)
      await run(
        'cargo',
        [
          'build',
          '--locked',
          '--profile',
          options.profile,
          '-p',
          'nanocode-cli',
          '--bin',
          'nanocode',
        ],
        { cwd: trees.nanocode, env: { ...process.env, CARGO_TARGET_DIR: target }, log: file },
      )
      await Fs.rm(directory, { force: true, recursive: true })
      await Fs.mkdir(directory, { recursive: true })
      await Fs.copyFile(
        Path.join(target, profileDirectory(options.profile), 'nanocode'),
        Path.join(directory, 'nanocode'),
      )
      builds.hand = await finish(directory, {
        label: Pins.hand(source.id),
        path: 'nanocode',
        seconds: Math.round((Date.now() - started) / 1000),
        sources: { nanocode: source },
      })
      log('hand: built in ' + builds.hand.seconds + ' s')
    }
  }

  if (planned.package) {
    const host = await resolve(planned.package.nanocodeTs, {
      repository: options.repositories.nanocodeTs,
      tree: trees.nanocodeTs,
    })
    await sync(trees.nanocodeTs, host)
    const own = JSON.parse(
      await Fs.readFile(Path.join(trees.nanocodeTs, 'sdk-revision.json'), 'utf8'),
    ) as { revision: string }
    const sdk =
      planned.package.sdk === undefined
        ? await nanocode(own.revision)
        : planned.package.sdk === planned.hand
          ? source!
          : await nanocode(planned.package.sdk)
    const key = host.id + '-on-' + sdk.id
    const directory = Path.join(lab, 'packages', key)
    builds.package = await cached(directory)
    if (builds.package) log('harness: ' + builds.package.label + ', built before in ' + directory)
    else {
      const file = Path.join(logs, 'package-' + key + '.log')
      log(
        'harness: building nanocode-ts ' + host.id + ' on nanocode ' + sdk.id + ', log in ' + file,
      )
      const started = Date.now()
      const tree = trees.nanocodeTs
      await sync(trees.nanocode, sdk)
      const env = {
        ...process.env,
        ...(options.caBundle ? { NODE_EXTRA_CA_CERTS: options.caBundle } : {}),
      }
      await run('npm', ['ci', '--ignore-scripts'], { cwd: tree, env, log: file })
      if (sdk.commit !== own.revision || sdk.dirty) {
        await Fs.writeFile(
          Path.join(tree, 'sdk-revision.json'),
          JSON.stringify({ ...own, revision: sdk.id }, null, 2) + '\n',
        )
        await run('cargo', ['fetch'], { cwd: tree, env, log: file })
      }
      await Fs.rm(Path.join(tree, 'dist'), { force: true, recursive: true })
      await run(process.execPath, ['scripts/build.mjs'], { cwd: tree, env, log: file })
      await run('npm', ['run', 'build:ts'], { cwd: tree, env, log: file })
      await Fs.rm(directory, { force: true, recursive: true })
      await Fs.mkdir(directory, { recursive: true })
      for (const name of ['package.json', 'package-lock.json'])
        await Fs.copyFile(Path.join(tree, name), Path.join(directory, name))
      await run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: directory, env, log: file })
      await Fs.cp(Path.join(tree, 'dist'), Path.join(directory, 'dist'), { recursive: true })
      builds.package = await finish(directory, {
        label: Pins.harness({ nanocode: sdk.id, nanocodeTs: host.id }),
        path: '.',
        seconds: Math.round((Date.now() - started) / 1000),
        sources: { nanocode: sdk, nanocodeTs: host },
      })
      log('harness: built in ' + builds.package.seconds + ' s')
    }
  }
  return builds
}

export declare namespace build {
  type Options = {
    caBundle?: string
    lab: string
    log(line: string): void
    nanocode?: string
    nanocodeTs?: string
    profile: string
    repositories: { nanocode: string; nanocodeTs: string }
    sdk?: string
  }
}

export async function wrangler(
  env: Record<string, string | undefined>,
): Promise<{ arguments: string[]; vars: Record<string, string> }> {
  const directory = env['NANOEVAL_NANOCODE_TS']
  if (!directory) return { arguments: [], vars: {} }
  const resolved = Path.resolve(directory)
  const manifest = JSON.parse(
    await Fs.readFile(Path.join(resolved, 'package.json'), 'utf8').catch(() => {
      throw new SourceError(resolved + ' holds no package.json of a built nanocode-ts')
    }),
  ) as { exports?: unknown; name?: unknown }
  const wasm = JSON.parse(
    await Fs.readFile(Path.join(resolved, 'dist', 'nanocode-wasm.json'), 'utf8').catch(() => {
      throw new SourceError(resolved + ' holds no dist of a built nanocode-ts')
    }),
  ) as { fingerprint: string }
  return {
    arguments: aliases(resolved, manifest),
    vars: {
      NANOCODE_TS_REVISION:
        env['NANOEVAL_NANOCODE_TS_REVISION'] || 'nanocode-ts wasm ' + wasm.fingerprint,
    },
  }
}

async function freePort(): Promise<number> {
  const server = Net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as Net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    process.kill(-child.pid!, 'SIGTERM')
  } catch {}
  await exited
}

export async function open(options: open.Options): Promise<Lab> {
  const { builds, lab, log } = options
  const file = Path.join(lab, 'token')
  if (!(await exists(file)))
    await Fs.writeFile(file, Crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  const token = (await Fs.readFile(file, 'utf8')).trim()
  const logs = Path.join(lab, 'logs')
  await Fs.mkdir(logs, { recursive: true })
  const port = options.port ?? (await freePort())
  const url = 'http://127.0.0.1:' + port
  const workerLog = Path.join(logs, 'worker.log')
  const output = await Fs.open(workerLog, 'a')
  const worker = spawn(
    process.execPath,
    [
      cli,
      'worker',
      '--port',
      String(port),
      '--state',
      Path.join(lab, 'worker'),
      ...(options.logins.claude ? ['--claude-login', options.logins.claude] : []),
      ...(options.logins.codex ? ['--codex-login', options.logins.codex] : []),
    ],
    {
      detached: true,
      env: {
        ...process.env,
        NANOEVAL_NANOCODE_TS: builds.package?.path ?? '',
        NANOEVAL_NANOCODE_TS_REVISION: builds.package?.label ?? '',
        NANOEVAL_TOKEN: token,
        NANOEVAL_URL: url,
      },
      stdio: ['ignore', output.fd, output.fd],
    },
  )
  await output.close()
  const home = Path.join(lab, 'runner')
  const runners: ChildProcess[] = []
  const sweep = async () => {
    const left = await Fs.readdir(Path.join(home, 'slots')).catch(() => [])
    if (!left.length) return
    log('removing ' + left.length + ' slots that an earlier runner left in ' + home)
    await run('bash', [Path.join(root, 'sandbox', 'slot.sh'), 'destroy'], {
      cwd: lab,
      env: { ...process.env, NANOEVAL_HOME: home },
    }).catch((error: Error) => log('the slots in ' + home + ' were not removed: ' + error.message))
  }
  const close = async () => {
    for (const runner of runners) {
      await stop(runner)
      await sweep()
    }
    await stop(worker)
  }
  for (;;) {
    const healthy = await fetch(url + '/health').then(
      (response) => response.ok,
      () => false,
    )
    if (healthy) break
    if (worker.exitCode !== null || worker.signalCode !== null)
      throw new BuildError('the Worker did not start:\n' + (await tail(workerLog)))
    await new Promise((resolve) => setTimeout(resolve, options.pollMs))
  }
  log('worker: ' + url + ' on the state in ' + Path.join(lab, 'worker') + ', log in ' + workerLog)
  return {
    builds,
    close,
    directory: lab,
    record: (entry) => Fs.appendFile(Path.join(lab, 'runs.jsonl'), JSON.stringify(entry) + '\n'),
    runner: async (run, env) => {
      const runnerLog = Path.join(logs, 'runner-' + run + '.log')
      await sweep()
      await Fs.mkdir(home, { recursive: true })
      const out = await Fs.open(runnerLog, 'a')
      const child = spawn(
        process.execPath,
        [cli, 'runner', '--url', url, '--run', run, '--home', home],
        {
          detached: true,
          env: {
            ...process.env,
            ...env,
            NANOEVAL_NANOCODE: builds.hand?.path ?? '',
            NANOEVAL_NANOCODE_REVISION: builds.hand?.label ?? '',
            NANOEVAL_TOKEN: token,
          },
          stdio: ['ignore', out.fd, out.fd],
        },
      )
      await out.close()
      runners.push(child)
      return {
        exit: () => child.exitCode ?? (child.signalCode ? 1 : null),
        log: runnerLog,
      }
    },
    token,
    url,
  }
}

export declare namespace open {
  type Options = {
    builds: Builds
    lab: string
    log(line: string): void
    logins: { claude?: string; codex?: string }
    pollMs: number
    port?: number
  }
}
