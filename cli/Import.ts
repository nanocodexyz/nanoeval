import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import type * as Dataset from '../datasets/Dataset.ts'
import type * as Converter from '../sandbox/Converter.ts'
import * as Store from '../sandbox/Store.ts'
import type * as Eval from '../src/Eval.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Tar from '../src/Tar.ts'
import * as Task from '../src/Task.ts'

export type Format = 'dir' | 'disk'

export type Timing = {
  adapterMs: number
  convertMs: number
  id: string
  packMs: number
  packedBytes: number
  reused: boolean
  uploadMs: number
}

export type Options = {
  cache: string
  converter: Converter.Converter
  format: Format
  log?(line: string): void
  refused?(id: string, error: Error): void
  store: Store.Store
}

type Conversion = Extract<Eval.Environment, { kind: 'disk' }>

function archive(item: Dataset.Case, directory: string, skip: readonly string[] = []): Uint8Array {
  return Tar.pack(
    Object.entries(item.files)
      .filter(([path]) => path.startsWith(directory + '/') && !skip.includes(path))
      .map(([path, data]) => ({
        data,
        executable: item.executable?.includes(path) ?? false,
        path,
      })),
  )
}

async function convert(
  item: Dataset.Case,
  task: Task.Task,
  options: Options,
): Promise<{
  convertMs: number
  environment: Conversion
  packMs: number
  reused: boolean
  uploadMs: number
}> {
  const image = task.environment.dockerImage
  const context = image === undefined ? archive(item, 'environment') : undefined
  const source =
    image ?? 'dockerfile:' + Crypto.createHash('sha256').update(context!).digest('hex').slice(0, 24)
  const key = Crypto.createHash('sha256')
    .update(
      JSON.stringify({
        converter: options.converter.name,
        source,
        storageMb: task.environment.storageMb,
      }),
    )
    .digest('hex')
  const record = Path.join(options.cache, 'conversions', key + '.json')
  const known = await Fs.readFile(record, 'utf8').then(
    (text) => JSON.parse(text) as Conversion,
    () => undefined,
  )
  if (known && (await options.store.has(known.disk.digest)))
    return { convertMs: 0, environment: known, packMs: 0, reused: true, uploadMs: 0 }

  const scratch = Path.join(options.cache, 'scratch', key + '-' + process.pid)
  await Fs.rm(scratch, { force: true, recursive: true })
  await Fs.mkdir(scratch, { recursive: true })
  try {
    const started = Date.now()
    if (context) {
      for (const [path, data] of Object.entries(item.files)) {
        if (!path.startsWith('environment/')) continue
        const target = Path.join(scratch, 'context', path.slice('environment/'.length))
        await Fs.mkdir(Path.dirname(target), { recursive: true })
        await Fs.writeFile(target, data, { mode: item.executable?.includes(path) ? 0o755 : 0o644 })
      }
    }
    const disk = Path.join(scratch, 'disk.ext4')
    const meta = await options.converter.convert(
      {
        ...(context ? { context: Path.join(scratch, 'context') } : { image: image! }),
        storageMb: task.environment.storageMb,
      },
      disk,
    )
    const built = Date.now()
    const packed = Path.join(scratch, 'disk.packed')
    await options.converter.pack(disk, packed)
    const converted = Date.now()
    const blob = await Store.add(options.store, packed)
    const environment: Conversion = {
      disk: blob,
      format: options.converter.format,
      kind: 'disk',
      meta,
      source,
    }
    await Fs.mkdir(Path.dirname(record), { recursive: true })
    await Fs.writeFile(record, JSON.stringify(environment))
    return {
      convertMs: built - started,
      environment,
      packMs: converted - built,
      reused: false,
      uploadMs: Date.now() - converted,
    }
  } finally {
    await Fs.rm(scratch, { force: true, recursive: true })
  }
}

export async function normalize(
  item: Dataset.Case,
  options: Options,
): Promise<{ task: Eval.Task; timing: Omit<Timing, 'adapterMs'> }> {
  const source = { ...(item.executable ? { executable: item.executable } : {}), files: item.files }
  const task = item.files['solution/solve.sh']
    ? await Task.load(source, { solution: true }).catch((error: unknown) => {
        if (error instanceof Task.InvalidError && !item.files[Task.finalMessagePath])
          return Task.load(source)
        throw error
      })
    : await Task.load(source)
  const instruction = item.files['instruction.md']!
  if (Bytes.toValidText(instruction) === undefined)
    throw new Task.InvalidError(item.id + ' has an instruction.md that is not UTF-8')

  let convertMs = 0
  let packMs = 0
  let uploadMs = 0
  let reused = false
  let environment: Eval.Environment
  const scratch = Path.join(options.cache, 'scratch')
  const upload = async (bytes: Uint8Array) => {
    const started = Date.now()
    const blob = await Store.addBytes(options.store, { bytes, scratch })
    uploadMs += Date.now() - started
    return blob
  }
  if (options.format === 'disk') {
    const converted = await convert(item, task, options)
    ;({ convertMs, environment, packMs, reused } = converted)
    uploadMs += converted.uploadMs
  } else {
    environment = {
      files: await upload(archive(item, 'environment', ['environment/Dockerfile'])),
      kind: 'dir',
    }
  }

  return {
    task: {
      agent: task.agent,
      checksum: task.checksum,
      description: task.description,
      env: task.environment.env,
      environment,
      id: item.id,
      instruction: await upload(instruction),
      name: task.name,
      network: { allowInternet: task.environment.allowInternet },
      resources: {
        cpus: task.environment.cpus,
        memoryMb: task.environment.memoryMb,
        storageMb: task.environment.storageMb,
      },
      ...(task.environment.buildTimeoutSec === undefined
        ? {}
        : { setupTimeoutSec: task.environment.buildTimeoutSec }),
      ...(task.solution
        ? {
            solution: {
              archive: await upload(archive(item, 'solution')),
              env: task.solution.env,
              ...(item.files[Task.finalMessagePath] ? { finalMessage: true as const } : {}),
            },
          }
        : {}),
      tests: await upload(archive(item, 'tests')),
      verifier: {
        ...(task.verifier.ctrf ? { ctrf: true as const } : {}),
        env: task.verifier.env,
        ...(task.verifier.finalMessage ? { finalMessage: true as const } : {}),
        ...(task.verifier.judge ? { judge: true as const } : {}),
        timeoutSec: task.verifier.timeoutSec,
      },
    },
    timing: {
      convertMs,
      id: item.id,
      packMs,
      packedBytes: environment.kind === 'disk' ? environment.disk.bytes : environment.files.bytes,
      reused,
      uploadMs,
    },
  }
}

export async function cases(
  source: AsyncIterable<Dataset.Case>,
  options: Options,
): Promise<{ tasks: Eval.Task[]; timings: Timing[] }> {
  const tasks: Eval.Task[] = []
  const timings: Timing[] = []
  const iterator = source[Symbol.asyncIterator]()
  for (;;) {
    const started = Date.now()
    const next = await iterator.next()
    if (next.done) break
    const adapterMs = Date.now() - started
    const normalized = await normalize(next.value, options).catch((error: Error) => {
      error.message = next.value.id + ': ' + error.message
      if (!options.refused) throw error
      options.refused(next.value.id, error)
      return undefined
    })
    if (!normalized) continue
    const { task, timing } = normalized
    tasks.push(task)
    timings.push({ adapterMs, ...timing })
    options.log?.(
      task.id +
        ': adapter ' +
        adapterMs +
        ' ms, convert ' +
        timing.convertMs +
        ' ms' +
        (timing.reused ? ' (reused)' : '') +
        ', pack ' +
        timing.packMs +
        ' ms, upload ' +
        timing.uploadMs +
        ' ms, environment ' +
        timing.packedBytes +
        ' bytes',
    )
  }
  return { tasks, timings }
}

async function walk(
  root: string,
  directory = '',
): Promise<{ executable: boolean; path: string }[]> {
  const found: { executable: boolean; path: string }[] = []
  for (const entry of await Fs.readdir(Path.join(root, directory), { withFileTypes: true })) {
    const path = directory ? directory + '/' + entry.name : entry.name
    if (entry.isDirectory()) found.push(...(await walk(root, path)))
    else if (entry.isFile())
      found.push({ executable: ((await Fs.stat(Path.join(root, path))).mode & 0o111) !== 0, path })
  }
  return found
}

export async function readDirectory(root: string): Promise<Dataset.Case> {
  const entries = await walk(root)
  const files: Record<string, Uint8Array> = {}
  for (const entry of entries) files[entry.path] = await Fs.readFile(Path.join(root, entry.path))
  return {
    executable: entries.filter((entry) => entry.executable).map((entry) => entry.path),
    files,
    id: Path.basename(Path.resolve(root)),
  }
}

export async function* directories(roots: readonly string[]): AsyncIterable<Dataset.Case> {
  for (const root of roots) yield await readDirectory(root)
}

export const local = { dataset: 'local', name: 'local', source: {} as Record<string, string> }
