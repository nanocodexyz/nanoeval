import * as Compare from './Compare.ts'
import * as Pins from './Pins.ts'

export class MissingError extends Error {
  override name = 'Baseline.MissingError'
}

export type Candidate = {
  cancelled: boolean
  eval: { name: string; version: string }
  id: string
  members: readonly Compare.Member[]
  nanocode: Pins.Pins
  rerun: boolean
  state: 'finished' | 'running'
  tasks: Readonly<Record<string, string>>
}

export type Rule =
  | { kind: 'latest'; pins: { hand: string; harness: string } }
  | { kind: 'previous' }
  | { hand: string; kind: 'revision' }

export type Wanted = {
  eval: { name: string }
  members: readonly Compare.Member[]
  not: readonly string[]
  rule: Rule
  tasks: Readonly<Record<string, string>>
}

export const rule = 'latest'
export const previous = 'previous'

const runId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function named(name: string): 'id' | 'latest' | 'previous' | 'revision' {
  return name === rule
    ? 'latest'
    : name === previous
      ? 'previous'
      : runId.test(name)
        ? 'id'
        : 'revision'
}

export function shared(candidate: Candidate, wanted: Wanted): string[] {
  return Object.entries(wanted.tasks)
    .filter(([name, digest]) => candidate.tasks[name] === digest)
    .map(([name]) => name)
}

export function misfit(candidate: Candidate, wanted: Wanted): string | undefined {
  if (wanted.not.includes(candidate.id)) return 'one of the runs it would be set against'
  if (candidate.state !== 'finished') return 'not finished'
  if (candidate.cancelled) return 'cancelled'
  if (candidate.rerun) return 'a rerun'
  if (candidate.eval.name !== wanted.eval.name) return 'of another eval'
  const { rule } = wanted
  if (
    rule.kind === 'latest' &&
    (candidate.nanocode.harness !== rule.pins.harness ||
      candidate.nanocode.hands.length !== 1 ||
      candidate.nanocode.hands[0] !== rule.pins.hand)
  )
    return 'on other builds'
  if (
    rule.kind === 'revision' &&
    (candidate.nanocode.hands.length !== 1 || candidate.nanocode.hands[0] !== rule.hand)
  )
    return 'on other builds'
  const limits = (members: readonly Compare.Member[]) =>
    [...new Set(members.flatMap((member) => member.limits))].sort().join(' ')
  if (limits(candidate.members) !== limits(wanted.members))
    return "under another limit on the agent's time"
  const verifierLimits = (members: readonly Compare.Member[]) =>
    [...new Set(members.flatMap((member) => member.verifierLimits))].sort().join(' ')
  if (verifierLimits(candidate.members) !== verifierLimits(wanted.members))
    return "under another limit on the verifier's time"
  const pairs = Compare.pairs(candidate.members, wanted.members)
  if (pairs.some((pair) => pair.by !== 'kind')) return 'without these agents'
  if (pairs.some((pair) => pair.differs.length)) return 'on another model route'
  if (
    pairs.some(
      (pair) => pair.missing.baseline.includes('payer') && !pair.missing.run.includes('payer'),
    )
  )
    return 'without a record of who paid for their models'
  const names = Object.keys(wanted.tasks)
  const held = names.filter((name) => candidate.tasks[name] !== undefined)
  const equal = shared(candidate, wanted)
  if (rule.kind === 'latest') {
    if (held.length < names.length) return 'without these tasks'
    if (equal.length < names.length) return 'with another version of these tasks'
    return undefined
  }
  if (!held.length) return 'without a task of these'
  if (!equal.length) return 'with another version of these tasks'
  return undefined
}

function builds(rule: Rule): string {
  return rule.kind === 'latest'
    ? ' on ' + rule.pins.harness + ', hand ' + rule.pins.hand
    : rule.kind === 'revision'
      ? ' on the hand ' + rule.hand
      : ''
}

export function said(wanted: Wanted, found: Candidate): string {
  const equal = shared(found, wanted).length
  const all = Object.keys(wanted.tasks).length
  return (
    (wanted.rule.kind === 'previous'
      ? 'the run before this one, the latest finished run of '
      : 'the latest finished run of ') +
    wanted.eval.name +
    ' on ' +
    Pins.text(found.nanocode) +
    ' that holds ' +
    (equal === all ? 'these tasks' : equal + ' of these ' + all + ' tasks') +
    (wanted.members.length
      ? ' with ' + wanted.members.map((member) => member.label).join(' and ')
      : '')
  )
}

export async function find(
  wanted: Wanted,
  input: { ids: readonly string[]; read: (id: string) => Promise<Candidate> },
): Promise<Candidate> {
  const reasons = new Map<string, number>()
  for (const id of input.ids) {
    const candidate = await input.read(id)
    const reason = misfit(candidate, wanted)
    if (reason === undefined) return candidate
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const all = Object.keys(wanted.tasks).length
  throw new MissingError(
    'no finished run of ' +
      wanted.eval.name +
      builds(wanted.rule) +
      (all === 1
        ? ' holds this task'
        : wanted.rule.kind === 'latest'
          ? ' holds these ' + all + ' tasks'
          : ' holds one of these ' + all + ' tasks') +
      (wanted.members.length
        ? ' with ' + wanted.members.map((member) => member.label).join(' and ')
        : '') +
      (reasons.size
        ? ': of the runs listed, ' +
          [...reasons]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reason, count]) => count + ' ' + reason)
            .join(', ')
        : ': no run is listed') +
      (wanted.rule.kind === 'latest'
        ? '. Make one on the pinned builds, or name a baseline by its id'
        : '. Name a baseline by its id'),
  )
}
