import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'

export type Entry = {
  at: number
  kind: 'blob' | 'disk' | 'staged'
  name: string
  path: string
}

const blobName = /^[0-9a-f]{64}$/
const stagedName = /^[0-9a-f]{64}\.(\d+)-[0-9a-f]{8}$/

export function idle(
  names: readonly string[],
  input: { held: ReadonlySet<string>; mark: string },
): string[] {
  return names
    .filter((name) => name.endsWith(input.mark))
    .map((name) => name.slice(0, -input.mark.length))
    .filter((digest) => !input.held.has(digest) && names.includes(digest + '.ext4'))
    .sort()
}

async function names(directory: string): Promise<string[]> {
  return Fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

async function modified(file: string): Promise<number | undefined> {
  return Fs.stat(file).then(
    (stat) => stat.mtimeMs,
    () => undefined,
  )
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function cached(cache: string): Promise<Entry[]> {
  const found: Entry[] = []
  const disks = Path.join(cache, 'disks')
  for (const name of await names(disks)) {
    if (!name.endsWith('.ext4')) continue
    const digest = name.slice(0, -'.ext4'.length)
    const prefix = Path.join(disks, digest)
    const times = (
      await Promise.all(['.ext4', '.workdir'].map((suffix) => modified(prefix + suffix)))
    ).filter((time) => time !== undefined)
    if (times.length)
      found.push({ at: Math.max(...times), kind: 'disk', name: digest, path: prefix })
  }
  const blobs = Path.join(cache, 'blobs')
  for (const name of await names(blobs)) {
    const staged = stagedName.exec(name)
    if (!blobName.test(name) && !(staged && !alive(Number(staged[1])))) continue
    const at = await modified(Path.join(blobs, name))
    if (at !== undefined)
      found.push({
        at,
        kind: staged ? 'staged' : 'blob',
        name: staged ? name.slice(0, 64) : name,
        path: Path.join(blobs, name),
      })
  }
  return found
}

export function order(entries: readonly Entry[], held: ReadonlySet<string>): Entry[] {
  return entries
    .filter((entry) => entry.kind === 'staged' || !held.has(entry.name))
    .sort((left, right) => left.at - right.at || (left.path < right.path ? -1 : 1))
}

export async function forget(prefix: string): Promise<boolean> {
  const gone = await Fs.stat(prefix + '.ext4').then(
    () => false,
    () => true,
  )
  if (!gone) return false
  const directory = Path.dirname(prefix)
  const base = Path.basename(prefix)
  const marks = (await names(directory)).filter((name) => name.startsWith(base + '.run-'))
  for (const name of [base + '.use', base + '.lock', ...marks])
    await Fs.rm(Path.join(directory, name), { force: true })
  return true
}

export async function collect(options: collect.Options): Promise<Entry[]> {
  const removed: Entry[] = []
  for (const entry of order(await cached(options.cache), options.held)) {
    if (!(await options.short())) break
    if (entry.kind === 'disk' ? await options.drop(entry.path) : await remove(entry.path)) {
      removed.push(entry)
      options.log(
        'removed the ' +
          (entry.kind === 'disk' ? 'disk ' : entry.kind === 'blob' ? 'blob ' : 'partial blob ') +
          entry.name +
          ', last used ' +
          new Date(entry.at).toISOString() +
          ', which no row here needs',
      )
    }
  }
  return removed
}

export declare namespace collect {
  type Options = {
    cache: string
    drop(prefix: string): Promise<boolean>
    held: ReadonlySet<string>
    log(line: string): void
    short(): Promise<boolean>
  }
}

async function remove(file: string): Promise<boolean> {
  await Fs.rm(file, { force: true })
  return true
}
