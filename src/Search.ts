import * as Config from './Config.ts'
import * as Overlay from './Overlay.ts'

export class InvalidError extends Error {
  override name = 'Search.InvalidError'
}

export type Setting = Record<string, unknown> | null

export type Dimension = {
  dim: Overlay.Dim
  harnesses?: readonly Overlay.Harness[]
  name: string
  pending?: true
  values: readonly Setting[]
}

export type Space = {
  dimensions: readonly Dimension[]
  format: 'nanoeval-space/1'
  harnesses: readonly Overlay.Harness[]
  model: string
  slug: string
  thinking: readonly string[]
}

export type Stage = 'A' | 'B' | 'C'

export const stages: Record<Stage, { attempts: number; eval: string; onlyFile?: string }> = {
  A: { attempts: 1, eval: 'tb21-full@96741725ac06', onlyFile: 'cheap10.txt' },
  B: { attempts: 3, eval: 'tb21-full@96741725ac06', onlyFile: 'dev44.txt' },
  C: { attempts: 3, eval: 'tb21-full@96741725ac06' },
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const fail = (message: string): never => {
  throw new InvalidError(message)
}

const record = (value: unknown, name: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(name + ' is not an object')

const strings = (value: unknown, name: string): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : fail(name + ' is not a list of strings')

const harnessNames = Object.keys(Overlay.harnesses) as Overlay.Harness[]

const isLever = (key: string) => Overlay.leverKeys.includes(key as keyof Config.Agent)

export function parseSpace(value: unknown): Space {
  const space = record(value, 'the search space')
  if (space['format'] !== 'nanoeval-space/1') fail('a search space has format nanoeval-space/1')
  const model = space['model']
  if (typeof model !== 'string' || !model) return fail('the search space names no model')
  const slug = space['slug']
  if (typeof slug !== 'string' || !idPattern.test(slug))
    return fail('the slug of a search space is letters, digits, dots, dashes and underscores')
  const allowed = strings(space['harnesses'], 'harnesses')
  if (
    !allowed.length ||
    allowed.some((harness) => !harnessNames.includes(harness as Overlay.Harness))
  )
    fail('harnesses is a non-empty list of ' + harnessNames.join(', '))
  const thinking = strings(space['thinking'], 'thinking')
  if (!thinking.length || thinking.some((level) => !Overlay.thinkings.includes(level)))
    fail('thinking is a non-empty list of ' + Overlay.thinkings.join(', '))
  if (!Array.isArray(space['dimensions'])) fail('dimensions is not a list')
  const dimensions = (space['dimensions'] as unknown[]).map((item, index): Dimension => {
    const dimension = record(item, 'dimension ' + index)
    const name = dimension['name']
    if (typeof name !== 'string' || !name) return fail('dimension ' + index + ' has no name')
    if (!Overlay.dims.includes(dimension['dim'] as Overlay.Dim))
      fail(name + ': dim must be one of ' + Overlay.dims.join(', '))
    if (!Array.isArray(dimension['values']) || dimension['values'].length < 2)
      fail(name + ' has fewer than two values')
    if (dimension['pending'] !== undefined && dimension['pending'] !== true)
      fail(name + ': pending is true or absent')
    const pending = dimension['pending'] === true
    const values = (dimension['values'] as unknown[]).map((setting) =>
      setting === null ? null : record(setting, name + ': a value'),
    )
    for (const key of keys({ values })) {
      if (pending && isLever(key))
        fail(name + ' is pending but sets ' + key + ', a lever the Worker takes')
      if (!pending && !isLever(key))
        fail(
          name +
            ' sets ' +
            key +
            ', a lever this checkout does not know: mark the dimension pending',
        )
    }
    const only =
      dimension['harnesses'] === undefined
        ? undefined
        : strings(dimension['harnesses'], name + ': harnesses')
    if (only?.some((harness) => !harnessNames.includes(harness as Overlay.Harness)))
      fail(name + ': harnesses must be among ' + harnessNames.join(', '))
    return {
      dim: dimension['dim'] as Overlay.Dim,
      ...(only ? { harnesses: only as Overlay.Harness[] } : {}),
      name,
      ...(pending ? { pending: true as const } : {}),
      values,
    }
  })
  const names = dimensions.map((dimension) => dimension.name)
  if (new Set(names).size !== names.length) fail('dimension names must be unique')
  const owners = new Map<string, string>()
  for (const dimension of dimensions)
    for (const key of keys(dimension)) {
      const owner = owners.get(key)
      if (owner) fail(key + ' is set by both ' + owner + ' and ' + dimension.name)
      owners.set(key, dimension.name)
    }
  return {
    dimensions,
    format: 'nanoeval-space/1',
    harnesses: allowed as Overlay.Harness[],
    model,
    slug,
    thinking,
  }
}

function keys(dimension: Pick<Dimension, 'values'>): string[] {
  return [...new Set(dimension.values.flatMap((setting) => Object.keys(setting ?? {})))].sort()
}

export function runnable(overlay: Overlay.Overlay): boolean {
  return !Overlay.pendingKeys(overlay).length
}

function sorted(levers: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(levers).sort(([left], [right]) => (left < right ? -1 : 1)),
  )
}

export function key(
  overlay: Pick<Overlay.Overlay, 'harness' | 'levers' | 'model' | 'pending' | 'thinking'>,
): string {
  return JSON.stringify([
    overlay.model,
    overlay.harness,
    overlay.thinking,
    sorted(overlay.levers),
    sorted(overlay.pending),
  ])
}

type Genome = { harness: Overlay.Harness; settings: Record<string, string>; thinking: string }

function settingText(setting: Setting): string {
  return JSON.stringify(setting === null ? null : sorted(setting))
}

function shown(text: string): string {
  return text === 'null' ? 'default' : text
}

function applies(dimension: Dimension, harness: Overlay.Harness): boolean {
  return !dimension.harnesses || dimension.harnesses.includes(harness)
}

function genome(space: Space, overlay: Overlay.Overlay): Genome {
  const all: Record<string, unknown> = { ...overlay.levers, ...overlay.pending }
  const covered = new Set(space.dimensions.flatMap(keys))
  const loose = Object.keys(all).filter((name) => !covered.has(name))
  if (loose.length)
    fail(overlay.id + ' sets ' + loose.join(', ') + ', which no dimension of the space covers')
  return {
    harness: overlay.harness,
    settings: Object.fromEntries(
      space.dimensions.map((dimension) => {
        const held = Object.fromEntries(
          keys(dimension)
            .filter((name) => all[name] !== undefined)
            .map((name) => [name, all[name]]),
        )
        return [dimension.name, settingText(Object.keys(held).length ? held : null)]
      }),
    ),
    thinking: overlay.thinking,
  }
}

function express(space: Space, genes: Genome): Pick<Overlay.Overlay, 'levers' | 'pending'> {
  const levers: Record<string, unknown> = {}
  const pending: Record<string, unknown> = {}
  for (const dimension of space.dimensions) {
    if (!applies(dimension, genes.harness)) continue
    const setting = JSON.parse(genes.settings[dimension.name]!) as Setting
    Object.assign(dimension.pending ? pending : levers, setting ?? {})
  }
  return { levers: sorted(levers) as Overlay.Levers, pending: sorted(pending) }
}

export function random(seed: string): () => number {
  let state = 2166136261
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<Each>(items: readonly Each[], next: () => number): Each[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1))
    ;[result[index], result[other]] = [result[other]!, result[index]!]
  }
  return result
}

type Proposal = { dims: Overlay.Dim[]; genes: Genome; hypothesis: string; parent: Overlay.Overlay }

function mutations(space: Space, parent: Overlay.Overlay): Proposal[] {
  const genes = genome(space, parent)
  const found: Proposal[] = []
  for (const harness of space.harnesses)
    if (harness !== genes.harness)
      found.push({
        dims: ['codemode'],
        genes: { ...genes, harness },
        hypothesis: 'harness ' + harness + ' instead of ' + genes.harness,
        parent,
      })
  for (const thinking of space.thinking)
    if (thinking !== genes.thinking)
      found.push({
        dims: ['effort'],
        genes: { ...genes, thinking },
        hypothesis: 'thinking ' + thinking + ' instead of ' + genes.thinking,
        parent,
      })
  for (const dimension of space.dimensions) {
    if (!applies(dimension, genes.harness)) continue
    const held = genes.settings[dimension.name]!
    for (const setting of dimension.values) {
      const text = settingText(setting)
      if (text === held) continue
      found.push({
        dims: [dimension.dim],
        genes: { ...genes, settings: { ...genes.settings, [dimension.name]: text } },
        hypothesis: dimension.name + ' ' + shown(text) + ' instead of ' + shown(held),
        parent,
      })
    }
  }
  return found
}

function crossover(
  space: Space,
  pair: readonly [Overlay.Overlay, Overlay.Overlay],
  next: () => number,
): Proposal {
  const [left, right] = [genome(space, pair[0]), genome(space, pair[1])]
  const touched = new Set<Overlay.Dim>()
  const pick = <Each>(from: Each, to: Each, dim: Overlay.Dim): Each => {
    if (from === to || next() < 0.5) return from
    touched.add(dim)
    return to
  }
  const harness = pick(left.harness, right.harness, 'codemode')
  const thinking = pick(left.thinking, right.thinking, 'effort')
  const settings = Object.fromEntries(
    space.dimensions.map((dimension) => [
      dimension.name,
      pick(left.settings[dimension.name]!, right.settings[dimension.name]!, dimension.dim),
    ]),
  )
  return {
    dims: [...touched].sort(),
    genes: { harness, settings, thinking },
    hypothesis: 'crossover of ' + pair[0].id + ' and ' + pair[1].id,
    parent: pair[0],
  }
}

export type Generated = {
  candidates: Overlay.Overlay[]
  pool: number
  refused: { hypothesis: string; reason: string }[]
}

export function generate(
  space: Space,
  input: {
    gen: number
    n: number
    parents: readonly Overlay.Overlay[]
    seed: string
    seen?: readonly Overlay.Overlay[]
  },
): Generated {
  if (!Number.isSafeInteger(input.gen) || input.gen < 1) fail('gen is a whole number of at least 1')
  if (!Number.isSafeInteger(input.n) || input.n < 1) fail('n is a whole number of at least 1')
  if (!input.parents.length) fail('a generation needs at least one parent')
  const foreign = input.parents.filter((parent) => parent.model !== space.model)
  if (foreign.length)
    fail(foreign.map((parent) => parent.id).join(', ') + ' is not of the model ' + space.model)
  const next = random(input.seed + '/' + input.gen)
  const pairs = input.parents.flatMap((left, index) =>
    input.parents.slice(index + 1).map((right) => [left, right] as const),
  )
  const proposals = shuffle(
    [
      ...input.parents.flatMap((parent) => mutations(space, parent)),
      ...pairs.map((pair) => crossover(space, pair, next)),
    ],
    next,
  )
  const seen = new Set([...input.parents, ...(input.seen ?? [])].map(key))
  const refused: Generated['refused'] = []
  const valid: Overlay.Overlay[] = []
  for (const proposal of proposals) {
    const candidate: Overlay.Overlay = {
      dims: proposal.dims,
      evidence: [],
      format: Overlay.format,
      harness: proposal.genes.harness,
      hypothesis: proposal.hypothesis,
      id: space.slug + '-g' + input.gen + '-candidate',
      model: space.model,
      parent: proposal.parent.id,
      thinking: proposal.genes.thinking,
      ...express(space, proposal.genes),
    }
    if (!proposal.dims.length || seen.has(key(candidate))) continue
    seen.add(key(candidate))
    try {
      valid.push(Overlay.parse(candidate))
    } catch (error) {
      if (!(error instanceof Config.InvalidError || error instanceof Overlay.InvalidError))
        throw error
      refused.push({
        hypothesis: proposal.hypothesis,
        reason: error.message.replace(candidate.id + ' ', ''),
      })
    }
  }
  const chosen = diverse(valid, input.n)
  const width = Math.max(2, String(chosen.length).length)
  return {
    candidates: chosen.map((overlay, index) => ({
      ...overlay,
      id: space.slug + '-g' + input.gen + '-' + String(index + 1).padStart(width, '0'),
    })),
    pool: valid.length,
    refused,
  }
}

function diverse(pool: readonly Overlay.Overlay[], n: number): Overlay.Overlay[] {
  const groups = new Map<string, Overlay.Overlay[]>()
  for (const overlay of pool) {
    const group = overlay.dims.join('+')
    groups.set(group, [...(groups.get(group) ?? []), overlay])
  }
  const queues = [...groups.values()]
  const chosen: Overlay.Overlay[] = []
  while (chosen.length < n && queues.some((queue) => queue.length))
    for (const queue of queues) if (queue.length && chosen.length < n) chosen.push(queue.shift()!)
  return chosen
}

export function members(
  overlays: readonly Overlay.Overlay[],
  baseline: Overlay.Overlay,
): Overlay.Overlay[] {
  const others = overlays.filter((overlay) => overlay.id !== baseline.id)
  const foreign = others.filter((overlay) => overlay.model !== baseline.model)
  if (foreign.length)
    fail(
      foreign.map((overlay) => overlay.id).join(', ') +
        ' is not of the model of the baseline ' +
        baseline.id +
        ', ' +
        baseline.model,
    )
  if (!runnable(baseline)) fail('the baseline ' + baseline.id + ' has pending levers')
  const ids = [baseline, ...others].map((overlay) => overlay.id)
  if (new Set(ids).size !== ids.length) fail('overlay ids must be unique')
  return [baseline, ...others.filter(runnable)]
}
