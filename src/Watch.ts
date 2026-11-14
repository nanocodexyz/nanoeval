import * as Stats from './Stats.ts'

export class ConfigError extends Error {
  override name = 'Watch.ConfigError'
}

export class JobError extends Error {
  override name = 'Watch.JobError'
}

export type Agent = { id: string; spec: string }

export type Source = { branch: string; repository: string } | { revision: string }

export type Kind =
  | 'bad'
  | 'baseline'
  | 'build_failed'
  | 'good'
  | 'incomplete'
  | 'interrupted'
  | 'ok'
  | 'regression'
  | 'run_failed'

export const kinds: readonly Kind[] = [
  'bad',
  'baseline',
  'build_failed',
  'good',
  'incomplete',
  'interrupted',
  'ok',
  'regression',
  'run_failed',
]

export type Config = {
  baseline: { alpha: number; window: number }
  bisect: 'auto' | 'off'
  budget: { dailyRuns: number; dailyUsd: number; runUsd: number }
  eval: {
    agents: Agent[]
    attempts: number
    name: string
    options: string[]
    slots?: number
    tasks: 'all' | string[]
  }
  hook?: { command: string[]; on: Kind[]; timeoutSec: number }
  limits: { buildSec?: number; runSec?: number; stopSec?: number }
  nanocode: Source
  nanocodeTs: Source
  pollSec?: number
  retries: { build: number; errored: number; run: number }
  revision: { command?: string[]; lab?: string; options: string[] }
  state: string
}

export type Pair = { nanocode: string; nanocodeTs: string }

export type Key = { agent: string; task: string }

export type Tally = { passed: number; scored: number }

export type Marks = Record<string, Record<string, string>>

export type Evidence = Record<string, Record<string, Tally>>

export type Usage = Record<
  string,
  { cachedTokens: number; costUsd: number | null; inputTokens: number; outputTokens: number }
>

export type Row = {
  agent: string
  cachedTokens: number
  costUsd: number | null
  error?: string
  index: number
  inputTokens: number
  metered: boolean
  outcome: 'errored' | 'failed' | 'passed'
  outputTokens: number
  task: string
}

export type Purpose = 'build' | 'confirm' | 'errored' | 'main'

export type Call = { agents: string[]; attempts: number; tasks: 'all' | string[] }

export type Step = {
  charged?: 'recorded' | 'reserved'
  exit: number | null
  finishedAt: string
  job?: string
  log: string
  purpose: Purpose
  startedAt: string
  usd: number
}

export type Request = {
  agents: string[]
  attempts: number
  covers?: { nanocode: number; nanocodeTs: number }
  label?: Pair
  lost?: Key[]
  pair: Pair
  role: 'baseline' | 'bisect' | 'head' | 'manual'
  tasks: 'all' | string[]
}

export type Pending = {
  argv: string[]
  before: string[]
  call?: Call
  job?: string
  log: string
  name: string
  pid?: number
  purpose: Purpose
  startedAt: string
}

export type Change = {
  agent: string
  base: Tally
  kind: 'gained' | 'lost' | 'moved'
  p: number
  revision: Tally
  task: string
}

export type Culprit = {
  commits: { repository: 'nanocode' | 'nanocode-ts'; sha: string; subject: string }[]
  good: Pair
}

export type Summary = {
  attempts: number
  cachedTokens: number
  costUsd: number | null
  errored: number
  failed: number
  inputTokens: number
  outputTokens: number
  pass1: number | null
  passK: number | null
  passed: number
  tasks: number
}

export type Evaluation = {
  agents: Record<string, string>
  attempts: number
  baseline: string | null
  changes: Change[]
  covers?: { nanocode: number; nanocodeTs: number }
  culprit?: Culprit
  detail?: string
  eval: string
  finishedAt: string
  id: string
  k: number
  label?: Pair
  marks: Marks
  pair: Pair
  startedAt: string
  steps: Step[]
  summary: Record<string, Summary>
  trigger: 'bisect' | 'manual' | 'watch'
  type: 'evaluation'
  verdict: Kind
}

export type Line =
  | Evaluation
  | { at: string; evaluation: string; type: 'accept' }
  | { at: string; type: 'retry' }

export type Failure = { detail: string; verdict: 'build_failed' | 'interrupted' | 'run_failed' }

export type Phase =
  | { failure: Failure; kind: 'failed' }
  | { kind: 'final'; line: Evaluation }
  | { kind: 'open' }
  | { kind: 'step'; pending: Pending }

export type Intent = {
  baseline: string | null
  confirm: Key[]
  errors: Record<string, number>
  id: string
  marks: Marks
  phase: Phase
  queue: (Call & { purpose: Purpose })[]
  request: Request
  rounds: { build: number; confirm: number; errored: number; main: number }
  startedAt: string
  steps: Step[]
  usage: Usage
}

export type Commit = { at: number; sha: string; subject: string }

export type Chain = { commits: Commit[]; head: string; rewritten: boolean }

export type Chains = { nanocode: Chain; nanocodeTs: Chain }

export type Point = {
  i: number
  j: number
  pair: Pair
  step?: { repository: 'nanocode' | 'nanocode-ts'; sha: string; subject: string }
}

export type State = {
  accepted: Evaluation[]
  baseline: Evaluation | undefined
  evaluations: Evaluation[]
  evidence: Evidence
  fresh: Evaluation[]
}

export type Action =
  | { culprit?: Culprit; kind: 'idle'; reason: string }
  | { kind: 'evaluate'; request: Request }

function table(
  value: unknown,
  options: { allowed: readonly string[]; name: string },
): Record<string, unknown> {
  const { allowed, name } = options
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ConfigError(name + ' is a table')
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new ConfigError(name + ' has no setting ' + key + ': it takes ' + allowed.join(', '))
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new ConfigError(name + ' is a string')
  return value
}

function texts(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new ConfigError(name + ' is a list of strings')
  return [...(value as string[])]
}

function whole(value: unknown, options: { least: number; name: string }): number {
  const { least, name } = options
  if (typeof value !== 'number' || !Number.isInteger(value) || value < least)
    throw new ConfigError(name + ' is a whole number of at least ' + least)
  return value
}

function amount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new ConfigError(name + ' is a number above zero')
  return value
}

function source(value: unknown, name: string): Source {
  const fields = table(value, { allowed: ['branch', 'repository', 'revision'], name: name })
  if (fields['revision'] !== undefined) {
    if (fields['branch'] !== undefined || fields['repository'] !== undefined)
      throw new ConfigError(name + ' names a revision to hold or a branch to watch, not both')
    return { revision: text(fields['revision'], name + '.revision') }
  }
  return {
    branch: text(fields['branch'], name + '.branch'),
    repository: text(fields['repository'], name + '.repository'),
  }
}

export function agent(value: string): Agent {
  const match = /^([^=\s]+)=(\S+)$/.exec(value)
  if (!match) throw new ConfigError('an agent is ID=HARNESS:MODEL[:THINKING], not ' + value)
  return { id: match[1]!, spec: match[2]! }
}

export function window(rule: { alpha: number; attempts: number }): number {
  for (let runs = 1; ; runs++) {
    const scored = runs * rule.attempts
    const never = { passed: 0, scored: 2 * rule.attempts }
    if (Stats.task({ passed: scored, scored }, never).worse <= rule.alpha) return runs
  }
}

export function config(value: unknown): Config {
  const top = table(value, {
    allowed: [
      'baseline',
      'bisect',
      'budget',
      'eval',
      'hook',
      'limits',
      'nanocode',
      'nanocode_ts',
      'poll_sec',
      'retries',
      'revision',
      'state',
    ],
    name: 'the configuration',
  })
  const evaluation = table(top['eval'], {
    allowed: ['agents', 'attempts', 'name', 'options', 'slots', 'tasks'],
    name: 'eval',
  })
  const agents = texts(evaluation['agents'], 'eval.agents').map(agent)
  if (!agents.length) throw new ConfigError('eval.agents names at least one agent')
  if (new Set(agents.map((entry) => entry.id)).size !== agents.length)
    throw new ConfigError('eval.agents names an agent twice')
  const tasks = evaluation['tasks'] === 'all' ? 'all' : texts(evaluation['tasks'], 'eval.tasks')
  if (tasks !== 'all' && !tasks.length)
    throw new ConfigError('eval.tasks is "all" or a list of task ids')
  if (tasks !== 'all' && new Set(tasks).size !== tasks.length)
    throw new ConfigError('eval.tasks names a task twice')
  const attempts = whole(evaluation['attempts'], { least: 1, name: 'eval.attempts' })

  const budget = table(top['budget'], {
    allowed: ['daily_runs', 'daily_usd', 'run_usd'],
    name: 'budget',
  })
  const runUsd = amount(budget['run_usd'], 'budget.run_usd')
  const dailyUsd = amount(budget['daily_usd'], 'budget.daily_usd')
  if (dailyUsd < runUsd)
    throw new ConfigError('budget.daily_usd is below budget.run_usd, so no run would ever start')

  const baseline = table(top['baseline'], { allowed: ['alpha', 'window'], name: 'baseline' })
  const alpha = baseline['alpha'] === undefined ? 0.05 : amount(baseline['alpha'], 'baseline.alpha')
  if (alpha >= 1) throw new ConfigError('baseline.alpha is a probability below 1')

  const retries = table(top['retries'], { allowed: ['build', 'errored', 'run'], name: 'retries' })
  const tries = (name: string) =>
    retries[name] === undefined ? 1 : whole(retries[name], { least: 0, name: 'retries.' + name })

  const limits = table(top['limits'], {
    allowed: ['build_sec', 'run_sec', 'stop_sec'],
    name: 'limits',
  })
  const limit = (name: string) =>
    limits[name] === undefined ? undefined : amount(limits[name], 'limits.' + name)
  const buildSec = limit('build_sec')
  const runSec = limit('run_sec')
  const stopSec = limit('stop_sec')
  if ((buildSec !== undefined || runSec !== undefined) && stopSec === undefined)
    throw new ConfigError(
      'limits.stop_sec says how long a command that passed its limit has to stop before it is killed',
    )

  const revision = table(top['revision'], {
    allowed: ['command', 'lab', 'options'],
    name: 'revision',
  })
  const command = texts(revision['command'], 'revision.command')

  const hook =
    top['hook'] === undefined
      ? undefined
      : table(top['hook'], { allowed: ['command', 'on', 'timeout_sec'], name: 'hook' })
  const on = hook?.['on'] === undefined ? ['regression'] : texts(hook['on'], 'hook.on')
  for (const kind of on)
    if (!kinds.includes(kind as Kind))
      throw new ConfigError('hook.on names verdicts: ' + kinds.join(', ') + ', not ' + kind)
  const hookCommand = hook ? texts(hook['command'], 'hook.command') : []
  if (hook && !hookCommand.length)
    throw new ConfigError('hook.command is a command and its arguments')

  const bisect = top['bisect'] === undefined ? 'auto' : top['bisect']
  if (bisect !== 'auto' && bisect !== 'off') throw new ConfigError('bisect is "auto" or "off"')

  return {
    baseline: {
      alpha,
      window:
        baseline['window'] === undefined
          ? window({ alpha, attempts })
          : whole(baseline['window'], { least: 1, name: 'baseline.window' }),
    },
    bisect,
    budget: {
      dailyRuns: whole(budget['daily_runs'], { least: 1, name: 'budget.daily_runs' }),
      dailyUsd,
      runUsd,
    },
    eval: {
      agents,
      attempts,
      name: text(evaluation['name'], 'eval.name'),
      options: texts(evaluation['options'], 'eval.options'),
      ...(evaluation['slots'] === undefined
        ? {}
        : { slots: whole(evaluation['slots'], { least: 1, name: 'eval.slots' }) }),
      tasks,
    },
    ...(hook
      ? {
          hook: {
            command: hookCommand,
            on: on as Kind[],
            timeoutSec:
              hook['timeout_sec'] === undefined
                ? 60
                : amount(hook['timeout_sec'], 'hook.timeout_sec'),
          },
        }
      : {}),
    limits: {
      ...(buildSec === undefined ? {} : { buildSec }),
      ...(runSec === undefined ? {} : { runSec }),
      ...(stopSec === undefined ? {} : { stopSec }),
    },
    nanocode: source(top['nanocode'], 'nanocode'),
    nanocodeTs: source(top['nanocode_ts'], 'nanocode_ts'),
    ...(top['poll_sec'] === undefined ? {} : { pollSec: amount(top['poll_sec'], 'poll_sec') }),
    retries: { build: tries('build'), errored: tries('errored'), run: tries('run') },
    revision: {
      ...(command.length ? { command } : {}),
      ...(revision['lab'] === undefined ? {} : { lab: text(revision['lab'], 'revision.lab') }),
      options: texts(revision['options'], 'revision.options'),
    },
    state: text(top['state'], 'state'),
  }
}

export function invocation(
  settings: Config,
  input: { call: Call; name: string; out: string; pair: Pair } | { pair: Pair },
): string[] {
  const repository = (from: Source, option: string) =>
    'repository' in from ? [option, from.repository] : []
  const specs = new Map(settings.eval.agents.map((entry) => [entry.id, entry.spec]))
  return [
    'revision',
    '--nanocode',
    input.pair.nanocode,
    ...repository(settings.nanocode, '--nanocode-repository'),
    '--nanocode-ts',
    input.pair.nanocodeTs,
    ...repository(settings.nanocodeTs, '--nanocode-ts-repository'),
    ...(settings.revision.lab ? ['--lab', settings.revision.lab] : []),
    ...settings.revision.options,
    ...('call' in input
      ? [
          '--eval',
          settings.eval.name,
          ...(input.call.tasks === 'all' ? [] : input.call.tasks.flatMap((id) => ['--only', id])),
          ...input.call.agents.flatMap((id) => ['--agent', id + '=' + specs.get(id)]),
          '--attempts',
          String(input.call.attempts),
          '--model-budget-usd',
          String(settings.budget.runUsd),
          ...(settings.eval.slots === undefined ? [] : ['--slots', String(settings.eval.slots)]),
          '--name',
          input.name,
          '--out',
          input.out,
          ...settings.eval.options,
        ]
      : ['--build-only']),
  ]
}

export function rows(job: { result: unknown; trials: readonly unknown[] }): Row[] {
  const result = job.result as Record<string, any> | null
  if (typeof result !== 'object' || result === null) throw new JobError('result.json is not a job')
  if (!result['finished_at']) throw new JobError('the job did not finish')
  if (
    typeof result['n_total_trials'] === 'number' &&
    result['n_total_trials'] !== job.trials.length
  )
    throw new JobError(
      'the job has ' + job.trials.length + ' of its ' + result['n_total_trials'] + ' trials',
    )
  const names = new Map<string, string>()
  return job.trials.map((value) => {
    const trial = value as Record<string, any>
    const name = trial?.['task_name']
    const agentId = trial?.['config']?.['agent']?.['kwargs']?.['id']
    const index = Number(/__(\d+)$/.exec(String(trial?.['trial_name']))?.[1])
    if (typeof name !== 'string' || typeof agentId !== 'string' || !Number.isInteger(index))
      throw new JobError('a trial names no task, agent or attempt')
    const task = name.split('/').at(-1)!
    if (names.has(task) && names.get(task) !== name)
      throw new JobError('two tasks of the job are called ' + task)
    names.set(task, name)
    const reward = trial['verifier_result']?.['rewards']?.['reward']
    const failure = trial['exception_info'] as Record<string, any> | null
    const errored =
      typeof reward !== 'number' || (failure && failure['exception_type'] !== 'AgentTimeoutError')
    const usage = trial['agent_result'] as Record<string, any> | null
    return {
      agent: agentId,
      cachedTokens: Number(usage?.['n_cache_tokens'] ?? 0),
      costUsd: typeof usage?.['cost_usd'] === 'number' ? usage['cost_usd'] : null,
      ...(errored && failure
        ? { error: failure['exception_type'] + ': ' + String(failure['exception_message']) }
        : {}),
      index,
      inputTokens: Number(usage?.['n_input_tokens'] ?? 0),
      metered: Boolean(usage),
      outcome: errored ? 'errored' : reward === 1 ? 'passed' : 'failed',
      outputTokens: Number(usage?.['n_output_tokens'] ?? 0),
      task,
    }
  })
}

const letters = { errored: 'e', failed: 'f', passed: 'p' } as const

export function record(
  into: { errors: Record<string, number>; marks: Marks; usage: Usage },
  found: readonly Row[],
): { charged: 'recorded' | 'reserved'; usd: number } {
  let priced = true
  let usd = 0
  for (const row of [...found].sort((left, right) => left.index - right.index)) {
    const tasks = (into.marks[row.agent] ??= {})
    tasks[row.task] = (tasks[row.task] ?? '') + letters[row.outcome]
    if (row.outcome === 'errored') {
      const error = (row.error ?? 'no reward and no error').slice(0, 300)
      into.errors[error] = (into.errors[error] ?? 0) + 1
    }
    const usage = (into.usage[row.agent] ??= {
      cachedTokens: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    usage.cachedTokens += row.cachedTokens
    usage.inputTokens += row.inputTokens
    usage.outputTokens += row.outputTokens
    if (row.costUsd !== null) {
      usd += row.costUsd
      if (usage.costUsd !== null) usage.costUsd += row.costUsd
    } else if (row.metered) {
      priced = false
      usage.costUsd = null
    }
  }
  for (const usage of Object.values(into.usage))
    if (usage.costUsd !== null) usage.costUsd = micro(usage.costUsd)
  return { charged: priced ? 'recorded' : 'reserved', usd: micro(usd) }
}

function micro(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}

export function tally(marks: string): Tally & { errored: number } {
  let passed = 0
  let scored = 0
  for (const mark of marks) {
    if (mark === 'e') continue
    scored++
    if (mark === 'p') passed++
  }
  return { errored: marks.length - scored, passed, scored }
}

function failures(value: Tally): Tally {
  return { passed: value.scored - value.passed, scored: value.scored }
}

export function judge(
  rule: { alpha: number; attempts: number },
  input: { base: Tally | undefined; confirmed: boolean; revision: Tally },
): { kind: 'gained' | 'lost' | 'moved' | 'new' | 'same' | 'suspect'; p: number } {
  const { base, revision } = input
  if (!base?.scored || !revision.scored) return { kind: 'new', p: 1 }
  const difference = revision.passed * base.scored - base.passed * revision.scored
  if (difference === 0) return { kind: 'same', p: 1 }
  const down = difference < 0
  const [from, to] = down ? [base, revision] : [failures(base), failures(revision)]
  const p = Stats.task(from, to).worse
  if (input.confirmed) return { kind: p <= rule.alpha ? (down ? 'lost' : 'gained') : 'moved', p }
  const reachable = Stats.task(from, {
    passed: to.passed,
    scored: to.scored + rule.attempts,
  }).worse
  return { kind: reachable <= rule.alpha ? 'suspect' : 'moved', p }
}

export function key(pair: Pair): string {
  return pair.nanocode + ' ' + pair.nanocodeTs
}

function specs(settings: Config): Record<string, string> {
  return Object.fromEntries(settings.eval.agents.map((entry) => [entry.id, entry.spec]))
}

export function replay(lines: readonly Line[], settings: Config): State {
  const evaluations = lines.filter((line): line is Evaluation => line.type === 'evaluation')
  const own = evaluations.filter((line) => line.eval === settings.eval.name)
  const taken = new Set(lines.flatMap((line) => (line.type === 'accept' ? [line.evaluation] : [])))
  const current = specs(settings)
  const fits = (line: Evaluation) =>
    Object.keys(current).length === Object.keys(line.agents).length &&
    Object.entries(current).every(
      ([id, spec]) =>
        line.agents[id] === spec &&
        (settings.eval.tasks === 'all' ||
          settings.eval.tasks.every((task) => line.marks[id]?.[task] !== undefined)),
    )
  const accepted = own.filter(
    (line) =>
      fits(line) &&
      line.trigger === 'watch' &&
      (line.verdict === 'baseline' ||
        line.verdict === 'ok' ||
        (line.verdict === 'regression' && taken.has(line.id))),
  )
  const evidence: Evidence = {}
  const closed = new Set<string>()
  for (const line of accepted.slice(-settings.baseline.window).reverse())
    for (const [id, tasks] of Object.entries(line.marks)) {
      if (line.agents[id] !== current[id]) continue
      for (const [task, marks] of Object.entries(tasks)) {
        if (closed.has(id + ' ' + task)) continue
        const sum = ((evidence[id] ??= {})[task] ??= { passed: 0, scored: 0 })
        const { passed, scored } = tally(marks)
        sum.passed += passed
        sum.scored += scored
        if (
          line.changes.some(
            (change) =>
              change.agent === id &&
              change.task === task &&
              (change.kind === 'gained' || change.kind === 'lost'),
          )
        )
          closed.add(id + ' ' + task)
      }
    }
  const retried = lines.findLastIndex((line) => line.type === 'retry')
  return {
    accepted,
    baseline: accepted.at(-1),
    evaluations: own,
    evidence,
    fresh: lines
      .slice(retried + 1)
      .filter(
        (line): line is Evaluation =>
          line.type === 'evaluation' && line.eval === settings.eval.name,
      ),
  }
}

export function spend(steps: readonly Step[], day: string): { runs: number; usd: number } {
  const own = steps.filter((step) => step.purpose !== 'build' && step.startedAt.startsWith(day))
  return {
    runs: own.length,
    usd: micro(own.reduce((sum, step) => sum + step.usd, 0)),
  }
}

export function admit(
  budget: Config['budget'],
  spent: { runs: number; usd: number },
): string | undefined {
  if (spent.runs + 1 > budget.dailyRuns)
    return spent.runs + ' of the ' + budget.dailyRuns + ' runs of the day are used'
  if (Math.round((spent.usd + budget.runUsd) * 1e6) > Math.round(budget.dailyUsd * 1e6))
    return (
      '$' +
      spent.usd.toFixed(4) +
      ' of the $' +
      budget.dailyUsd +
      ' of the day is spent or reserved, and a run may spend $' +
      budget.runUsd
    )
  return undefined
}

function required(intent: Pick<Intent, 'confirm' | 'request'>, entry: Key): number {
  return (
    intent.request.attempts +
    (intent.confirm.some((other) => other.agent === entry.agent && other.task === entry.task)
      ? intent.request.attempts
      : 0)
  )
}

function expected(intent: Pick<Intent, 'marks' | 'request'>): Key[] {
  return intent.request.agents.flatMap((id) =>
    (intent.request.tasks === 'all'
      ? Object.keys(intent.marks[id] ?? {}).sort()
      : intent.request.tasks
    ).map((task) => ({ agent: id, task })),
  )
}

export function compare(
  settings: Config,
  input: { evidence: Evidence; intent: Pick<Intent, 'confirm' | 'marks' | 'request' | 'rounds'> },
): { changes: Change[]; suspects: Key[]; unscored: Key[] } {
  const { intent } = input
  const changes: Change[] = []
  const suspects: Key[] = []
  const unscored: Key[] = []
  for (const entry of expected(intent)) {
    const revision = tally(intent.marks[entry.agent]?.[entry.task] ?? '')
    if (revision.scored < required(intent, entry)) {
      unscored.push(entry)
      continue
    }
    if (intent.request.role === 'baseline') continue
    const base = input.evidence[entry.agent]?.[entry.task]
    const found = judge(
      { alpha: settings.baseline.alpha, attempts: intent.request.attempts },
      { base, confirmed: intent.rounds.confirm > 0, revision },
    )
    if (found.kind === 'suspect') suspects.push(entry)
    else if (found.kind !== 'new' && found.kind !== 'same')
      changes.push({
        ...entry,
        base: base!,
        kind: found.kind,
        p: found.p,
        revision: { passed: revision.passed, scored: revision.scored },
      })
  }
  return { changes, suspects, unscored }
}

function group(needs: readonly (Key & { attempts: number })[]): Call[] {
  const perAgent = new Map<string, { attempts: number; tasks: string[] }>()
  for (const need of needs) {
    const entry = perAgent.get(need.agent) ?? { attempts: 0, tasks: [] }
    entry.attempts = Math.max(entry.attempts, need.attempts)
    entry.tasks.push(need.task)
    perAgent.set(need.agent, entry)
  }
  const calls = new Map<string, Call>()
  for (const [id, entry] of perAgent) {
    const tasks = [...entry.tasks].sort()
    const name = entry.attempts + ' ' + tasks.join(' ')
    const call = calls.get(name) ?? { agents: [], attempts: entry.attempts, tasks }
    call.agents.push(id)
    calls.set(name, call)
  }
  return [...calls.values()]
}

export function next(
  settings: Config,
  input: { evidence: Evidence; intent: Intent },
): { calls: Call[]; purpose: Purpose } | undefined {
  const { intent } = input
  const { request } = intent
  if (intent.phase.kind !== 'open') return undefined
  if (!intent.rounds.main)
    return {
      calls: [{ agents: request.agents, attempts: request.attempts, tasks: request.tasks }],
      purpose: 'main',
    }
  const scored = Object.values(intent.marks).some((tasks) =>
    Object.values(tasks).some((marks) => tally(marks).scored > 0),
  )
  if (!scored) return undefined
  const { suspects, unscored } = compare(settings, input)
  if (unscored.length && intent.rounds.errored < settings.retries.errored)
    return {
      calls: group(
        unscored.map((entry) => ({
          ...entry,
          attempts:
            required(intent, entry) - tally(intent.marks[entry.agent]?.[entry.task] ?? '').scored,
        })),
      ),
      purpose: 'errored',
    }
  if (suspects.length && !intent.rounds.confirm)
    return {
      calls: group(suspects.map((entry) => ({ ...entry, attempts: request.attempts }))),
      purpose: 'confirm',
    }
  return undefined
}

export function summarize(
  intent: Pick<Intent, 'marks' | 'usage'>,
  input: { agents: readonly string[]; k: number },
) {
  const summary: Record<string, Summary> = {}
  for (const id of input.agents) {
    const tasks = intent.marks[id]
    if (!tasks) continue
    const groups = Object.values(tasks).map((marks) => marks.replaceAll('e', ''))
    const scored = groups.filter((marks) => marks.length)
    const all = Object.values(tasks).join('')
    const usage = intent.usage[id]
    summary[id] = {
      attempts: all.length,
      cachedTokens: usage?.cachedTokens ?? 0,
      costUsd: usage ? usage.costUsd : null,
      errored: all.split('e').length - 1,
      failed: all.split('f').length - 1,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      pass1: scored.length
        ? scored.filter((marks) => marks.startsWith('p')).length / scored.length
        : null,
      passK: scored.length
        ? scored.filter((marks) => marks.slice(0, input.k).includes('p')).length / scored.length
        : null,
      passed: all.split('p').length - 1,
      tasks: groups.length,
    }
  }
  return summary
}

export function conclude(
  settings: Config,
  input: { culprit?: Culprit; evidence: Evidence; finishedAt: string; intent: Intent },
): Evaluation {
  const { intent } = input
  const { request } = intent
  const { changes, suspects, unscored } = compare(settings, input)
  const lost = changes.filter((change) => change.kind === 'lost')
  const sought = (entry: Key) =>
    (request.lost ?? []).some((other) => other.agent === entry.agent && other.task === entry.task)
  const open = [...unscored, ...suspects]
  const failure = intent.phase.kind === 'failed' ? intent.phase.failure : undefined
  let verdict: Kind
  if (failure) verdict = failure.verdict
  else if (request.role === 'baseline') verdict = open.length ? 'incomplete' : 'baseline'
  else if (request.role === 'bisect')
    verdict = lost.some(sought) ? 'bad' : open.some(sought) ? 'incomplete' : 'good'
  else verdict = lost.length ? 'regression' : open.length ? 'incomplete' : 'ok'
  const current = specs(settings)
  const k = request.role === 'baseline' ? settings.eval.attempts : request.attempts
  const detail =
    failure?.detail ??
    (verdict === 'incomplete'
      ? (open.length === 1 ? '1 task has' : open.length + ' tasks have') +
        ' too few scored attempts: ' +
        open.map((entry) => entry.agent + '/' + entry.task).join(', ') +
        Object.entries(intent.errors)
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3)
          .map(([error, count]) => ', ' + count + ' x ' + error)
          .join('')
      : undefined)
  return {
    agents: Object.fromEntries(request.agents.map((id) => [id, current[id]!])),
    attempts: request.attempts,
    baseline: intent.baseline,
    changes,
    ...(request.covers ? { covers: request.covers } : {}),
    ...(input.culprit ? { culprit: input.culprit } : {}),
    ...(detail ? { detail } : {}),
    eval: settings.eval.name,
    finishedAt: input.finishedAt,
    id: intent.id,
    k,
    ...(request.label ? { label: request.label } : {}),
    marks: intent.marks,
    pair: request.pair,
    startedAt: intent.startedAt,
    steps: intent.steps,
    summary: summarize(intent, { agents: request.agents, k }),
    trigger: request.role === 'bisect' ? 'bisect' : request.role === 'manual' ? 'manual' : 'watch',
    type: 'evaluation',
    verdict,
  }
}

export function path(base: Pair, chains: Chains): Point[] {
  const points: Point[] = [{ i: 0, j: 0, pair: base }]
  let i = 0
  let j = 0
  let pair = base
  while (i < chains.nanocode.commits.length || j < chains.nanocodeTs.commits.length) {
    const left = chains.nanocode.commits[i]
    const right = chains.nanocodeTs.commits[j]
    if (left && (!right || left.at <= right.at)) {
      i++
      pair = { ...pair, nanocode: left.sha }
      points.push({
        i,
        j,
        pair,
        step: { repository: 'nanocode', sha: left.sha, subject: left.subject },
      })
    } else {
      j++
      pair = { ...pair, nanocodeTs: right!.sha }
      points.push({
        i,
        j,
        pair,
        step: { repository: 'nanocode-ts', sha: right!.sha, subject: right!.subject },
      })
    }
  }
  return points
}

export function head(chains: Chains): Pair {
  return { nanocode: chains.nanocode.head, nanocodeTs: chains.nanocodeTs.head }
}

function tries(state: State, pair: Pair): { build: Evaluation[]; run: Evaluation[] } {
  const own = state.fresh.filter(
    (line) => line.trigger !== 'manual' && key(line.pair) === key(pair),
  )
  return {
    build: own.filter((line) => line.verdict === 'build_failed'),
    run: own.filter((line) => line.verdict !== 'build_failed' && !conclusive(line)),
  }
}

export function conclusive(line: Evaluation): boolean {
  return scored(line) && line.verdict !== 'incomplete'
}

function scored(line: Evaluation): boolean {
  return (
    line.verdict !== 'build_failed' &&
    line.verdict !== 'interrupted' &&
    line.verdict !== 'run_failed'
  )
}

function exhausted(settings: Config, input: { pair: Pair; state: State }): string | undefined {
  const found = tries(input.state, input.pair)
  if (found.build.length > settings.retries.build)
    return (
      'its build failed ' +
      found.build.length +
      ' times, log ' +
      found.build.at(-1)!.steps.at(-1)?.log
    )
  if (found.run.length > settings.retries.run)
    return (
      found.run.length +
      ' evaluations of it did not complete, the last one ' +
      found.run.at(-1)!.verdict +
      (found.run.at(-1)!.detail ? ' (' + found.run.at(-1)!.detail + ')' : '')
    )
  return undefined
}

export function short(revision: string): string {
  return /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 12) : revision
}

export function name(pair: Pair): string {
  return 'nanocode ' + short(pair.nanocode) + ' nanocode-ts ' + short(pair.nanocodeTs)
}

export function search(
  settings: Config,
  input: { chains: Chains; regression: Evaluation; state: State },
): { culprit: Culprit } | { pair: Pair } {
  const { chains, regression, state } = input
  const base = state.baseline!.pair
  const points = path(base, chains)
  const position = (pair: Pair) => {
    const index = (chain: Chain, at: { origin: string; sha: string }) =>
      at.sha === at.origin
        ? 0
        : chain.commits.findIndex((commit) => commit.sha === at.sha) + 1 || -1
    return {
      i: index(chains.nanocode, { origin: base.nanocode, sha: pair.nanocode }),
      j: index(chains.nanocodeTs, { origin: base.nanocodeTs, sha: pair.nanocodeTs }),
    }
  }
  const sought = regression.changes.filter((change) => change.kind === 'lost')
  const current = specs(settings)
  const found: { bad: boolean; i: number; j: number }[] = [{ bad: false, i: 0, j: 0 }]
  for (const line of state.evaluations) {
    if (line.trigger === 'manual' || !scored(line)) continue
    const at = position(line.pair)
    if (at.i < 0 || at.j < 0 || (at.i === 0 && at.j === 0)) continue
    let bad = false
    let covered = true
    for (const entry of sought) {
      const marks = line.marks[entry.agent]?.[entry.task]
      if (line.agents[entry.agent] !== current[entry.agent] || marks === undefined) {
        covered = false
        continue
      }
      const revision = tally(marks)
      if (revision.scored < line.attempts) covered = false
      else if (
        judge(
          { alpha: settings.baseline.alpha, attempts: line.attempts },
          { base: state.evidence[entry.agent]?.[entry.task], confirmed: true, revision },
        ).kind === 'lost'
      )
        bad = true
    }
    if (bad || covered) found.push({ bad, ...at })
  }
  const known = (point: Point, bad: boolean) =>
    found.some(
      (entry) =>
        entry.bad === bad &&
        (bad ? entry.i <= point.i && entry.j <= point.j : entry.i >= point.i && entry.j >= point.j),
    )
  const bad = points.findIndex((point) => known(point, true))
  const hi = bad < 0 ? points.length - 1 : bad
  const lo = points.findLastIndex((point, index) => index < hi && known(point, false))
  const between = points.slice(lo + 1, hi)
  const open = between.filter((point) => !exhausted(settings, { pair: point.pair, state }))
  if (!open.length)
    return {
      culprit: {
        commits: points.slice(lo + 1, hi + 1).map((point) => point.step!),
        good: points[lo]!.pair,
      },
    }
  const middle = (lo + hi) / 2
  const nearest = [...open].sort(
    (left, right) =>
      Math.abs(points.indexOf(left) - middle) - Math.abs(points.indexOf(right) - middle),
  )[0]!
  return { pair: nearest.pair }
}

export function standing(state: State, pair: Pair): Evaluation | undefined {
  const last = state.evaluations.findLast(
    (line) => line.trigger === 'watch' && key(line.pair) === key(pair) && conclusive(line),
  )
  return last?.verdict === 'regression' && state.baseline?.id !== last.id ? last : undefined
}

export function plan(
  settings: Config,
  input: { bisect?: boolean; chains: Chains; state: State },
): Action {
  const { chains, state } = input
  const pair = head(chains)
  const agents = settings.eval.agents.map((entry) => entry.id)
  const gaveUp = exhausted(settings, { pair, state })
  if (!state.baseline)
    return gaveUp
      ? { kind: 'idle', reason: 'no baseline: ' + name(pair) + ' is not tried again, ' + gaveUp }
      : {
          kind: 'evaluate',
          request: {
            agents,
            attempts: settings.baseline.window * settings.eval.attempts,
            pair,
            role: 'baseline',
            tasks: settings.eval.tasks,
          },
        }
  if (key(pair) === key(state.baseline.pair))
    return { kind: 'idle', reason: 'up to date at ' + name(pair) }
  const regression = standing(state, pair)
  if (!regression)
    return gaveUp
      ? { kind: 'idle', reason: name(pair) + ' is not tried again: ' + gaveUp }
      : {
          kind: 'evaluate',
          request: {
            agents,
            attempts: settings.eval.attempts,
            covers: {
              nanocode: chains.nanocode.commits.length,
              nanocodeTs: chains.nanocodeTs.commits.length,
            },
            pair,
            role: 'head',
            tasks: settings.eval.tasks,
          },
        }
  const lost = regression.changes
    .filter((change) => change.kind === 'lost')
    .map((change) => ({ agent: change.agent, task: change.task }))
  const stands =
    name(pair) +
    ' lost ' +
    lost.map((entry) => entry.agent + '/' + entry.task).join(', ') +
    ' against ' +
    name(state.baseline.pair)
  if (settings.bisect === 'off' && !input.bisect)
    return { kind: 'idle', reason: stands + ', and bisect is off' }
  const found = search(settings, { chains, regression, state })
  if ('culprit' in found)
    return { culprit: found.culprit, kind: 'idle', reason: stands + ': ' + blame(found.culprit) }
  return {
    kind: 'evaluate',
    request: {
      agents: agents.filter((id) => lost.some((entry) => entry.agent === id)),
      attempts: settings.eval.attempts,
      lost,
      pair: found.pair,
      role: 'bisect',
      tasks: [...new Set(lost.map((entry) => entry.task))].sort(),
    },
  }
}

export function blame(culprit: Culprit): string {
  const commits = culprit.commits.map(
    (commit) => commit.repository + ' ' + short(commit.sha) + ' "' + commit.subject + '"',
  )
  return commits.length === 1
    ? 'first losing commit ' + commits[0]
    : 'first losing commit is one of ' +
        commits.length +
        ' that could not be told apart: ' +
        commits.join(', ')
}

function percent(value: number | null): string {
  return value === null ? 'not scored' : (value * 100).toFixed(1) + '%'
}

function fraction(value: Tally): string {
  return value.passed + '/' + value.scored
}

function recent(revisions: number): string {
  return revisions === 1
    ? 'the last accepted revision'
    : 'the last ' + revisions + ' accepted revisions'
}

function chance(p: number): string {
  return p < 0.001 ? p.toExponential(1) : p.toFixed(3)
}

function moves(line: Evaluation, kind: Change['kind']): string[] {
  return line.changes
    .filter((change) => change.kind === kind)
    .map(
      (change) =>
        change.agent +
        '/' +
        change.task +
        ' ' +
        fraction(change.base) +
        ' -> ' +
        fraction(change.revision) +
        ' (p ' +
        chance(change.p) +
        ')',
    )
}

function usd(steps: readonly Step[]): number {
  return micro(steps.reduce((sum, step) => sum + step.usd, 0))
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

export function sentence(line: Evaluation): string {
  const lost = moves(line, 'lost')
  const gained = moves(line, 'gained')
  const moved = moves(line, 'moved')
  const runs = line.steps.filter((step) => step.purpose !== 'build')
  const what: Record<Kind, string> = {
    bad: 'bisect, loses',
    baseline: 'baseline',
    build_failed: 'build failed',
    good: 'bisect, loses nothing',
    incomplete: 'incomplete',
    interrupted: 'interrupted',
    ok: 'ok',
    regression: 'REGRESSION',
    run_failed: 'run failed',
  }
  return [
    (line.trigger === 'manual' ? 'on demand ' : '') +
      name(line.label ?? line.pair) +
      ': ' +
      what[line.verdict] +
      (lost.length ? ', lost ' + lost.join(', ') : '') +
      (gained.length ? ', gained ' + gained.join(', ') : '') +
      (moved.length ? ', within noise ' + moved.join(', ') : ''),
    ...(line.detail ? [line.detail] : []),
    ...(line.culprit ? [blame(line.culprit)] : []),
    ...Object.entries(line.summary).map(
      ([id, summary]) =>
        id +
        ' pass@1 ' +
        percent(summary.pass1) +
        (line.k > 1 ? ' pass@' + line.k + ' ' + percent(summary.passK) : '') +
        (summary.errored ? ', ' + summary.errored + ' errored' : ''),
    ),
    ...(runs.length
      ? [
          runs.length +
            (runs.length === 1 ? ' run' : ' runs') +
            ', $' +
            usd(runs).toFixed(4) +
            (runs.some((step) => step.charged === 'reserved') ? ' with what is reserved' : ''),
        ]
      : []),
    ...(scored(line) ? [] : ['log ' + line.steps.at(-1)?.log]),
  ].join('; ')
}

function cells(rows: readonly (readonly string[])[]): string {
  const [first, ...body] = rows
  return [first!, first!.map(() => '---'), ...body]
    .map((row) => '| ' + row.join(' | ') + ' |')
    .join('\n')
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function tokens(summary: Summary | undefined): string[] {
  return summary
    ? [
        number(summary.inputTokens) + ' (' + number(summary.cachedTokens) + ')',
        number(summary.outputTokens),
        summary.costUsd === null ? 'not known' : '$' + summary.costUsd.toFixed(4),
      ]
    : ['', '', '']
}

export function comparison(
  settings: Config,
  input: { evidence: Evidence; line: Evaluation; state: State },
): string {
  const { line, state } = input
  const base = state.baseline
  const side = base
    ? summarize({ marks: base.marks, usage: {} }, { agents: Object.keys(base.agents), k: line.k })
    : {}
  if (!Object.keys(line.summary).length)
    return 'no attempt ran, so there is nothing to set against the baseline\n'
  const several = line.k > 1
  const rows = Object.entries(line.summary).map(([id, summary]) => [
    id,
    line.agents[id]!,
    percent(side[id]?.pass1 ?? null) + ' -> ' + percent(summary.pass1),
    ...(several ? [percent(side[id]?.passK ?? null) + ' -> ' + percent(summary.passK)] : []),
    String(summary.passed),
    String(summary.failed),
    String(summary.errored),
    ...tokens(summary),
  ])
  const tasks = [...new Set(Object.values(line.marks).flatMap((entry) => Object.keys(entry)))]
  const ids = Object.keys(line.summary)
  const verdicts = new Map(line.changes.map((change) => [change.agent + ' ' + change.task, change]))
  return [
    base
      ? 'against the baseline ' +
        name(base.pair) +
        ', whose tasks have the attempts of ' +
        recent(Math.min(settings.baseline.window, state.accepted.length))
      : 'no baseline to set it against',
    '',
    cells([
      [
        'Agent',
        'Model',
        'pass@1',
        ...(several ? ['pass@' + line.k] : []),
        'Passed',
        'Failed',
        'Errored',
        'Input tokens (cached)',
        'Output tokens',
        'Cost',
      ],
      ...rows,
    ]),
    '',
    cells([
      ['Task', ...ids.flatMap((id) => [id + ' baseline', id + ' revision', id])],
      ...tasks.sort().map((task) => [
        task,
        ...ids.flatMap((id) => {
          const from = input.evidence[id]?.[task]
          const marks = line.marks[id]?.[task]
          const change = verdicts.get(id + ' ' + task)
          return [
            from ? fraction(from) : 'not run',
            marks === undefined ? 'not run' : fraction(tally(marks)) + ' ' + marks,
            change ? change.kind + ' (p ' + chance(change.p) + ')' : '',
          ]
        }),
      ]),
    ]),
    '',
  ].join('\n')
}

export function scoreboard(
  settings: Config,
  input: { at: string; lines: readonly Line[] },
): string {
  const state = replay(input.lines, settings)
  const all = input.lines.filter((line): line is Evaluation => line.type === 'evaluation')
  const ids = settings.eval.agents.map((entry) => entry.id)
  const base = state.baseline
  const tasks = [
    ...new Set(Object.values(state.evidence).flatMap((entry) => Object.keys(entry))),
  ].sort()
  const last = all.findLast((line) => line.trigger === 'watch' && conclusive(line))
  const regression =
    last && last.verdict === 'regression' && last.id !== base?.id ? last : undefined
  const culprit = regression
    ? all.findLast(
        (line) => line.culprit && Date.parse(line.finishedAt) >= Date.parse(regression.finishedAt),
      )?.culprit
    : undefined
  return [
    '# nanoeval watch',
    '',
    'Eval ' +
      settings.eval.name +
      ', ' +
      (settings.eval.tasks === 'all'
        ? 'all tasks'
        : settings.eval.tasks.length + ' tasks (' + settings.eval.tasks.join(', ') + ')') +
      ', ' +
      settings.eval.attempts +
      ' attempts a task, agents ' +
      settings.eval.agents.map((entry) => entry.id + ' (' + entry.spec + ')').join(', ') +
      '. A task is lost or gained when its passes differ from those of ' +
      recent(settings.baseline.window) +
      ' at p <= ' +
      settings.baseline.alpha +
      ' in a one-sided Fisher exact test, after one rerun of ' +
      settings.eval.attempts +
      ' more attempts. Written ' +
      input.at +
      '.',
    '',
    '## Baseline',
    '',
    base
      ? name(base.pair) +
        ', accepted ' +
        base.finishedAt +
        ' (evaluation ' +
        base.id +
        '). Passes of scored attempts over ' +
        recent(Math.min(settings.baseline.window, state.accepted.length)) +
        ':'
      : 'None yet.',
    '',
    ...(base
      ? [
          cells([
            ['Task', ...ids],
            ...tasks.map((task) => [
              task,
              ...ids.map((id) => {
                const found = state.evidence[id]?.[task]
                return found ? fraction(found) : 'not run'
              }),
            ]),
          ]),
          '',
        ]
      : []),
    ...(regression
      ? [
          '## Standing regression',
          '',
          name(regression.pair) +
            ' (evaluation ' +
            regression.id +
            ') lost ' +
            moves(regression, 'lost').join(', ') +
            '. ' +
            (culprit ? 'The ' + blame(culprit) + '.' : 'The first losing commit is not known.') +
            ' The baseline stays until a revision loses nothing or this one is accepted.',
          '',
        ]
      : []),
    '## Revisions',
    '',
    cells([
      [
        'Finished',
        'nanocode',
        'nanocode-ts',
        'For',
        'Verdict',
        'Agent',
        'pass@1',
        'pass@k',
        'Gained',
        'Lost',
        'Input tokens (cached)',
        'Output tokens',
        'Cost',
        'Runs',
      ],
      ...all
        .slice()
        .reverse()
        .flatMap((line) => {
          const shown = line.label ?? line.pair
          const lead = [
            line.finishedAt,
            short(shown.nanocode),
            short(shown.nanocodeTs),
            line.trigger === 'manual' ? 'on demand' : line.trigger,
            line.verdict.replaceAll('_', ' ') +
              (line.covers
                ? ', covers ' + line.covers.nanocode + ' + ' + line.covers.nanocodeTs + ' commits'
                : '') +
              (scored(line) ? '' : ', log ' + line.steps.at(-1)?.log) +
              (line.culprit ? ', ' + blame(line.culprit) : ''),
          ]
          const runs = String(line.steps.filter((step) => step.purpose !== 'build').length)
          const agents = Object.keys(line.summary)
          if (!agents.length) return [[...lead, '', '', '', '', '', '', '', '', runs]]
          return agents.map((id) => {
            const summary = line.summary[id]!
            const of = (kind: Change['kind']) =>
              line.changes
                .filter((change) => change.agent === id && change.kind === kind)
                .map((change) => change.task)
                .join(', ')
            return [
              ...lead,
              id,
              percent(summary.pass1),
              percent(summary.passK) + ' @' + line.k,
              of('gained'),
              of('lost'),
              ...tokens(summary),
              runs,
            ]
          })
        }),
    ]),
    '',
  ].join('\n')
}
