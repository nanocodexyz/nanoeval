import * as Slot from './Slot.ts'
import * as Task from './Task.ts'

export class InvalidError extends Error {
  override name = 'Config.InvalidError'
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
  judge?: Judge
  limits: { attachSec: number; setupSec: number; stepRetries: number }
  name: string
  sandbox: {
    backend: Slot.Backend
    docker: 'install' | 'keep'
    freeDiskMb?: number
    images: 'keep' | 'remove'
    limits: 'enforce' | 'none'
    max: number
    memoryMb?: number
    network: Slot.Network
    provider: 'e2b' | 'local'
    slots: number
    template?: string
    timeoutSec: number
  }
  tasks: readonly Task.Task[]
}

const thinking = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

export function network(sandbox: Pick<Config['sandbox'], 'backend' | 'provider'>): Slot.Network {
  if (sandbox.backend === 'dir') return 'host'
  if (sandbox.provider === 'local') return 'private'
  return sandbox.backend === 'docker' ? 'bridge' : 'host'
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
      : fail(name + ' must be a nonnegative amount in USD')
  const choice = <const T extends string>(candidate: unknown, name: string, values: readonly T[]) =>
    values.includes(candidate as T)
      ? (candidate as T)
      : fail(name + ' must be one of ' + values.join(', '))

  if (typeof config !== 'object' || config === null) fail('the run configuration must be an object')
  if (typeof config.name !== 'string' || !config.name) fail('name must be a nonempty string')
  if (!Array.isArray(config.agents) || !config.agents.length)
    fail('agents must list at least one agent')
  if (!Array.isArray(config.tasks) || !config.tasks.length)
    fail('tasks must list at least one task')

  const agents = config.agents.map((agent): Agent => {
    if (typeof agent?.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(agent.id))
      fail('an agent id is 1 to 48 lowercase letters, digits, _ . or -')
    if (typeof agent.model !== 'string' || !agent.model)
      fail('agent ' + agent.id + ' names no model')
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

  const tasks = config.tasks.map((task) => Task.parse(task))
  if (new Set(tasks.map((task) => task.name)).size !== tasks.length)
    fail('task names must be unique')
  for (const task of tasks)
    if (!task.environment.allowInternet)
      throw new Task.UnsupportedError(
        task.name + ' sets allow_internet = false, which no slot backend enforces yet',
      )
  const oracle = agents.some((agent) => agent.provider === 'oracle')
  if (oracle && agents.length > 1) fail('an oracle run has the oracle as its only agent')
  for (const task of tasks)
    if (oracle !== (task.solution !== undefined))
      fail(
        oracle
          ? task.name + ' carries no solution for the oracle'
          : task.name + ' carries its solution, which only an oracle run may send',
      )

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
  for (const task of tasks)
    if (task.verifier.judge && !judge)
      fail(task.name + ' is graded by a model: the run must name a judge')

  const sandbox = config.sandbox ?? fail('sandbox is required')
  const backend = choice(sandbox.backend, 'sandbox.backend', ['dir', 'docker', 'krun'])
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
    ...(judge ? { judge } : {}),
    limits: {
      attachSec: integer(limits.attachSec, 'limits.attachSec', 1),
      setupSec: integer(limits.setupSec, 'limits.setupSec', 1),
      stepRetries: integer(limits.stepRetries, 'limits.stepRetries', 0),
    },
    name: config.name,
    sandbox: {
      backend,
      docker: choice(sandbox.docker, 'sandbox.docker', ['install', 'keep']),
      ...(sandbox.freeDiskMb === undefined
        ? {}
        : { freeDiskMb: integer(sandbox.freeDiskMb, 'sandbox.freeDiskMb', 1) }),
      images: choice(sandbox.images ?? 'keep', 'sandbox.images', ['keep', 'remove']),
      limits: choice(sandbox.limits, 'sandbox.limits', ['enforce', 'none']),
      max: integer(sandbox.max, 'sandbox.max', 1),
      ...(sandbox.memoryMb === undefined
        ? {}
        : { memoryMb: integer(sandbox.memoryMb, 'sandbox.memoryMb', 1) }),
      network: sandbox.network,
      provider: choice(sandbox.provider, 'sandbox.provider', ['e2b', 'local']),
      slots: integer(sandbox.slots, 'sandbox.slots', 1),
      ...(typeof sandbox.template === 'string' ? { template: sandbox.template } : {}),
      timeoutSec: integer(sandbox.timeoutSec, 'sandbox.timeoutSec', 1),
    },
    tasks,
  }
}
