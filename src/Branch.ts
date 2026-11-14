export const checkRequestId = 'self-check'
export const record = 'agent/branches.json'

export const prompt =
  'Before you finish, check your work: run the tests and checks you can, your own or ones the environment has, fix anything that fails, and leave the solution in place. End your reply with one line that says SELF-CHECK: PASS if everything you checked passes, or SELF-CHECK: FAIL if anything still fails.'

export type Verdict = 'fail' | 'pass' | 'unknown'

export type Outcome =
  | { message: string; state: 'completed'; verdict: Verdict }
  | { error: string; state: 'failed' }
  | { state: 'timeout' }

export type Record = { branches: readonly Outcome[]; chosen: number }

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
