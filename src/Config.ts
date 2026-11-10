import type * as Slot from './Slot.ts'
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

export type Config = {
  agents: readonly Agent[]
  attempts: number
  budget: { modelUsd?: number; sandboxUsd: number }
  limits: { attachSec: number; setupSec: number; stepRetries: number }
  name: string
  sandbox: {
    backend: Slot.Backend
    docker: 'install' | 'keep'
    limits: 'enforce' | 'none'
    max: number
    memoryMb?: number
    network: 'bridge' | 'host'
    provider: 'e2b' | 'local'
    slots: number
    template?: string
    timeoutSec: number
  }
  tasks: readonly Task.Task[]
}

const thinking = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

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

  const sandbox = config.sandbox ?? fail('sandbox is required')
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
    limits: {
      attachSec: integer(limits.attachSec, 'limits.attachSec', 1),
      setupSec: integer(limits.setupSec, 'limits.setupSec', 1),
      stepRetries: integer(limits.stepRetries, 'limits.stepRetries', 0),
    },
    name: config.name,
    sandbox: {
      backend: choice(sandbox.backend, 'sandbox.backend', ['dir', 'docker']),
      docker: choice(sandbox.docker, 'sandbox.docker', ['install', 'keep']),
      limits: choice(sandbox.limits, 'sandbox.limits', ['enforce', 'none']),
      max: integer(sandbox.max, 'sandbox.max', 1),
      ...(sandbox.memoryMb === undefined
        ? {}
        : { memoryMb: integer(sandbox.memoryMb, 'sandbox.memoryMb', 1) }),
      network: choice(sandbox.network, 'sandbox.network', ['bridge', 'host']),
      provider: choice(sandbox.provider, 'sandbox.provider', ['e2b', 'local']),
      slots: integer(sandbox.slots, 'sandbox.slots', 1),
      ...(typeof sandbox.template === 'string' ? { template: sandbox.template } : {}),
      timeoutSec: integer(sandbox.timeoutSec, 'sandbox.timeoutSec', 1),
    },
    tasks,
  }
}
