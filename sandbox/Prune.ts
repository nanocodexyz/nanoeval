import { spawn } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Eval from '../src/Eval.ts'
import * as Host from './Host.ts'
import * as Store from './Store.ts'

export class EmptyError extends Error {
  override name = 'Prune.EmptyError'
}

export class LauncherError extends Error {
  override name = 'Prune.LauncherError'
}

export class MissingError extends Error {
  override name = 'Prune.MissingError'
}

export type Api = {
  eval(reference: string, options: { tasks: true }): Promise<{ tasks?: Eval.Task[] }>
  evals(): Promise<{ evals: { name: string }[] }>
  versions(name: string): Promise<{ versions: { digest: string }[] }>
}

export type Found = {
  bytes: number
  kind: 'blob' | 'staged' | 'unknown'
  name: string
  path: string
}

export type References = { digests: Set<string>; evals: number; versions: number }

export type Result = {
  kept: Found[]
  missing: number
  references: References
  removed: boolean
  unknown: Found[]
  unreferenced: Found[]
}

const blobName = /^[0-9a-f]{64}$/
const script = Path.join(import.meta.dirname, 'slot.sh')
const stagedName = /^[0-9a-f]{64}\.\d+-[0-9a-f]{8}$/

export async function referenced(api: Api): Promise<References> {
  const digests = new Set<string>()
  const { evals } = await api.evals()
  let versions = 0
  for (const entry of evals)
    for (const version of (await api.versions(entry.name)).versions) {
      const reference = entry.name + '@' + version.digest
      const { tasks } = await api.eval(reference, { tasks: true })
      if (!tasks) throw new Eval.InvalidError('the Worker did not list the tasks of ' + reference)
      for (const task of tasks)
        for (const blob of Eval.blobs(task, { solution: true })) digests.add(blob.digest)
      versions++
    }
  return { digests, evals: evals.length, versions }
}

async function list(directory: string) {
  const entries = await Fs.readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  return entries.sort((left, right) => (left.name < right.name ? -1 : 1))
}

export async function scan(root: string): Promise<Found[]> {
  const base = Path.join(root, 'sha256')
  const found: Found[] = []
  for (const prefix of await list(base)) {
    if (!prefix.isDirectory()) {
      found.push({
        bytes: 0,
        kind: 'unknown',
        name: prefix.name,
        path: Path.join(base, prefix.name),
      })
      continue
    }
    for (const entry of await list(Path.join(base, prefix.name))) {
      const path = Path.join(base, prefix.name, entry.name)
      const stat = await Fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!stat) continue
      const blob = blobName.test(entry.name) && entry.name.startsWith(prefix.name)
      const kind = !stat.isFile()
        ? 'unknown'
        : blob
          ? 'blob'
          : stagedName.test(entry.name)
            ? 'staged'
            : 'unknown'
      found.push({
        bytes: stat.size,
        kind,
        name: kind === 'blob' ? entry.name : prefix.name + '/' + entry.name,
        path,
      })
    }
  }
  return found
}

const bytes = (entries: readonly Found[]) => entries.reduce((sum, entry) => sum + entry.bytes, 0)

export async function store(options: store.Options): Promise<Result> {
  const present = await Fs.stat(Path.join(options.root, 'sha256')).then(
    (stat) => stat.isDirectory(),
    () => false,
  )
  if (!present) throw new MissingError('no directory store is at ' + options.root)
  const held = options.remove ? await Store.lock(options.root, 'exclusive') : undefined
  try {
    const references = await referenced(options.api)
    const found = await scan(options.root)
    const blobs = found.filter((entry) => entry.kind === 'blob')
    const kept = blobs.filter((entry) => references.digests.has(entry.name))
    const unknown = found.filter((entry) => entry.kind === 'unknown')
    const unreferenced = found.filter(
      (entry) =>
        entry.kind === 'staged' || (entry.kind === 'blob' && !references.digests.has(entry.name)),
    )
    const emptied = blobs.length > 0 && kept.length === 0
    if (options.remove && emptied && !options.allowEmpty)
      throw new EmptyError(
        (references.evals === 0
          ? 'the Worker lists no eval'
          : 'the ' + references.evals + ' evals of the Worker name no blob of ' + options.root) +
          ': removing would empty the store. --allow-empty says that this is meant',
      )
    options.log(
      'referenced: ' +
        references.digests.size +
        ' blobs by ' +
        references.versions +
        ' versions of ' +
        references.evals +
        ' evals, ' +
        (references.digests.size - kept.length) +
        ' of them not in this store',
    )
    for (const entry of unknown) options.log('unknown ' + entry.name)
    for (const entry of unreferenced) {
      if (options.remove) await Fs.rm(entry.path)
      options.log(
        (options.remove ? 'removed ' : 'unreferenced ') +
          entry.kind +
          ' ' +
          entry.name +
          ' ' +
          entry.bytes +
          ' bytes',
      )
    }
    options.log(
      'total: ' +
        unreferenced.length +
        (options.remove ? ' removed, ' : ' unreferenced, ') +
        bytes(unreferenced) +
        ' bytes; ' +
        kept.length +
        ' kept, ' +
        bytes(kept) +
        ' bytes',
    )
    if (!options.remove && emptied && !options.allowEmpty)
      options.log('no blob of this store is referenced: --remove is refused without --allow-empty')
    return {
      kept,
      missing: references.digests.size - kept.length,
      references,
      removed: options.remove,
      unknown,
      unreferenced,
    }
  } finally {
    await held?.release()
  }
}

export declare namespace store {
  type Options = {
    allowEmpty: boolean
    api: Api
    log(line: string): void
    remove: boolean
    root: string
  }
}

function run(
  command: readonly [program: string, ...arguments: string[]],
  stdout: 'ignore' | 'inherit',
): Promise<number> {
  const [program, ...rest] = command
  const child = spawn(program, rest, {
    env: Host.environment(),
    stdio: ['ignore', stdout, 'inherit'],
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

export async function layers(options: layers.Options): Promise<number> {
  const tools = await run(
    ['env', 'NANOEVAL_HOME=' + options.home, 'bash', script, 'tools'],
    'ignore',
  )
  if (tools !== 0)
    throw new LauncherError('the launcher was not set up: slot.sh tools exited ' + tools)
  return run(
    [
      Path.join(options.home, 'rt', 'krun', 'nanoeval-krun'),
      'image',
      'prune',
      '--cache',
      options.layers,
      '--days',
      options.days,
      ...(options.remove ? ['--remove'] : []),
    ],
    'inherit',
  )
}

export declare namespace layers {
  type Options = { days: string; home: string; layers: string; remove: boolean }
}
