import * as Config from './Config.ts'

export class InvalidError extends Error {
  override name = 'Overlay.InvalidError'
}

export class PendingError extends Error {
  override name = 'Overlay.PendingError'
}

export const format = 'nanoeval-overlay/1'

export type Harness = 'claude' | 'claude-direct' | 'codex' | 'codex-code-mode' | 'codex-jobs'

export const harnesses: Record<Harness, Pick<Config.Agent, 'orchestration' | 'provider'>> = {
  claude: { provider: 'claude' },
  'claude-direct': { orchestration: 'direct', provider: 'claude' },
  codex: { orchestration: 'direct', provider: 'codex' },
  'codex-code-mode': { provider: 'codex' },
  'codex-jobs': { orchestration: 'jobs', provider: 'codex' },
}

export type Dim =
  | 'codemode'
  | 'context'
  | 'effort'
  | 'finish'
  | 'prompt'
  | 'retries'
  | 'subagents'
  | 'tools'

export const dims: readonly Dim[] = [
  'codemode',
  'context',
  'effort',
  'finish',
  'prompt',
  'retries',
  'subagents',
  'tools',
]

export const thinkings: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

const fixed = ['api', 'id', 'model', 'orchestration', 'provider', 'thinking'] as const

export const leverKeys: readonly (keyof Config.Agent)[] = Config.agentKeys.filter(
  (key) => !(fixed as readonly string[]).includes(key),
)

export type Levers = Omit<Partial<Config.Agent>, (typeof fixed)[number]>

export type Overlay = {
  dims: Dim[]
  evidence: string[]
  format: typeof format
  harness: Harness
  hypothesis: string
  id: string
  levers: Levers
  model: string
  parent: string | null
  pending: Record<string, unknown>
  thinking: string
}

const keys: readonly string[] = [
  'dims',
  'evidence',
  'format',
  'harness',
  'hypothesis',
  'id',
  'levers',
  'model',
  'parent',
  'pending',
  'thinking',
]

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const fail = (message: string): never => {
  throw new InvalidError(message)
}

export function parse(value: unknown): Overlay {
  if (!record(value)) return fail('an overlay is a JSON object')
  if (value['format'] !== format) fail('an overlay has the format ' + format)
  const id = value['id']
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    return fail('an overlay id is letters, digits, dots, dashes and underscores')
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  if (unknown.length) fail(id + ' has keys an overlay does not have: ' + unknown.join(', '))
  const model = value['model']
  if (typeof model !== 'string' || !model) return fail(id + ' names no model')
  const harness = value['harness']
  if (typeof harness !== 'string' || !Object.hasOwn(harnesses, harness))
    return fail(id + ': harness must be one of ' + Object.keys(harnesses).join(', '))
  const thinking = value['thinking']
  if (typeof thinking !== 'string' || !thinkings.includes(thinking))
    return fail(id + ': thinking must be one of ' + thinkings.join(', '))
  const parent = value['parent']
  if (parent !== null && (typeof parent !== 'string' || !parent))
    return fail(id + ': parent is the id of an overlay or null')
  const levers = value['levers']
  if (!record(levers)) return fail(id + ': levers is an object')
  const foreign = Object.keys(levers).filter(
    (key) => !leverKeys.includes(key as keyof Config.Agent),
  )
  if (foreign.length)
    fail(
      id +
        ' has levers this checkout does not know (' +
        foreign.join(', ') +
        '): put a lever no Worker accepts in pending',
    )
  const pending = value['pending']
  if (!record(pending)) return fail(id + ': pending is an object')
  const known = Object.keys(pending).filter((key) => leverKeys.includes(key as keyof Config.Agent))
  if (known.length)
    fail(id + ' has pending keys that are levers (' + known.join(', ') + '): put them in levers')
  const named = value['dims']
  if (!strings(named) || named.some((dim) => !dims.includes(dim as Dim)))
    return fail(id + ': dims is a list of ' + dims.join(', '))
  const hypothesis = value['hypothesis']
  if (typeof hypothesis !== 'string' || !hypothesis) return fail(id + ' states no hypothesis')
  const evidence = value['evidence']
  if (!strings(evidence)) return fail(id + ': evidence is a list of strings')
  const overlay: Overlay = {
    dims: [...(named as Dim[])],
    evidence: [...evidence],
    format,
    harness: harness as Harness,
    hypothesis,
    id,
    levers: { ...levers },
    model,
    parent,
    pending: { ...pending },
    thinking,
  }
  agent(overlay)
  return overlay
}

export function pendingKeys(overlay: Overlay): string[] {
  return Object.keys(overlay.pending).sort()
}

function agent(overlay: Overlay): Config.Agent {
  return Config.parseAgents([
    {
      ...overlay.levers,
      ...harnesses[overlay.harness],
      id: overlay.id,
      model: overlay.model,
      thinking: overlay.thinking,
    },
  ])[0]!
}

export function compile(overlay: Overlay): Config.Agent {
  const pending = pendingKeys(overlay)
  if (pending.length)
    throw new PendingError(
      overlay.id + ' is not runnable until a Worker accepts ' + pending.join(', '),
    )
  return agent(overlay)
}
