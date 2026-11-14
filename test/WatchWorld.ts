import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import type * as Watch from '../src/Watch.ts'
import type { Scenario } from './StubRevision.ts'

const cli = Path.join(import.meta.dirname, '..', 'cli', 'nanoeval.ts')
const stub = Path.join(import.meta.dirname, 'StubRevision.ts')
const roots: string[] = []

export function clean(): void {
  for (const root of roots) Fs.rmSync(root, { force: true, recursive: true })
}

type Options = {
  bisect?: 'off'
  dailyRuns?: number
  dailyUsd?: number
  hook?: boolean | string[]
  hookSec?: number
}

export function world(options: Options = {}) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-watch-'))
  roots.push(root)
  const lab = Path.join(root, 'lab')
  const state = Path.join(root, 'state')
  const config = Path.join(root, 'watch.toml')
  const hooked = Path.join(root, 'hook.jsonl')
  let clock = 1_800_000_000
  let date = clock + ' +0000'
  const git = (repository: string, args: readonly string[]) => {
    const result = spawnSync('git', ['-C', Path.join(root, repository), ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const commit = (repository: 'nanocode' | 'nanocode-ts', subject: string): string => {
    clock += 10
    date = clock + ' +0000'
    git(repository, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.test',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      subject,
    ])
    return git(repository, ['rev-parse', 'HEAD'])
  }
  const configure = (changed: Options = options) =>
    Fs.writeFileSync(
      config,
      [
        'state = "state"',
        'poll_sec = 0.2',
        ...(changed.bisect ? ['bisect = "off"'] : []),
        '[nanocode]',
        'repository = ' + JSON.stringify(Path.join(root, 'nanocode')),
        'branch = "master"',
        '[nanocode_ts]',
        'repository = ' + JSON.stringify(Path.join(root, 'nanocode-ts')),
        'branch = "master"',
        '[eval]',
        'name = "bench"',
        'tasks = ["alpha", "beta", "gamma"]',
        'attempts = 2',
        'agents = ["sonnet=claude:claude-sonnet-5-5", "luna=codex:gpt-6-luna"]',
        'slots = 4',
        '[budget]',
        'run_usd = 1',
        'daily_usd = ' + (changed.dailyUsd ?? 100),
        'daily_runs = ' + (changed.dailyRuns ?? 100),
        '[revision]',
        'command = ' + JSON.stringify([process.execPath, stub]),
        'lab = "lab"',
        ...(changed.hook
          ? [
              '[hook]',
              'command = ' +
                JSON.stringify(
                  changed.hook === true ? ['sh', '-c', 'cat >> ' + hooked] : changed.hook,
                ),
              ...(changed.hookSec === undefined ? [] : ['timeout_sec = ' + changed.hookSec]),
            ]
          : []),
        '',
      ].join('\n'),
    )
  const origin: Record<string, string> = {}
  for (const repository of ['nanocode', 'nanocode-ts'] as const) {
    Fs.mkdirSync(Path.join(root, repository))
    git(repository, ['init', '-q', '-b', 'master'])
    Fs.writeFileSync(Path.join(root, repository, 'README'), 'first\n')
    git(repository, ['add', 'README'])
    origin[repository] = commit(repository, 'init ' + repository)
  }
  Fs.mkdirSync(lab)
  let scenario: Scenario = {}
  const play = (change: Scenario) => {
    scenario = { ...scenario, ...change }
    Fs.writeFileSync(Path.join(lab, 'stub.json'), JSON.stringify(scenario))
  }
  play({})
  configure()
  const lines = (): Watch.Evaluation[] =>
    Fs.existsSync(Path.join(state, 'watch.jsonl'))
      ? Fs.readFileSync(Path.join(state, 'watch.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Watch.Evaluation)
      : []
  const calls = (): string[][] =>
    Fs.existsSync(Path.join(lab, 'stub-calls.jsonl'))
      ? Fs.readFileSync(Path.join(lab, 'stub-calls.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : []
  return {
    board: () => Fs.readFileSync(Path.join(state, 'scoreboard.md'), 'utf8'),
    calls,
    commit,
    config,
    configure,
    git,
    hooked: () =>
      Fs.readFileSync(hooked, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Watch.Evaluation & { scoreboard: string }),
    intents: () =>
      Fs.readdirSync(Path.join(state, 'intents')).map(
        (name) =>
          JSON.parse(Fs.readFileSync(Path.join(state, 'intents', name), 'utf8')) as Watch.Intent,
      ),
    lab,
    lines,
    origin,
    play,
    root,
    runs: (nanocode?: string) =>
      calls().filter(
        (call) =>
          !call.includes('--build-only') &&
          (nanocode === undefined || value(call, '--nanocode')[0] === nanocode),
      ),
    start: (...args: string[]) =>
      spawn(process.execPath, [cli, 'watch', '--config', config, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    state,
    watch: (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, 'watch', '--config', config, ...args], {
        encoding: 'utf8',
      })
      return { status: result.status, stderr: result.stderr, stdout: result.stdout }
    },
  }
}

export function value(call: readonly string[], option: string): string[] {
  return call.flatMap((entry, index) => (entry === option ? [call[index + 1]!] : []))
}

export async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 60_000
  for (;;) {
    let found: T | undefined | false
    try {
      found = read()
    } catch {}
    if (found) return found
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what)
    await new Promise((done) => setTimeout(done, 25))
  }
}

export function ended(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((done) => child.once('exit', (code) => done(code)))
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const short = (sha: string) => sha.slice(0, 12)
