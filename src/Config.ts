import * as Branch from './Branch.ts'
import * as Eval from './Eval.ts'
import * as Installed from './Installed.ts'
import type * as Ledger from './Ledger.ts'
import * as Pace from './Pace.ts'
import * as Price from './Price.ts'
import type * as Protocol from './Protocol.ts'
import type * as Sandbox from './Sandbox.ts'
import * as Slot from './Slot.ts'

export class InvalidError extends Error {
  override name = 'Config.InvalidError'
}

export class UnsupportedError extends Error {
  override name = 'Config.UnsupportedError'
}

export type Backend = Slot.Backend | 'auto'

export type Agent = {
  api?: Installed.Api
  branches?: number
  briefFinal?: true
  briefFinish?: true
  cellYieldMs?: number
  escalateContextTokens?: number
  escalateModel?: string
  escalateToolErrors?: number
  foldFinish?: true
  id: string
  lateFinishCheckMs?: number
  lazy?: true
  leanCells?: true
  lowEffortRounds?: true
  model: string
  orchestration?: Orchestration
  preflight?: true
  provider: 'claude' | 'codex' | 'oracle' | Installed.Kind
  refusalFallback?: RefusalFallback
  resultEffort?: Effort
  skipFinishCheck?: true
  stopAtTarget?: true
  thinking?: string
  toolResultTokens?: number
  yieldFloorMs?: number
  yieldShare?: number
}

export type Harness = 'installed' | 'oracle' | 'session'

export type Orchestration = 'direct' | 'jobs'

export type Judge = {
  model: string
  provider: 'claude' | 'codex'
  thinking?: string
}

export type Payer = 'deployment' | 'plan'

export const payers: readonly Payer[] = ['deployment', 'plan']

export type RefusalFallback = 'return_once' | 'session'

export type Effort = 'high' | 'low' | 'max' | 'medium' | 'xhigh'

export const efforts: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const finishLevers = [
  'briefFinal',
  'briefFinish',
  'foldFinish',
  'leanCells',
  'lowEffortRounds',
  'skipFinishCheck',
  'stopAtTarget',
] as const

export const planSignIn = 'nanoeval plans sign-in claude'

export type Config = {
  agents: readonly Agent[]
  attempts: number
  budget: { modelUsd?: number; sandboxUsd: number }
  eval: Eval.Reference
  judge?: Judge
  key?: { deposit?: number; topUp?: number }
  limit?: number
  limits: {
    agentMaxSec?: number
    attachSec: number
    claims: number
    leaseSec: number
    noDeadline?: true
    setupSec: number
    stepRetries: number
    verifierMaxSec?: number
  }
  name: string
  only?: readonly string[]
  paces?: Pace.List
  payer?: Payer
  prices?: Price.List
  rerun?: { run: string; select: Ledger.Selection }
  sandbox: {
    backend: Backend
    disks: 'keep' | 'remove'
    cpusPerThread?: number | null
    freeDiskMb?: number
    leaseSec?: number
    max: number
    memoryMb?: number
    network: Slot.Network
    pollMs: number
    provider: 'e2b' | 'gateway' | 'local'
    runtime?: Eval.Blob
    slots?: number
    template?: string
    timeoutSec?: number
    verifierCache?: true
    warm?: { idleSec: number; usd: number }
  }
}

export type Runner = {
  ahead?: Protocol.Ahead[]
  backend: Backend
  cpusPerThread?: number | null
  disks: 'keep' | 'remove'
  endsAt?: number
  freeDiskMb?: number
  leaseSec: number
  limits: { attachSec: number; setupSec: number; stepRetries: number }
  memoryMb?: number
  memoryOvercommit?: true
  network: Slot.Network
  oracle: boolean
  pollMs: number
  pool?: Protocol.Standing
  protocol?: number
  ready?: true
  run: string
  runner: number
  slots?: number
  token: string
  url: string
  verifierCache?: true
}

const thinking = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

export function backend(
  requested: Backend,
  machine: Pick<Sandbox.Capabilities, 'kvm' | 'ns'>,
): Slot.Backend | undefined {
  if (requested !== 'auto') return requested
  return machine.kvm ? 'krun' : machine.ns ? 'ns' : undefined
}

export function kind(backend: Backend | 'none'): 'dir' | 'disk' {
  return backend === 'dir' ? 'dir' : 'disk'
}

export function network(sandbox: Pick<Config['sandbox'], 'backend'>): Slot.Network {
  return sandbox.backend === 'dir' ? 'host' : 'private'
}

export function harness(agent: Pick<Agent, 'provider'>): Harness {
  if (agent.provider === 'oracle') return 'oracle'
  return Installed.is(agent.provider) ? 'installed' : 'session'
}

export function bounded<Task extends Pick<Eval.Task, 'agent' | 'verifier'>>(
  limits: Pick<Config['limits'], 'agentMaxSec' | 'verifierMaxSec'>,
  task: Task,
): Task {
  const agent =
    limits.agentMaxSec === undefined || task.agent.timeoutSec <= limits.agentMaxSec
      ? task
      : { ...task, agent: { ...task.agent, timeoutSec: limits.agentMaxSec } }
  return cuts(limits, task)
    ? { ...agent, verifier: { ...task.verifier, timeoutSec: limits.verifierMaxSec } }
    : agent
}

export function cuts(
  limits: Pick<Config['limits'], 'verifierMaxSec'>,
  task: Pick<Eval.Task, 'verifier'>,
): boolean {
  return limits.verifierMaxSec !== undefined && task.verifier.timeoutSec > limits.verifierMaxSec
}

export function lifetimeSec(
  config: Pick<Config, 'limits' | 'sandbox'>,
  rows: readonly Pick<Eval.Task, 'agent' | 'setupTimeoutSec' | 'verifier'>[],
): number {
  const lanes = Array.from(
    { length: Math.max(config.sandbox.max, 1) * (config.sandbox.slots ?? 1) },
    () => 0,
  )
  const longest = rows
    .map((task) => rowSec(config.limits, task))
    .sort((left, right) => right - left)
  for (const seconds of longest) lanes[lanes.indexOf(Math.min(...lanes))]! += seconds
  return Math.ceil(config.limits.setupSec + Math.max(...lanes))
}

export function rowSec(
  limits: Pick<Config['limits'], 'setupSec'>,
  task: Pick<Eval.Task, 'agent' | 'setupTimeoutSec' | 'verifier'>,
): number {
  return (
    Math.max(task.setupTimeoutSec ?? 0, limits.setupSec) +
    task.agent.timeoutSec +
    task.verifier.timeoutSec * (task.verifier.judge ? 3 : 1)
  )
}

export function oracle(config: Pick<Config, 'agents'>): Agent | undefined {
  return config.agents.find((agent) => agent.provider === 'oracle')
}

export function disks(provider: Config['sandbox']['provider']): Config['sandbox']['disks'] {
  return provider === 'local' ? 'keep' : 'remove'
}

export function rerunAgents(parent: readonly Agent[], ids: readonly string[]): Agent[] {
  if (!ids.length) return [...parent]
  const missing = ids.filter((id) => !parent.some((agent) => agent.id === id))
  if (missing.length)
    throw new InvalidError('the run has no agent ' + missing.join(', ') + ' to rerun')
  return parent.filter((agent) => ids.includes(agent.id))
}

export function parse(value: unknown): Config {
  const config = value as Config
  const fail = (message: string): never => {
    throw new InvalidError(message)
  }
  const integer = (candidate: unknown, name: string, minimum: number) =>
    Number.isSafeInteger(candidate) && (candidate as number) >= minimum
      ? (candidate as number)
      : fail(name + ' must be an integer of at least ' + minimum)
  const amount = (candidate: unknown, name: string) =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : fail(name + ' must be a non-negative number')
  const choice = <T extends string>(candidate: unknown, name: string, choices: readonly T[]): T =>
    choices.includes(candidate as T)
      ? (candidate as T)
      : fail(name + ' must be one of ' + choices.join(', '))

  if (typeof config !== 'object' || config === null) fail('the run configuration is not an object')
  if (typeof config.name !== 'string' || !config.name) fail('name is required')
  if (!Array.isArray(config.agents) || !config.agents.length) fail('at least one agent is required')
  const agents = config.agents.map((agent: Agent) => {
    if (typeof agent?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent.id))
      fail('an agent id is letters, digits, dots, dashes and underscores')
    if (typeof agent.model !== 'string' || !agent.model) fail(agent.id + ' names no model')
    if (agent.thinking !== undefined) choice(agent.thinking, 'thinking', thinking)
    const provider = choice(agent.provider, 'provider', [
      'claude',
      'codex',
      'oracle',
      ...Installed.kinds,
    ])
    if (agent.orchestration !== undefined) {
      choice(agent.orchestration, 'orchestration', ['direct', 'jobs'])
      if (provider === 'claude' && agent.orchestration !== 'direct')
        fail(
          agent.id +
            ' has the orchestration ' +
            agent.orchestration +
            ', and claude takes only direct',
        )
      if (provider !== 'codex' && provider !== 'claude')
        fail(agent.id + ' has an orchestration, which only codex and claude take')
    }
    if (agent.preflight !== undefined) {
      if (agent.preflight !== true) fail(agent.id + ' has a preflight that is not true')
      if (provider !== 'claude' && provider !== 'codex')
        fail(agent.id + ' has a preflight, which only claude and codex sessions take')
    }
    if (agent.branches !== undefined) {
      if (!Branch.valid(agent.branches))
        fail(agent.id + ' branches into a whole number of at least two sessions')
      if (provider !== 'claude' && provider !== 'codex')
        fail(agent.id + ' branches, and only a claude or codex session can')
    }
    if (agent.lazy !== undefined) {
      if (agent.lazy !== true) fail(agent.id + ' has a lazy that is not true')
      if (agent.branches === undefined)
        fail(agent.id + ' is lazy, and only an agent that branches can be')
    }
    if (agent.refusalFallback !== undefined) {
      choice(agent.refusalFallback, 'refusalFallback', ['return_once', 'session'])
      if (provider !== 'claude')
        fail(agent.id + ' has a refusalFallback, which only a claude session takes')
    }
    if (agent.cellYieldMs !== undefined) {
      integer(agent.cellYieldMs, agent.id + ': cellYieldMs', 1)
      if (provider !== 'claude' && provider !== 'codex')
        fail(agent.id + ' has a cellYieldMs, which only claude and codex sessions take')
    }
    if (
      agent.escalateContextTokens !== undefined ||
      agent.escalateModel !== undefined ||
      agent.escalateToolErrors !== undefined
    ) {
      if (typeof agent.escalateModel !== 'string' || !agent.escalateModel)
        fail(agent.id + ' escalates and names no escalateModel')
      if (agent.escalateContextTokens === undefined && agent.escalateToolErrors === undefined)
        fail(
          agent.id +
            ' has an escalateModel and neither an escalateToolErrors nor an escalateContextTokens',
        )
      if (agent.escalateContextTokens !== undefined)
        integer(agent.escalateContextTokens, agent.id + ': escalateContextTokens', 1)
      if (agent.escalateToolErrors !== undefined)
        integer(agent.escalateToolErrors, agent.id + ': escalateToolErrors', 1)
      if (provider !== 'claude')
        fail(agent.id + ' has an escalateModel, which only a claude session takes')
    }
    if (agent.toolResultTokens !== undefined) {
      integer(agent.toolResultTokens, agent.id + ': toolResultTokens', 1)
      if (provider !== 'claude')
        fail(agent.id + ' has a toolResultTokens, which only a claude session takes')
    }
    if (agent.lateFinishCheckMs !== undefined) {
      integer(agent.lateFinishCheckMs, agent.id + ': lateFinishCheckMs', 1)
      if (provider !== 'claude')
        fail(agent.id + ' has a lateFinishCheckMs, which only a claude session takes')
      if (agent.skipFinishCheck !== undefined)
        fail(agent.id + ' has a skipFinishCheck and a lateFinishCheckMs, which never go in one arm')
    }
    if (agent.resultEffort !== undefined) {
      choice(agent.resultEffort, agent.id + ': resultEffort', efforts)
      if (provider !== 'claude')
        fail(agent.id + ' has a resultEffort, which only a claude session takes')
    }
    if (agent.yieldFloorMs !== undefined) {
      integer(agent.yieldFloorMs, agent.id + ': yieldFloorMs', 1)
      if (provider !== 'claude')
        fail(agent.id + ' has a yieldFloorMs, which only a claude session takes')
    }
    if (agent.yieldShare !== undefined) {
      if (
        !(
          Number.isSafeInteger(agent.yieldShare) &&
          agent.yieldShare >= 1 &&
          agent.yieldShare <= 100
        )
      )
        fail(agent.id + ': yieldShare must be a whole percent from 1 to 100')
      if (provider !== 'claude')
        fail(agent.id + ' has a yieldShare, which only a claude session takes')
    }
    for (const lever of finishLevers) {
      if (agent[lever] === undefined) continue
      if (agent[lever] !== true) fail(agent.id + ' has a ' + lever + ' that is not true')
      if (provider !== 'claude')
        fail(agent.id + ' has a ' + lever + ', which only a claude session takes')
    }
    const named = Installed.is(provider) && Installed.releases[provider].provider === 'api'
    if (agent.api !== undefined || named) {
      if (!named) fail(agent.id + ' has an api, which ' + provider + ' does not take')
      choice(agent.api, agent.id + ': the api of ' + provider, Object.keys(Installed.apis))
    }
    return {
      ...(agent.api ? { api: agent.api } : {}),
      ...(agent.branches === undefined ? {} : { branches: agent.branches }),
      ...(agent.briefFinal ? { briefFinal: true as const } : {}),
      ...(agent.briefFinish ? { briefFinish: true as const } : {}),
      ...(agent.cellYieldMs === undefined ? {} : { cellYieldMs: agent.cellYieldMs }),
      ...(agent.escalateContextTokens === undefined
        ? {}
        : { escalateContextTokens: agent.escalateContextTokens }),
      ...(agent.escalateModel ? { escalateModel: agent.escalateModel } : {}),
      ...(agent.escalateToolErrors === undefined
        ? {}
        : { escalateToolErrors: agent.escalateToolErrors }),
      ...(agent.foldFinish ? { foldFinish: true as const } : {}),
      id: agent.id,
      ...(agent.lateFinishCheckMs === undefined
        ? {}
        : { lateFinishCheckMs: agent.lateFinishCheckMs }),
      ...(agent.lazy ? { lazy: true as const } : {}),
      ...(agent.leanCells ? { leanCells: true as const } : {}),
      ...(agent.lowEffortRounds ? { lowEffortRounds: true as const } : {}),
      model: agent.model,
      ...(agent.orchestration ? { orchestration: agent.orchestration } : {}),
      ...(agent.preflight ? { preflight: true as const } : {}),
      provider,
      ...(agent.refusalFallback ? { refusalFallback: agent.refusalFallback } : {}),
      ...(agent.resultEffort ? { resultEffort: agent.resultEffort } : {}),
      ...(agent.skipFinishCheck ? { skipFinishCheck: true as const } : {}),
      ...(agent.stopAtTarget ? { stopAtTarget: true as const } : {}),
      ...(agent.thinking ? { thinking: agent.thinking } : {}),
      ...(agent.toolResultTokens === undefined ? {} : { toolResultTokens: agent.toolResultTokens }),
      ...(agent.yieldFloorMs === undefined ? {} : { yieldFloorMs: agent.yieldFloorMs }),
      ...(agent.yieldShare === undefined ? {} : { yieldShare: agent.yieldShare }),
    }
  })
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length)
    fail('agent ids must be unique')
  if (agents.some((agent) => agent.provider === 'oracle') && agents.length > 1)
    fail('an oracle run has the oracle as its only agent')

  let judge: Judge | undefined
  if (config.judge !== undefined) {
    if (typeof config.judge?.model !== 'string' || !config.judge.model)
      fail('the judge names no model')
    if (config.judge.thinking !== undefined) choice(config.judge.thinking, 'thinking', thinking)
    judge = {
      model: config.judge.model,
      provider: choice(config.judge.provider, 'judge.provider', ['claude', 'codex']),
      ...(config.judge.thinking ? { thinking: config.judge.thinking } : {}),
    }
  }

  const payer =
    config.payer === undefined ? 'deployment' : choice<Payer>(config.payer, 'payer', payers)
  const unpaid =
    payer === 'plan'
      ? [
          ...agents,
          ...(judge ? [{ id: 'the judge', provider: judge.provider as string }] : []),
        ].find((agent) => agent.provider !== 'claude' && agent.provider !== 'oracle')
      : undefined
  if (unpaid)
    fail(
      'payer plan pays for claude sessions with the Claude plan signed in on the Worker, and ' +
        unpaid.id +
        ' is ' +
        unpaid.provider,
    )

  if (typeof config.eval?.name !== 'string') fail('eval names the imported eval to run')
  const reference = Eval.reference(
    config.eval.name + (config.eval.version ? '@' + config.eval.version : ''),
  )
  if (
    config.only !== undefined &&
    (!Array.isArray(config.only) || config.only.some((id) => typeof id !== 'string'))
  )
    fail('only is a list of task ids')

  const sandbox = config.sandbox ?? fail('sandbox is required')
  const backend = choice<Backend>(sandbox.backend, 'sandbox.backend', ['auto', 'dir', 'krun', 'ns'])
  const networks = Slot.networks[backend === 'auto' ? 'krun' : backend]
  if (!networks.includes(sandbox.network))
    fail('sandbox.network of the ' + backend + ' backend is ' + networks.join(' or '))
  if (sandbox.verifierCache !== undefined && typeof sandbox.verifierCache !== 'boolean')
    fail('sandbox.verifierCache is true or false')
  if (sandbox.verifierCache && backend === 'dir')
    fail('sandbox.verifierCache needs the krun or the ns backend')
  if (
    config.key !== undefined &&
    (typeof config.key !== 'object' ||
      config.key === null ||
      (config.key.deposit === undefined && config.key.topUp === undefined) ||
      (config.key.deposit !== undefined &&
        !(typeof config.key.deposit === 'number' && config.key.deposit > 0)) ||
      (config.key.topUp !== undefined &&
        !(typeof config.key.topUp === 'number' && config.key.topUp >= 0)))
  )
    fail('key holds a deposit above zero, a topUp of at least zero, or both')
  const budget = config.budget ?? fail('budget is required')
  const limits = config.limits ?? fail('limits is required')
  if (limits.noDeadline !== undefined && typeof limits.noDeadline !== 'boolean')
    fail('limits.noDeadline is true or false')
  if (sandbox.leaseSec !== undefined && !(sandbox.leaseSec >= limits.leaseSec))
    fail('sandbox.leaseSec is at least limits.leaseSec, the notice a renewal is given')
  return {
    agents,
    attempts: integer(config.attempts, 'attempts', 1),
    budget: {
      ...(budget.modelUsd === undefined
        ? {}
        : { modelUsd: amount(budget.modelUsd, 'budget.modelUsd') }),
      sandboxUsd: amount(budget.sandboxUsd, 'budget.sandboxUsd'),
    },
    eval: reference,
    ...(judge ? { judge } : {}),
    ...(config.key === undefined
      ? {}
      : {
          key: {
            ...(config.key.deposit === undefined ? {} : { deposit: config.key.deposit }),
            ...(config.key.topUp === undefined ? {} : { topUp: config.key.topUp }),
          },
        }),
    ...(config.limit === undefined ? {} : { limit: integer(config.limit, 'limit', 1) }),
    limits: {
      ...(limits.agentMaxSec === undefined
        ? {}
        : { agentMaxSec: integer(limits.agentMaxSec, 'limits.agentMaxSec', 1) }),
      attachSec: integer(limits.attachSec, 'limits.attachSec', 1),
      claims: integer(limits.claims, 'limits.claims', 1),
      leaseSec: integer(limits.leaseSec, 'limits.leaseSec', 1),
      ...(limits.noDeadline ? { noDeadline: true as const } : {}),
      setupSec: integer(limits.setupSec, 'limits.setupSec', 1),
      stepRetries: integer(limits.stepRetries, 'limits.stepRetries', 0),
      ...(limits.verifierMaxSec === undefined
        ? {}
        : { verifierMaxSec: integer(limits.verifierMaxSec, 'limits.verifierMaxSec', 1) }),
    },
    name: config.name,
    ...(config.only?.length ? { only: [...config.only] } : {}),
    ...(config.paces === undefined
      ? {}
      : {
          paces: Object.fromEntries(
            Object.entries(
              typeof config.paces === 'object' && config.paces !== null
                ? config.paces
                : fail('paces holds the requests a minute of each model it names'),
            ).map(([model, perMin]) => [
              agents.some((agent) => agent.model === model) || judge?.model === model
                ? model
                : fail('paces names ' + model + ', the model of no agent and no judge of the run'),
              Pace.valid(perMin)
                ? perMin
                : fail('paces.' + model + ' is the requests a minute of the model, above zero'),
            ]),
          ),
        }),
    ...(payer === 'plan' ? { payer } : {}),
    ...(config.prices === undefined
      ? {}
      : {
          prices: Object.fromEntries(
            Object.entries(
              typeof config.prices === 'object' && config.prices !== null
                ? config.prices
                : fail('prices holds a price for each model it names'),
            ).map(([model, price]) => [
              model,
              {
                cachedUsd: amount(price?.cachedUsd, 'prices.' + model + '.cachedUsd'),
                inputUsd: amount(price?.inputUsd, 'prices.' + model + '.inputUsd'),
                outputUsd: amount(price?.outputUsd, 'prices.' + model + '.outputUsd'),
                ...(price?.writeUsd === undefined
                  ? {}
                  : {
                      writeUsd: {
                        fiveMinutes: amount(
                          price.writeUsd?.fiveMinutes,
                          'prices.' + model + '.writeUsd.fiveMinutes',
                        ),
                        oneHour: amount(
                          price.writeUsd?.oneHour,
                          'prices.' + model + '.writeUsd.oneHour',
                        ),
                      },
                    }),
              },
            ]),
          ),
        }),
    ...(config.rerun === undefined
      ? {}
      : {
          rerun: {
            run:
              typeof config.rerun?.run === 'string' && /^[0-9a-f-]{36}$/.test(config.rerun.run)
                ? config.rerun.run
                : fail('rerun.run is the id of a run'),
            select: choice(config.rerun.select, 'rerun.select', ['errored', 'failed', 'unpassed']),
          },
        }),
    sandbox: {
      backend,
      ...(sandbox.cpusPerThread === undefined
        ? {}
        : {
            cpusPerThread:
              sandbox.cpusPerThread === null ||
              (typeof sandbox.cpusPerThread === 'number' && sandbox.cpusPerThread > 0)
                ? sandbox.cpusPerThread
                : fail(
                    'sandbox.cpusPerThread is a number above 0, or null to count no vCPUs of rows',
                  ),
          }),
      disks: choice(sandbox.disks ?? 'keep', 'sandbox.disks', ['keep', 'remove']),
      ...(sandbox.freeDiskMb === undefined
        ? {}
        : { freeDiskMb: integer(sandbox.freeDiskMb, 'sandbox.freeDiskMb', 1) }),
      ...(sandbox.leaseSec === undefined
        ? {}
        : { leaseSec: integer(sandbox.leaseSec, 'sandbox.leaseSec', 1) }),
      max: integer(sandbox.max, 'sandbox.max', 0),
      ...(sandbox.memoryMb === undefined
        ? {}
        : { memoryMb: integer(sandbox.memoryMb, 'sandbox.memoryMb', 1) }),
      network: sandbox.network,
      pollMs: integer(sandbox.pollMs, 'sandbox.pollMs', 1),
      provider: choice(sandbox.provider, 'sandbox.provider', ['e2b', 'gateway', 'local']),
      ...(sandbox.runtime === undefined
        ? {}
        : {
            runtime: {
              bytes: integer(sandbox.runtime?.bytes, 'sandbox.runtime.bytes', 1),
              digest: /^[0-9a-f]{64}$/.test(String(sandbox.runtime?.digest))
                ? sandbox.runtime.digest
                : fail('sandbox.runtime.digest is a SHA-256 in hex'),
            },
          }),
      ...(sandbox.slots === undefined ? {} : { slots: integer(sandbox.slots, 'sandbox.slots', 1) }),
      ...(typeof sandbox.template === 'string' ? { template: sandbox.template } : {}),
      ...(sandbox.timeoutSec === undefined
        ? {}
        : { timeoutSec: integer(sandbox.timeoutSec, 'sandbox.timeoutSec', 1) }),
      ...(sandbox.verifierCache ? { verifierCache: true as const } : {}),
      ...(sandbox.warm === undefined
        ? {}
        : {
            warm: {
              idleSec: integer(sandbox.warm?.idleSec, 'sandbox.warm.idleSec', 1),
              usd: amount(sandbox.warm?.usd, 'sandbox.warm.usd'),
            },
          }),
    },
  }
}

export function check(config: Config, tasks: readonly Eval.Task[]): void {
  const fail = (message: string): never => {
    throw new InvalidError(message)
  }
  if (!tasks.length) fail('the run selects no task')
  if (new Set(tasks.map((task) => task.name)).size !== tasks.length)
    fail('task names must be unique')
  const wanted = kind(config.sandbox.backend)
  const solved = oracle(config) !== undefined
  for (const task of tasks) {
    const offline = Eval.offline(task)
    if (
      offline.length &&
      !(config.sandbox.backend === 'krun' && config.sandbox.network === 'private')
    )
      throw new UnsupportedError(
        task.name +
          ' closes the network of its ' +
          offline.join(' and its ') +
          ', which only krun slots on a private network enforce',
      )
    if (task.environment.kind !== wanted)
      fail(
        task.name +
          ' was imported with a ' +
          task.environment.kind +
          ' environment, and the ' +
          config.sandbox.backend +
          ' backend runs ' +
          wanted +
          ' environments: ' +
          (task.environment.kind === 'dir'
            ? 'run it with --backend dir, or import it again without --backend dir on a machine that builds disks'
            : 'run it on krun or ns slots, or import it again with --backend dir'),
      )
    if (solved && !task.solution) fail(task.name + ' carries no solution for the oracle')
    if (task.verifier.judge && !config.judge)
      fail(task.name + ' is graded by a model: the run must name a judge')
  }
}
