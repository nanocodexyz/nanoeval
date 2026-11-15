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
    allowInternet?: boolean
    ctrf?: boolean
    env: Record<string, string>
    finalMessage?: true
    judge?: true
    separate?: Separate
    timeoutSec: number
  }
}

export type Separate = {
  artifacts: readonly { exclude: readonly string[]; source: string }[]
  collect: readonly { command: string; timeoutSec: number }[]
  cpus: number
  dockerImage?: string
  memoryMb: number
  storageMb: number
}

export type Source = {
  executable?: readonly string[]
  files: Record<string, Uint8Array>
}

export const report = 'ctrf.json'
export const schemaVersions = ['1', '1.0', '1.1', '1.2', '1.3', '1.4', '2.0']
export const artifactsPath = '/logs/artifacts'
export const collectTimeoutSec = 60
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
  const version = raw['schema_version'] ?? raw['version']
  if (version !== undefined && !schemaVersions.includes(version as string))
    throw new UnsupportedError(
      'task schema_version must be one of ' +
        schemaVersions.join(', ') +
        ', not ' +
        String(version),
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
  const own = verifier['environment'] === undefined ? undefined : table(verifier, 'environment')
  const mode = verifier['environment_mode'] ?? (own ? 'separate' : 'shared')
  if (!['same', 'separate', 'shared'].includes(mode as string))
    throw new InvalidError('verifier.environment_mode must be shared or separate')
  if (mode !== 'separate' && own)
    throw new InvalidError('a shared verifier has no [verifier.environment]')
  const separate =
    mode === 'separate'
      ? separateVerifier(source, { environment, finalMessage, judge, own: own ?? environment, raw })
      : undefined
  const baseline = internet(environment, 'environment') ?? environment['allow_internet'] !== false
  const agentInternet = internet(agent, 'agent') ?? baseline
  const verifierInternet =
    internet(verifier, 'verifier') ??
    (own ? (internet(own, 'verifier.environment') ?? own['allow_internet'] !== false) : baseline)
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
      allowInternet: agentInternet,
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
      ...(verifierInternet === agentInternet ? {} : { allowInternet: verifierInternet }),
      ...(Bytes.toText(source.files['tests/test.sh']).includes(report) ? { ctrf: true } : {}),
      env: { ...(own ? strings(own, 'env') : {}), ...strings(verifier, 'env') },
      ...(finalMessage ? { finalMessage } : {}),
      ...(judge ? { judge } : {}),
      ...(separate ? { separate } : {}),
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

function separateVerifier(
  source: Source,
  options: {
    environment: Record<string, unknown>
    finalMessage: true | undefined
    judge: true | undefined
    own: Record<string, unknown>
    raw: Record<string, unknown>
  },
): Separate {
  const { environment, own, raw } = options
  const verifier = raw['verifier'] as Record<string, unknown>
  if (options.finalMessage || options.judge)
    throw new UnsupportedError(
      'a verifier in an environment of its own takes no final message and no judge',
    )
  if (verifier['user'] !== undefined) throw new UnsupportedError('verifier.user is not supported')
  if (compose.some((path) => path.replace('environment/', 'tests/') in source.files))
    throw new UnsupportedError('tasks with a Compose file are not supported')
  if (number(own, 'gpus', 0) > 0) throw new UnsupportedError('GPU tasks are not supported')
  const image = own['docker_image']
  if (image !== undefined && (typeof image !== 'string' || !image))
    throw new InvalidError('verifier.environment.docker_image must be a nonempty string')
  if (!source.files['tests/Dockerfile'])
    throw new (image === undefined ? InvalidError : UnsupportedError)(
      image === undefined
        ? 'the verifier has neither an image nor tests/Dockerfile'
        : 'a verifier image without tests/Dockerfile is not supported',
    )
  const resource = (key: string) => positive(own[key] === undefined ? environment : own, key)
  const cpus = resource('cpus')
  const memoryMb = resource('memory_mb')
  if (cpus > positive(environment, 'cpus') || memoryMb > positive(environment, 'memory_mb'))
    throw new UnsupportedError(
      'a verifier with more cpus or memory than the environment of its task is not supported',
    )
  const artifacts = [{ exclude: [] as string[], source: artifactsPath }]
  for (const entry of list(raw['artifacts'], 'artifacts')) {
    const artifact = typeof entry === 'string' ? { source: entry } : (entry as Artifact)
    if (typeof artifact !== 'object' || artifact === null || typeof artifact.source !== 'string')
      throw new InvalidError('an artifact is a path or a table with a source')
    const exclude = list(artifact.exclude, 'artifacts.exclude')
    if (![artifact.source, ...exclude].every((text) => typeof text === 'string' && plain(text)))
      throw new InvalidError('an artifact source and its excludes are single-line strings')
    if (artifact.source.split('/').includes('..'))
      throw new InvalidError('an artifact source has no .. segment')
    if (!['main', undefined].includes(artifact.service))
      throw new UnsupportedError(
        'an artifact of the service ' +
          String(artifact.service) +
          ' needs Compose, which is not supported',
      )
    if (!artifact.source.startsWith('/'))
      throw new UnsupportedError('an artifact source that is not an absolute path is not supported')
    const path = artifact.source.replace(/\/+$/, '') || '/'
    if (path === artifactsPath) continue
    artifacts.push({ exclude: exclude as string[], source: path })
  }
  const collect = list(verifier['collect'], 'verifier.collect').map((entry) => {
    const hook = entry as Record<string, unknown>
    if (typeof hook !== 'object' || hook === null || typeof hook['command'] !== 'string')
      throw new InvalidError('a verifier.collect hook has a command')
    if (!['main', undefined].includes(hook['service'] as string))
      throw new UnsupportedError(
        'a collect hook of the service ' +
          String(hook['service']) +
          ' needs Compose, which is not supported',
      )
    if (hook['user'] !== undefined)
      throw new UnsupportedError('a collect hook with a user is not supported')
    return {
      command: hook['command'],
      timeoutSec:
        hook['timeout_sec'] === undefined ? collectTimeoutSec : positive(hook, 'timeout_sec'),
    }
  })
  return {
    artifacts,
    collect,
    cpus,
    ...(image === undefined ? {} : { dockerImage: image }),
    memoryMb,
    storageMb: resource('storage_mb'),
  }
}

type Artifact = { exclude?: unknown; service?: string; source: string }

function plain(text: string): boolean {
  return text !== '' && !/[\t\r\n]/.test(text)
}

function list(value: unknown, key: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new InvalidError(key + ' must be a list')
  return value
}

function flag(table: Record<string, unknown>, key: string): true | undefined {
  const value = table[key]
  if (value !== undefined && typeof value !== 'boolean')
    throw new InvalidError('metadata.nanoeval.' + key + ' must be true or false')
  return value === true ? true : undefined
}

function internet(table: Record<string, unknown>, name: string): boolean | undefined {
  const mode = table['network_mode']
  if (mode === 'allowlist' || table['allowed_hosts'] !== undefined)
    throw new UnsupportedError(name + '.network_mode allowlist is not supported')
  if (mode === undefined) return undefined
  if (mode !== 'public' && mode !== 'no-network')
    throw new InvalidError(name + '.network_mode must be public, no-network or allowlist')
  return mode === 'public'
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
