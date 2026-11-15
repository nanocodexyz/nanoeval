import type * as Config from './Config.ts'

export type Turn = {
  deadline?: { atMs: number; limitMs: number }
  hand?: string
  model: string
  orchestration?: 'direct' | 'jobs'
  payer?: Config.Payer
  prompt: string
  provider: 'claude' | 'codex'
  requestId: string
  thinking?: string
}

export const record = 'agent/turns.jsonl'

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
      deadline: turn.deadline
        ? { at_ms: turn.deadline.atMs, limit_ms: turn.deadline.limitMs }
        : null,
      request_id: turn.requestId,
      session: input.session,
    }) + '\n'
  )
}

export function body(turn: Turn): Record<string, unknown> {
  return {
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
    request_id: turn.requestId,
    ...(turn.provider === 'codex' ? { subagents: false } : {}),
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
    ...(turn.provider === 'codex' ? { web_search: false } : {}),
  }
}
