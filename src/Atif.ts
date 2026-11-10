export type SessionEvent = {
  created_at: number
  event: {
    event?: { payload: Record<string, any>; type: string }
    source?: string
    type?: string
  }
  request_id: string
  seq: number
}

export type Trajectory = {
  schema_version: 'ATIF-v1.7'
  session_id: string
  agent: { name: string; version: string; model_name: string; extra: Record<string, unknown> }
  steps: Step[]
  final_metrics: {
    total_prompt_tokens: number
    total_completion_tokens: number
    total_cached_tokens: number
    total_cost_usd?: number
    total_steps: number
    extra: { cache_write_input_tokens: number; model_calls: number; tool_calls: number }
  }
}

export type Step = {
  step_id: number
  timestamp: string
  source: 'agent' | 'user'
  model_name?: string
  message: string
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
  arguments: unknown
  extra?: { parent_call_id: string }
}

export type Observation = {
  source_call_id: string
  content: string
  extra: { duration_ns: number | null; status: string }
}

export type Usage = {
  cacheWriteTokens: number
  cachedTokens: number
  costUsd: number | undefined
  inputTokens: number
  modelCalls: number
  outputTokens: number
  toolCalls: number
}

export function fromEvents(
  events: readonly SessionEvent[],
  options: fromEvents.Options,
): Trajectory {
  const steps: Step[] = []
  const totals = usage(events)
  let model = options.model
  let session = ''
  let extra: Record<string, unknown> = {}
  let current: Step | undefined

  const agentStep = (at: number): Step => {
    if (!current) {
      current = { step_id: steps.length + 1, timestamp: iso(at), source: 'agent', message: '' }
      steps.push(current)
    }
    return current
  }

  for (const entry of events) {
    const event = entry.event.event
    if (entry.event.source !== 'agent' || !event) continue
    const payload = event.payload

    switch (event.type) {
      case 'input.accepted':
        session = String(payload['session_id'] ?? session)
        steps.push({
          step_id: steps.length + 1,
          timestamp: iso(entry.created_at),
          source: 'user',
          message: String(payload['input'] ?? ''),
        })
        current = undefined
        break
      case 'run.started':
        model = String(payload['model'] ?? model)
        extra = { orchestration: payload['orchestration'], transport: payload['transport'] }
        break
      case 'model.call.completed': {
        current = undefined
        const step = agentStep(entry.created_at)
        const used = payload['usage'] ?? {}
        const details = used['input_tokens_details'] ?? {}
        step.model_name = String(payload['model'] ?? model)
        step.metrics = {
          prompt_tokens: count(used['input_tokens']),
          completion_tokens: count(used['output_tokens']),
          cached_tokens: count(details['cached_tokens']),
          extra: {
            attempt: payload['attempt'],
            cache_write_input_tokens: count(details['cache_write_tokens']),
            call_index: payload['call_index'],
            duration_ns: payload['duration_ns'],
            status: payload['status'],
            time_to_first_event_ns: payload['time_to_first_event_ns'],
            time_to_first_output_ns: payload['time_to_first_output_ns'],
          },
        }
        break
      }
      case 'assistant.message': {
        const step = agentStep(entry.created_at)
        const text = String(payload['text'] ?? '')
        step.message = step.message ? step.message + '\n' + text : text
        break
      }
      case 'tool.call': {
        const step = agentStep(entry.created_at)
        step.tool_calls ??= []
        step.tool_calls.push({
          tool_call_id: String(payload['call_id']),
          function_name: String(payload['tool']),
          arguments: payload['arguments'] ?? {},
          ...(payload['parent_call_id']
            ? { extra: { parent_call_id: String(payload['parent_call_id']) } }
            : {}),
        })
        break
      }
      case 'tool.result': {
        const step = agentStep(entry.created_at)
        step.observation ??= { results: [] }
        step.observation.results.push({
          source_call_id: String(payload['call_id']),
          content: content(payload['result']),
          extra: {
            duration_ns: typeof payload['duration_ns'] === 'number' ? payload['duration_ns'] : null,
            status: String(payload['status'] ?? ''),
          },
        })
        break
      }
    }
  }

  return {
    schema_version: 'ATIF-v1.7',
    session_id: session || options.session,
    agent: { name: options.name, version: options.version, model_name: model, extra },
    steps,
    final_metrics: {
      total_prompt_tokens: totals.inputTokens,
      total_completion_tokens: totals.outputTokens,
      total_cached_tokens: totals.cachedTokens,
      ...(totals.costUsd === undefined ? {} : { total_cost_usd: totals.costUsd }),
      total_steps: steps.length,
      extra: {
        cache_write_input_tokens: totals.cacheWriteTokens,
        model_calls: totals.modelCalls,
        tool_calls: totals.toolCalls,
      },
    },
  }
}

export declare namespace fromEvents {
  type Options = {
    model: string
    name: string
    session: string
    version: string
  }
}

export function usage(events: readonly SessionEvent[]): Usage {
  const totals: Usage = {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    costUsd: undefined,
    inputTokens: 0,
    modelCalls: 0,
    outputTokens: 0,
    toolCalls: 0,
  }
  for (const entry of events) {
    const event = entry.event.event
    if (entry.event.source !== 'agent' || !event) continue
    const payload = event.payload

    if (event.type === 'model.call.completed') {
      const used = payload['usage'] ?? {}
      const details = used['input_tokens_details'] ?? {}
      totals.modelCalls++
      totals.inputTokens += count(used['input_tokens'])
      totals.outputTokens += count(used['output_tokens'])
      totals.cachedTokens += count(details['cached_tokens'])
      totals.cacheWriteTokens += count(details['cache_write_tokens'])
    }
    if (event.type === 'tool.call') totals.toolCalls++
    if (
      (event.type === 'run.completed' || event.type === 'run.failed') &&
      typeof payload['cost_usd'] === 'number'
    )
      totals.costUsd = (totals.costUsd ?? 0) + payload['cost_usd']
  }
  return totals
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
