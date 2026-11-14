import type * as Config from './Config.ts'

export type Turn = {
  hand?: string
  model: string
  orchestration?: 'direct'
  payer?: Config.Payer
  prompt: string
  provider: 'claude' | 'codex'
  requestId: string
  thinking?: string
}

export function body(turn: Turn): Record<string, unknown> {
  return {
    ...(turn.hand ? { hand: turn.hand } : {}),
    ...(turn.orchestration ? { codex_orchestration: turn.orchestration } : {}),
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
