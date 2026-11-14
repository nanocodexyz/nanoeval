import type * as Eval from './Eval.ts'

export class InvalidError extends Error {
  override name = 'Subset.InvalidError'
}

export class UnknownError extends Error {
  override name = 'Subset.UnknownError'
}

export type Entry = Pick<Eval.Entry, 'id' | 'name'>

export type Subsets = Record<string, Record<string, readonly string[]>>

export function glob(text: string): boolean {
  return /[*?]/.test(text)
}

function pattern(text: string): RegExp {
  return new RegExp(
    '^' +
      text
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  )
}

function short(name: string): string {
  return name.split('/').at(-1)!
}

export function match(
  entries: readonly Entry[],
  wanted: readonly string[],
): { ids: string[]; unknown: string[] } {
  const chosen = new Set<string>()
  const unknown: string[] = []
  for (const text of wanted) {
    const found = glob(text)
      ? entries.filter((entry) =>
          [entry.id, entry.name, short(entry.name)].some((value) => pattern(text).test(value)),
        )
      : entries.filter((entry) => entry.id === text || entry.name === text)
    const named = found.length ? found : entries.filter((entry) => short(entry.name) === text)
    if (!glob(text) && named.length > 1)
      throw new InvalidError(
        text + ' names ' + named.length + ' tasks: ' + named.map((entry) => entry.name).join(', '),
      )
    if (!named.length) unknown.push(text)
    for (const entry of named) chosen.add(entry.id)
  }
  return { ids: entries.flatMap((entry) => (chosen.has(entry.id) ? [entry.id] : [])), unknown }
}

export function resolve(
  entries: readonly Entry[],
  input: { eval: string; wanted: readonly string[] },
): string[] {
  const found = match(entries, input.wanted)
  if (found.unknown.length)
    throw new UnknownError(
      found.unknown
        .map((text) =>
          glob(text)
            ? 'no task of the eval ' + input.eval + ' matches ' + text
            : 'the eval ' + input.eval + ' has no task ' + text,
        )
        .join(', and '),
    )
  return found.ids
}

export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

export function parse(text: string, file: string): Subsets {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new InvalidError(file + ' is not JSON: ' + (error as Error).message)
  }
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
  if (
    !object(value) ||
    !Object.values(value).every(
      (subsets) =>
        object(subsets) &&
        Object.values(subsets).every(
          (tasks) =>
            Array.isArray(tasks) &&
            tasks.length > 0 &&
            tasks.every((task) => typeof task === 'string'),
        ),
    )
  )
    throw new InvalidError(
      file + ' has to hold {"EVAL": {"SUBSET": ["task id, name or pattern", ...]}}',
    )
  return value as Subsets
}

export function named(
  subsets: Subsets,
  input: { eval: string; file: string; names: readonly string[] },
): string[] {
  const own = subsets[input.eval] ?? {}
  return input.names.flatMap((name) => {
    const tasks = own[name]
    if (!tasks)
      throw new UnknownError(
        input.file +
          ' has no subset ' +
          name +
          ' of the eval ' +
          input.eval +
          (Object.keys(own).length ? ': it has ' + Object.keys(own).sort().join(', ') : ''),
      )
    return [...tasks]
  })
}
