import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'

export class InvalidError extends Error {
  override name = 'Suite.InvalidError'
}

export type Expect = {
  cells?: number
  ok?: boolean
  stalled?: boolean
  text?: string
  timedOut?: boolean
}

export type Turn = { expect?: Expect; prompt: string }

export type Slo = {
  max?: number
  metric: string
  min?: number
  note?: string
  stat: 'mean' | 'p50' | 'p95'
}

export type Kind = 'coldwarm' | 'sustained' | 'turns'

export type Scenario = {
  concurrency: number[]
  deadlineMs: number
  description: string
  durationS?: number
  id: string
  kind: Kind
  model?: string
  reps: number
  slo: Slo[]
  stallMs: number
  thinking?: string
  turns: Turn[]
}

export type Suite = {
  dir: string
  digest: string
  model?: string
  name: string
  scenarios: Scenario[]
  thinking?: string
  version: string
}

type Raw = {
  defaults?: {
    deadlineMs?: number
    model?: string
    reps?: number
    stallMs?: number
    thinking?: string
  }
  name?: unknown
  scenarios?: unknown
  version?: unknown
}

export async function locate(spec: string): Promise<string> {
  const tries = [spec]
  const root = process.env['NANOEVAL_SUITES']
  if (root && !Path.isAbsolute(spec)) {
    tries.push(Path.join(root, spec), Path.join(root, 'systems', spec))
  }
  for (const at of tries) {
    const file = at.endsWith('.json') ? at : Path.join(at, 'suite.json')
    const found = await Fs.stat(file).catch(() => undefined)
    if (found?.isFile()) return Path.resolve(file)
  }
  throw new InvalidError(
    'no systems suite at ' +
      tries.join(' or ') +
      ' (a directory with suite.json, or NANOEVAL_SUITES)',
  )
}

export async function load(spec: string): Promise<Suite> {
  const file = await locate(spec)
  const text = await Fs.readFile(file, 'utf8')
  const { createHash } = await import('node:crypto')
  return parse(
    JSON.parse(text) as Raw,
    Path.dirname(file),
    createHash('sha256').update(text).digest('hex').slice(0, 12),
  )
}

function whole(value: unknown, what: string, least = 1): number {
  if (!Number.isInteger(value) || (value as number) < least)
    throw new InvalidError(
      what + ' is a whole number of at least ' + least + ', not ' + JSON.stringify(value),
    )
  return value as number
}

export function parse(raw: Raw, dir = '.', digest = 'inline'): Suite {
  if (typeof raw.name !== 'string' || !raw.name) throw new InvalidError('a suite has a name')
  if (typeof raw.version !== 'string' || !raw.version)
    throw new InvalidError('a suite has a version')
  if (!Array.isArray(raw.scenarios) || !raw.scenarios.length)
    throw new InvalidError('a suite has at least one scenario')
  const defaults = raw.defaults ?? {}
  const seen = new Set<string>()
  const scenarios = raw.scenarios.map((entry: Record<string, unknown>): Scenario => {
    const id = entry['id']
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id))
      throw new InvalidError(
        'a scenario id is lowercase letters, digits and dashes, not ' + JSON.stringify(id),
      )
    if (seen.has(id)) throw new InvalidError('scenario ' + id + ' is named twice')
    seen.add(id)
    const kind = (entry['kind'] ?? 'turns') as Kind
    if (!['coldwarm', 'sustained', 'turns'].includes(kind))
      throw new InvalidError(
        'scenario ' + id + ' has kind turns, coldwarm or sustained, not ' + kind,
      )
    const turns = entry['turns']
    if (!Array.isArray(turns) || !turns.length)
      throw new InvalidError('scenario ' + id + ' has turns')
    for (const turn of turns as Turn[])
      if (typeof turn?.prompt !== 'string' || !turn.prompt)
        throw new InvalidError('every turn of scenario ' + id + ' has a prompt')
    if (kind === 'coldwarm' && turns.length < 2)
      throw new InvalidError('coldwarm scenario ' + id + ' has a cold turn and a warm turn')
    const concurrency = ((entry['concurrency'] as unknown[] | undefined) ?? [1]).map((value) =>
      whole(value, 'a concurrency of scenario ' + id),
    )
    const slo = ((entry['slo'] as Slo[] | undefined) ?? []).map((item) => {
      if (typeof item.metric !== 'string' || !['mean', 'p50', 'p95'].includes(item.stat))
        throw new InvalidError(
          'an SLO of scenario ' + id + ' has a metric and a stat of mean, p50 or p95',
        )
      if (item.max === undefined && item.min === undefined)
        throw new InvalidError('an SLO of scenario ' + id + ' has a max or a min')
      return item
    })
    const durationS = entry['durationS']
    if (kind === 'sustained') whole(durationS, 'durationS of sustained scenario ' + id)
    const model = (entry['model'] as string | undefined) ?? defaults.model
    const thinking = (entry['thinking'] as string | undefined) ?? defaults.thinking
    return {
      concurrency,
      deadlineMs: whole(
        entry['deadlineMs'] ?? defaults.deadlineMs ?? 120_000,
        'deadlineMs of ' + id,
      ),
      description: String(entry['description'] ?? ''),
      ...(kind === 'sustained' ? { durationS: durationS as number } : {}),
      id,
      kind,
      ...(model ? { model } : {}),
      reps: whole(entry['reps'] ?? defaults.reps ?? 1, 'reps of ' + id),
      slo,
      stallMs: whole(entry['stallMs'] ?? defaults.stallMs ?? 30_000, 'stallMs of ' + id),
      ...(thinking ? { thinking } : {}),
      turns: turns as Turn[],
    }
  })
  return {
    dir,
    digest,
    ...(defaults.model ? { model: defaults.model } : {}),
    name: raw.name,
    scenarios,
    ...(defaults.thinking ? { thinking: defaults.thinking } : {}),
    version: raw.version,
  }
}

export function pick(
  suite: Suite,
  ids: readonly string[] | undefined,
  concurrency?: readonly number[],
): Suite {
  let scenarios = suite.scenarios
  if (ids?.length) {
    const missing = ids.find((id) => !scenarios.some((scenario) => scenario.id === id))
    if (missing)
      throw new InvalidError(
        'suite ' +
          suite.name +
          ' has no scenario ' +
          missing +
          ' (it has ' +
          scenarios.map((s) => s.id).join(', ') +
          ')',
      )
    scenarios = scenarios.filter((scenario) => ids.includes(scenario.id))
  }
  if (concurrency?.length)
    scenarios = scenarios
      .map((scenario) => ({
        ...scenario,
        concurrency: scenario.concurrency.filter((level) => concurrency.includes(level)),
      }))
      .filter((scenario) => scenario.concurrency.length)
  return { ...suite, scenarios }
}
