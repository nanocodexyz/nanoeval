import * as Bytes from './internal/Bytes.ts'
import type * as Sql from './Sql.ts'

export class InvalidError extends Error {
  override name = 'Eval.InvalidError'
}

export class NotFoundError extends Error {
  override name = 'Eval.NotFoundError'
}

export type Blob = { bytes: number; digest: string }

export type Meta = {
  architecture: string
  cmd: readonly string[]
  digest: string
  entrypoint: readonly string[]
  env: readonly string[]
  user: string
  workdir: string
}

export type Environment =
  | { disk: Blob; format: string; kind: 'disk'; meta: Meta; source: string }
  | { files: Blob; kind: 'dir' }

export type Task = {
  agent: { timeoutSec: number }
  checksum: string
  description: string
  env: Record<string, string>
  environment: Environment
  id: string
  instruction: Blob
  name: string
  network: { allowInternet: boolean }
  resources: { cpus: number; memoryMb: number; storageMb: number }
  setupTimeoutSec?: number
  solution?: { archive: Blob; env: Record<string, string>; finalMessage?: true }
  tests: Blob
  verifier: {
    ctrf?: true
    env: Record<string, string>
    finalMessage?: true
    judge?: true
    timeoutSec: number
  }
}

export type Entry = { digest: string; id: string; name: string }

export type Version = {
  createdAt: number
  dataset: string
  digest: string
  parent: string | null
  source: Record<string, string>
  tasks: number
}

export type Reference = { name: string; version?: string }

export type Selection = { limit?: number; only?: readonly string[] }

export const schema = 'nanoeval-eval-v1'
export const taskSchema = 'nanoeval-eval-task-v1'

export const tables = [
  `CREATE TABLE IF NOT EXISTS tasks (digest TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS versions (
    digest TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    dataset TEXT NOT NULL,
    source TEXT NOT NULL,
    parent TEXT,
    tasks INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS version_tasks (
    version TEXT NOT NULL,
    id TEXT NOT NULL,
    task TEXT NOT NULL,
    PRIMARY KEY (version, id)
  )`,
]

const digestPattern = /^[0-9a-f]{64}$/
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const namePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (typeof value === 'object' && value !== null)
    return (
      '{' +
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}

export function taskDigest(task: Task): Promise<string> {
  return Bytes.sha256(Bytes.fromText(taskSchema + '\0' + canonical(task)))
}

export function versionDigest(input: {
  dataset: string
  entries: readonly Pick<Entry, 'digest' | 'id'>[]
  source: Record<string, string>
}): Promise<string> {
  const entries = [...input.entries]
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((entry) => ({ digest: entry.digest, id: entry.id }))
  return Bytes.sha256(
    Bytes.fromText(
      schema + '\0' + canonical({ dataset: input.dataset, source: input.source, tasks: entries }),
    ),
  )
}

export function validName(name: string): boolean {
  return namePattern.test(name)
}

export function reference(text: string): Reference {
  const [name, version, ...rest] = text.split('@')
  if (!name || !validName(name) || rest.length)
    throw new InvalidError('an eval is NAME or NAME@DIGEST, not ' + text)
  if (version !== undefined && !/^[0-9a-f]{8,64}$/.test(version))
    throw new InvalidError('an eval version is at least 8 hex digits of its digest, not ' + version)
  return { name, ...(version ? { version } : {}) }
}

function blob(value: unknown, name: string): Blob {
  const candidate = value as Blob
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.digest !== 'string' ||
    !digestPattern.test(candidate.digest) ||
    !Number.isSafeInteger(candidate.bytes) ||
    candidate.bytes < 0
  )
    throw new InvalidError(name + ' is not a blob with a SHA-256 digest and a size')
  return { bytes: candidate.bytes, digest: candidate.digest }
}

function variables(value: unknown, name: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidError(name + ' is not a table of variables')
  for (const [key, entry] of Object.entries(value))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string' || /[\r\n]/.test(entry))
      throw new InvalidError(name + '.' + key + ' is not a single-line environment variable')
  return { ...(value as Record<string, string>) }
}

function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new InvalidError(name + ' must be a positive number')
  return value
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new InvalidError(name + ' is not a list of strings')
  return [...(value as string[])]
}

function flag(value: unknown, name: string): true | undefined {
  if (value !== undefined && value !== true) throw new InvalidError(name + ' is true or absent')
  return value
}

function environment(value: unknown): Environment {
  const candidate = value as Environment
  if (candidate?.kind === 'dir')
    return { files: blob(candidate.files, 'environment.files'), kind: 'dir' }
  if (candidate?.kind !== 'disk') throw new InvalidError('environment.kind is disk or dir')
  const meta = candidate.meta
  if (
    typeof meta !== 'object' ||
    meta === null ||
    typeof meta.architecture !== 'string' ||
    typeof meta.digest !== 'string' ||
    typeof meta.user !== 'string' ||
    typeof meta.workdir !== 'string' ||
    typeof candidate.format !== 'string' ||
    typeof candidate.source !== 'string'
  )
    throw new InvalidError('environment.meta does not describe an image')
  return {
    disk: blob(candidate.disk, 'environment.disk'),
    format: candidate.format,
    kind: 'disk',
    meta: {
      architecture: meta.architecture,
      cmd: strings(meta.cmd, 'environment.meta.cmd'),
      digest: meta.digest,
      entrypoint: strings(meta.entrypoint, 'environment.meta.entrypoint'),
      env: strings(meta.env, 'environment.meta.env'),
      user: meta.user,
      workdir: meta.workdir,
    },
    source: candidate.source,
  }
}

export function parse(value: unknown): Task {
  const task = value as Task
  if (typeof task !== 'object' || task === null) throw new InvalidError('a task is an object')
  if (typeof task.id !== 'string' || !idPattern.test(task.id))
    throw new InvalidError('a task id is letters, digits, dots, dashes and underscores')
  if (typeof task.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(task.name))
    throw new InvalidError(task.id + ' names no task')
  if (typeof task.checksum !== 'string') throw new InvalidError(task.id + ' has no checksum')
  const resources = task.resources ?? {}
  if (!Number.isSafeInteger(resources.memoryMb) || !Number.isSafeInteger(resources.storageMb))
    throw new InvalidError(task.id + ' needs memory and storage in whole MB')
  const finalMessage = flag(task.verifier?.finalMessage, 'verifier.finalMessage')
  const judge = flag(task.verifier?.judge, 'verifier.judge')
  const ctrf = flag(task.verifier?.ctrf, 'verifier.ctrf')
  const answered = flag(task.solution?.finalMessage, 'solution.finalMessage')
  if (task.solution && finalMessage && !answered)
    throw new InvalidError(task.id + ' answers with its final message and its solution has none')
  return {
    agent: { timeoutSec: positive(task.agent?.timeoutSec, 'agent.timeoutSec') },
    checksum: task.checksum,
    description: typeof task.description === 'string' ? task.description : '',
    env: variables(task.env ?? {}, 'env'),
    environment: environment(task.environment),
    id: task.id,
    instruction: blob(task.instruction, 'instruction'),
    name: task.name,
    network: { allowInternet: task.network?.allowInternet !== false },
    resources: {
      cpus: positive(resources.cpus, 'resources.cpus'),
      memoryMb: positive(resources.memoryMb, 'resources.memoryMb'),
      storageMb: positive(resources.storageMb, 'resources.storageMb'),
    },
    ...(task.setupTimeoutSec === undefined
      ? {}
      : { setupTimeoutSec: positive(task.setupTimeoutSec, 'setupTimeoutSec') }),
    ...(task.solution
      ? {
          solution: {
            archive: blob(task.solution.archive, 'solution.archive'),
            env: variables(task.solution.env ?? {}, 'solution.env'),
            ...(answered ? { finalMessage: answered } : {}),
          },
        }
      : {}),
    tests: blob(task.tests, 'tests'),
    verifier: {
      ...(ctrf ? { ctrf } : {}),
      env: variables(task.verifier?.env ?? {}, 'verifier.env'),
      ...(finalMessage ? { finalMessage } : {}),
      ...(judge ? { judge } : {}),
      timeoutSec: positive(task.verifier?.timeoutSec, 'verifier.timeoutSec'),
    },
  }
}

export function blobs(task: Task, options: { solution: boolean }): Blob[] {
  return [
    task.instruction,
    task.tests,
    task.environment.kind === 'disk' ? task.environment.disk : task.environment.files,
    ...(options.solution && task.solution ? [task.solution.archive] : []),
  ]
}

export function withoutSolution(task: Task): Task {
  const { solution: _, ...rest } = task
  return rest
}

export function select<T extends { id: string }>(tasks: readonly T[], selection: Selection): T[] {
  const known = new Set(tasks.map((task) => task.id))
  for (const id of selection.only ?? [])
    if (!known.has(id)) throw new NotFoundError('the eval has no task ' + id)
  const chosen = selection.only?.length
    ? tasks.filter((task) => selection.only!.includes(task.id))
    : [...tasks]
  return selection.limit === undefined ? chosen : chosen.slice(0, selection.limit)
}

function versionOf(row: Sql.Row): Version {
  return {
    createdAt: row['created_at'] as number,
    dataset: row['dataset'] as string,
    digest: row['digest'] as string,
    parent: row['parent'] as string | null,
    source: JSON.parse(row['source'] as string) as Record<string, string>,
    tasks: row['tasks'] as number,
  }
}

export function versions(sql: Sql.Sql): Version[] {
  return sql.all('SELECT * FROM versions ORDER BY n DESC').map(versionOf)
}

export function version(sql: Sql.Sql, digest?: string): Version | undefined {
  if (digest === undefined) return versions(sql)[0]
  const found = sql
    .all('SELECT * FROM versions WHERE digest >= ? AND digest < ? ORDER BY n', digest, digest + 'g')
    .map(versionOf)
  if (found.length > 1)
    throw new InvalidError(digest + ' is the start of ' + found.length + ' versions of this eval')
  return found[0]
}

export function entries(sql: Sql.Sql, digest: string): Entry[] {
  return sql
    .all(
      'SELECT version_tasks.id AS id, tasks.digest AS digest, tasks.name AS name FROM version_tasks JOIN tasks ON tasks.digest = version_tasks.task WHERE version = ? ORDER BY version_tasks.id',
      digest,
    )
    .map((row) => ({
      digest: row['digest'] as string,
      id: row['id'] as string,
      name: row['name'] as string,
    }))
}

export function tasks(sql: Sql.Sql, digest: string, selection: Selection = {}): Task[] {
  const chosen = new Set(select(entries(sql, digest), selection).map((entry) => entry.id))
  return sql
    .all(
      'SELECT tasks.body AS body FROM version_tasks JOIN tasks ON tasks.digest = version_tasks.task WHERE version = ? ORDER BY version_tasks.id',
      digest,
    )
    .map((row) => JSON.parse(row['body'] as string) as Task)
    .filter((task) => chosen.has(task.id))
}

export async function put(sql: Sql.Sql, input: put.Input): Promise<Version> {
  const parent = input.base === null ? undefined : version(sql, input.base)
  if (input.base && !parent) throw new NotFoundError('the eval has no version ' + input.base)
  if (
    parent &&
    (parent.dataset !== input.dataset || canonical(parent.source) !== canonical(input.source))
  )
    throw new InvalidError(
      'the eval holds ' + parent.dataset + ' from another source: import under a new name',
    )
  const added: (Entry & { body: string })[] = []
  for (const value of input.tasks) {
    const task = parse(value)
    added.push({
      body: JSON.stringify(task),
      digest: await taskDigest(task),
      id: task.id,
      name: task.name,
    })
  }
  if (new Set(added.map((entry) => entry.id)).size !== added.length)
    throw new InvalidError('task ids must be unique')
  const merged = new Map<string, Pick<Entry, 'digest' | 'id'>>()
  for (const entry of parent ? entries(sql, parent.digest) : []) merged.set(entry.id, entry)
  for (const entry of added) merged.set(entry.id, entry)
  if (!merged.size) throw new InvalidError('a version has at least one task')
  const digest = await versionDigest({
    dataset: input.dataset,
    entries: [...merged.values()],
    source: input.source,
  })

  return sql.transaction(() => {
    const existing = version(sql, digest)
    if (existing) return existing
    for (const entry of added)
      sql.run(
        'INSERT OR IGNORE INTO tasks (digest, id, name, body) VALUES (?, ?, ?, ?)',
        entry.digest,
        entry.id,
        entry.name,
        entry.body,
      )
    for (const entry of merged.values())
      sql.run(
        'INSERT INTO version_tasks (version, id, task) VALUES (?, ?, ?)',
        digest,
        entry.id,
        entry.digest,
      )
    const n = (sql.all('SELECT COALESCE(MAX(n), 0) AS n FROM versions')[0]!['n'] as number) + 1
    sql.run(
      'INSERT INTO versions (digest, n, created_at, dataset, source, parent, tasks) VALUES (?, ?, ?, ?, ?, ?, ?)',
      digest,
      n,
      input.now,
      input.dataset,
      JSON.stringify(input.source),
      parent?.digest ?? null,
      merged.size,
    )
    return version(sql, digest)!
  })
}

export declare namespace put {
  type Input = {
    base?: string | null
    dataset: string
    now: number
    source: Record<string, string>
    tasks: readonly unknown[]
  }
}
