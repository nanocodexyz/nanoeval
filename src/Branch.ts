import type * as Atif from './Atif.ts'
import type * as Picker from './Picker.ts'

export const checkRequestId = 'self-check'
export const record = 'agent/branches.json'

export const prompt =
  'Before you finish, check your work: run the tests and checks you can, your own or ones the environment has, fix anything that fails, and leave the solution in place. Run your final check as a command of its own, with nothing after it, so its exit status shows whether it passes. End your reply with one line that says SELF-CHECK: PASS if everything you checked passes, or SELF-CHECK: FAIL if anything still fails.'

export type Verdict = 'fail' | 'pass' | 'unknown'

export type Outcome =
  | { evidence?: Evidence; message: string; state: 'completed'; verdict: Verdict }
  | { state: 'cancelled' }
  | { error: string; state: 'failed' }
  | { state: 'timeout' }

export type Record = {
  branches: readonly Outcome[]
  chosen: number
  fork?: Fork
  picker?: Picker.Record
}

export class InvalidError extends Error {
  override name = 'Branch.InvalidError'
}

export function session(name: string, index: number): string {
  return index === 0 ? name : name + '-branch-' + index
}

export function slot(name: string, index: number): string {
  return index === 0 ? name : name + '-b' + index
}

export function base(name: string): string {
  return name.replace(/-b[0-9]+$/, '')
}

export function indexes(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

export function verdict(message: string): Verdict {
  const found = [...message.matchAll(/SELF-CHECK:\s*(PASS|FAIL)\b/gi)].at(-1)
  if (!found) return 'unknown'
  return found[1]!.toUpperCase() === 'PASS' ? 'pass' : 'fail'
}

const ranks: { [verdict in Verdict]: number } = { fail: 1, pass: 3, unknown: 2 }

export function rank(outcome: Outcome): number {
  return outcome.state === 'completed' ? ranks[outcome.verdict] : 0
}

export function choose(outcomes: readonly Outcome[]): number {
  if (!outcomes.length) throw new InvalidError('there is no branch to choose from')
  let chosen = 0
  for (const [index, outcome] of outcomes.entries())
    if (rank(outcome) > rank(outcomes[chosen]!)) chosen = index
  return chosen
}

export function valid(count: unknown): count is number {
  return typeof count === 'number' && Number.isInteger(count) && count >= 2
}

export const forkRecord = 'agent/fork.json'
export const lazyShare = 0.6

export type Fork = { at: number; reason: Reason }

export type Reason = 'time' | 'unverified' | 'verifier_fail' | 'verifier_unsure'

export type Evidence = { command: string; exitCode: 0 }

type Shell = { command: string }

export const shells: { [tool: string]: (input: { [key: string]: unknown }) => string | undefined } =
  {
    Bash: (input) => (typeof input['command'] === 'string' ? input['command'] : undefined),
    exec_command: (input) => {
      const cmd = input['cmd']
      if (typeof cmd === 'string') return cmd
      return Array.isArray(cmd) && cmd.every((part) => typeof part === 'string')
        ? cmd.join(' ')
        : undefined
    },
    shell: (input) => {
      const command = input['command']
      return Array.isArray(command) && command.every((part) => typeof part === 'string')
        ? command.join(' ')
        : undefined
    },
  }

export const writes = new Set(['apply_patch', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write'])

const runner = new RegExp(
  String.raw`^(\w+=\S*\s+)*((nice|npx|pipenv run|poetry run|sudo|time|timeout|uv run|xvfb-run)(\s+\S+)*?\s+)?(` +
    [
      String.raw`(bats|ctest|jest|mocha|nox|phpunit|prove|py\.test|pytest|rspec|tox|vitest)`,
      String.raw`python[0-9.]*\s+(-\S+\s+)*-m\s+(pytest|unittest)`,
      String.raw`(bun|cabal|cargo|deno|dotnet|go|gradle|mix|mvn|npm|pnpm|stack|swift|yarn|zig)\s+(run\s+)?test`,
      String.raw`make\s+(-\S+\s+)*(check|test)`,
      String.raw`((bash|node|perl|python[0-9.]*|ruby|sh|zsh)\s+(-\S+\s+)*)?(\S*/)?(tests?/\S+|[^\s/]*test[^\s/]*\.(js|py|sh|ts)|run[_-]?tests?[^\s/]*)`,
    ].join('|') +
    String.raw`)(\s|$)`,
)

const inert = /\s(--collect-only|--help|--list|--version|-h|-V)(\s|$)/

const inline = /^(\w+=\S*\s+)*(\S*\/)?python[0-9.]*\s+(-[A-NP-Za-z]+\s+)*-c\s+\S[\s\S]*\bassert\b/

const failures = /\b[1-9][0-9]* (errors?|failed|failing|failures?)\b|^FAILED\b|test result: FAILED/m

function masked(command: string): string {
  let escaped = false
  let quote: string | undefined
  return [...command]
    .map((char) => {
      if (escaped) {
        escaped = false
        return '_'
      }
      if (char === '\\' && quote !== "'") {
        escaped = true
        return quote === undefined ? char : '_'
      }
      if (quote === undefined) {
        if (char === '"' || char === "'") quote = char
        return char
      }
      if (char !== quote) return '_'
      quote = undefined
      return char
    })
    .join('')
}

function split(command: string, separator: RegExp): string[] {
  const parts: string[] = []
  let start = 0
  for (const found of masked(command).matchAll(separator)) {
    parts.push(command.slice(start, found.index))
    start = found.index + found[0].length
  }
  return [...parts, command.slice(start)]
}

function check(stage: string): boolean {
  return runner.test(stage) || (inline.test(stage) && !stage.includes('PYTHONOPTIMIZE'))
}

export function testCommand(command: string): boolean {
  if (masked(command).includes('||') || inert.test(command)) return false
  const last = split(command, /;|\n|(?<![&<>])&(?![&>])/g).findLast((part) => part.trim() !== '')
  if (last === undefined) return false
  const pipefail = command.includes('pipefail')
  return split(last, /&&/g).some((step) => {
    const stages = split(step, /\|/g)
    return (pipefail ? stages : stages.slice(-1)).some((stage) => check(stage.trim()))
  })
}

export function argumentsOf(value: unknown): { [key: string]: unknown } {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as { [key: string]: unknown })
        : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null ? (value as { [key: string]: unknown }) : {}
}

export function said(payload: { [key: string]: any }): string {
  const structured = payload['structured_result']
  const parts =
    typeof structured === 'object' && structured !== null
      ? [structured['stdout'], structured['stderr'], structured['output']]
      : []
  return [...parts, typeof payload['result'] === 'string' ? payload['result'] : '']
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
}

export function evidence(
  events: readonly Atif.SessionEvent[],
  options: evidence.Options,
): Evidence | undefined {
  const calls = new Map<string, Shell>()
  const running = new Map<string, Shell>()
  let latest: { command: string; passed: boolean } | undefined
  for (const entry of events) {
    if (entry.request_id !== options.requestId) continue
    const event = entry.event.event ?? entry.event.update?.event
    if (!event) continue
    const payload = event.payload
    const id = String(payload['call_id'])
    const tool = String(payload['tool'])
    if (event.type === 'tool.call') {
      if (writes.has(tool)) latest = undefined
      const command = shells[tool]?.(argumentsOf(payload['arguments']))
      if (command !== undefined) calls.set(id, { command })
      if (tool === 'write_stdin') {
        const session = argumentsOf(payload['arguments'])['session_id']
        const started = running.get(String(session))
        if (started) calls.set(id, started)
      }
      continue
    }
    if (event.type !== 'tool.result') continue
    const call = calls.get(id)
    if (!call) continue
    const structured = payload['structured_result']
    const exitCode =
      typeof structured === 'object' && structured !== null ? structured['exit_code'] : undefined
    const session =
      typeof structured === 'object' && structured !== null ? structured['session_id'] : undefined
    if (typeof exitCode !== 'number') {
      if (session !== undefined && session !== null) running.set(String(session), call)
      continue
    }
    if (!testCommand(call.command)) continue
    latest = {
      command: call.command,
      passed: payload['status'] === 'completed' && exitCode === 0 && !failures.test(said(payload)),
    }
  }
  return latest?.passed ? { command: latest.command, exitCode: 0 } : undefined
}

export declare namespace evidence {
  type Options = { requestId: string }
}

export function verified(outcome: Outcome | undefined): boolean {
  return (
    outcome?.state === 'completed' && outcome.verdict === 'pass' && outcome.evidence !== undefined
  )
}

export function forkReason(
  trunk: Outcome | undefined,
  options: forkReason.Options,
): Reason | undefined {
  if (options.now >= options.deadlineAt) return undefined
  if (trunk !== undefined) return verified(trunk) ? undefined : 'unverified'
  return options.now - options.startedAt >= lazyShare * (options.deadlineAt - options.startedAt)
    ? 'time'
    : undefined
}

export declare namespace forkReason {
  type Options = { deadlineAt: number; now: number; startedAt: number }
}

export function forkAt(options: Omit<forkReason.Options, 'now'>): number {
  return options.startedAt + Math.ceil(lazyShare * (options.deadlineAt - options.startedAt))
}

export function settle(outcomes: readonly (Outcome | undefined)[]): number | undefined {
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === undefined) return undefined
    if (verified(outcome)) return index
  }
  if (outcomes[0]?.state === 'completed') return 0
  return choose(outcomes as Outcome[])
}
