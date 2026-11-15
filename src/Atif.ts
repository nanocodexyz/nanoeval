export type AgentEvent = { payload: Record<string, any>; type: string }

export type SessionEvent = {
  created_at: number
  event: {
    event?: AgentEvent
    source?: string
    type?: string
    update?: {
      agent?: { id?: number; parent?: number | null; role?: string; session_id?: string }
      event?: AgentEvent
      id?: number
      parent?: number | null
      type?: string
    }
  }
  request_id: string
  seq: number
}

export type Trajectory = {
  schema_version: 'ATIF-v1.7'
  session_id: string
  trajectory_id?: string
  agent: { name: string; version: string; model_name: string; extra: Record<string, unknown> }
  steps: Step[]
  notes?: string
  final_metrics: {
    total_prompt_tokens: number
    total_completion_tokens: number
    total_cached_tokens: number
    total_cost_usd?: number
    total_steps: number
    extra: {
      cache_write_input_tokens: number
      model_calls: number
      reasoning_tokens?: number
      subagents?: number
      tool_calls: number
    }
  }
  subagent_trajectories?: Trajectory[]
}

export type Step = {
  step_id: number
  timestamp?: string
  source: 'agent' | 'system' | 'user'
  model_name?: string
  message: string
  reasoning_content?: string
  tool_calls?: ToolCall[]
  observation?: { results: Observation[] }
  metrics?: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens: number
    extra: Record<string, unknown>
  }
}

export type ToolCall = {
  tool_call_id: string
  function_name: string
  arguments: Record<string, unknown>
  extra?: { parent_call_id: string }
}

export type Observation = {
  source_call_id: string
  content: string
  subagent_trajectory_ref?: { trajectory_id: string }[]
  extra: { duration_ns: number | null; exit_code?: number; status: string }
}

export type Usage = {
  cacheWriteHourTokens?: number
  cacheWriteTokens: number
  cachedTokens: number
  costBy?: 'list'
  costUsd: number | undefined
  inputTokens: number
  modelCalls: number
  outputTokens: number
  reasoningTokens?: number
  toolCalls: number
  toolsUsd?: number
  unmeteredRequests?: number
}

type Thread = {
  accepted: Set<string>
  calls: Map<string, Step>
  costs: Map<string, number>
  current: Step | undefined
  extra: Record<string, unknown>
  held: Map<number, string>
  id: number | undefined
  index: number | undefined
  latest: Step | undefined
  model: string | undefined
  parent: number | undefined
  request: string | undefined
  role: string | undefined
  session: string
  spawned: Map<number, Observation>
  steps: Step[]
  unpriced: number
  usage: Usage
}

type Threads = { agents: Map<number, Thread>; root: Thread }

const spawn = 'spawn_agent'

export function fromEvents(
  events: readonly SessionEvent[],
  options: fromEvents.Options,
): Trajectory {
  const threads = read(events)
  return project(threads.root, { options, threads })
}

export declare namespace fromEvents {
  type Options = {
    model: string
    name: string
    session: string
    version: string
  }
}

export function sum(usages: readonly Usage[]): Usage {
  const total = none()
  for (const usage of usages) {
    if (usage.cacheWriteHourTokens)
      total.cacheWriteHourTokens = (total.cacheWriteHourTokens ?? 0) + usage.cacheWriteHourTokens
    total.cacheWriteTokens += usage.cacheWriteTokens
    total.cachedTokens += usage.cachedTokens
    if (usage.costBy) total.costBy = usage.costBy
    if (usage.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + usage.costUsd
    total.inputTokens += usage.inputTokens
    total.modelCalls += usage.modelCalls
    total.outputTokens += usage.outputTokens
    if (usage.reasoningTokens !== undefined)
      total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens
    total.toolCalls += usage.toolCalls
    if (usage.unmeteredRequests)
      total.unmeteredRequests = (total.unmeteredRequests ?? 0) + usage.unmeteredRequests
  }
  return total
}

export function usage(events: readonly SessionEvent[]): Usage {
  const threads = read(events)
  return whole(threads.root, threads)
}

function none(): Usage {
  return {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    costUsd: undefined,
    inputTokens: 0,
    modelCalls: 0,
    outputTokens: 0,
    toolCalls: 0,
  }
}

function thread(id: number | undefined): Thread {
  return {
    accepted: new Set(),
    calls: new Map(),
    costs: new Map(),
    current: undefined,
    extra: {},
    held: new Map(),
    id,
    index: undefined,
    latest: undefined,
    model: undefined,
    parent: undefined,
    request: undefined,
    role: undefined,
    session: '',
    spawned: new Map(),
    steps: [],
    unpriced: 0,
    usage: none(),
  }
}

function read(events: readonly SessionEvent[]): Threads {
  const root = thread(undefined)
  const agents = new Map<number, Thread>()
  const agent = (id: number): Thread => {
    const found = agents.get(id) ?? thread(id)
    agents.set(id, found)
    return found
  }
  for (const entry of events) {
    const { event, source, update } = entry.event
    if (source === 'agent' && event) apply(root, { at: entry.created_at, event })
    if (source !== 'subagent' || !update) continue
    if (update.type === 'added' && typeof update.agent?.id === 'number') {
      const added = agent(update.agent.id)
      added.parent = update.agent.parent ?? undefined
      added.role = update.agent.role
      added.session ||= update.agent.session_id ?? ''
    }
    if (update.type === 'event' && typeof update.id === 'number' && update.event) {
      const child = agent(update.id)
      child.parent = update.parent ?? undefined
      apply(child, { at: entry.created_at, event: update.event })
    }
  }
  const last = events.at(-1)?.created_at ?? 0
  for (const open of [root, ...agents.values()]) flush(open, last)
  return { agents, root }
}

function agentStep(thread: Thread, at: number): Step {
  thread.current ??= thread.latest
  if (!thread.current) {
    thread.current = {
      step_id: thread.steps.length + 1,
      timestamp: iso(at),
      source: 'agent',
      message: '',
    }
    thread.steps.push(thread.current)
  }
  return thread.current
}

function say(step: Step, text: string): void {
  step.message = step.message ? step.message + '\n' + text : text
}

function flush(thread: Thread, at: number): void {
  for (const text of thread.held.values()) say(agentStep(thread, at), text)
  thread.held.clear()
}

function apply(thread: Thread, entry: { at: number; event: AgentEvent }): void {
  const { at, event } = entry
  const payload = event.payload

  switch (event.type) {
    case 'input.accepted': {
      flush(thread, at)
      if (payload['kind'] === 'prompt' && typeof payload['request_id'] === 'string')
        thread.request = payload['request_id']
      const item =
        payload['kind'] === 'prompt' && typeof payload['request_id'] === 'string'
          ? payload['request_id'] + ':prompt'
          : payload['item_id']
      if (typeof item === 'string') {
        if (thread.accepted.has(item)) break
        thread.accepted.add(item)
      }
      thread.session = String(payload['session_id'] ?? thread.session)
      thread.steps.push({
        step_id: thread.steps.length + 1,
        timestamp: iso(at),
        source: 'user',
        message: String(payload['input'] ?? ''),
      })
      thread.current = undefined
      break
    }
    case 'run.started':
      flush(thread, at)
      thread.index = undefined
      thread.model = String(payload['model'] ?? thread.model)
      thread.extra = { orchestration: payload['orchestration'], transport: payload['transport'] }
      break
    case 'model.call.completed': {
      if (typeof payload['call_index'] === 'number') thread.index = payload['call_index']
      if (payload['timing']?.replayed === true) break
      const used = payload['usage'] ?? {}
      const details = used['input_tokens_details'] ?? {}
      const reasoning = used['output_tokens_details']?.['reasoning_tokens']
      const totals = thread.usage
      totals.modelCalls++
      totals.inputTokens += count(used['input_tokens'])
      totals.outputTokens += count(used['output_tokens'])
      totals.cachedTokens += count(details['cached_tokens'])
      totals.cacheWriteTokens += count(details['cache_write_tokens'])
      if (typeof reasoning === 'number')
        totals.reasoningTokens = (totals.reasoningTokens ?? 0) + count(reasoning)
      thread.unpriced++
      thread.current = undefined
      thread.latest = undefined
      const step = agentStep(thread, at)
      thread.latest = step
      step.message = thread.held.get(payload['call_index']) ?? ''
      thread.held.delete(payload['call_index'])
      step.model_name = String(payload['model'] ?? thread.model)
      step.metrics = {
        prompt_tokens: count(used['input_tokens']),
        completion_tokens: count(used['output_tokens']),
        cached_tokens: count(details['cached_tokens']),
        extra: {
          attempt: payload['attempt'],
          cache_write_input_tokens: count(details['cache_write_tokens']),
          call_index: payload['call_index'],
          duration_ns: payload['duration_ns'],
          ...(typeof reasoning === 'number' ? { reasoning_tokens: reasoning } : {}),
          status: payload['status'],
          time_to_first_event_ns: payload['time_to_first_event_ns'],
          time_to_first_output_ns: payload['time_to_first_output_ns'],
        },
      }
      break
    }
    case 'assistant.message': {
      const text = String(payload['text'] ?? '')
      const index = payload['model_call_index']
      if (typeof index === 'number' && (thread.index === undefined || index > thread.index)) {
        const held = thread.held.get(index)
        thread.held.set(index, held === undefined ? text : held + '\n' + text)
        break
      }
      say(agentStep(thread, at), text)
      break
    }
    case 'tool.call': {
      if (thread.calls.has(String(payload['call_id']))) break
      const step = agentStep(thread, at)
      thread.calls.set(String(payload['call_id']), step)
      thread.usage.toolCalls++
      step.tool_calls ??= []
      step.tool_calls.push({
        tool_call_id: String(payload['call_id']),
        function_name: String(payload['tool']),
        arguments: argumentsOf(payload['arguments']),
        ...(payload['parent_call_id']
          ? { extra: { parent_call_id: String(payload['parent_call_id']) } }
          : {}),
      })
      break
    }
    case 'tool.result': {
      const step = thread.calls.get(String(payload['call_id'])) ?? agentStep(thread, at)
      const result: Observation = {
        source_call_id: String(payload['call_id']),
        content: content(payload['result']),
        extra: {
          duration_ns: typeof payload['duration_ns'] === 'number' ? payload['duration_ns'] : null,
          status: String(payload['status'] ?? ''),
        },
      }
      step.observation ??= { results: [] }
      step.observation.results.push(result)
      const spawned = payload['tool'] === spawn ? started(payload, result.content) : undefined
      if (spawned !== undefined) thread.spawned.set(spawned, result)
      break
    }
    case 'context.notice': {
      const role = payload['role']
      if ((role !== 'system' && role !== 'user') || typeof payload['text'] !== 'string') break
      const called = thread.steps.findLastIndex(
        (step) => step.metrics?.extra['call_index'] === payload['after_model_call_index'],
      )
      const next =
        called < 0
          ? -1
          : thread.steps.findIndex((step, index) => index > called && step.source === 'agent')
      const position = next < 0 ? thread.steps.length : next
      for (const later of thread.steps.slice(position)) later.step_id++
      thread.steps.splice(position, 0, {
        step_id: position + 1,
        timestamp: iso(at),
        source: role,
        message: payload['text'],
      })
      break
    }
    case 'run.completed':
    case 'run.failed':
      flush(thread, at)
      if (typeof payload['cost_usd'] !== 'number') break
      thread.costs.set(thread.request ?? '', payload['cost_usd'])
      thread.usage.costUsd = [...thread.costs.values()].reduce((total, cost) => total + cost, 0)
      thread.unpriced = 0
      break
  }
}

function started(payload: Record<string, any>, text: string): number | undefined {
  const structured = payload['structured_result']?.['agent_id']
  if (typeof structured === 'number') return structured
  const found = /"agent_id":\s*(\d+)/.exec(text)?.[1]
  return found === undefined ? undefined : Number(found)
}

function under(thread: Thread, threads: Threads): Thread[] {
  return [...threads.agents.values()].filter(
    (agent) =>
      (agent.parent !== undefined && agent.parent < agent.id! && threads.agents.has(agent.parent)
        ? agent.parent
        : undefined) === thread.id,
  )
}

function whole(thread: Thread, threads: Threads): Usage {
  const parts = [thread, ...under(thread, threads)].map((part) =>
    part === thread
      ? { unpriced: thread.unpriced > 0, usage: thread.usage }
      : { unpriced: false, usage: whole(part, threads) },
  )
  const total = sum(parts.map((part) => part.usage))
  const unknown = parts.some(
    (part) => part.unpriced || (part.usage.modelCalls > 0 && part.usage.costUsd === undefined),
  )
  return unknown ? { ...total, costUsd: undefined } : total
}

function project(
  thread: Thread,
  input: { options: fromEvents.Options; threads: Threads },
): Trajectory {
  const { options, threads } = input
  const children = under(thread, threads).filter((child) => child.steps.length > 0)
  const totals = whole(thread, threads)
  for (const child of children) {
    const result = thread.spawned.get(child.id!)
    if (result) result.subagent_trajectory_ref = [{ trajectory_id: name(child) }]
  }
  return {
    schema_version: 'ATIF-v1.7',
    session_id: thread.session || options.session,
    ...(thread.id === undefined ? {} : { trajectory_id: name(thread) }),
    agent: {
      name: options.name,
      version: options.version,
      model_name: thread.model ?? options.model,
      extra:
        thread.id === undefined
          ? thread.extra
          : { ...thread.extra, agent_id: thread.id, role: thread.role },
    },
    steps: thread.steps,
    ...(children.length
      ? {
          notes:
            'final_metrics counts the model calls, tokens, tool calls and cost of this agent and of the subagents under it, whose steps are in subagent_trajectories. total_steps counts the steps of this agent.',
        }
      : {}),
    final_metrics: {
      total_prompt_tokens: totals.inputTokens,
      total_completion_tokens: totals.outputTokens,
      total_cached_tokens: totals.cachedTokens,
      ...(totals.costUsd === undefined ? {} : { total_cost_usd: totals.costUsd }),
      total_steps: thread.steps.length,
      extra: {
        cache_write_input_tokens: totals.cacheWriteTokens,
        model_calls: totals.modelCalls,
        ...(totals.reasoningTokens === undefined
          ? {}
          : { reasoning_tokens: totals.reasoningTokens }),
        ...(children.length ? { subagents: children.length } : {}),
        tool_calls: totals.toolCalls,
      },
    },
    ...(children.length
      ? { subagent_trajectories: children.map((child) => project(child, input)) }
      : {}),
  }
}

function name(thread: Thread): string {
  return 'agent-' + thread.id
}

function content(result: unknown): string {
  if (typeof result === 'string') return result
  const value = result as { content_blocks?: { text?: unknown }[]; text?: unknown } | null
  if (typeof value?.text === 'string') return value.text
  if (Array.isArray(value?.content_blocks))
    return value.content_blocks
      .map((block) => (typeof block.text === 'string' ? block.text : JSON.stringify(block)))
      .join('')
  return JSON.stringify(result ?? null)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function argumentsOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return { input: value }
}
