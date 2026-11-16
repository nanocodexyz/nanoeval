import type * as Branch from './Branch.ts'
import type * as Picker from './Picker.ts'

export type Agent = {
  executorShare?: number
  fixModel?: string
  fixProvider?: 'claude' | 'codex'
  fixThinking?: string
  model: string
  provider: string
  thinking?: string
  verifierShare?: number
}

type Bare = {
  escalateContextTokens?: unknown
  escalateModel?: unknown
  escalateToolErrors?: unknown
  refusalFallback?: unknown
}

export type Stage = { model: string; provider: 'claude' | 'codex'; thinking?: string }

export type Usage = {
  escalated: boolean
  execUsd: number
  executorTimedOut: boolean
  fixUsd: number
  handoff: 'continue'
  reason: Branch.Reason | null
  verifierUsd: number
}

export type Verifier = { confidence: number; message: string; verdict: Picker.Verdict }

export const defaultExecutorShare = 50

export const defaultVerifierShare = 10

export const fixBranch = 1

export const messageBytes = 3000

export const path = 'fix/'

export function on(agent: Pick<Agent, 'fixModel'>): boolean {
  return agent.fixModel !== undefined
}

export function executorShare(agent: Pick<Agent, 'executorShare'>): number {
  return agent.executorShare ?? defaultExecutorShare
}

export function verifierShare(agent: Pick<Agent, 'verifierShare'>): number {
  return agent.verifierShare ?? defaultVerifierShare
}

export function executorDeadline(
  agent: Pick<Agent, 'executorShare'>,
  input: { limitMs: number; startedAt: number },
): number {
  return input.startedAt + Math.floor((executorShare(agent) * input.limitMs) / 100)
}

export function verifierLimitMs(
  agent: Pick<Agent, 'verifierShare'>,
  input: { agentMs: number; limitMs: number },
): number {
  return Math.min(input.limitMs, Math.floor((verifierShare(agent) * input.agentMs) / 100))
}

export function fixing(agent: Pick<Agent, 'fixModel'>, branch: number): boolean {
  return agent.fixModel !== undefined && branch >= fixBranch
}

export function bare<T extends Bare>(turn: T): Omit<T, keyof Bare> {
  const {
    escalateContextTokens: _context,
    escalateModel: _model,
    escalateToolErrors: _errors,
    refusalFallback: _fallback,
    ...rest
  } = turn
  return rest
}

export function stage(agent: Agent, branch: number): Stage {
  if (fixing(agent, branch))
    return {
      model: agent.fixModel!,
      provider: agent.fixProvider!,
      ...(agent.fixThinking ? { thinking: agent.fixThinking } : {}),
    }
  return {
    model: agent.model,
    provider: agent.provider as Stage['provider'],
    ...(agent.thinking ? { thinking: agent.thinking } : {}),
  }
}

export function handoff(input: { instruction: string; verifier?: Verifier | undefined }): string {
  const lines = [
    input.instruction,
    '---',
    'Another agent already worked on this task in this sandbox, and its work is not done. ' +
      (input.verifier
        ? 'An independent check of the sandbox found it unfinished.'
        : 'It ran out of its time or stopped before it finished, so nothing checked its work.'),
  ]
  if (input.verifier) {
    lines.push(
      'Verdict of the check: ' +
        input.verifier.verdict.toUpperCase() +
        ', confidence ' +
        input.verifier.confidence +
        '.',
    )
    const message = input.verifier.message.trim()
    if (message) lines.push('What the check reported:\n' + tail(message, messageBytes))
  }
  lines.push(
    'The files and processes it left are still in this sandbox. Finish the task in place: start from the current state, fix what is wrong or missing, and verify the result yourself before you finish.',
  )
  return lines.join('\n\n')
}

export function pick(
  outcomes: readonly (Branch.Outcome | undefined)[],
  input: { worked: boolean },
): number {
  const fix = outcomes[fixBranch]
  if (fix?.state === 'completed') return fixBranch
  if (fix?.state === 'timeout' && input.worked) return fixBranch
  return 0
}

export function usage(input: {
  branchUsd: number
  executorTimedOut: boolean
  fixUsd: number
  fork: Branch.Fork | undefined
  verifierUsd: number
}): Usage {
  return {
    escalated: input.fork !== undefined,
    execUsd: input.branchUsd - input.fixUsd,
    executorTimedOut: input.executorTimedOut,
    fixUsd: input.fixUsd,
    handoff: 'continue',
    reason: input.fork?.reason ?? null,
    verifierUsd: input.verifierUsd,
  }
}

function tail(text: string, bytes: number): string {
  return text.length > bytes
    ? '[... earlier lines omitted ...]\n' + text.slice(text.length - bytes)
    : text
}
