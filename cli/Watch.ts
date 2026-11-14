import { spawn, spawnSync } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import * as Toml from 'smol-toml'
import * as Watch from '../src/Watch.ts'

export class GitError extends Error {
  override name = 'Watch.GitError'
}

export class StateError extends Error {
  override name = 'Watch.StateError'
}

class StopError extends Error {
  override name = 'Watch.StopError'
  readonly signal: NodeJS.Signals
  constructor(signal: NodeJS.Signals) {
    super('stopped by ' + signal)
    this.signal = signal
  }
}

export const usage = `  watch     --config FILE [--once | --dry-run] [--bisect]
            Follow the branches of nanocode and nanocode-ts that FILE names: fetch them, and
            when either moved, run the newest pair of revisions through nanoeval revision on
            the tasks, attempts and agents of FILE, set it against the last accepted
            baseline, append one line to STATE/watch.jsonl, rewrite STATE/scoreboard.md and
            print one line. A task is lost or gained when a one-sided Fisher exact test on
            its passes and those of the last accepted revisions gives p <= baseline.alpha,
            after one rerun of the tasks that moved. A revision that lost a task is not
            accepted: the baseline stays, and the first losing commit is looked for among
            the commits since, on the lost tasks only (--bisect asks for it where FILE says
            bisect = "off"). Runs stop for the day at budget.daily_usd and
            budget.daily_runs. --once does this until nothing is left and exits, for a
            timer; without it the command repeats every poll_sec. --dry-run fetches and
            prints what it would evaluate. Killed at any moment, it goes on from STATE when
            it is started again.
  watch     --config FILE (--nanocode REV|DIR | --nanocode-ts REV|DIR|pinned)... [--only ID]...
            [--attempts N] [--ignore-cap]
            Evaluate one pair of revisions now, a checkout with uncommitted changes
            included, on the same tasks, attempts and agents, and print it beside the
            baseline. The side that is not named is the head of its branch. The baseline
            does not move. Exits with 1 when a task was lost and with 2 when the evaluation
            did not complete.
  watch     --config FILE (--accept EVALUATION | --retry | --board)
            --accept makes a revision that lost tasks the baseline. --retry forgets the
            builds and runs that failed, so the revisions given up on are tried again.
            --board prints the scoreboard.
`

type Context = {
  bisect: boolean
  ignoreCap: boolean
  patient: boolean
  quiet: boolean
  settings: Watch.Config
}

type Outcome =
  | { kind: 'busy'; reason: string }
  | { kind: 'done'; line: Watch.Evaluation }
  | { kind: 'paused'; reason: string }

let running: number | undefined
let said: string | undefined
let stopped: NodeJS.Signals | undefined
let wake: (() => void) | undefined

function say(context: Context, line: string): void {
  if (context.quiet && line === said) return
  said = line
  console.log(line)
}

function home(value: string): string {
  return value === '~' || value.startsWith('~/') ? Path.join(Os.homedir(), value.slice(1)) : value
}

export function load(file: string): Watch.Config {
  const settings = Watch.config(Toml.parse(Fs.readFileSync(file, 'utf8')))
  const place = (value: string) => Path.resolve(Path.dirname(Path.resolve(file)), home(value))
  return {
    ...settings,
    eval: { ...settings.eval, options: settings.eval.options.map(home) },
    ...(settings.hook
      ? { hook: { ...settings.hook, command: settings.hook.command.map(home) } }
      : {}),
    revision: {
      ...(settings.revision.command ? { command: settings.revision.command.map(home) } : {}),
      ...(settings.revision.lab ? { lab: place(settings.revision.lab) } : {}),
      options: settings.revision.options.map(home),
    },
    state: place(settings.state),
  }
}

function paths(settings: Watch.Config) {
  const at = (name: string) => Path.join(settings.state, name)
  return {
    board: at('scoreboard.md'),
    intents: at('intents'),
    jobs: at('jobs'),
    ledger: at('watch.jsonl'),
    lock: at('lock'),
    logs: at('logs'),
    repos: at('repos'),
  }
}

function lab(settings: Watch.Config): string {
  return (
    settings.revision.lab ??
    process.env['NANOEVAL_LAB'] ??
    Path.join(
      process.env['XDG_DATA_HOME'] ?? Path.join(Os.homedir(), '.local', 'share'),
      'nanoeval',
      'lab',
    )
  )
}

function save(file: string, contents: string): void {
  const staged = file + '.' + process.pid + '.tmp'
  const handle = Fs.openSync(staged, 'w')
  try {
    Fs.writeSync(handle, contents)
    Fs.fsyncSync(handle)
  } finally {
    Fs.closeSync(handle)
  }
  Fs.renameSync(staged, file)
}

export function ledger(
  settings: Watch.Config,
  options: { repair: boolean } = { repair: true },
): Watch.Line[] {
  const file = paths(settings).ledger
  if (!Fs.existsSync(file)) return []
  const contents = Fs.readFileSync(file, 'utf8')
  const end = contents.lastIndexOf('\n') + 1
  if (end < contents.length && options.repair) {
    console.error(
      'nanoeval watch: ' +
        file +
        ' ended in a line that was cut off while it was written, which is removed: ' +
        contents.slice(end, end + 200),
    )
    Fs.truncateSync(file, Buffer.byteLength(contents.slice(0, end)))
  }
  return contents
    .slice(0, end)
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Watch.Line
      } catch {
        throw new StateError(file + ' line ' + (index + 1) + ' is not JSON')
      }
    })
}

function append(settings: Watch.Config, line: Watch.Line): void {
  const handle = Fs.openSync(paths(settings).ledger, 'a')
  try {
    Fs.writeSync(handle, JSON.stringify(line) + '\n')
    Fs.fsyncSync(handle)
  } finally {
    Fs.closeSync(handle)
  }
}

function board(settings: Watch.Config): void {
  save(
    paths(settings).board,
    Watch.scoreboard(settings, { at: Watch.now(), lines: ledger(settings) }),
  )
}

async function hold(
  settings: Watch.Config,
  wait: boolean,
): Promise<{ release(): Promise<void> } | undefined> {
  const child = spawn(
    'flock',
    [...(wait ? [] : ['--nonblock']), paths(settings).lock, 'sh', '-c', 'echo held; exec cat'],
    { detached: true, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once('error', (error) =>
      reject(new StateError('flock from util-linux is needed: ' + error.message)),
    )
    child.once('exit', resolve)
  })
  const held = new Promise<true>((resolve) => child.stdout!.once('data', () => resolve(true)))
  if ((await Promise.race([held, ended])) !== true) return undefined
  return {
    release: async () => {
      child.stdin!.end()
      await ended
    },
  }
}

function git(args: readonly string[], cwd?: string): string {
  const result = spawnSync('git', args, {
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: Infinity,
  })
  if (result.status !== 0)
    throw new GitError(
      'git ' + args.join(' ') + ' failed: ' + (result.error?.message ?? result.stderr.trim()),
    )
  return result.stdout
}

function commits(directory: string, range: readonly string[]): Watch.Commit[] {
  return git(
    ['log', '--first-parent', '--reverse', '--format=%H%x09%ct%x09%s', ...range],
    directory,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, at, ...subject] = line.split('\t')
      return { at: Number(at), sha: sha!, subject: subject.join('\t') }
    })
}

function chain(
  settings: Watch.Config,
  input: { base: string | undefined; name: string; source: Watch.Source },
): Watch.Chain {
  const { base, source } = input
  if ('revision' in source) return { commits: [], head: source.revision, rewritten: false }
  const directory = Path.join(paths(settings).repos, input.name + '.git')
  if (!Fs.existsSync(directory)) git(['init', '--quiet', '--bare', directory])
  git(
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--filter=tree:0',
      source.repository,
      '+refs/heads/' + source.branch + ':refs/heads/' + source.branch,
    ],
    directory,
  )
  const head = git(['rev-parse', 'refs/heads/' + source.branch], directory).trim()
  if (!base || base === head) return { commits: [], head, rewritten: false }
  const known =
    /^[0-9a-f]{40}$/.test(base) &&
    spawnSync('git', ['cat-file', '-e', base + '^{commit}'], { cwd: directory }).status === 0
  const follows =
    known &&
    spawnSync('git', ['merge-base', '--is-ancestor', base, head], { cwd: directory }).status === 0
  const found = known ? commits(directory, [base + '..' + head]) : []
  return {
    commits: found.length ? found : commits(directory, ['-1', head]),
    head,
    rewritten: !follows,
  }
}

function chains(settings: Watch.Config, base: Watch.Pair | undefined): Watch.Chains {
  Fs.mkdirSync(paths(settings).repos, { recursive: true })
  return {
    nanocode: chain(settings, {
      base: base?.nanocode,
      name: 'nanocode',
      source: settings.nanocode,
    }),
    nanocodeTs: chain(settings, {
      base: base?.nanocodeTs,
      name: 'nanocode-ts',
      source: settings.nanocodeTs,
    }),
  }
}

const colors = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

function tail(log: string): string {
  let contents = ''
  try {
    contents = Fs.readFileSync(log, 'utf8')
  } catch {}
  return contents
    .split('\n')
    .map((line) => line.replace(colors, '').trim())
    .filter((line) => line && !/^(at |\^|\$ |Node\.js v|file:\/\/|stack: |throw )/.test(line))
    .slice(-3)
    .map((line) => line.slice(0, 300))
    .join(' | ')
}

async function invoke(
  settings: Watch.Config,
  input: { args: readonly string[]; limitSec?: number; log: string; started(pid: number): void },
): Promise<number | null> {
  const command = settings.revision.command ?? [
    process.execPath,
    Path.join(import.meta.dirname, 'nanoeval.ts'),
  ]
  const line = [...command, ...input.args]
  Fs.appendFileSync(input.log, '$ ' + line.join(' ') + '\n')
  const out = Fs.openSync(input.log, 'a')
  const child = spawn(line[0]!, line.slice(1), { detached: true, stdio: ['ignore', out, out] })
  Fs.closeSync(out)
  const timers: NodeJS.Timeout[] = []
  try {
    return await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code))
      if (child.pid === undefined) return
      const pid = child.pid
      running = pid
      input.started(pid)
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(-pid, name)
        } catch {}
      }
      if (stopped) signal(stopped)
      if (input.limitSec !== undefined)
        timers.push(
          setTimeout(() => {
            Fs.appendFileSync(
              input.log,
              'nanoeval watch: stopped after ' + input.limitSec + ' s, its limit\n',
            )
            signal('SIGTERM')
            timers.push(setTimeout(() => signal('SIGKILL'), settings.limits.stopSec! * 1000))
          }, input.limitSec * 1000),
        )
    })
  } finally {
    running = undefined
    for (const timer of timers) clearTimeout(timer)
  }
}

// The holder of the lock is a child of the command and can outlive it by a moment, so a lock that the call before
// this one held is asked about for a second before another evaluation is taken to hold the lab.
async function busy(settings: Watch.Config): Promise<boolean> {
  const lock = Path.join(lab(settings), 'lock')
  if (!Fs.existsSync(lock)) return false
  for (let asked = 1; ; asked++) {
    if (spawnSync('flock', ['--nonblock', lock, 'true']).status !== 1) return false
    if (asked === 5) return true
    await new Promise((done) => setTimeout(done, 250))
  }
}

function read(directory: string): { rows: Watch.Row[] } | { reason: string } {
  let result: unknown
  try {
    result = JSON.parse(Fs.readFileSync(Path.join(directory, 'result.json'), 'utf8'))
  } catch {
    return { reason: 'no job at ' + directory }
  }
  const trials: unknown[] = []
  for (const entry of Fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      trials.push(
        JSON.parse(Fs.readFileSync(Path.join(directory, entry.name, 'result.json'), 'utf8')),
      )
    } catch {}
  }
  try {
    return { rows: Watch.rows({ result, trials }) }
  } catch (error) {
    if (error instanceof Watch.JobError) return { reason: error.message + ', at ' + directory }
    throw error
  }
}

function labRuns(settings: Watch.Config): string[] {
  try {
    return Fs.readdirSync(Path.join(lab(settings), 'runs')).sort()
  } catch {
    return []
  }
}

function locate(
  settings: Watch.Config,
  pending: Watch.Pending,
): { directory: string; rows: Watch.Row[] } | { reason: string } {
  const own = read(pending.job!)
  if ('rows' in own) return { directory: pending.job!, rows: own.rows }
  const fresh = labRuns(settings)
    .filter((name) => !pending.before.includes(name))
    .map((name) => Path.join(lab(settings), 'runs', name))
    .flatMap((directory) => {
      const found = read(directory)
      return 'rows' in found ? [{ directory, rows: found.rows }] : []
    })
  const named = fresh.filter(({ directory }) => {
    try {
      return (
        JSON.parse(Fs.readFileSync(Path.join(directory, 'config.json'), 'utf8'))['job_name'] ===
        pending.name
      )
    } catch {
      return false
    }
  })
  if (named.length === 1) return named[0]!
  if (!named.length && fresh.length === 1) return fresh[0]!
  return {
    reason:
      own.reason +
      (fresh.length
        ? ', and ' + fresh.length + ' new jobs under ' + Path.join(lab(settings), 'runs')
        : ''),
  }
}

function file(settings: Watch.Config, intent: Watch.Intent): string {
  return Path.join(paths(settings).intents, intent.id + '.json')
}

function keep(settings: Watch.Config, intent: Watch.Intent): void {
  save(file(settings, intent), JSON.stringify(intent, null, 2) + '\n')
}

function intents(settings: Watch.Config): Watch.Intent[] {
  const directory = paths(settings).intents
  return Fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(Fs.readFileSync(Path.join(directory, name), 'utf8')) as Watch.Intent)
}

function at(intent: Watch.Intent): Watch.Phase['kind'] {
  return intent.phase.kind
}

function spent(settings: Watch.Config): { runs: number; usd: number } {
  return Watch.spend(
    [
      ...ledger(settings).flatMap((line) => (line.type === 'evaluation' ? line.steps : [])),
      ...intents(settings).flatMap((intent) => (at(intent) === 'final' ? [] : intent.steps)),
    ],
    Watch.now().slice(0, 10),
  )
}

function resolve(
  settings: Watch.Config,
  input: { exit: number | null; intent: Watch.Intent; pending: Watch.Pending },
): void {
  const { intent, pending } = input
  const step: Watch.Step = {
    exit: input.exit,
    finishedAt: Watch.now(),
    log: pending.log,
    purpose: pending.purpose,
    startedAt: pending.startedAt,
    usd: 0,
  }
  intent.phase = { kind: 'open' }
  if (pending.purpose === 'build') {
    if (input.exit !== 0)
      intent.phase = {
        failure: {
          detail: 'the build ended with status ' + input.exit + ': ' + tail(pending.log),
          verdict: 'build_failed',
        },
        kind: 'failed',
      }
  } else {
    const found = locate(settings, pending)
    if ('rows' in found) {
      const { charged, usd } = Watch.record(intent, found.rows)
      step.charged = charged
      step.job = found.directory
      step.usd = charged === 'recorded' ? usd : settings.budget.runUsd
    } else {
      step.charged = 'reserved'
      step.usd = settings.budget.runUsd
      intent.phase = {
        failure: {
          detail:
            'the run ended with status ' +
            input.exit +
            ' and left no finished job (' +
            found.reason +
            '): ' +
            tail(pending.log),
          verdict: 'run_failed',
        },
        kind: 'failed',
      }
    }
  }
  intent.steps.push(step)
  keep(settings, intent)
}

function alive(pending: Watch.Pending): boolean {
  if (pending.pid === undefined) return false
  try {
    return Fs.readFileSync('/proc/' + pending.pid + '/cmdline', 'utf8')
      .split('\0')
      .includes(pending.purpose === 'build' ? '--build-only' : pending.name)
  } catch {
    return false
  }
}

async function step(
  context: Context,
  input: { call?: Watch.Call; intent: Watch.Intent; purpose: Watch.Purpose },
): Promise<void> {
  const { settings } = context
  const { intent } = input
  const base = intent.id + '-' + (intent.steps.length + 1) + '-' + input.purpose
  const name = 'watch-' + base
  const job = Path.join(paths(settings).jobs, base)
  const pending: Watch.Pending = {
    argv: Watch.invocation(
      settings,
      input.call
        ? { call: input.call, name, out: job, pair: intent.request.pair }
        : { pair: intent.request.pair },
    ),
    before: labRuns(settings),
    ...(input.call ? { call: input.call, job } : {}),
    log: Path.join(paths(settings).logs, base + '.log'),
    name,
    purpose: input.purpose,
    startedAt: Watch.now(),
  }
  intent.phase = { kind: 'step', pending }
  keep(settings, intent)
  const limitSec = input.call ? settings.limits.runSec : settings.limits.buildSec
  const exit = await invoke(settings, {
    args: pending.argv,
    ...(limitSec === undefined ? {} : { limitSec }),
    log: pending.log,
    started: (pid) => {
      pending.pid = pid
      keep(settings, intent)
    },
  })
  if (stopped) throw new StopError(stopped)
  resolve(settings, { exit, intent, pending })
}

async function hook(settings: Watch.Config, input: { line: Watch.Evaluation; repeat: boolean }) {
  if (!settings.hook) return
  const { line } = input
  if (!settings.hook.on.includes(line.verdict) && !line.culprit) return
  const log = Path.join(paths(settings).logs, line.id + '-hook.log')
  const out = Fs.openSync(log, 'a')
  const child = spawn(settings.hook.command[0]!, settings.hook.command.slice(1), {
    stdio: ['pipe', out, out],
  })
  Fs.closeSync(out)
  let late = false
  const limit = setTimeout(() => {
    late = true
    child.kill('SIGKILL')
  }, settings.hook.timeoutSec * 1000)
  const exit = await new Promise<number | string | null>((done) => {
    child.once('error', (error) => done(error.message))
    child.once('exit', (code, signal) => done(code ?? signal))
    child.stdin!.on('error', () => {})
    child.stdin!.end(
      JSON.stringify({
        ...line,
        ...(input.repeat ? { repeat: true } : {}),
        scoreboard: paths(settings).board,
      }) + '\n',
    )
  })
  clearTimeout(limit)
  if (late)
    console.log(
      'the hook for ' +
        line.id +
        ' had not ended after ' +
        settings.hook.timeoutSec +
        ' s and was killed, log ' +
        log,
    )
  else if (exit !== 0)
    console.log('the hook for ' + line.id + ' ended with ' + exit + ', log ' + log)
}

async function finish(
  context: Context,
  input: { chains?: Watch.Chains; intent: Watch.Intent },
): Promise<Watch.Evaluation> {
  const { settings } = context
  const { intent } = input
  const lines = ledger(settings)
  const repeat = intent.phase.kind === 'final'
  let line: Watch.Evaluation
  if (intent.phase.kind === 'final') line = intent.phase.line
  else {
    const state = Watch.replay(lines, settings)
    const finishedAt = Watch.now()
    const concluded = (culprit?: Watch.Culprit) =>
      Watch.conclude(settings, {
        ...(culprit ? { culprit } : {}),
        evidence: state.evidence,
        finishedAt,
        intent,
      })
    line = concluded()
    if (input.chains && line.trigger !== 'manual' && state.baseline) {
      const after = Watch.replay([...lines, line], settings)
      const regression = Watch.standing(after, Watch.head(input.chains))
      if (regression) {
        const found = Watch.search(settings, { chains: input.chains, regression, state: after })
        if ('culprit' in found) line = concluded(found.culprit)
      }
    }
    intent.phase = { kind: 'final', line }
    keep(settings, intent)
  }
  const id = line.id
  if (!lines.some((entry) => entry.type === 'evaluation' && entry.id === id)) append(settings, line)
  board(settings)
  said = undefined
  console.log(Watch.sentence(line) + (repeat ? '; said again after a restart' : ''))
  await hook(settings, { line, repeat })
  Fs.rmSync(file(settings, intent))
  return line
}

async function advance(
  context: Context,
  input: { chains?: Watch.Chains; intent: Watch.Intent },
): Promise<Outcome> {
  const { settings } = context
  const { intent } = input
  const evidence = Watch.replay(ledger(settings), settings).evidence
  const held = async () =>
    !context.patient && (await busy(settings))
      ? ({
          kind: 'busy',
          reason:
            'another evaluation holds ' +
            Path.join(lab(settings), 'lock') +
            ': ' +
            Watch.name(intent.request.label ?? intent.request.pair) +
            ' waits for the next time',
        } as const)
      : undefined
  while (at(intent) === 'open') {
    if (stopped) throw new StopError(stopped)
    if (!intent.rounds.build) {
      const waits = await held()
      if (waits) return waits
      intent.rounds.build++
      await step(context, { intent, purpose: 'build' })
      continue
    }
    if (!intent.queue.length) {
      const round = Watch.next(settings, { evidence, intent })
      if (!round) break
      if (round.purpose === 'confirm')
        intent.confirm = round.calls.flatMap((call) =>
          call.agents.flatMap((agent) => (call.tasks as string[]).map((task) => ({ agent, task }))),
        )
      intent.queue = round.calls.map((call) => ({ ...call, purpose: round.purpose }))
      intent.rounds[round.purpose]++
      keep(settings, intent)
      continue
    }
    const refused = context.ignoreCap ? undefined : Watch.admit(settings.budget, spent(settings))
    if (refused)
      return {
        kind: 'paused',
        reason:
          'the daily cap is reached, ' +
          refused +
          ': ' +
          Watch.name(intent.request.label ?? intent.request.pair) +
          ' goes on the next day (UTC)',
      }
    const waits = await held()
    if (waits) return waits
    const { purpose, ...call } = intent.queue[0]!
    intent.queue = intent.queue.slice(1)
    await step(context, { call, intent, purpose })
  }
  return { kind: 'done', line: await finish(context, input) }
}

async function settle(
  context: Context,
  input: { chains: Watch.Chains; resume: boolean },
): Promise<Outcome | undefined> {
  const { settings } = context
  for (const intent of intents(settings)) {
    if (intent.phase.kind === 'step') {
      const { pending } = intent.phase
      if (alive(pending))
        return {
          kind: 'busy',
          reason:
            'the ' +
            pending.purpose +
            ' step that an earlier nanoeval watch started for ' +
            Watch.name(intent.request.label ?? intent.request.pair) +
            ' still runs as process ' +
            pending.pid,
        }
      if (pending.purpose === 'build') {
        intent.rounds.build = 0
        intent.phase = { kind: 'open' }
        keep(settings, intent)
      } else if ('rows' in locate(settings, pending))
        resolve(settings, { exit: null, intent, pending })
      else {
        intent.steps.push({
          charged: 'reserved',
          exit: null,
          finishedAt: Watch.now(),
          log: pending.log,
          purpose: pending.purpose,
          startedAt: pending.startedAt,
          usd: settings.budget.runUsd,
        })
        intent.phase = {
          failure: {
            detail:
              'the watcher stopped during the ' +
              pending.purpose +
              ' run and the run left no finished job, so what it spent is counted as its whole budget',
            verdict: 'interrupted',
          },
          kind: 'failed',
        }
        keep(settings, intent)
      }
    }
    if (at(intent) === 'open' && intent.request.role === 'manual') {
      intent.phase = {
        failure: {
          detail: 'the command that asked for this evaluation stopped before it ended',
          verdict: 'interrupted',
        },
        kind: 'failed',
      }
      keep(settings, intent)
    }
    if (at(intent) === 'open' && !input.resume) continue
    const outcome = await advance(context, { chains: input.chains, intent })
    if (
      outcome.kind !== 'done' ||
      (!Watch.conclusive(outcome.line) && outcome.line.verdict !== 'interrupted')
    )
      return outcome
  }
  return undefined
}

function fresh(settings: Watch.Config, request: Watch.Request): Watch.Intent {
  const state = Watch.replay(ledger(settings), settings)
  const now = Watch.now()
  const intent: Watch.Intent = {
    baseline: request.role === 'baseline' ? null : (state.baseline?.id ?? null),
    confirm: [],
    errors: {},
    id: now.replace(/[-:]/g, '') + '-' + Crypto.randomBytes(3).toString('hex'),
    marks: {},
    phase: { kind: 'open' },
    queue: [],
    request,
    rounds: { build: 0, confirm: 0, errored: 0, main: 0 },
    startedAt: now,
    steps: [],
    usage: {},
  }
  keep(settings, intent)
  return intent
}

function prepare(settings: Watch.Config): void {
  const places = paths(settings)
  for (const directory of [settings.state, places.intents, places.jobs, places.logs, places.repos])
    Fs.mkdirSync(directory, { recursive: true })
}

export async function tick(context: Context): Promise<void> {
  const { settings } = context
  prepare(settings)
  const lock = await hold(settings, false)
  if (!lock) {
    say(context, 'another nanoeval watch works on ' + settings.state + ': nothing done')
    return
  }
  try {
    const before = Watch.replay(ledger(settings), settings)
    const settled = await settle(context, {
      chains: chains(settings, before.baseline?.pair),
      resume: true,
    })
    if (settled) {
      if (settled.kind !== 'done') say(context, settled.reason)
      return
    }
    for (;;) {
      if (stopped) throw new StopError(stopped)
      const state = Watch.replay(ledger(settings), settings)
      const found = chains(settings, state.baseline?.pair)
      const action = Watch.plan(settings, { bisect: context.bisect, chains: found, state })
      if (action.kind === 'idle') {
        say(context, action.reason)
        return
      }
      const outcome = await advance(context, {
        chains: found,
        intent: fresh(settings, action.request),
      })
      if (outcome.kind !== 'done') {
        say(context, outcome.reason)
        return
      }
      if (!Watch.conclusive(outcome.line)) return
    }
  } finally {
    if (!Fs.existsSync(paths(settings).board)) board(settings)
    await lock.release()
  }
}

function checkout(directory: string): string {
  const head = git(['rev-parse', 'HEAD'], directory).trim()
  if (!git(['status', '--porcelain'], directory)) return head
  const hash = Crypto.createHash('sha256')
  hash.update(git(['diff', '--binary', 'HEAD'], directory))
  for (const name of git(['ls-files', '--others', '--exclude-standard', '-z'], directory)
    .split('\0')
    .filter(Boolean)
    .sort()) {
    const path = Path.join(directory, name)
    hash.update(name + '\0')
    hash.update(Fs.lstatSync(path).isSymbolicLink() ? Fs.readlinkSync(path) : Fs.readFileSync(path))
  }
  return head.slice(0, 12) + '+' + hash.digest('hex').slice(0, 12)
}

async function waited(settings: Watch.Config): Promise<{ release(): Promise<void> }> {
  const now = await hold(settings, false)
  if (now) return now
  console.error('nanoeval watch: waits for the nanoeval watch that works on ' + settings.state)
  const later = await hold(settings, true)
  if (!later) throw new StateError('the lock of ' + settings.state + ' could not be taken')
  return later
}

async function demand(
  context: Context,
  input: { attempts?: number; nanocode?: string; nanocodeTs?: string; only?: string[] },
): Promise<number> {
  const { settings } = context
  prepare(settings)
  const lock = await waited(settings)
  try {
    const state = Watch.replay(ledger(settings), settings)
    const found = chains(settings, state.baseline?.pair)
    const settled = await settle(context, { chains: found, resume: false })
    if (settled && settled.kind !== 'done') throw new StateError(settled.reason)
    const side = (value: string | undefined, head: string) => {
      if (value === undefined) return { label: head, revision: head }
      const directory = Path.resolve(home(value))
      return Fs.existsSync(directory) && Fs.statSync(directory).isDirectory()
        ? { label: checkout(directory), revision: directory }
        : { label: value, revision: value }
    }
    const nanocode = side(input.nanocode, found.nanocode.head)
    const nanocodeTs = side(input.nanocodeTs, found.nanocodeTs.head)
    const refused = context.ignoreCap ? undefined : Watch.admit(settings.budget, spent(settings))
    if (refused)
      throw new StateError('the daily cap is reached, ' + refused + ': --ignore-cap runs anyway')
    const outcome = await advance(context, {
      intent: fresh(settings, {
        agents: settings.eval.agents.map((entry) => entry.id),
        attempts: input.attempts ?? settings.eval.attempts,
        label: { nanocode: nanocode.label, nanocodeTs: nanocodeTs.label },
        pair: { nanocode: nanocode.revision, nanocodeTs: nanocodeTs.revision },
        role: 'manual',
        tasks: input.only?.length ? input.only : settings.eval.tasks,
      }),
    })
    if (outcome.kind !== 'done') throw new StateError(outcome.reason)
    const after = Watch.replay(ledger(settings), settings)
    process.stdout.write(
      '\n' +
        Watch.comparison(settings, { evidence: after.evidence, line: outcome.line, state: after }),
    )
    return outcome.line.verdict === 'ok' ? 0 : outcome.line.verdict === 'regression' ? 1 : 2
  } finally {
    await lock.release()
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, seconds * 1000)
    wake = () => {
      clearTimeout(timer)
      done()
    }
  })
}

async function run(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      accept: { type: 'string' },
      attempts: { type: 'string' },
      bisect: { default: false, type: 'boolean' },
      board: { default: false, type: 'boolean' },
      config: { default: process.env['NANOEVAL_WATCH'], type: 'string' },
      'dry-run': { default: false, type: 'boolean' },
      help: { default: false, short: 'h', type: 'boolean' },
      'ignore-cap': { default: false, type: 'boolean' },
      nanocode: { type: 'string' },
      'nanocode-ts': { type: 'string' },
      once: { default: false, type: 'boolean' },
      only: { multiple: true, type: 'string' },
      retry: { default: false, type: 'boolean' },
    },
  })
  if (values.help) {
    console.log('nanoeval <command>\n\n' + usage)
    return
  }
  if (!values.config) throw new Watch.ConfigError('--config FILE or NANOEVAL_WATCH is required')
  const settings = load(values.config)
  const context: Context = {
    bisect: values.bisect,
    ignoreCap: values['ignore-cap'],
    patient: false,
    quiet: false,
    settings,
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stopped = signal
      if (running !== undefined)
        try {
          process.kill(-running, signal)
        } catch {}
      wake?.()
    })
  if (values.board) {
    process.stdout.write(
      Watch.scoreboard(settings, {
        at: Watch.now(),
        lines: ledger(settings, { repair: false }),
      }),
    )
    return
  }
  if (values.accept || values.retry) {
    prepare(settings)
    const lock = await waited(settings)
    try {
      if (values.accept) {
        const line = ledger(settings).find(
          (entry) => entry.type === 'evaluation' && entry.id === values.accept,
        ) as Watch.Evaluation | undefined
        if (!line || line.trigger !== 'watch' || line.verdict !== 'regression')
          throw new StateError(
            values.accept + ' is not an evaluation of the watcher that lost tasks',
          )
        append(settings, { at: Watch.now(), evaluation: line.id, type: 'accept' })
        console.log(Watch.name(line.pair) + ' is accepted as the baseline with what it lost')
      } else {
        append(settings, { at: Watch.now(), type: 'retry' })
        console.log('the builds and runs that failed so far are forgotten')
      }
      board(settings)
    } finally {
      await lock.release()
    }
    return
  }
  if (values.nanocode !== undefined || values['nanocode-ts'] !== undefined) {
    const attempts = values.attempts === undefined ? undefined : Number(values.attempts)
    if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1))
      throw new Watch.ConfigError('--attempts is a whole number of at least 1')
    context.patient = true
    process.exitCode = await demand(context, {
      ...(attempts === undefined ? {} : { attempts }),
      ...(values.nanocode === undefined ? {} : { nanocode: values.nanocode }),
      ...(values['nanocode-ts'] === undefined ? {} : { nanocodeTs: values['nanocode-ts'] }),
      ...(values.only ? { only: values.only } : {}),
    })
    return
  }
  if (values['dry-run']) {
    prepare(settings)
    const lock = await hold(settings, false)
    if (!lock) {
      console.log('another nanoeval watch works on ' + settings.state + ': nothing read')
      return
    }
    try {
      const state = Watch.replay(ledger(settings), settings)
      const action = Watch.plan(settings, {
        bisect: values.bisect,
        chains: chains(settings, state.baseline?.pair),
        state,
      })
      for (const intent of intents(settings))
        console.log(
          'an evaluation of ' +
            Watch.name(intent.request.label ?? intent.request.pair) +
            ' is under way and goes on first',
        )
      console.log(
        action.kind === 'idle'
          ? action.reason
          : 'would evaluate ' +
              Watch.name(action.request.pair) +
              ' as ' +
              action.request.role +
              ': ' +
              action.request.attempts +
              ' attempts of ' +
              (action.request.tasks === 'all' ? 'all tasks' : action.request.tasks.join(', ')) +
              ' for ' +
              action.request.agents.join(', '),
      )
    } finally {
      await lock.release()
    }
    return
  }
  if (values.once) {
    await tick(context)
    return
  }
  if (settings.pollSec === undefined)
    throw new Watch.ConfigError(
      'poll_sec says how often the branches are fetched: set it, or use --once',
    )
  context.quiet = true
  for (;;) {
    try {
      await tick(context)
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      say(context, error.message)
    }
    if (stopped) throw new StopError(stopped)
    await sleep(settings.pollSec)
    if (stopped) throw new StopError(stopped)
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  try {
    await run(argv)
  } catch (error) {
    if (error instanceof StopError) process.exitCode = error.signal === 'SIGINT' ? 130 : 143
    else if (
      error instanceof GitError ||
      error instanceof StateError ||
      error instanceof Watch.ConfigError
    ) {
      console.error('nanoeval watch: ' + error.message)
      process.exitCode = 1
    } else throw error
  }
}
