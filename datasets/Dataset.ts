import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Toml from 'smol-toml'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Task from '../src/Task.ts'
import type * as Source from './Source.ts'

export class ManifestError extends Error {
  override name = 'Dataset.ManifestError'
}

export class SelectionError extends Error {
  override name = 'Dataset.SelectionError'
}

export type Case = {
  executable?: readonly string[]
  files: Record<string, Uint8Array>
  id: string
}

export type Selection = {
  limit?: number
  only?: readonly string[]
}

export type Context = Selection & {
  store: Source.Store
}

export type Adapter = {
  cases(context: Context): AsyncIterable<Case>
  description: string
  name: string
  proof: string
  source: Record<string, string>
  state: 'unverified' | 'verified'
}

export type Entry = {
  checksum: string
  id: string
  name: string
}

export type Manifest = {
  dataset: string
  schema: typeof schema
  source: Record<string, string>
  tasks: Entry[]
}

export const manifestFile = 'dataset.json'
export const schema = 'nanoeval-dataset-v1'

export function select(ids: readonly string[], selection: Selection): string[] {
  const known = new Set(ids)
  for (const id of selection.only ?? [])
    if (!known.has(id)) throw new SelectionError('the dataset has no task ' + id)
  const chosen = selection.only?.length
    ? ids.filter((id) => selection.only!.includes(id))
    : [...ids]
  return selection.limit === undefined ? chosen : chosen.slice(0, selection.limit)
}

export function toml(value: Record<string, unknown>): Uint8Array {
  return Bytes.fromText(Toml.stringify(value) + '\n')
}

export function json(value: unknown): Uint8Array {
  return Bytes.fromText(JSON.stringify(value, null, 2) + '\n')
}

export async function assets(name: string): Promise<Record<string, Uint8Array>> {
  const directory = Path.join(import.meta.dirname, 'assets', name)
  const files: Record<string, Uint8Array> = {}
  for (const entry of await Fs.readdir(directory))
    files[entry] = await Fs.readFile(Path.join(directory, entry))
  return files
}

export function taskId(text: string): string {
  const id = text.replace(/[^A-Za-z0-9._-]/g, '-')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new SelectionError(text + ' cannot name a task directory')
  return id
}

export async function read(directory: string): Promise<Manifest> {
  const path = Path.join(directory, manifestFile)
  let manifest: Manifest
  try {
    manifest = JSON.parse(await Fs.readFile(path, 'utf8')) as Manifest
  } catch (error) {
    throw new ManifestError(path + ' cannot be read: ' + (error as Error).message)
  }
  if (
    manifest?.schema !== schema ||
    typeof manifest.dataset !== 'string' ||
    !Array.isArray(manifest.tasks) ||
    manifest.tasks.some(
      (entry) =>
        typeof entry?.id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id) ||
        typeof entry.checksum !== 'string',
    )
  )
    throw new ManifestError(path + ' is not a ' + schema + ' manifest')
  return manifest
}

export async function entries(
  directory: string,
  selection: Selection,
): Promise<(Entry & { directory: string })[]> {
  const manifest = await read(directory)
  const byId = new Map(manifest.tasks.map((entry) => [entry.id, entry]))
  return select([...byId.keys()], selection).map((id) => ({
    ...byId.get(id)!,
    directory: Path.join(directory, id),
  }))
}

export async function write(
  adapter: Adapter,
  options: Context & { out: string },
): Promise<Manifest> {
  await Fs.mkdir(options.out, { recursive: true })
  const present = await Fs.stat(Path.join(options.out, manifestFile)).then(
    () => true,
    () => false,
  )
  const previous = present ? await read(options.out) : undefined
  if (
    previous &&
    (previous.dataset !== adapter.name ||
      JSON.stringify(previous.source) !== JSON.stringify(adapter.source))
  )
    throw new ManifestError(
      options.out +
        ' holds ' +
        previous.dataset +
        ' from another source: import into a new directory',
    )

  const tasks = new Map((previous?.tasks ?? []).map((entry) => [entry.id, entry]))
  const save = async () => {
    const manifest: Manifest = {
      dataset: adapter.name,
      schema,
      source: adapter.source,
      tasks: [...tasks.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    }
    await Fs.writeFile(Path.join(options.out, manifestFile), Bytes.toText(json(manifest)))
    return manifest
  }
  for await (const item of adapter.cases(options)) {
    const id = taskId(item.id)
    if (id !== item.id) throw new SelectionError(item.id + ' cannot name a task directory')
    const manifest = item.files['task.toml']
    if (!manifest) throw new Task.InvalidError(id + ' has no task.toml')
    const name = (
      Toml.parse(Bytes.toText(manifest))['task'] as Record<string, unknown> | undefined
    )?.['name']
    if (typeof name !== 'string') throw new Task.InvalidError(id + ' names no task')

    const directory = Path.join(options.out, id)
    await Fs.rm(directory, { force: true, recursive: true })
    for (const [path, data] of Object.entries(item.files)) {
      const target = Path.join(directory, path)
      await Fs.mkdir(Path.dirname(target), { recursive: true })
      await Fs.writeFile(target, data, { mode: item.executable?.includes(path) ? 0o755 : 0o644 })
    }
    tasks.set(id, { checksum: 'sha256:' + (await Task.checksum(item.files)), id, name })
  }
  return save()
}
