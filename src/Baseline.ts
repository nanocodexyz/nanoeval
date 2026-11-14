import type * as Config from './Config.ts'
import type * as Pins from './Pins.ts'

export class MissingError extends Error {
  override name = 'Baseline.MissingError'
}

export type Candidate = {
  agents: readonly Config.Agent[]
  cancelled: boolean
  eval: { name: string; version: string }
  id: string
  nanocode: Pins.Pins
  rerun: boolean
  state: 'finished' | 'running'
  tasks: readonly string[]
}

export type Wanted = {
  agents: readonly Config.Agent[]
  eval: { name: string; version: string }
  not: readonly string[]
  pins: { hand: string; harness: string }
  tasks: readonly string[]
}

export const rule = 'latest'

export function misfit(candidate: Candidate, wanted: Wanted): string | undefined {
  if (wanted.not.includes(candidate.id)) return 'one of the runs it would be set against'
  if (candidate.state !== 'finished') return 'not finished'
  if (candidate.cancelled) return 'cancelled'
  if (candidate.rerun) return 'a rerun'
  if (candidate.eval.name !== wanted.eval.name || candidate.eval.version !== wanted.eval.version)
    return 'of another eval version'
  if (
    candidate.nanocode.harness !== wanted.pins.harness ||
    candidate.nanocode.hands.length !== 1 ||
    candidate.nanocode.hands[0] !== wanted.pins.hand
  )
    return 'on other builds'
  const same = (agent: Config.Agent) =>
    candidate.agents.some(
      (other) =>
        other.id === agent.id &&
        other.model === agent.model &&
        (other.orchestration ?? '') === (agent.orchestration ?? '') &&
        other.provider === agent.provider &&
        (other.thinking ?? '') === (agent.thinking ?? ''),
    )
  if (!wanted.agents.every(same)) return 'without these agents'
  if (!wanted.tasks.every((task) => candidate.tasks.includes(task))) return 'without these tasks'
  return undefined
}

export async function latest(
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
  throw new MissingError(
    'no finished run of ' +
      wanted.eval.name +
      '@' +
      wanted.eval.version.slice(0, 12) +
      ' on ' +
      wanted.pins.harness +
      ', hand ' +
      wanted.pins.hand +
      (wanted.tasks.length === 1
        ? ' holds this task'
        : ' holds these ' + wanted.tasks.length + ' tasks') +
      ' with ' +
      wanted.agents.map((agent) => agent.id).join(' and ') +
      (reasons.size
        ? ': of the runs listed, ' +
          [...reasons]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reason, count]) => count + ' ' + reason)
            .join(', ')
        : ': no run is listed') +
      '. Make one on the pinned builds, or name a baseline by its id',
  )
}
