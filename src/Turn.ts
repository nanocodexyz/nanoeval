import type * as Config from './Config.ts'

export type Turn = {
  briefFinal?: true
  briefFinish?: true
  cellYieldMs?: number
  compactInstructions?: true
  contextWindow?: number
  deadline?: { atMs: number; limitMs: number }
  escalateContextTokens?: number
  escalateModel?: string
  escalateToolErrors?: number
  foldFinish?: true
  hand?: string
  lateFinishCheckMs?: number
  leanCells?: true
  leanToolArguments?: true
  lenientPatches?: true
  lowEffortRounds?: true
  maxOutputTokens?: number
  minWaitMs?: number
  model: string
  orchestration?: 'direct' | 'jobs'
  payer?: Config.Payer
  persistFinish?: true
  prompt: string
  provider: 'claude' | 'codex'
  refusalFallback?: Config.RefusalFallback
  requestId: string
  resultEffort?: Config.Effort
  skipFinishCheck?: true
  stopAtTarget?: true
  thinking?: string
  toolResultTokens?: number
  yieldFloorMs?: number
  yieldShare?: number
}

export const record = 'agent/turns.jsonl'

function levers(turn: Turn): Record<string, true> {
  return {
    ...(turn.briefFinal ? { brief_final: true as const } : {}),
    ...(turn.briefFinish ? { brief_finish: true as const } : {}),
    ...(turn.foldFinish ? { fold_finish: true as const } : {}),
    ...(turn.leanCells ? { lean_cells: true as const } : {}),
    ...(turn.lowEffortRounds ? { low_effort_rounds: true as const } : {}),
    ...(turn.persistFinish ? { persist_finish: true as const } : {}),
    ...(turn.skipFinishCheck ? { skip_finish_check: true as const } : {}),
    ...(turn.stopAtTarget ? { stop_at_target: true as const } : {}),
  }
}

function losses(turn: Turn): Record<string, number | string> {
  return {
    ...(turn.lateFinishCheckMs === undefined
      ? {}
      : { late_finish_check_ms: turn.lateFinishCheckMs }),
    ...(turn.resultEffort ? { result_effort: turn.resultEffort } : {}),
    ...(turn.yieldFloorMs === undefined ? {} : { yield_floor_ms: turn.yieldFloorMs }),
    ...(turn.yieldShare === undefined ? {} : { yield_share: turn.yieldShare }),
  }
}

export function codexOptions(turn: Turn): Record<string, number | true> {
  if (turn.provider !== 'codex') return {}
  return {
    ...(turn.compactInstructions ? { compact_instructions: true as const } : {}),
    ...(turn.contextWindow === undefined ? {} : { context_window: turn.contextWindow }),
    ...(turn.leanToolArguments ? { lean_tool_arguments: true as const } : {}),
    ...(turn.lenientPatches ? { lenient_patches: true as const } : {}),
    ...(turn.maxOutputTokens === undefined ? {} : { max_output_tokens: turn.maxOutputTokens }),
    ...(turn.minWaitMs === undefined ? {} : { min_wait_ms: turn.minWaitMs }),
  }
}

function escalate(turn: Turn): { escalate?: Record<string, number | string> } {
  const named = {
    ...(turn.escalateContextTokens === undefined
      ? {}
      : { context_tokens: turn.escalateContextTokens }),
    ...(turn.escalateModel === undefined ? {} : { model: turn.escalateModel }),
    ...(turn.escalateToolErrors === undefined ? {} : { tool_errors: turn.escalateToolErrors }),
  }
  return Object.keys(named).length ? { escalate: named } : {}
}

export function deadline(
  limits: Pick<Config.Config['limits'], 'noDeadline'>,
  input: { limitMs: number; now: number },
): Turn['deadline'] {
  return limits.noDeadline ? undefined : { atMs: input.now + input.limitMs, limitMs: input.limitMs }
}

export function sent(turn: Turn, input: { at: number; session: string }): string {
  return (
    JSON.stringify({
      at_ms: input.at,
      ...levers(turn),
      ...(turn.cellYieldMs === undefined ? {} : { cell_yield_ms: turn.cellYieldMs }),
      ...codexOptions(turn),
      deadline: turn.deadline
        ? { at_ms: turn.deadline.atMs, limit_ms: turn.deadline.limitMs }
        : null,
      ...escalate(turn),
      ...losses(turn),
      ...(turn.refusalFallback ? { refusal_fallback: turn.refusalFallback } : {}),
      request_id: turn.requestId,
      session: input.session,
      ...(turn.toolResultTokens === undefined ? {} : { tool_result_tokens: turn.toolResultTokens }),
    }) + '\n'
  )
}

export function body(turn: Turn): Record<string, unknown> {
  return {
    ...levers(turn),
    ...codexOptions(turn),
    ...(turn.hand ? { hand: turn.hand } : {}),
    ...(turn.orchestration && turn.provider === 'claude'
      ? { claude_orchestration: turn.orchestration }
      : {}),
    ...(turn.orchestration && turn.provider === 'codex'
      ? { codex_orchestration: turn.orchestration }
      : {}),
    ...(turn.deadline
      ? { deadline: { at_ms: turn.deadline.atMs, limit_ms: turn.deadline.limitMs } }
      : {}),
    ...escalate(turn),
    ...losses(turn),
    model: turn.model,
    ...(turn.payer ? { payer: turn.payer } : {}),
    prompt: turn.prompt,
    provider: turn.provider,
    ...(turn.refusalFallback ? { refusal_fallback: turn.refusalFallback } : {}),
    request_id: turn.requestId,
    ...(turn.provider === 'codex' ? { subagents: false } : {}),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...(turn.toolResultTokens === undefined ? {} : { tool_result_tokens: turn.toolResultTokens }),
    ...(turn.provider === 'codex' ? { web_search: false } : {}),
  }
}
