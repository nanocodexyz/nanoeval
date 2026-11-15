import { type ChildProcess, spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import * as Net from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import type * as Dataset from '../datasets/Dataset.ts'
import type * as Config from '../src/Config.ts'
import * as Installed from '../src/Installed.ts'
import * as Pins from '../src/Pins.ts'
import type * as Runs from '../src/Runs.ts'

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

export const ownProcesses = { option: '--own-processes', since: '5f8b457de' }

export const quick = { attempts: 3, eval: 'terminal-bench-2.1', subset: 'quick' }

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

export type Progress = {
  line(text: string): void
  rows(counts: Runs.Counts): void
  settle(): void
}

export type Ticket = { at: string; file: string; n: number; pid: number; what: string }

export type Served = { close(): Promise<void>; url: string }

export type Settings = {
  agents: readonly Config.Agent[]
  attempts: number
  judge?: Config.Judge
  modelUsd?: number
  slots: number
}

export type Recorded = {
  cancelled?: boolean
  eval?: { name: string; version: string }
  id: string
  nanocode?: Pins.Pins
  quick?: boolean
  rerun?: boolean
  settings?: Settings
}

export type Builds = { hand?: Built; package?: Built }

export type Held = { release(): Promise<void> }

export type Runner = { exit(): number | null; log: string }

export type Lab = {
  builds: Builds
  close(): Promise<void>
  directory: string
  progress: Progress
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

export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

export function rowsLine(counts: Runs.Counts): string {
  const ended = counts.passed + counts.failed + counts.errored
  return (
    'rows: ' +
    ended +
    ' of ' +
    counts.total +
    ' ended' +
    (ended
      ? ' (' +
        counts.passed +
        ' passed, ' +
        counts.failed +
        ' failed, ' +
        counts.errored +
        ' errored)'
      : '') +
    ', ' +
    counts.active +
    ' running, ' +
    counts.unclaimed +
    ' waiting'
  )
}

export function progress(options: {
  live: boolean
  now(): number
  quiet: boolean
  write(text: string): void
}): Progress {
  const started = options.now()
  const erase = '\r\u001b[K'
  let open = false
  let shown: string | undefined
  const stamp = () => '[' + clock(options.now() - started) + '] '
  return {
    line: (text) => {
      if (options.quiet) return
      options.write((open ? erase : '') + stamp() + text + '\n')
      open = false
    },
    rows: (counts) => {
      if (options.quiet) return
      const text = rowsLine(counts)
      if (options.live) {
        options.write(erase + stamp() + text)
        open = true
      } else if (text !== shown) options.write(stamp() + text + '\n')
      shown = text
    },
    settle: () => {
      if (open) options.write('\n')
      open = false
    },
  }
}

export async function recorded(lab: string): Promise<Recorded[]> {
  const text = await Fs.readFile(Path.join(lab, 'runs.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded)
}

export function standard(
  runs: readonly Recorded[],
  wanted: { eval: string; pins: { hand: string; harness: string } },
): Recorded | undefined {
  return runs.findLast(
    (run) =>
      run.quick &&
      !run.cancelled &&
      !run.rerun &&
      run.eval?.name === wanted.eval &&
      run.nanocode?.harness === wanted.pins.harness &&
      run.nanocode.hands.length === 1 &&
      run.nanocode.hands[0] === wanted.pins.hand,
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
  agents: readonly Pick<Config.Agent, 'api' | 'id' | 'provider'>[]
  judge?: Pick<Config.Judge, 'provider'>
  logins: { claude?: string; codex?: string }
  variables: Record<string, string | undefined>
}): (keyof typeof keys)[] {
  const wanted = new Map<keyof typeof keys, string[]>()
  for (const agent of input.agents) {
    if (agent.provider === 'oracle') continue
    const provider = Installed.is(agent.provider)
      ? Installed.provider(agent.provider, agent.api)
      : agent.provider
    wanted.set(provider, [...(wanted.get(provider) ?? []), 'the agent ' + agent.id])
  }
  if (input.judge)
    wanted.set(input.judge.provider, [...(wanted.get(input.judge.provider) ?? []), 'the judge'])
  const served: (keyof typeof keys)[] = []
  for (const [provider, users] of wanted) {
    if (input.logins[provider]) served.push(provider)
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
  return served
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
      ended([command, ...args], { code, cwd: options.cwd }) +
        ':\n' +
        (options.log ? await tail(options.log) : Buffer.concat(errors).toString().slice(-logTail)),
    )
  return Buffer.concat(chunks).toString()
}

export function ended(
  command: readonly string[],
  input: { code: number | string; cwd: string },
): string {
  const ran = command.join(' ') + ' in ' + input.cwd
  if (typeof input.code === 'number') return ran + ' exited with ' + input.code
  if (!input.code.endsWith('ENOENT')) return ran + ' ended with ' + input.code
  return (
    command[0] +
    ' is not on the PATH of this command, which ran ' +
    ran +
    ': install it, or start the command with a PATH that holds it. A systemd unit takes its PATH from its EnvironmentFile and not from the profile of a shell'
  )
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

async function free(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.stdin!.end()
  await ended
}

async function tickets(queue: string): Promise<Ticket[]> {
  const found: Ticket[] = []
  for (const name of await Fs.readdir(queue)) {
    const n = /^(\d+)\.json$/.exec(name)?.[1]
    if (n === undefined) continue
    const file = Path.join(queue, name)
    const said = await Fs.readFile(file, 'utf8').then(
      (text) => JSON.parse(text || '{}') as Partial<Ticket>,
      () => ({}) as Partial<Ticket>,
    )
    found.push({ at: said.at ?? '', file, n: Number(n), pid: said.pid ?? 0, what: said.what ?? '' })
  }
  return found.sort((left, right) => left.n - right.n)
}

export async function hold(
  lab: string,
  options: { waiting(ahead: readonly Ticket[]): void; what: string },
): Promise<Held> {
  const queue = Path.join(lab, 'queue')
  await Fs.mkdir(queue, { recursive: true })
  const gate = (await flock(Path.join(queue, 'gate'), true))!
  let ahead: Ticket[]
  let file: string
  let ticket: ChildProcess
  try {
    ahead = await tickets(queue)
    file = Path.join(queue, (ahead.at(-1)?.n ?? 0) + 1 + '.json')
    await Fs.writeFile(
      file,
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, what: options.what }) + '\n',
    )
    ticket = (await flock(file, true))!
  } finally {
    await free(gate)
  }
  const live: Ticket[] = []
  for (const earlier of ahead) {
    const left = await flock(earlier.file, false)
    if (!left) live.push(earlier)
    else {
      await free(left)
      await Fs.rm(earlier.file, { force: true })
    }
  }
  if (live.length) options.waiting(live)
  for (const earlier of live) {
    await free((await flock(earlier.file, true))!)
    await Fs.rm(earlier.file, { force: true })
  }
  const lock = Path.join(lab, 'lock')
  let child = await flock(lock, false)
  if (!child) {
    if (!live.length) options.waiting([])
    child = await flock(lock, true)
  }
  return {
    release: async () => {
      await free(child!)
      await free(ticket)
      await Fs.rm(file, { force: true })
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

export async function startable(tree: string, source: Source): Promise<void> {
  const child = spawn(
    'git',
    [
      '-C',
      tree,
      'grep',
      '--quiet',
      '--fixed-strings',
      '-e',
      ownProcesses.option.slice(2),
      source.commit,
    ],
    { stdio: 'ignore' },
  )
  const found = await new Promise<boolean>((done) => {
    child.once('error', () => done(false))
    child.once('close', (code) => done(code === 0))
  })
  if (found || source.dirty?.patch.includes(ownProcesses.option.slice(2))) return
  throw new SourceError(
    'nanocode ' +
      source.id +
      ' cannot be the hand of a slot: a slot starts its hand with ' +
      ownProcesses.option +
      ', so that a command that exhausts the memory of the slot ends alone, and nanocode knows that option from ' +
      ownProcesses.since +
      ' on. A hand without it ends at once and every row is an error: name a revision from ' +
      ownProcesses.since +
      ' on',
  )
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

  if (planned.hand !== undefined)
    log('hand: reading nanocode ' + planned.hand + ' from ' + options.repositories.nanocode)
  const source = planned.hand === undefined ? undefined : await nanocode(planned.hand)
  if (source) {
    await startable(trees.nanocode, source)
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
    log(
      'harness: reading nanocode-ts ' +
        planned.package.nanocodeTs +
        ' from ' +
        options.repositories.nanocodeTs,
    )
    const host = await resolve(planned.package.nanocodeTs, {
      repository: options.repositories.nanocodeTs,
      tree: trees.nanocodeTs,
    })
    await sync(trees.nanocodeTs, host)
    const own = JSON.parse(
      await Fs.readFile(Path.join(trees.nanocodeTs, 'sdk-revision.json'), 'utf8'),
    ) as { revision: string }
    const pack = async (sdk: Source): Promise<Built> => {
      const key = host.id + '-on-' + sdk.id
      const directory = Path.join(lab, 'packages', key)
      const before = await cached(directory)
      if (before) {
        log('harness: ' + before.label + ', built before in ' + directory)
        return before
      }
      const file = Path.join(logs, 'package-' + key + '.log')
      log(
        'harness: building nanocode-ts ' + host.id + ' on nanocode ' + sdk.id + ', log in ' + file,
      )
      const started = Date.now()
      const tree = trees.nanocodeTs
      await sync(tree, host)
      await sync(trees.nanocode, sdk)
      const env = {
        ...process.env,
        ...(options.caBundle ? { NODE_EXTRA_CA_CERTS: options.caBundle } : {}),
      }
      log('harness: npm ci')
      await run('npm', ['ci', '--ignore-scripts'], { cwd: tree, env, log: file })
      if (sdk.commit !== own.revision || sdk.dirty) {
        await Fs.writeFile(
          Path.join(tree, 'sdk-revision.json'),
          JSON.stringify({ ...own, revision: sdk.id }, null, 2) + '\n',
        )
        log('harness: cargo fetch, the lock of its crates for nanocode ' + sdk.id)
        await run('cargo', ['fetch'], { cwd: tree, env, log: file })
      }
      await Fs.rm(Path.join(tree, 'dist'), { force: true, recursive: true })
      log('harness: scripts/build.mjs, the WebAssembly modules')
      await run(process.execPath, ['scripts/build.mjs'], { cwd: tree, env, log: file })
      log('harness: npm run build:ts')
      await run('npm', ['run', 'build:ts'], { cwd: tree, env, log: file })
      await Fs.rm(directory, { force: true, recursive: true })
      await Fs.mkdir(directory, { recursive: true })
      for (const name of ['package.json', 'package-lock.json'])
        await Fs.copyFile(Path.join(tree, name), Path.join(directory, name))
      log('harness: npm ci --omit=dev, the dependencies of the package')
      await run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: directory, env, log: file })
      await Fs.cp(Path.join(tree, 'dist'), Path.join(directory, 'dist'), { recursive: true })
      const built = await finish(directory, {
        label: Pins.harness({ nanocode: sdk.id, nanocodeTs: host.id }),
        path: '.',
        seconds: Math.round((Date.now() - started) / 1000),
        sources: { nanocode: sdk, nanocodeTs: host },
      })
      log('harness: built in ' + built.seconds + ' s')
      return built
    }
    const sdk =
      planned.package.sdk === undefined
        ? await nanocode(own.revision)
        : planned.package.sdk === planned.hand
          ? source!
          : await nanocode(planned.package.sdk)
    const fallback = options.sdkFallback && sdk.commit !== own.revision
    const failed = Path.join(lab, 'packages', host.id + '-on-' + sdk.id + '.failed.json')
    const said = fallback
      ? await Fs.readFile(failed, 'utf8').then(
          (text) => (JSON.parse(text) as { log: string }).log,
          () => undefined,
        )
      : undefined
    let unbuilt = said
    if (said === undefined)
      try {
        builds.package = await pack(sdk)
      } catch (error) {
        if (!fallback || !(error instanceof BuildError)) throw error
        unbuilt = Path.join(logs, 'package-' + host.id + '-on-' + sdk.id + '.log')
        await Fs.mkdir(Path.dirname(failed), { recursive: true })
        await Fs.writeFile(
          failed,
          JSON.stringify({ at: new Date().toISOString(), log: unbuilt }) + '\n',
        )
      }
    if (unbuilt !== undefined) {
      const named = await nanocode(own.revision)
      log(
        'harness: nanocode-ts ' +
          host.id +
          ' does not build on nanocode ' +
          sdk.id +
          ' (' +
          unbuilt +
          '), so it is built on nanocode ' +
          named.id +
          ', the one it names itself: the rows run the brain of that nanocode' +
          (source ? ' with the hand of ' + source.id : ''),
      )
      builds.package = await pack(named)
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
    sdkFallback?: boolean
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

export async function port(): Promise<{ port: number; release(): void }> {
  const peer = Net.createServer()
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const held = Net.connect({
    host: '127.0.0.1',
    localAddress: '127.0.0.1',
    port: (peer.address() as Net.AddressInfo).port,
  })
  await new Promise<void>((resolve, reject) => {
    held.once('connect', resolve)
    held.once('error', reject)
  })
  return {
    port: held.localPort!,
    release: () => {
      held.end()
      peer.close()
    },
  }
}

export async function stop(
  child: ChildProcess,
  input: { log(line: string): void; stopSec: number; what: string },
): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const group = -child.pid
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(group, name)
    } catch {}
  }
  signal('SIGTERM')
  const limit = setTimeout(() => {
    input.log(
      input.what + ' did not stop within ' + input.stopSec + ' s of SIGTERM, and was killed',
    )
    signal('SIGKILL')
  }, input.stopSec * 1000)
  await exited
  clearTimeout(limit)
  signal('SIGKILL')
}

async function note(file: string, value: unknown): Promise<void> {
  const partial = file + '.' + process.pid
  await Fs.writeFile(partial, JSON.stringify(value) + '\n')
  await Fs.rename(partial, file)
}

async function secret(lab: string): Promise<string> {
  const file = Path.join(lab, 'token')
  if (!(await exists(file)))
    await Fs.writeFile(file, Crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  return (await Fs.readFile(file, 'utf8')).trim()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function noted(file: string): Promise<{ pid: number; url?: string } | undefined> {
  const text = await Fs.readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let said: { pid: number; url?: string }
  try {
    said = JSON.parse(text)
  } catch (error) {
    throw new Error(file + ' holds no JSON: ' + (error as Error).message)
  }
  return alive(said.pid) ? said : undefined
}

async function worker(options: {
  builds: Builds
  lab: string
  log(line: string): void
  logins: { claude?: string; codex?: string }
  pollMs: number
  state: ChildProcess
  stopSec: number
  token: string
  unwanted?(): Promise<boolean>
}): Promise<{ log: string; stop(): Promise<void>; url: string } | undefined> {
  const { builds, lab } = options
  const logs = Path.join(lab, 'logs')
  await Fs.mkdir(logs, { recursive: true })
  const kept = await port()
  const url = 'http://127.0.0.1:' + kept.port
  const log = Path.join(logs, 'worker.log')
  const output = await Fs.open(log, 'a')
  const child = spawn(
    process.execPath,
    [
      cli,
      'worker',
      '--port',
      String(kept.port),
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
        NANOEVAL_TOKEN: options.token,
        NANOEVAL_URL: url,
      },
      stdio: ['ignore', output.fd, output.fd],
    },
  )
  await output.close()
  const said = Path.join(lab, 'worker.json')
  const end = async () => {
    await stop(child, { log: options.log, stopSec: options.stopSec, what: 'the Worker' })
    kept.release()
    await Fs.rm(said, { force: true })
    await free(options.state)
  }
  const answers = async () => {
    for (;;) {
      const healthy = await fetch(url + '/health').then(
        (response) => response.ok,
        () => false,
      )
      if (healthy) return true
      if (child.exitCode !== null || child.signalCode !== null)
        throw new BuildError('the Worker did not start:\n' + (await tail(log)))
      if (await options.unwanted?.()) return false
      await new Promise((resolve) => setTimeout(resolve, options.pollMs))
    }
  }
  try {
    if (await answers()) {
      await note(said, { pid: process.pid, url })
      return { log, stop: end, url }
    }
  } catch (error) {
    await end()
    throw error
  }
  await end()
  return undefined
}

export async function open(options: open.Options): Promise<Lab> {
  const { builds, lab, progress } = options
  const log = progress.line
  const token = await secret(lab)
  const logs = Path.join(lab, 'logs')
  const wanted = Path.join(lab, 'worker.wanted')
  await note(wanted, { pid: process.pid })
  log('worker: starting under local workerd on the state in ' + Path.join(lab, 'worker'))
  const served = (await worker({
    builds,
    lab,
    log,
    logins: options.logins,
    pollMs: options.pollMs,
    state: (await flock(Path.join(lab, 'worker.lock'), true))!,
    stopSec: options.stopSec,
    token,
  }).catch(async (error: unknown) => {
    await Fs.rm(wanted, { force: true })
    throw error
  }))!
  const { url } = served
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
    progress.settle()
    for (const runner of runners) {
      await stop(runner, { log, stopSec: options.stopSec, what: 'the runner' })
      await sweep()
    }
    await served.stop()
    await Fs.rm(wanted, { force: true })
  }
  log('worker: ' + url + ', log in ' + served.log)
  return {
    builds,
    close,
    directory: lab,
    progress,
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
      log('runner: started on the rows of the run, log in ' + runnerLog)
      return {
        exit: () => child.exitCode ?? (child.signalCode ? 1 : null),
        log: runnerLog,
      }
    },
    token,
    url,
  }
}

export async function serve(options: serve.Options): Promise<Served> {
  const { lab, log } = options
  await Fs.mkdir(lab, { recursive: true })
  const token = await secret(lab)
  let closed = false
  let own: { stop(): Promise<void>; url: string } | undefined
  const wanted = async () => (await noted(Path.join(lab, 'worker.wanted'))) !== undefined
  const target = async () => own?.url ?? (await noted(Path.join(lab, 'worker.json')))?.url
  const settle = async () => {
    if (own && (await wanted())) {
      const mine = own
      own = undefined
      await mine.stop()
      log('an evaluation took the lab: its Worker answers from here on')
      return
    }
    if (own || (await wanted())) return
    const state = await flock(Path.join(lab, 'worker.lock'), false)
    if (!state) return
    try {
      if (!closed && !(await wanted()))
        own = await worker({
          builds: {},
          lab,
          log,
          logins: options.logins,
          pollMs: options.pollMs,
          state,
          stopSec: options.stopSec,
          token,
          unwanted: async () => closed || (await wanted()),
        })
    } finally {
      if (!own) await free(state)
    }
    if (own) log('no evaluation runs in the lab: a Worker of its own answers, ' + own.url)
  }
  const refuse = (response: Http.ServerResponse, status: number, error: string) =>
    response
      .writeHead(status, {
        'content-type': 'application/json',
        ...(status === 503 ? { 'retry-after': '1' } : {}),
      })
      .end(JSON.stringify({ error }) + '\n')
  const server = Http.createServer((request, response) => {
    void (async () => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        refuse(
          response,
          405,
          'the lab is served to be read: ' +
            request.method +
            ' is refused, an evaluation is started with nanoeval revision',
        )
        return
      }
      const base = await target()
      if (!base) {
        refuse(
          response,
          503,
          'no Worker answers for the lab at this moment, between two evaluations: ask again',
        )
        return
      }
      const answer = await fetch(base + request.url, {
        headers: request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {},
        method: request.method,
      })
      const headers: Record<string, string> = {}
      for (const name of ['content-length', 'content-type']) {
        const value = answer.headers.get(name)
        if (value !== null) headers[name] = value
      }
      response.writeHead(answer.status, headers)
      response.end(request.method === 'HEAD' ? undefined : Buffer.from(await answer.arrayBuffer()))
    })().catch((error: Error) => {
      if (!response.headersSent)
        refuse(response, 503, 'the Worker of the lab did not answer: ' + error.message)
      else response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  const url = 'http://127.0.0.1:' + (server.address() as Net.AddressInfo).port
  const loop = (async () => {
    while (!closed) {
      await settle().catch((error: Error) =>
        log('the lab has no Worker of its own: ' + error.message),
      )
      await new Promise((resolve) => setTimeout(resolve, options.pollMs))
    }
  })()
  return {
    close: async () => {
      closed = true
      await loop
      await own?.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    url,
  }
}

export declare namespace open {
  type Options = {
    builds: Builds
    lab: string
    logins: { claude?: string; codex?: string }
    pollMs: number
    progress: Progress
    stopSec: number
  }
}

export declare namespace serve {
  type Options = {
    lab: string
    log(line: string): void
    logins: { claude?: string; codex?: string }
    pollMs: number
    port?: number
    stopSec: number
  }
}
