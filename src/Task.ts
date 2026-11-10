import * as Toml from 'smol-toml'
import * as Bytes from './internal/Bytes.ts'

export class InvalidError extends Error {
  override name = 'Task.InvalidError'
}

export class UnsupportedError extends Error {
  override name = 'Task.UnsupportedError'
}

export type Task = {
  agent: { timeoutSec: number }
  checksum: string
  description: string
  environment: {
    allowInternet: boolean
    buildTimeoutSec?: number
    cpus: number
    dockerImage?: string
    env: Record<string, string>
    memoryMb: number
    storageMb: number
  }
  executable: readonly string[]
  files: Record<string, string>
  instruction: string
  name: string
  solution?: { env: Record<string, string> }
  verifier: {
    env: Record<string, string>
    finalMessage?: true
    judge?: true
    timeoutSec: number
  }
}

export type Source = {
  executable?: readonly string[]
  files: Record<string, Uint8Array>
}

export const report = 'ctrf.json'
export const schemaVersion = '1.1'
export const earlierVersion = '1.0'
export const finalMessagePath = 'solution/final_message.txt'
export const verifierInputs = 'tests/.nanoeval'

const compose = ['environment/docker-compose.yaml', 'environment/docker-compose.yml']
const packageDirectories = ['environment', 'solution', 'steps', 'tests']
const packageFiles = ['instruction.md', 'README.md', 'task.toml']
const shippedDirectories = ['environment/', 'tests/']

export async function load(source: Source, options: load.Options = {}): Promise<Task> {
  const manifest = source.files['task.toml']
  const instruction = source.files['instruction.md']
  if (!manifest) throw new InvalidError('the task has no task.toml')
  if (!instruction) throw new InvalidError('the task has no instruction.md')
  if (!source.files['tests/test.sh']) throw new InvalidError('the task has no tests/test.sh')

  let raw: Record<string, unknown>
  try {
    raw = Toml.parse(Bytes.toText(manifest))
  } catch (error) {
    throw new InvalidError('task.toml is not valid TOML: ' + (error as Error).message)
  }
  const earlier = raw['schema_version'] === undefined && raw['version'] === earlierVersion
  if (raw['schema_version'] !== schemaVersion && !earlier)
    throw new UnsupportedError(
      'task schema_version must be ' + schemaVersion + ', not ' + String(raw['schema_version']),
    )

  const task = table(raw, 'task')
  const agent = table(raw, 'agent')
  const verifier = table(raw, 'verifier')
  const environment = table(raw, 'environment')
  const metadata = raw['metadata'] === undefined ? {} : table(raw, 'metadata')
  const extension = metadata['nanoeval'] === undefined ? {} : table(metadata, 'nanoeval')
  const finalMessage = flag(extension, 'final_message')
  const judge = flag(extension, 'judge')

  if (compose.some((path) => path in source.files))
    throw new UnsupportedError('tasks with a Compose file are not supported')
  if (number(environment, 'gpus', 0) > 0) throw new UnsupportedError('GPU tasks are not supported')
  if ((verifier['environment_mode'] ?? 'same') !== 'same')
    throw new UnsupportedError('verifier environment_mode must be same')
  const servers = environment['mcp_servers']
  if (servers !== undefined && !(Array.isArray(servers) && servers.length === 0))
    throw new UnsupportedError('tasks with mcp_servers are not supported')

  const image = environment['docker_image']
  if (image !== undefined && (typeof image !== 'string' || !image))
    throw new InvalidError('environment.docker_image must be a nonempty string')
  if (image === undefined && !source.files['environment/Dockerfile'])
    throw new InvalidError(
      'the task has neither environment.docker_image nor environment/Dockerfile',
    )

  if (options.solution && !source.files['solution/solve.sh'])
    throw new InvalidError('the task has no solution/solve.sh')
  if (options.solution && finalMessage && !source.files[finalMessagePath])
    throw new InvalidError('the task answers with its final message and has no ' + finalMessagePath)
  const solution = raw['solution'] === undefined ? {} : table(raw, 'solution')
  const shipped = [
    ...(image === undefined ? ['environment/'] : []),
    ...(options.solution ? ['solution/'] : []),
    'tests/',
  ]
  const files: Record<string, string> = {}
  for (const [path, data] of Object.entries(source.files))
    if (shipped.some((directory) => path.startsWith(directory))) files[path] = Bytes.toBase64(data)

  return {
    agent: { timeoutSec: positive(agent, 'timeout_sec') },
    checksum: 'sha256:' + (await checksum(source.files)),
    description: typeof task['description'] === 'string' ? task['description'] : '',
    environment: {
      allowInternet: environment['allow_internet'] !== false,
      ...(environment['build_timeout_sec'] === undefined
        ? {}
        : { buildTimeoutSec: positive(environment, 'build_timeout_sec') }),
      cpus: positive(environment, 'cpus'),
      ...(image === undefined ? {} : { dockerImage: image }),
      env: strings(environment, 'env'),
      memoryMb: positive(environment, 'memory_mb'),
      storageMb: positive(environment, 'storage_mb'),
    },
    executable: (source.executable ?? []).filter((path) => path in files).sort(),
    files,
    instruction: Bytes.toText(instruction),
    name: string(task, 'name'),
    ...(options.solution ? { solution: { env: strings(solution, 'env') } } : {}),
    verifier: {
      env: strings(verifier, 'env'),
      ...(finalMessage ? { finalMessage } : {}),
      ...(judge ? { judge } : {}),
      timeoutSec: positive(verifier, 'timeout_sec'),
    },
  }
}

export declare namespace load {
  type Options = {
    solution?: boolean
  }
}

export function parse(value: unknown): Task {
  const task = value as Task
  const valid =
    typeof task === 'object' &&
    task !== null &&
    typeof task.name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(task.name) &&
    typeof task.instruction === 'string' &&
    task.instruction.trim() !== '' &&
    typeof task.checksum === 'string' &&
    Number.isFinite(task.agent?.timeoutSec) &&
    task.agent.timeoutSec > 0 &&
    Number.isFinite(task.verifier?.timeoutSec) &&
    task.verifier.timeoutSec > 0 &&
    (task.verifier.finalMessage === undefined || task.verifier.finalMessage === true) &&
    (task.verifier.judge === undefined || task.verifier.judge === true) &&
    (!task.solution ||
      !task.verifier.finalMessage ||
      typeof task.files[finalMessagePath] === 'string') &&
    Number.isFinite(task.environment?.cpus) &&
    task.environment.cpus > 0 &&
    Number.isSafeInteger(task.environment?.memoryMb) &&
    task.environment.memoryMb > 0 &&
    (task.environment.buildTimeoutSec === undefined ||
      (Number.isFinite(task.environment.buildTimeoutSec) &&
        task.environment.buildTimeoutSec > 0)) &&
    typeof task.files === 'object' &&
    task.files !== null &&
    typeof task.files['tests/test.sh'] === 'string' &&
    Array.isArray(task.executable) &&
    (task.solution === undefined || typeof task.files['solution/solve.sh'] === 'string') &&
    Object.keys(task.files).every((path) =>
      [...shippedDirectories, ...(task.solution ? ['solution/'] : [])].some((directory) =>
        path.startsWith(directory),
      ),
    )
  if (!valid) throw new InvalidError('the task is not a normalized nanoeval task')
  return task
}

export async function checksum(files: Record<string, Uint8Array>): Promise<string> {
  const packaged = Object.keys(files)
    .filter(
      (path) =>
        packageFiles.includes(path) ||
        packageDirectories.some((directory) => path.startsWith(directory + '/')),
    )
    .sort()
  const lines: string[] = []
  for (const path of packaged) lines.push(path + '\0' + (await Bytes.sha256(files[path]!)) + '\n')
  return Bytes.sha256(Bytes.fromText(lines.join('')))
}

function flag(table: Record<string, unknown>, key: string): true | undefined {
  const value = table[key]
  if (value !== undefined && typeof value !== 'boolean')
    throw new InvalidError('metadata.nanoeval.' + key + ' must be true or false')
  return value === true ? true : undefined
}

function number(table: Record<string, unknown>, key: string, fallback: number): number {
  const value = table[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new InvalidError(key + ' must be a number')
  return value
}

function positive(table: Record<string, unknown>, key: string): number {
  const value = table[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new InvalidError(key + ' must be a positive number')
  return value
}

function string(table: Record<string, unknown>, key: string): string {
  const value = table[key]
  if (typeof value !== 'string' || !value)
    throw new InvalidError(key + ' must be a nonempty string')
  return value
}

function strings(table: Record<string, unknown>, key: string): Record<string, string> {
  const value = table[key]
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidError(key + ' must be a table of strings')
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new InvalidError(key + '.' + name + ' must be a string')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(entry))
      throw new InvalidError(key + '.' + name + ' is not a single-line environment variable')
  }
  return { ...(value as Record<string, string>) }
}

function table(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidError('task.toml has no [' + key + '] table')
  return value as Record<string, unknown>
}
