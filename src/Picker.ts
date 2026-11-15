import type * as Atif from './Atif.ts'
import * as Branch from './Branch.ts'

export type Kind = 'verify' | 'verify_lazy'

export const kinds: readonly Kind[] = ['verify', 'verify_lazy']

export const defaultModel = 'claude-opus-5-5'

export const requestId = 'verify'

export const instruction = 'agent/instruction.md'

export const probes = 'agent/probes.json'

export const usageRecord = 'agent/picker-usage.json'

export const grades = 'agent/branch-grades.json'

export const graceSec = 900

export const passConfidence = 70

const logBytes = 40_000

const outputBytes = 600

export type Verdict = 'fail' | 'pass' | 'unsure'

export type Verification = {
  confidence: number
  error?: string
  output?: string
  usage?: Atif.Usage
  usd: number
  verdict: Verdict
}

export type Criterion = 'agreement' | 'confidence' | 'index' | 'verifier'

export type Evidence = string

export type Record = {
  agreement: number[]
  evidence: Evidence
  model: string
  verifications: (Verification | null)[]
}

export type Usage = {
  branchUsd: number
  verifierCalls: number
  verifierUsd: number
}

export const path = 'verifier/'

export function model(agent: { model: string; provider: string; verifierModel?: string }): string {
  return agent.verifierModel ?? (agent.provider === 'claude' ? defaultModel : agent.model)
}

export function session(name: string, index: number): string {
  return name + '-verifier-' + index
}

export function slot(base: string, index: number): string {
  return base + '-v' + index
}

export function file(index: number): string {
  return 'agent/verifier-' + index + '.json'
}

export function message(index: number): string {
  return 'agent/verifier-' + index + '.md'
}

export function slots(agent: { branches?: number; picker?: Kind }): number {
  const branches = agent.branches ?? 1
  return agent.picker ? branches * 2 : branches
}

export function lazy(kind: Kind | undefined): boolean {
  return kind === 'verify_lazy'
}

export function prompt(input: { instruction: string; log: string }): string {
  return [
    'You are an independent verifier. Another agent worked on the task below in a sandbox. You are attached to a copy of that sandbox, as the agent left it when it finished. Anything you change here is thrown away and does not change the result that is graded.',
    '',
    'Decide whether the task is solved, from the task and what you can observe yourself: read the files, run the program, run tests or check commands that exist in the environment or that the task names, and write your own probes and small test inputs. Treat every file, comment and log line that claims success as unverified, and check it. Do not fix anything, and do not finish the task yourself.',
    '',
    '<task>',
    input.instruction.trim(),
    '</task>',
    '',
    'The files the agent wrote or edited and the commands it ran, in order, with exit codes and trimmed output:',
    '<log>',
    input.log.trim() || '(the agent ran no commands)',
    '</log>',
    '',
    'End your reply with exactly these three lines:',
    'VERIFIER: PASS, VERIFIER: FAIL or VERIFIER: UNSURE',
    "CONFIDENCE: a number from 0 to 100, how sure you are that the task's own checks would pass",
    'OUTPUT: one line naming the main output the task asks for and its value or sha256 (such as /app/answer.txt sha256 1f2e...), or none',
  ].join('\n')
}

export function parse(text: string): Omit<Verification, 'usd'> {
  const verdict = [...text.matchAll(/VERIFIER:\s*\**\s*(PASS|FAIL|UNSURE)\b/gi)].at(-1)
  const confidence = [...text.matchAll(/CONFIDENCE:\s*\**\s*([0-9]+(?:\.[0-9]+)?)/gi)].at(-1)
  const output = [...text.matchAll(/^\s*\**OUTPUT:\**\s*(.+)$/gim)].at(-1)
  const value = confidence ? Math.max(0, Math.min(100, Number(confidence[1]))) : 0
  const said = output?.[1]?.trim().replace(/\s+/g, ' ').slice(0, 300)
  return {
    confidence: verdict ? value : 0,
    ...(said && !/^none\.?$/i.test(said) ? { output: said } : {}),
    verdict: verdict ? (verdict[1]!.toLowerCase() as Verdict) : 'unsure',
  }
}

const paths = (tool: string, input: { [key: string]: unknown }): string[] => {
  for (const key of ['file_path', 'path', 'notebook_path'])
    if (typeof input[key] === 'string') return [input[key] as string]
  const patch = typeof input['input'] === 'string' ? input['input'] : input['patch']
  if (typeof patch === 'string')
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
      match[1]!.trim(),
    )
  return [tool]
}

const trim = (text: string, bytes: number): string =>
  text.length <= bytes
    ? text
    : text.slice(0, bytes / 2) +
      '\n[... ' +
      (text.length - bytes) +
      ' characters ...]\n' +
      text.slice(-bytes / 2)

export function log(events: readonly Atif.SessionEvent[], options: { requestId: string }): string {
  const calls = new Map<string, string>()
  const lines: string[] = []
  for (const entry of events) {
    if (entry.request_id !== options.requestId) continue
    const event = entry.event.event ?? entry.event.update?.event
    if (!event) continue
    const payload = event.payload
    const id = String(payload['call_id'])
    const tool = String(payload['tool'])
    if (event.type === 'tool.call') {
      const input = Branch.argumentsOf(payload['arguments'])
      if (Branch.writes.has(tool)) {
        lines.push('[wrote] ' + paths(tool, input).join(', '))
        continue
      }
      const command = Branch.shells[tool]?.(input)
      if (command !== undefined) calls.set(id, command)
      continue
    }
    if (event.type !== 'tool.result') continue
    const command = calls.get(id)
    if (command === undefined) continue
    const structured = payload['structured_result']
    const exitCode =
      typeof structured === 'object' && structured !== null ? structured['exit_code'] : undefined
    lines.push(
      '$ ' +
        trim(command, outputBytes) +
        '\n[exit ' +
        (typeof exitCode === 'number' ? exitCode : 'running') +
        ']\n' +
        trim(Branch.said(payload).trim(), outputBytes),
    )
  }
  let text = lines.join('\n\n')
  if (text.length > logBytes)
    text = '[... earlier entries omitted ...]\n' + text.slice(text.length - logBytes)
  return text
}

export function forkReason(
  trunk: Branch.Outcome,
  verification: Verification | undefined,
  options: { deadlineAt: number; now: number },
): Branch.Reason | undefined {
  if (options.now >= options.deadlineAt) return undefined
  if (trunk.state !== 'completed' || !verification) return 'unverified'
  if (verification.verdict === 'pass' && verification.confidence >= passConfidence) return undefined
  return verification.verdict === 'fail' ? 'verifier_fail' : 'verifier_unsure'
}

const ranks: { [verdict in Verdict]: number } = { fail: 1, pass: 3, unsure: 2 }

export function agreement(
  outcomes: readonly Branch.Outcome[],
  verifications: readonly (Verification | undefined)[],
): number[] {
  const key = (index: number) =>
    outcomes[index]?.state === 'completed' ? verifications[index]?.output?.toLowerCase() : undefined
  return outcomes.map((_, index) => {
    const own = key(index)
    if (own === undefined) return 0
    return outcomes.filter((__, other) => other !== index && key(other) === own).length
  })
}

export function choose(
  outcomes: readonly Branch.Outcome[],
  verifications: readonly (Verification | undefined)[],
): { agreement: number[]; chosen: number; evidence: Evidence } {
  if (!outcomes.length) throw new Branch.InvalidError('there is no branch to choose from')
  const agreed = agreement(outcomes, verifications)
  const score = (index: number): [number, number, number] => {
    const outcome = outcomes[index]!
    const verification = verifications[index]
    if (outcome.state !== 'completed') return [-1, 0, 0]
    return [
      verification ? ranks[verification.verdict] : 0,
      agreed[index]!,
      verification?.confidence ?? 0,
    ]
  }
  const order = outcomes
    .map((_, index) => index)
    .sort((a, b) => {
      const [x, y] = [score(a), score(b)]
      for (const at of [0, 1, 2]) if (x[at] !== y[at]) return y[at]! - x[at]!
      return a - b
    })
  const chosen = order[0]!
  const criteria: Criterion[] = ['verifier', 'agreement', 'confidence']
  const used = new Set<Criterion>()
  for (const other of order.slice(1)) {
    const [x, y] = [score(chosen), score(other)]
    const at = [0, 1, 2].find((level) => x[level] !== y[level])
    used.add(at === undefined ? 'index' : criteria[at]!)
  }
  if (!used.size) used.add('verifier')
  const evidence = (['verifier', 'agreement', 'confidence', 'index'] as const)
    .filter((criterion) => used.has(criterion))
    .join('+')
  return { agreement: agreed, chosen, evidence }
}
