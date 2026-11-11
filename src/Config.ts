import * as Eval from './Eval.ts'
import type * as Ledger from './Ledger.ts'
import * as Slot from './Slot.ts'

export class InvalidError extends Error {
  override name = 'Config.InvalidError'
}

export class UnsupportedError extends Error {
  override name = 'Config.UnsupportedError'
}

export type Agent = {
  id: string
  model: string
  provider: 'claude' | 'codex' | 'oracle'
  thinking?: string
}

export type Judge = {
  model: string
  provider: 'claude' | 'codex'
  thinking?: string
}

export type Config = {
  agents: readonly Agent[]
  attempts: number
  budget: { modelUsd?: number; sandboxUsd: number }
  eval: Eval.Reference
  judge?: Judge
  limit?: number
  limits: {
    attachSec: number
    claims: number
    leaseSec: number
    setupSec: number
    stepRetries: number
  }
  name: string
  only?: readonly string[]
  rerun?: { run: string; select: Ledger.Selection }
  sandbox: {
    backend: Slot.Backend
    disks: 'keep' | 'remove'
    freeDiskMb?: number
    max: number
    memoryMb?: number
    network: Slot.Network
    pollMs: number
    provider: 'e2b' | 'local'
    slots: number
    template?: string
    timeoutSec: number
  }
}

export type Runner = {
  backend: Slot.Backend
  disks: 'keep' | 'remove'
  freeDiskMb?: number
  leaseSec: number
  limits: { attachSec: number; setupSec: number; stepRetries: number }
  memoryMb?: number
  network: Slot.Network
  oracle: boolean
  pollMs: number
  run: string
  runner: number
  slots: number
  token: string
  url: string
}

const thinking = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

export function network(sandbox: Pick<Config['sandbox'], 'backend'>): Slot.Network {
  return sandbox.backend === 'dir' ? 'host' : 'private'
}

export function oracle(config: Pick<Config, 'agents'>): Agent | undefined {
  return config.agents.find((agent) => agent.provider === 'oracle')
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
    return {
      id: agent.id,
      model: agent.model,
      provider: choice(agent.provider, 'provider', ['claude', 'codex', 'oracle']),
      ...(agent.thinking ? { thinking: agent.thinking } : {}),
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
  const backend = choice(sandbox.backend, 'sandbox.backend', ['dir', 'krun'])
  if (!Slot.networks[backend].includes(sandbox.network))
    fail('sandbox.network of the ' + backend + ' backend is ' + Slot.networks[backend].join(' or '))
  const budget = config.budget ?? fail('budget is required')
  const limits = config.limits ?? fail('limits is required')
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
    ...(config.limit === undefined ? {} : { limit: integer(config.limit, 'limit', 1) }),
    limits: {
      attachSec: integer(limits.attachSec, 'limits.attachSec', 1),
      claims: integer(limits.claims, 'limits.claims', 1),
      leaseSec: integer(limits.leaseSec, 'limits.leaseSec', 1),
      setupSec: integer(limits.setupSec, 'limits.setupSec', 1),
      stepRetries: integer(limits.stepRetries, 'limits.stepRetries', 0),
    },
    name: config.name,
    ...(config.only?.length ? { only: [...config.only] } : {}),
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
      disks: choice(sandbox.disks ?? 'keep', 'sandbox.disks', ['keep', 'remove']),
      ...(sandbox.freeDiskMb === undefined
        ? {}
        : { freeDiskMb: integer(sandbox.freeDiskMb, 'sandbox.freeDiskMb', 1) }),
      max: integer(sandbox.max, 'sandbox.max', 0),
      ...(sandbox.memoryMb === undefined
        ? {}
        : { memoryMb: integer(sandbox.memoryMb, 'sandbox.memoryMb', 1) }),
      network: sandbox.network,
      pollMs: integer(sandbox.pollMs, 'sandbox.pollMs', 1),
      provider: choice(sandbox.provider, 'sandbox.provider', ['e2b', 'local']),
      slots: integer(sandbox.slots, 'sandbox.slots', 1),
      ...(typeof sandbox.template === 'string' ? { template: sandbox.template } : {}),
      timeoutSec: integer(sandbox.timeoutSec, 'sandbox.timeoutSec', 1),
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
  const kind = config.sandbox.backend === 'krun' ? 'disk' : 'dir'
  const solved = oracle(config) !== undefined
  for (const task of tasks) {
    if (!task.network.allowInternet)
      throw new UnsupportedError(
        task.name + ' sets allow_internet = false, which no slot backend enforces yet',
      )
    if (task.environment.kind !== kind)
      fail(
        task.name +
          ' was imported with a ' +
          task.environment.kind +
          ' environment, and the ' +
          config.sandbox.backend +
          ' backend runs ' +
          kind +
          ' environments',
      )
    if (solved && !task.solution) fail(task.name + ' carries no solution for the oracle')
    if (task.verifier.judge && !config.judge)
      fail(task.name + ' is graded by a model: the run must name a judge')
  }
}
