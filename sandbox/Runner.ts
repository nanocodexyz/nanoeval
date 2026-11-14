import { execFile, spawn } from 'node:child_process'
import { type FSWatcher, watch } from 'node:fs'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Admission from '../src/Admission.ts'
import * as Bootstrap from '../src/Bootstrap.ts'
import * as Config from '../src/Config.ts'
import * as Eval from '../src/Eval.ts'
import * as Installed from '../src/Installed.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Judge from '../src/Judge.ts'
import * as Protocol from '../src/Protocol.ts'
import type * as Result from '../src/Result.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Task from '../src/Task.ts'
import type * as Timeline from '../src/Timeline.ts'
import * as Verdict from '../src/Verdict.ts'
import * as Converter from './Converter.ts'
import * as Disks from './Disks.ts'
import * as Host from './Host.ts'
import * as Store from './Store.ts'

export class GoneError extends Error {
  override name = 'Runner.GoneError'
}

export class MachineError extends Error {
  override name = 'Runner.MachineError'
}

export class RefusedError extends Error {
  override name = 'Runner.RefusedError'
}

export type Options = {
  cache: string
  config?: Config.Runner
  home: string
  log?(line: string): void
  override?: Partial<Config.Runner>
  standing?: Standing
  store?: string
}

export type Standing = {
  backend: Config.Backend
  enroll?(): Promise<Protocol.Standing>
  leaseSec: number
  network: Slot.Network
  pollMs: number
  pool: Protocol.Standing
  setupSec: number
  url: string
}

type Ready = { backend: Slot.Backend; capabilities: Sandbox.Capabilities }

type Serving = { rows(): Work[]; wake(): void; yield(): void }

type Shared = {
  entering: { enter(): void; serving: Serving }[]
  inside?: Serving
  ready?: Ready
  serving: Set<Serving>
  stopping: boolean
  stops: Set<() => void>
  unpacking: Map<string, Promise<void>>
}

type Stage = 'agent' | 'attach' | 'cli' | 'judge' | 'prepare' | 'solve' | 'up' | 'verify'

type Work = {
  at: number
  busy: boolean
  changed: number
  delay: number
  down?: Promise<void>
  errors: number
  instruction?: string
  marks: Mark[]
  memoryMb?: number
  message: string
  next: number
  round: 1 | 2
  row: Protocol.Claimed
  session?: Protocol.Session
  stage: Stage
  watcher?: FSWatcher
}

type Saved = Pick<Work, 'at' | 'memoryMb' | 'message' | 'round' | 'row' | 'session' | 'stage'>

type Mark = { at: number; ms?: number; name: string }

const hostUtilization = 0.8
const firstPollMs = 25
const script = Path.join(import.meta.dirname, 'slot.sh')

function output(command: string, env: NodeJS.ProcessEnv): Promise<Sandbox.Output> {
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      ['-c', command],
      { env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error)
        else resolve({ exitCode: error ? (error.code as number) : 0, stderr, stdout })
      },
    )
  })
}

async function text(file: string): Promise<string | undefined> {
  return Fs.readFile(file, 'utf8').catch(() => undefined)
}

async function phase(file: string): Promise<Slot.Phase> {
  return ((await text(file))?.trim() || 'none') as Slot.Phase
}

async function availableMb(): Promise<number | undefined> {
  const found = /^MemAvailable:\s+(\d+) kB$/m.exec((await text('/proc/meminfo')) ?? '')
  return found ? Math.floor(Number(found[1]) / 1024) : undefined
}

async function freeDiskMb(paths: readonly string[]): Promise<number> {
  let least = Infinity
  for (const path of paths) {
    const stat = await Fs.statfs(path).catch(() => undefined)
    if (stat) least = Math.min(least, Math.floor((stat.bavail * stat.bsize) / (1024 * 1024)))
  }
  return Number.isFinite(least) ? least : 0
}

function changed(directory: string, name: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let watcher: FSWatcher | undefined
    const done = () => {
      clearTimeout(timer)
      watcher?.close()
      resolve()
    }
    const timer = setTimeout(done, ms)
    try {
      watcher = watch(directory, (_event, file) => {
        if (file === name) done()
      })
      watcher.on('error', done)
    } catch {
      watcher = undefined
    }
  })
}

function admit(shared: Shared): void {
  if (shared.inside || !shared.entering.length) return
  const next = shared.entering.reduce((least, entry) =>
    entry.serving.rows().length < least.serving.rows().length ? entry : least,
  )
  shared.entering.splice(shared.entering.indexOf(next), 1)
  shared.inside = next.serving
  next.enter()
}

function enter(shared: Shared, serving: Serving): Promise<void> {
  return new Promise((resolve) => {
    shared.entering.push({ enter: resolve, serving })
    shared.inside?.yield()
    setImmediate(() => admit(shared))
  })
}

function exit(shared: Shared, serving: Serving): void {
  if (shared.inside !== serving) return
  shared.inside = undefined
  admit(shared)
}

function rest(shared: Shared, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      shared.stops.delete(done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    shared.stops.add(done)
  })
}

async function setup(input: {
  backend: Config.Backend
  cache: string
  home: string
  network: Slot.Network
  pollMs: number
  setupSec: number
}): Promise<Ready> {
  const { home } = input
  const env: NodeJS.ProcessEnv = {
    ...Host.environment(),
    NANOEVAL_CACHE: input.cache,
    NANOEVAL_HOME: home,
  }
  const slots = Slot.create({ home })
  const shell = async (command: string): Promise<string> => {
    const result = await output(command, env)
    if (result.exitCode !== 0)
      throw new Error(
        'the slot command exited with ' +
          result.exitCode +
          ': ' +
          (result.stderr.trim() || result.stdout.trim()).slice(-2000),
      )
    return result.stdout
  }
  await Fs.mkdir(Path.join(home, 'slots'), { recursive: true })
  await Fs.mkdir(Path.join(input.cache, 'blobs'), { recursive: true })
  await Fs.copyFile(script, slots.script)
  const backend = Config.backend(
    input.backend,
    JSON.parse(await shell(slots.probe())) as Sandbox.Capabilities,
  )
  if (!backend)
    throw new RefusedError(
      'this machine has neither /dev/kvm for the krun backend nor root for the ns backend',
    )
  await shell(slots.setup({ backend, network: input.network, runtime: Slot.runtime }))
  for (const started = Date.now(); ; ) {
    const moved = changed(home, 'setup.status', input.pollMs)
    const code = Slot.exit(await phase(Path.join(home, 'setup.status')))
    if (code === 0) break
    if (code !== undefined || Date.now() - started > input.setupSec * 1000)
      throw new RefusedError(
        (code === undefined
          ? 'sandbox setup did not finish within ' + input.setupSec + ' s'
          : 'sandbox setup exited with ' + code) +
          ': ' +
          (await shell(slots.log('-', 'setup', Protocol.logBytes))).slice(-2000),
      )
    await moved
  }
  return { backend, capabilities: JSON.parse(await shell(slots.probe())) as Sandbox.Capabilities }
}

async function ask(
  standing: Standing,
  input: { done?: string; log(line: string): void; shared: Shared },
): Promise<Config.Runner | 'closed' | undefined> {
  const { log, shared } = input
  const base = standing.url.replace(/\/+$/, '') + '/v1/pool/members/' + standing.pool.member
  const send = (path: string, body: unknown, signal?: AbortSignal) =>
    fetch(base + path, {
      body: JSON.stringify(body),
      headers: {
        authorization: 'Bearer ' + standing.pool.token,
        'content-type': 'application/json',
      },
      method: 'POST',
      ...(signal ? { signal } : {}),
    })
  const query = standing.pool.location ? '?location=' + standing.pool.location : ''
  const waitMs = Math.floor((standing.leaseSec * 1000) / 3)
  let pause = standing.pollMs
  let left: Promise<boolean> | undefined
  log('standing as member ' + standing.pool.member + ' of the pool')
  while (!shared.stopping) {
    const abort = new AbortController()
    const stop = () => {
      left = leave(standing)
      void left.then((gone) => {
        if (!gone) abort.abort()
      })
    }
    shared.stops.add(stop)
    const askedAt = Date.now()
    let answer: Protocol.Next | undefined
    try {
      const response = await send(
        '/next' + query,
        {
          capabilities: shared.ready!.capabilities,
          ...(input.done ? { done: input.done } : {}),
          waitMs,
        } satisfies Protocol.Waiting,
        abort.signal,
      )
      if (response.status === 401 || response.status === 404) {
        shared.stops.delete(stop)
        log('the pool does not know member ' + standing.pool.member + ' any more')
        return 'closed'
      }
      if (response.ok) answer = (await response.json()) as Protocol.Next
      else
        log('the pool answered ' + response.status + ': ' + (await response.text()).slice(0, 500))
    } catch (error) {
      if (!shared.stopping) log('asking the pool failed: ' + String(error))
    }
    shared.stops.delete(stop)
    if (shared.stopping) {
      if (answer?.state === 'assigned')
        await fetch(
          standing.url.replace(/\/+$/, '') + '/v1/runs/' + answer.config.run + '/runner/leave',
          {
            body: JSON.stringify({
              held: [],
              runner: answer.config.runner,
            } satisfies Protocol.Leave),
            headers: {
              authorization: 'Bearer ' + answer.config.token,
              'content-type': 'application/json',
            },
            method: 'POST',
          },
        ).then(
          (response) => response.body?.cancel(),
          () => {},
        )
      break
    }
    if (answer?.state === 'assigned') return answer.config
    if (answer?.state === 'closed') {
      log('the pool closed member ' + standing.pool.member)
      return 'closed'
    }
    if (answer) pause = standing.pollMs
    if (!shared.stopping && Date.now() - askedAt < waitMs) {
      await rest(shared, pause)
      if (!answer) pause = Math.min(pause * 2, Math.max(waitMs, standing.pollMs))
    }
  }
  if (!(await left)) await leave(standing)
  return undefined
}

async function leave(standing: Standing): Promise<boolean> {
  const deadline = Date.now() + (standing.leaseSec * 1000) / 3
  for (;;) {
    const status = await fetch(
      standing.url.replace(/\/+$/, '') +
        '/v1/pool/members/' +
        standing.pool.member +
        '/leave' +
        (standing.pool.location ? '?location=' + standing.pool.location : ''),
      {
        body: '{}',
        headers: {
          authorization: 'Bearer ' + standing.pool.token,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    ).then(
      async (response) => {
        await response.body?.cancel()
        return response.status
      },
      () => undefined,
    )
    if (status !== undefined && status < 500) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, standing.pollMs))
  }
}

export async function run(options: Options): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(new Date().toISOString() + ' ' + line))
  const shared: Shared = {
    entering: [],
    serving: new Set(),
    stopping: false,
    stops: new Set(),
    unpacking: new Map(),
  }
  const stop = () => {
    shared.stopping = true
    for (const stop of shared.stops) stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  if (options.standing?.enroll) return stand(options, { log, shared, stop })
  let config = options.config
  let standing = options.standing
  let done: string | undefined
  for (;;) {
    if (config) {
      await serve({ ...options, config }, shared)
      if (shared.stopping || !config.pool) return
      standing = {
        backend: config.backend,
        leaseSec: config.leaseSec,
        network: config.network,
        pollMs: config.pollMs,
        pool: config.pool,
        setupSec: config.limits.setupSec,
        url: config.url,
      }
      done = config.run
    }
    if (!standing) return
    shared.ready ??= await setup({
      backend: standing.backend,
      cache: options.cache,
      home: options.home,
      network: standing.network,
      pollMs: standing.pollMs,
      setupSec: standing.setupSec,
    })
    const next = await ask(standing, { ...(done ? { done } : {}), log, shared })
    if (!next || next === 'closed') return
    config = { ...next, ...options.override, url: standing.url }
  }
}

async function stand(
  options: Options,
  input: { log(line: string): void; shared: Shared; stop(): void },
): Promise<void> {
  const { log, shared } = input
  const standing = options.standing!
  const waitMs = Math.floor((standing.leaseSec * 1000) / 3)
  const loops = new Set<Promise<void>>()
  let failure: { error: unknown } | undefined
  let standby = 0
  shared.ready = await setup({
    backend: standing.backend,
    cache: options.cache,
    home: options.home,
    network: standing.network,
    pollMs: standing.pollMs,
    setupSec: standing.setupSec,
  })
  const enroll = async (): Promise<Protocol.Standing | undefined> => {
    for (let pause = standing.pollMs; !shared.stopping; ) {
      try {
        return await standing.enroll!()
      } catch (error) {
        if (error instanceof RefusedError) throw error
        log('enrolling in the pool failed: ' + String(error))
      }
      await rest(shared, pause)
      pause = Math.min(pause * 2, Math.max(waitMs, standing.pollMs))
    }
    return undefined
  }
  const loop = async (first: Protocol.Standing | undefined) => {
    let done: string | undefined
    let pool = first
    for (;;) {
      standby++
      let next: Config.Runner | 'closed' | undefined
      try {
        pool ??= await enroll()
        if (!pool) return
        next = await ask({ ...standing, pool }, { ...(done ? { done } : {}), log, shared })
      } finally {
        standby--
      }
      done = undefined
      if (!next) return
      if (next === 'closed') {
        pool = undefined
        continue
      }
      if (!standby) start(undefined)
      const config = { ...next, ...options.override, url: standing.url }
      try {
        await serve({ ...options, config }, shared)
      } catch (error) {
        await leave({ ...standing, pool })
        throw error
      }
      if (shared.stopping || standby) {
        await leave({ ...standing, pool })
        return
      }
      done = config.run
    }
  }
  const start = (pool: Protocol.Standing | undefined) => {
    const running: Promise<void> = loop(pool)
      .catch((error) => {
        failure ??= { error }
        input.stop()
      })
      .finally(() => loops.delete(running))
    loops.add(running)
  }
  start(standing.pool)
  while (loops.size) await Promise.all(loops)
  if (failure) throw failure.error
}

async function serve(options: Options & { config: Config.Runner }, shared: Shared): Promise<void> {
  const serving: Serving = { rows: () => [], wake() {}, yield() {} }
  shared.serving.add(serving)
  try {
    await attend(options, { serving, shared })
  } finally {
    shared.serving.delete(serving)
    exit(shared, serving)
    for (const other of shared.serving) other.wake()
  }
}

async function attend(
  options: Options & { config: Config.Runner },
  input: { serving: Serving; shared: Shared },
): Promise<void> {
  const { serving, shared } = input
  const { cache, home } = options
  const startedAt = Date.now()
  const log = options.log ?? ((line: string) => console.log(new Date().toISOString() + ' ' + line))
  const env: NodeJS.ProcessEnv = {
    ...Host.environment(),
    NANOEVAL_CACHE: cache,
    NANOEVAL_HOME: home,
  }
  const base = options.config.url.replace(/\/+$/, '') + '/v1/runs/' + options.config.run + '/runner'
  const authorization = { authorization: 'Bearer ' + options.config.token }
  const slots = Slot.create({ home })
  const converter = Converter.create({
    home: Path.join(cache, 'converter'),
    layers: Converter.defaultLayers(cache),
  })
  const stores: Store.Store[] = [
    ...(options.store ? [Store.directory(options.store)] : []),
    Store.remote({ base: base + '/blobs', token: options.config.token }),
  ]
  const work = new Map<string, Work>()
  const up = new Set<Work>()
  const unpacking = shared.unpacking
  const config = options.config
  const everything = () => [...shared.serving].flatMap((other) => other.rows())
  const holdMs = Math.floor((config.leaseSec * 1000) / 3)
  const reported: Mark[] = []
  let claimAt = 0
  const mark = '.run-' + config.run
  let fault: string | undefined
  let finished = false
  let frees = 0
  let signalled = false
  let wake = () => {}
  const signal = () => {
    signalled = true
    wake()
  }

  const shell = async (command: string): Promise<string> => {
    const result = await output(command, env)
    if (result.exitCode !== 0)
      throw new Error(
        'the slot command exited with ' +
          result.exitCode +
          ': ' +
          (result.stderr.trim() || result.stdout.trim()).slice(-2000),
      )
    return result.stdout
  }

  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const deadline = Date.now() + config.leaseSec * 1000
    for (let wait = 100; ; wait = Math.min(wait * 2, 2000)) {
      let response: Response
      try {
        response = await fetch(base + path, {
          body: JSON.stringify(body),
          headers: { ...authorization, 'content-type': 'application/json' },
          method: 'POST',
        })
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      if (response.ok) return (await response.json()) as T
      const reason = (await response.text()).slice(0, 500)
      if (response.status === 410 || response.status === 404) throw new GoneError(reason)
      if (response.status < 500 || Date.now() > deadline)
        throw new Error(path + ' answered ' + response.status + ': ' + reason)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  const rowCall = <T>(item: Work, action: string, body: Record<string, unknown> = {}) =>
    call<T>('/rows/' + item.row.id + '/' + action, {
      ...body,
      claim: item.row.claim,
      ...(item.marks.length
        ? {
            timeline: { marks: item.marks.splice(0), sentAt: Date.now() } satisfies Timeline.Report,
          }
        : {}),
    })
  const timed = async <T>(item: Work, name: string, work: () => Promise<T>): Promise<T> => {
    const at = Date.now()
    try {
      return await work()
    } finally {
      item.marks.push({ at, ms: Date.now() - at, name })
    }
  }

  const upload = async (item: Work, name: string, content: string | Uint8Array) => {
    const response = await fetch(
      base +
        '/rows/' +
        item.row.id +
        '/artifacts/' +
        encodeURIComponent(name) +
        '?claim=' +
        item.row.claim,
      {
        body: (typeof content === 'string' ? content : content) as string | Uint8Array<ArrayBuffer>,
        headers: authorization,
        method: 'PUT',
      },
    )
    if (response.status === 410) throw new GoneError(await response.text())
    if (!response.ok)
      throw new Error(
        'storing ' + name + ' answered ' + response.status + ': ' + (await response.text()),
      )
    await response.body?.cancel()
  }

  const directory = (item: Work) => Path.join(home, 'slots', item.row.slot)
  const save = async (item: Work) => {
    const saved: Saved = {
      at: item.at,
      ...(item.memoryMb === undefined ? {} : { memoryMb: item.memoryMb }),
      message: item.message,
      round: item.round,
      row: item.row,
      ...(item.session ? { session: item.session } : {}),
      stage: item.stage,
    }
    const file = Path.join(directory(item), 'row.json')
    await Fs.writeFile(file + '.tmp', JSON.stringify(saved))
    await Fs.rename(file + '.tmp', file)
  }
  const move = async (item: Work, stage: Stage) => {
    item.stage = stage
    item.at = Date.now()
    item.delay = firstPollMs
    item.next = 0
    await save(item)
  }
  const later = (item: Work) => {
    item.next = Date.now() + item.delay
    item.delay = Math.min(Math.ceil(item.delay * 1.6), config.pollMs)
  }
  const again = (item: Work, askedAt: number) => {
    if (Date.now() - askedAt < holdMs) return later(item)
    item.delay = firstPollMs
    item.next = 0
  }
  const pending = (item: Work) => {
    item.next = Date.now() + config.pollMs
  }
  const observe = (item: Work) => {
    try {
      item.watcher = watch(directory(item), (_event, name) => {
        if (!name?.endsWith('.status')) return
        item.changed++
        item.next = 0
        signal()
      })
      item.watcher.on('error', (error) => log('watching ' + item.row.slot + ' failed: ' + error))
    } catch (error) {
      log('watching ' + item.row.slot + ' failed: ' + String(error))
    }
  }
  const slotLog = (item: Work, name: 'agent' | 'hand' | 'solve' | 'up' | 'verify', bytes: number) =>
    shell(slots.log(item.row.slot, name, bytes))

  const down = (item: Work, evict: boolean) => (item.down ??= takeDown(item, evict))

  const takeDown = async (item: Work, evict: boolean) => {
    const disk = await text(Path.join(directory(item), 'disk'))
    const marked =
      evict &&
      disk !== undefined &&
      (await Fs.stat(disk.trim() + mark).then(
        () => true,
        () => false,
      ))
    await output(slots.down(item.row.slot, marked ? 'remove' : 'keep'), env)
    if (marked) await forget(disk!.trim())
    item.watcher?.close()
    up.delete(item)
    if (work.get(item.row.id) === item) work.delete(item.row.id)
    claimAt = 0
    frees++
    signal()
    for (const other of shared.serving) if (other !== serving) other.wake()
  }

  const forget = async (prefix: string) => {
    const gone = await Fs.stat(prefix + '.ext4').then(
      () => false,
      () => true,
    )
    if (gone)
      for (const suffix of [mark, '.use', '.lock']) await Fs.rm(prefix + suffix, { force: true })
    return gone
  }

  const reclaim = async () => {
    const held = new Set(
      everything().flatMap((item) =>
        item.row.task.environment.kind === 'disk' ? [item.row.task.environment.disk.digest] : [],
      ),
    )
    const names = await Fs.readdir(Path.join(cache, 'disks')).catch(() => [] as string[])
    for (const digest of Disks.idle(names, { held, mark })) {
      const prefix = Path.join(cache, 'disks', digest)
      await output(slots.drop(prefix), env)
      if (await forget(prefix)) log('removed the disk ' + digest + ', which no row here uses')
    }
  }

  const finish = async (item: Work, body: Protocol.Finish) => {
    const { evict } = await rowCall<Protocol.Finished>(item, 'finish', body)
    log(
      'finished ' +
        item.row.id +
        ' ' +
        item.row.task.name +
        (body.failure ? ' ' + body.failure.kind + ': ' + body.failure.message.slice(0, 200) : ''),
    )
    await down(item, evict)
  }

  const fail = (item: Work, kind: Result.FailureKind, message: string) =>
    finish(item, { failure: { kind, message } })

  const giveBack = async (item: Work, message: string) => {
    fault ??= message
    log(
      'the machine could not bring a slot up, so ' +
        item.row.id +
        ' goes back to the run and this runner claims no more rows: ' +
        message,
    )
    await rowCall(item, 'fault', { message } satisfies Protocol.Fault)
    await down(item, false)
  }

  const ensureDisk = async (environment: Protocol.Ahead, marks: Mark[]) => {
    const prefix = Path.join(cache, 'disks', environment.disk.digest)
    let pending = unpacking.get(prefix)
    if (!pending) {
      pending = (async () => {
        await Fs.mkdir(Path.dirname(prefix), { recursive: true })
        const present = await Fs.stat(prefix + '.ext4').then(
          () => true,
          () => false,
        )
        if (present) return
        if (environment.format !== converter.format)
          throw new Error(
            'the environment disk is packed as ' +
              environment.format +
              ', and this runner unpacks ' +
              converter.format,
          )
        const fetchAt = Date.now()
        const packed = await Store.ensure(stores, { blob: environment.disk, cache })
        const unpackAt = Date.now()
        marks.push({ at: fetchAt, ms: unpackAt - fetchAt, name: 'attempt.disk.fetch' })
        await converter.unpack(packed, prefix + '.ext4')
        await Fs.writeFile(prefix + mark, '')
        marks.push({ at: unpackAt, ms: Date.now() - unpackAt, name: 'attempt.disk.unpack' })
        if (config.disks === 'remove') await Fs.rm(packed, { force: true })
      })().finally(() => unpacking.delete(prefix))
      unpacking.set(prefix, pending)
    }
    await pending
    await Host.describe(prefix, environment.meta)
    return prefix
  }

  const prefetch = (ahead: readonly Protocol.Ahead[] | undefined) => {
    if (config.disks !== 'keep' || config.freeDiskMb !== undefined) return
    for (const environment of ahead ?? [])
      void ensureDisk(environment, reported).catch((error) =>
        log('fetching a disk ahead failed: ' + String(error)),
      )
  }

  const hostPolicy = Fs.readFile(process.env['NANOEVAL_SLOT_ENV'] ?? '').then(
    (variables) => Bytes.sha256(variables),
    () => '',
  )

  const prepare = async (item: Work) => {
    const task = item.row.task
    const target = directory(item)
    if (fault !== undefined) throw new MachineError(fault)
    try {
      await Fs.mkdir(target, { recursive: true })
      observe(item)
      await save(item)
    } catch (error) {
      throw new MachineError(error instanceof Error ? error.message : String(error))
    }
    const fetch = async (blob: Eval.Blob, name: string) => {
      const file = Path.join(target, name)
      await Fs.rm(file, { force: true })
      await Fs.copyFile(await Store.ensure(stores, { blob, cache }), file)
      await Fs.chmod(file, 0o644)
    }
    const environment = task.environment
    const [disk] = await Promise.all([
      environment.kind === 'disk'
        ? timed(item, 'attempt.disk', () => ensureDisk(environment, item.marks))
        : undefined,
      timed(item, 'attempt.blobs', () =>
        Promise.all([
          fetch(task.tests, 'tests.tar'),
          task.solution && item.row.agent.oracle
            ? fetch(task.solution.archive, 'solution.tar')
            : undefined,
          environment.kind === 'disk' ? undefined : fetch(environment.files, 'environment.tar'),
        ]),
      ),
      item.row.agent.oracle ? undefined : instruct(item),
      item.row.agent.cli
        ? undefined
        : rowCall<Protocol.Session>(item, 'session').then((session) => {
            item.session = session
          }),
    ])
    const variables: [
      name: 'env' | 'solution.env' | 'verifier.env',
      env: Record<string, string>,
    ][] = [
      ['env', task.env],
      ['verifier.env', task.verifier.env],
      ['solution.env', item.row.agent.oracle ? (task.solution?.env ?? {}) : {}],
    ]
    for (const [name, values] of variables)
      if (Object.keys(values).length)
        await Fs.writeFile(slots.envFile(item.row.slot, name), Slot.envFile(values))
    if (config.verifierCache && task.environment.kind === 'disk')
      await Fs.writeFile(
        slots.verifierCacheFile(item.row.slot),
        (await Eval.verifierCache(task, await hostPolicy)) +
          (item.row.agent.oracle ? ' write\n' : ' read\n'),
      )
    const offline = Eval.offline(task)
    if (offline.length)
      await Fs.writeFile(slots.offlineFile(item.row.slot), offline.join('\n') + '\n')
    const cli = item.row.agent.cli
    if (cli)
      await timed(item, 'attempt.cli', () =>
        shell(slots.agents(cli.kind, Installed.releases[cli.kind])),
      )
    item.memoryMb = Admission.alone({
      availableMb: config.memoryMb === undefined ? await availableMb() : undefined,
      capacityMb: capacity.memoryMb,
      requestedMb: task.resources.memoryMb,
    })
    const up = await output(
      slots.up(item.row.slot, {
        backend,
        cpus: task.resources.cpus,
        ...(disk ? { disk } : {}),
        memoryMb: item.memoryMb,
        network: config.network,
        storageMb: task.resources.storageMb,
      }),
      env,
    )
    const said = (up.stderr.trim() || up.stdout.trim()).slice(-2000)
    if (up.exitCode === Slot.machineExit) throw new MachineError(said)
    if (up.exitCode !== 0)
      throw new Error('the slot command exited with ' + up.exitCode + ': ' + said)
    await move(item, 'up')
  }

  const instruct = async (item: Work) =>
    (item.instruction ??= await Fs.readFile(
      await Store.ensure(stores, { blob: item.row.task.instruction, cache }),
      'utf8',
    ))

  const startCli = async (item: Work, cli: Installed.Agent) => {
    const instruction = await instruct(item)
    const endpoint = await rowCall<Protocol.Endpoint>(item, 'endpoint')
    const state = await rowCall<Protocol.Agent>(item, 'agent', { instruction })
    if (state.state !== 'attached')
      throw new Error('the run answered ' + state.state + ' for an installed agent')
    const file = slots.agentFile(item.row.slot, 'token')
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(slots.agentFile(item.row.slot, 'instruction.md'), instruction)
    await Fs.writeFile(
      slots.agentFile(item.row.slot, 'run.sh'),
      Installed.script(cli, { url: endpoint.url }),
    )
    await Fs.writeFile(file, endpoint.token + '\n', { mode: 0o600 })
    try {
      await shell(
        slots.agent(item.row.slot, { timeoutSec: state.timeoutSec, url: endpoint.url }) +
          ' < ' +
          Sandbox.quote(file),
      )
    } finally {
      await Fs.rm(file, { force: true })
    }
    return move(item, 'cli')
  }

  const endCli = async (item: Work, input: { cli: Installed.Agent; code: number }) => {
    const stream = await Fs.readFile(slots.agentOutput(item.row.slot)).catch(() => Buffer.alloc(0))
    const whole = stream.length <= Protocol.artifactBytes
    const kept = whole
      ? stream
      : stream.subarray(0, stream.lastIndexOf(10, Protocol.artifactBytes - 1) + 1)
    await upload(item, Installed.events, kept)
    if (!whole)
      await upload(
        item,
        'agent/events-omitted.txt',
        'the event stream of the agent is ' +
          stream.length +
          ' bytes, and its first ' +
          kept.length +
          ' are kept\n',
      )
    const errors = await slotLog(item, 'agent', Protocol.artifactBytes)
    await upload(item, 'agent/stderr.txt', errors + '\nthe agent exited with ' + input.code + '\n')
    const summary = Installed.summarize(input.cli.kind, stream.toString('utf8'))
    if (input.code !== 0 && !Verdict.timeoutCodes.includes(input.code))
      return fail(
        item,
        'agent',
        input.cli.kind +
          ' exited with ' +
          input.code +
          ': ' +
          (summary.error ?? errors.slice(-2000)),
      )
    item.message = Verdict.timeoutCodes.includes(input.code) ? '' : summary.message
    return startVerifier(item, { code: input.code })
  }

  const verifierInput = async (item: Work, name: string, content: string) => {
    const file = slots.verifierInput(item.row.slot, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, content)
  }

  const startVerifier = async (item: Work, solve?: { code: number }) => {
    const task = item.row.task
    await rowCall(item, 'verify', solve ? { solve } : {})
    if (task.verifier.finalMessage) await verifierInput(item, 'final_message.txt', item.message)
    await shell(slots.verify(item.row.slot, task.verifier.timeoutSec))
    item.round = 1
    await move(item, 'verify')
  }

  const collect = async (item: Work, code: number) => {
    const task = item.row.task
    const target = directory(item)
    const written = Slot.parseFiles(await shell(slots.files(item.row.slot)))
    const omitted = written.filter((file) => file.bytes > Protocol.artifactBytes)
    for (const file of written)
      if (!omitted.includes(file))
        await upload(
          item,
          'verifier/' + file.path,
          await Fs.readFile(Path.join(target, 'verifier', file.path)),
        )
    if (omitted.length)
      await upload(
        item,
        'verifier-omitted.txt',
        omitted.map((file) => file.path + ' ' + file.bytes + ' bytes\n').join(''),
      )
    await upload(
      item,
      'verifier/test-stdout.txt',
      await slotLog(item, 'verify', Protocol.artifactBytes),
    )

    const rewardText = (await text(Path.join(target, 'verifier', 'reward.txt')))?.replace(
      /[ \n\r]/g,
      '',
    )
    const reward =
      rewardText !== undefined && /^-?[0-9]+(\.[0-9]+)?$/.test(rewardText)
        ? Number(rewardText)
        : null
    const oomText = (await text(Path.join(target, 'oom')))?.trim()
    const oom = oomText !== undefined && /^[0-9]+$/.test(oomText) ? Number(oomText) : 0

    if (
      reward === null &&
      task.verifier.judge &&
      item.round === 1 &&
      !Verdict.timeoutCodes.includes(code)
    ) {
      const request = await shell(slots.log(item.row.slot, 'judge', Judge.requestBytes))
      if (request) {
        const judged = await rowCall<Protocol.Judgement>(item, 'judge', { request })
        if (judged.state === 'invalid' || judged.state === 'failed')
          return fail(item, 'verifier', judged.error)
        return move(item, 'judge')
      }
    }
    const memoryMb = item.memoryMb ?? Admission.clamp(task.resources.memoryMb, capacity)
    await finish(item, {
      verifier: {
        code,
        files: written.map((file) => file.path),
        ...(memoryMb < task.resources.memoryMb ? { memoryMb } : {}),
        ...(oom ? { oom } : {}),
        reward,
      },
    })
  }

  const advance = async (item: Work) => {
    const task = item.row.task
    const target = directory(item)
    const now = Date.now()
    const elapsed = now - item.at
    switch (item.stage) {
      case 'prepare':
        return prepare(item)
      case 'up': {
        const code = Slot.exit(await phase(Path.join(target, 'up.status')))
        if (code === undefined) {
          const setupSec = Math.max(task.setupTimeoutSec ?? 0, config.limits.setupSec)
          if (elapsed > setupSec * 1000)
            return fail(
              item,
              'environment',
              'the task environment was not ready within ' + setupSec + ' s',
            )
          return pending(item)
        }
        if (code !== 0) {
          const upLog = await slotLog(item, 'up', Protocol.logBytes)
          if (code === Slot.machineExit) throw new MachineError(upLog.trim().slice(-2000))
          await upload(item, 'environment.log', upLog)
          return fail(
            item,
            'environment',
            'the task environment failed with exit code ' + code + ': ' + upLog.slice(-2000),
          )
        }
        item.marks.push({ at: item.at, ms: now - item.at, name: 'attempt.up' })
        if (item.row.agent.cli) return startCli(item, item.row.agent.cli)
        const session = (item.session ??= await rowCall<Protocol.Session>(item, 'session'))
        const file = Path.join(target, 'token')
        await Fs.writeFile(file, session.token + '\n', { mode: 0o600 })
        try {
          await timed(item, 'attempt.hand', () =>
            shell(
              slots.hand(item.row.slot, { name: session.name, url: session.url }) +
                ' < ' +
                Sandbox.quote(file),
            ),
          )
        } finally {
          await Fs.rm(file, { force: true })
        }
        return move(item, 'attach')
      }
      case 'attach': {
        if (!item.row.agent.oracle) await instruct(item)
        const askedAt = Date.now()
        const state = await rowCall<Protocol.Agent>(item, 'agent', {
          ...(item.instruction === undefined ? {} : { instruction: item.instruction }),
          waitMs: holdMs,
        })
        if (state.state === 'attached') {
          await shell(slots.solve(item.row.slot, state.timeoutSec))
          return move(item, 'solve')
        }
        if (state.state !== 'waiting') return move(item, 'agent')
        const code = Slot.exit(await phase(Path.join(target, 'hand.status')))
        if (code !== undefined || elapsed > config.limits.attachSec * 1000) {
          const handLog = await slotLog(item, 'hand', Protocol.logBytes)
          await upload(item, 'hand.log', handLog)
          return fail(
            item,
            'environment',
            (code === undefined
              ? 'the hand did not attach within ' + config.limits.attachSec + ' s'
              : 'the hand exited with ' + code) +
              ': ' +
              handLog.slice(-2000),
          )
        }
        return again(item, askedAt)
      }
      case 'agent': {
        const askedAt = Date.now()
        const state = await rowCall<Protocol.Agent>(item, 'agent', { waitMs: holdMs })
        if (state.state === 'completed' || state.state === 'timeout') {
          item.message = state.state === 'completed' ? state.message : ''
          return startVerifier(item)
        }
        if (state.state === 'failed') return fail(item, 'agent', state.error)
        if (
          state.state === 'running' &&
          state.detached &&
          Slot.exit(await phase(Path.join(target, 'hand.status'))) !== undefined
        ) {
          const handLog = await slotLog(item, 'hand', Protocol.logBytes)
          await upload(item, 'hand.log', handLog)
          return fail(item, 'environment', 'the hand left during the turn: ' + handLog.slice(-2000))
        }
        return again(item, askedAt)
      }
      case 'cli': {
        const code = Slot.exit(await phase(Path.join(target, 'agent.status')))
        if (code === undefined) {
          if (elapsed > (task.agent.timeoutSec + config.limits.attachSec) * 1000)
            return fail(item, 'environment', 'the agent did not report within its deadline')
          return pending(item)
        }
        return endCli(item, { cli: item.row.agent.cli!, code })
      }
      case 'solve': {
        const code = Slot.exit(await phase(Path.join(target, 'solve.status')))
        if (code === undefined) {
          if (elapsed > (task.agent.timeoutSec + config.limits.attachSec) * 1000)
            return fail(item, 'environment', 'the solution did not report within its deadline')
          return pending(item)
        }
        await upload(
          item,
          'agent/oracle.txt',
          (await slotLog(item, 'solve', Protocol.artifactBytes)) +
            '\nsolve.sh exited with ' +
            code +
            '\n',
        )
        item.message = (await text(Path.join(target, 'task', Task.finalMessagePath))) ?? ''
        return startVerifier(item, { code })
      }
      case 'verify': {
        const code = Slot.exit(await phase(Path.join(target, 'verify.status')))
        if (code === undefined) {
          if (elapsed > (task.verifier.timeoutSec + config.limits.setupSec) * 1000)
            return fail(item, 'verifier_timeout', 'the verifier did not report within its deadline')
          return pending(item)
        }
        item.marks.push({ at: item.at, ms: now - item.at, name: 'attempt.verifier' })
        return timed(item, 'attempt.collect', () => collect(item, code))
      }
      case 'judge': {
        const judged = await rowCall<Protocol.Judgement>(item, 'judge')
        if (judged.state === 'waiting') return later(item)
        if (judged.state === 'timeout')
          return fail(
            item,
            'verifier_timeout',
            'the judge did not answer within ' + task.verifier.timeoutSec + ' s',
          )
        if (judged.state !== 'answered') return fail(item, 'verifier', judged.error)
        await verifierInput(item, Judge.responseFile, judged.response)
        await shell(slots.reverify(item.row.slot, task.verifier.timeoutSec))
        item.round = 2
        return move(item, 'verify')
      }
    }
  }

  const step = async (item: Work) => {
    item.busy = true
    const seen = item.changed
    try {
      await advance(item)
      item.errors = 0
    } catch (error) {
      if (error instanceof GoneError) {
        log('dropped ' + item.row.id + ': ' + error.message)
        await down(item, false).catch(() => {})
        return
      }
      const dropped = async (failure: unknown) => {
        log('attempt ' + item.row.id + ' could not be finished: ' + String(failure))
        await down(item, false).catch(() => {})
      }
      if (error instanceof MachineError) {
        await giveBack(item, error.message).catch(dropped)
        return
      }
      const reason = error instanceof Error ? error.name + ': ' + error.message : String(error)
      item.errors++
      item.marks.push({ at: Date.now(), name: 'attempt.retry' })
      log('attempt ' + item.row.id + ' stumbled in ' + item.stage + ': ' + reason)
      const final = error instanceof Store.MissingError || error instanceof Store.DigestError
      const full = item.stage === 'prepare' && (error as NodeJS.ErrnoException).code === 'ENOSPC'
      if (final || item.errors > config.limits.stepRetries)
        await (full ? giveBack(item, reason) : fail(item, 'environment', reason)).catch(dropped)
      else item.next = Date.now() + config.pollMs
    } finally {
      item.busy = false
      if (item.changed !== seen) item.next = 0
      signal()
    }
  }

  const fresh = shared.ready === undefined
  if (!shared.ready)
    try {
      shared.ready = await setup({
        backend: config.backend,
        cache,
        home,
        network: config.network,
        pollMs: config.pollMs,
        setupSec: config.limits.setupSec,
      })
    } catch (error) {
      if (error instanceof RefusedError)
        await call('/hello', { error: error.message, runner: config.runner }).catch(() => {})
      throw error
    }
  const { backend, capabilities } = shared.ready
  prefetch(config.ahead)
  const others = new Set(everything().map((item) => item.row.slot))
  serving.rows = () => [...work.values()]
  for (const name of await Fs.readdir(Path.join(home, 'slots'))) {
    if (others.has(name)) continue
    const saved = await text(Path.join(home, 'slots', name, 'row.json'))
    if (!saved) {
      await output(slots.down(name, 'keep'), env)
      continue
    }
    const item: Work = {
      ...(JSON.parse(saved) as Saved),
      busy: false,
      changed: 0,
      delay: firstPollMs,
      errors: 0,
      marks: [],
      next: 0,
    }
    work.set(item.row.id, item)
    up.add(item)
    observe(item)
    log('resumed ' + item.row.id + ' in ' + item.stage)
  }

  if (fresh)
    reported.push(
      ...((await text(Path.join(home, Bootstrap.files.marks))) ?? '')
        .split('\n')
        .map((line) => line.split(' '))
        .filter((fields) => fields.length === 2 && Number.isFinite(Number(fields[1])))
        .map(([name, at]) => ({ at: Number(at), name: name! })),
      { at: startedAt, name: 'runner.start' },
      { at: startedAt, ms: Date.now() - startedAt, name: 'runner.setup' },
    )
  if (!config.ready) {
    const helloAt = Date.now()
    try {
      await call<Config.Runner>('/hello', {
        capabilities,
        held: [...work.values()].map((item) => ({ claim: item.row.claim, id: item.row.id })),
        runner: config.runner,
        ...(reported.length ? { timeline: { marks: reported.splice(0), sentAt: Date.now() } } : {}),
      } satisfies Protocol.Hello)
    } catch (error) {
      throw new RefusedError(error instanceof Error ? error.message : String(error))
    }
    reported.push({ at: helloAt, ms: Date.now() - helloAt, name: 'runner.hello.call' })
  }
  const capacity: Admission.Capacity = {
    ...(config.freeDiskMb === undefined ? {} : { freeDiskMb: config.freeDiskMb }),
    memoryMb: config.memoryMb ?? Math.floor(capabilities.memory_mb * hostUtilization),
    slots: config.slots,
  }
  log(
    'runner ' +
      config.runner +
      ' of run ' +
      config.run +
      ': ' +
      capacity.slots +
      ' slots, ' +
      capacity.memoryMb +
      ' MB, ' +
      backend +
      ' on the ' +
      config.network +
      ' network' +
      (config.endsAt === undefined
        ? ''
        : ', its sandbox ends at ' + new Date(config.endsAt).toISOString()),
  )

  const load = async (): Promise<Admission.Load> => {
    const rows = everything()
    return {
      ...(capacity.freeDiskMb === undefined ? {} : { freeDiskMb: await freeDiskMb([home, cache]) }),
      memoryMb: rows.reduce(
        (total, item) => total + Admission.clamp(item.row.task.resources.memoryMb, capacity),
        0,
      ),
      running: rows.length,
      starting: rows.filter((item) => item.stage === 'prepare' || item.stage === 'up').length,
    }
  }
  const report = (current: Admission.Load): Protocol.Report => ({
    ...(current.freeDiskMb === undefined ? {} : { freeDiskMb: current.freeDiskMb }),
    running: current.running,
    starved: Admission.starved(current, capacity),
  })
  const held = () => [...work.values()].map((item) => ({ claim: item.row.claim, id: item.row.id }))

  let beatAt = 0
  let claiming = false
  let beating = false
  let drained = false
  let holding = false
  let idleMs = config.pollMs
  let over = false
  let yielding = false
  const beatMs = (config.leaseSec * 1000) / 3
  serving.wake = () => {
    claimAt = 0
    frees++
    idleMs = config.pollMs
    signal()
  }
  serving.yield = () => {
    if (!holding || yielding) return
    yielding = true
    void (async () => {
      try {
        while (holding && !shared.stopping) {
          const { yielded } = await call<Protocol.Yielded>('/yield', {
            runner: config.runner,
          } satisfies Protocol.Yield)
          if (yielded) break
          await rest(shared, config.pollMs)
        }
      } catch (error) {
        log('the held claim was not ended: ' + String(error))
      } finally {
        yielding = false
      }
    })()
  }
  shared.stops.add(signal)
  while (!shared.stopping && !((finished || drained || fault !== undefined) && !work.size)) {
    const now = Date.now()
    for (const item of work.values()) if (!item.busy && now >= item.next) void step(item)

    if (!beating && now - beatAt > beatMs) {
      beating = true
      beatAt = now
      void (async () => {
        try {
          const answer = await call<Protocol.HeartbeatResponse>('/heartbeat', {
            held: held(),
            report: report(await load()),
            runner: config.runner,
          } satisfies Protocol.Heartbeat)
          finished = answer.finished
          prefetch(answer.ahead)
          for (const id of answer.lost) {
            const item = work.get(id)
            if (item && !item.busy) {
              log('lost ' + id)
              item.busy = true
              await down(item, false).catch(() => {})
            }
          }
        } catch (error) {
          log('heartbeat failed: ' + String(error))
        } finally {
          beating = false
          signal()
        }
      })()
    }

    if (!claiming && !finished && !drained && fault === undefined && now >= claimAt) {
      claiming = true
      const freed = frees
      void (async () => {
        let next = Date.now() + config.pollMs
        await enter(shared, serving)
        try {
          if (shared.stopping || over) return
          let current = await load()
          if (
            config.disks === 'remove' &&
            capacity.freeDiskMb !== undefined &&
            (current.freeDiskMb ?? 0) < capacity.freeDiskMb
          ) {
            await reclaim()
            current = await load()
          }
          const offer = Admission.offer(current, capacity)
          if (offer.slots > 0 || Admission.starved(current, capacity)) {
            const sentAt = Date.now()
            const waitMs = shared.serving.size > 1 || shared.entering.length ? 0 : holdMs
            holding = waitMs > 0
            const answer = await call<Protocol.ClaimResponse>('/claims', {
              offer,
              report: report(current),
              runner: config.runner,
              ...(reported.length ? { timeline: { marks: reported.splice(0), sentAt } } : {}),
              waitMs,
            } satisfies Protocol.ClaimRequest)
            holding = false
            const claimed: Mark = { at: sentAt, ms: Date.now() - sentAt, name: 'attempt.claim' }
            finished = answer.finished
            if (answer.drained !== undefined) {
              drained = true
              log('claims no more rows: ' + answer.drained)
            }
            for (const row of answer.rows) {
              if (shared.stopping) {
                log('not started ' + row.id + ': the runner is stopping')
                continue
              }
              const earlier = work.get(row.id)
              const item: Work = {
                at: Date.now(),
                busy: false,
                changed: 0,
                delay: firstPollMs,
                errors: 0,
                marks: [claimed],
                message: '',
                next: 0,
                round: 1,
                row,
                stage: 'prepare',
              }
              work.set(row.id, item)
              up.add(item)
              log('claimed ' + row.id + ' ' + row.task.name)
              if (earlier && !earlier.busy) {
                log('lost ' + row.id + ': the run handed the row out again')
                earlier.busy = true
                void down(earlier, false).catch(() => {})
              }
            }
            prefetch(answer.ahead)
            if (answer.rows.length || (waitMs > 0 && Date.now() - sentAt >= holdMs)) next = 0
            else if (!waitMs) {
              next = Date.now() + idleMs
              idleMs = Math.min(idleMs * 2, Math.max(holdMs, config.pollMs))
            }
            if (answer.rows.length) idleMs = config.pollMs
          }
        } catch (error) {
          log('claim failed: ' + String(error))
        } finally {
          holding = false
          exit(shared, serving)
          claiming = false
          claimAt = frees === freed ? next : 0
          signal()
        }
      })()
    }

    if (!signalled) {
      const due = Math.min(
        beating ? Infinity : beatAt + beatMs + 1,
        claiming || finished || drained || fault !== undefined ? Infinity : claimAt,
        ...[...work.values()].filter((item) => !item.busy).map((item) => item.next),
      )
      await new Promise<void>((resolve) => {
        const timer = Number.isFinite(due)
          ? setTimeout(resolve, Math.max(0, due - Date.now()))
          : undefined
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    signalled = false
  }
  over = true
  shared.stops.delete(signal)

  if (shared.stopping) {
    log('stopping: releasing ' + work.size + ' attempts')
    await call('/leave', { held: held(), runner: config.runner } satisfies Protocol.Leave).catch(
      () => {},
    )
    for (const item of up) await down(item, false).catch(() => {})
  } else {
    await call('/leave', { held: [], runner: config.runner } satisfies Protocol.Leave).catch(
      () => {},
    )
  }
  log('runner ' + config.runner + ' left')
  if (fault !== undefined && !shared.stopping)
    throw new MachineError('the machine could not bring a slot up: ' + fault)
}

export async function detach(options: {
  arguments: readonly string[]
  home: string
}): Promise<number> {
  await Fs.mkdir(options.home, { recursive: true })
  const log = await Fs.open(Path.join(options.home, 'runner.log'), 'a')
  const child = spawn(process.execPath, [...process.execArgv, ...options.arguments], {
    cwd: options.home,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  })
  await Fs.writeFile(Path.join(options.home, 'runner.pid'), String(child.pid) + '\n')
  child.unref()
  await log.close()
  return child.pid!
}
