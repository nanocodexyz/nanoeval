import type * as Config from './Config.ts'

export type Turn = {
  briefFinal?: true
  briefFinish?: true
  cellYieldMs?: number
  deadline?: { atMs: number; limitMs: number }
  foldFinish?: true
  hand?: string
  lowEffortRounds?: true
  model: string
  orchestration?: 'direct' | 'jobs'
  payer?: Config.Payer
  prompt: string
  provider: 'claude' | 'codex'
  refusalFallback?: Config.RefusalFallback
  requestId: string
  thinking?: string
}

export const record = 'agent/turns.jsonl'

function levers(turn: Turn): Record<string, true> {
  return {
    ...(turn.briefFinal ? { brief_final: true as const } : {}),
    ...(turn.briefFinish ? { brief_finish: true as const } : {}),
    ...(turn.foldFinish ? { fold_finish: true as const } : {}),
    ...(turn.lowEffortRounds ? { low_effort_rounds: true as const } : {}),
  }
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
      ...(turn.refusalFallback ? { refusal_fallback: turn.refusalFallback } : {}),
      request_id: turn.requestId,
      session: input.session,
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
    ...(turn.deadline
      ? { deadline: { at_ms: turn.deadline.atMs, limit_ms: turn.deadline.limitMs } }
      : {}),
    model: turn.model,
    ...(turn.payer ? { payer: turn.payer } : {}),
    prompt: turn.prompt,
    provider: turn.provider,
    ...(turn.refusalFallback ? { refusal_fallback: turn.refusalFallback } : {}),
    request_id: turn.requestId,
    ...(turn.provider === 'codex' ? { subagents: false } : {}),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...(turn.provider === 'codex' ? { web_search: false } : {}),
  }
}
