import type * as Config from './Config.ts'
import * as Installed from './Installed.ts'

export type Turn = {
  briefFinal?: true
  briefFinish?: true
  cellYieldMs?: number
  clearingCacheFloors?: true
  contextWindow?: number
  deadline?: { atMs: number; limitMs: number }
  escalateContextTokens?: number
  escalateModel?: string
  escalateToolErrors?: number
  finishAmbiguity?: true
  finishCheck?: true
  finishRetries?: number
  foldFinish?: true
  hand?: string
  lateFinishCheckMs?: number
  leanCells?: true
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
  subagents?: false
  thinking?: string
  toolResultClearing?: Config.ToolResultClearing
  toolResultTokens?: number
  webSearch?: false
  yieldFloorMs?: number
  yieldShare?: number
}

export const record = 'agent/turns.jsonl'

function levers(turn: Turn): Record<string, true> {
  return {
    ...(turn.briefFinal ? { brief_final: true as const } : {}),
    ...(turn.briefFinish ? { brief_finish: true as const } : {}),
    ...(turn.clearingCacheFloors ? { clearing_cache_floors: true as const } : {}),
    ...(turn.finishAmbiguity ? { finish_ambiguity: true as const } : {}),
    ...(turn.finishCheck ? { finish_check: true as const } : {}),
    ...(turn.foldFinish ? { fold_finish: true as const } : {}),
    ...(turn.leanCells ? { lean_cells: true as const } : {}),
    ...(turn.lenientPatches ? { lenient_patches: true as const } : {}),
    ...(turn.lowEffortRounds ? { low_effort_rounds: true as const } : {}),
    ...(turn.persistFinish ? { persist_finish: true as const } : {}),
    ...(turn.skipFinishCheck ? { skip_finish_check: true as const } : {}),
    ...(turn.stopAtTarget ? { stop_at_target: true as const } : {}),
  }
}

function losses(turn: Turn): Record<string, number | string> {
  return {
    ...(turn.contextWindow === undefined ? {} : { context_window: turn.contextWindow }),
    ...(turn.maxOutputTokens === undefined ? {} : { max_output_tokens: turn.maxOutputTokens }),
    ...(turn.minWaitMs === undefined ? {} : { min_wait_ms: turn.minWaitMs }),
    ...(turn.finishRetries === undefined ? {} : { finish_retries: turn.finishRetries }),
    ...(turn.lateFinishCheckMs === undefined
      ? {}
      : { late_finish_check_ms: turn.lateFinishCheckMs }),
    ...(turn.resultEffort ? { result_effort: turn.resultEffort } : {}),
    ...(turn.yieldFloorMs === undefined ? {} : { yield_floor_ms: turn.yieldFloorMs }),
    ...(turn.yieldShare === undefined ? {} : { yield_share: turn.yieldShare }),
  }
}

function clearing(turn: Turn): {
  tool_result_clearing?: { at_least_tokens: number; keep: number }
} {
  return turn.toolResultClearing === undefined
    ? {}
    : {
        tool_result_clearing: {
          at_least_tokens: turn.toolResultClearing.atLeastTokens,
          keep: turn.toolResultClearing.keep,
        },
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
      deadline: turn.deadline
        ? { at_ms: turn.deadline.atMs, limit_ms: turn.deadline.limitMs }
        : null,
      ...escalate(turn),
      ...losses(turn),
      ...(turn.refusalFallback ? { refusal_fallback: turn.refusalFallback } : {}),
      request_id: turn.requestId,
      session: input.session,
      ...(turn.subagents === false ? { subagents: false } : {}),
      ...clearing(turn),
      ...(turn.toolResultTokens === undefined ? {} : { tool_result_tokens: turn.toolResultTokens }),
      ...(turn.webSearch === false ? { web_search: false } : {}),
    }) + '\n'
  )
}

export function body(turn: Turn): Record<string, unknown> {
  return {
    ...levers(turn),
    ...(turn.hand ? { hand: turn.hand } : {}),
    ...(turn.orchestration && turn.provider === 'claude'
      ? { claude_orchestration: turn.orchestration }
      : {}),
    ...(turn.orchestration && turn.provider === 'codex'
      ? { codex_orchestration: turn.orchestration }
      : {}),
    ...(Installed.contextWindow(turn.model)
      ? { context_window: Installed.contextWindow(turn.model) }
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
    ...(turn.provider === 'codex' || turn.subagents === false ? { subagents: false } : {}),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...clearing(turn),
    ...(turn.toolResultTokens === undefined ? {} : { tool_result_tokens: turn.toolResultTokens }),
    ...(turn.provider === 'codex' || turn.webSearch === false ? { web_search: false } : {}),
  }
}
