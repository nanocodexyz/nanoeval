import { execFile, spawn } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Admission from '../src/Admission.ts'
import type * as Config from '../src/Config.ts'
import * as Eval from '../src/Eval.ts'
import * as Installed from '../src/Installed.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Judge from '../src/Judge.ts'
import * as Protocol from '../src/Protocol.ts'
import type * as Result from '../src/Result.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Task from '../src/Task.ts'
import * as Verdict from '../src/Verdict.ts'
import * as Converter from './Converter.ts'
import * as Host from './Host.ts'
import * as Store from './Store.ts'

export class GoneError extends Error {
  override name = 'Runner.GoneError'
}

export class RefusedError extends Error {
  override name = 'Runner.RefusedError'
}

export type Options = {
  cache: string
  config: Config.Runner
  home: string
  log?(line: string): void
  store?: string
}

type Stage = 'agent' | 'attach' | 'cli' | 'judge' | 'prepare' | 'solve' | 'up' | 'verify'

type Work = {
  at: number
  busy: boolean
  delay: number
  errors: number
  instruction?: string
  message: string
  next: number
  round: 1 | 2
  row: Protocol.Claimed
  stage: Stage
}

type Saved = Pick<Work, 'at' | 'message' | 'round' | 'row' | 'stage'>

const hostUtilization = 0.8
const loopMs = 25
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

async function freeDiskMb(paths: readonly string[]): Promise<number> {
  let least = Infinity
  for (const path of paths) {
    const stat = await Fs.statfs(path).catch(() => undefined)
    if (stat) least = Math.min(least, Math.floor((stat.bavail * stat.bsize) / (1024 * 1024)))
  }
  return Number.isFinite(least) ? least : 0
}

export async function run(options: Options): Promise<void> {
  const { cache, home } = options
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
  const unpacking = new Map<string, Promise<void>>()
  const config = options.config
  let stopping = false
  let finished = false

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
    call<T>('/rows/' + item.row.id + '/' + action, { ...body, claim: item.row.claim })

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
      message: item.message,
      round: item.round,
      row: item.row,
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
  const slotLog = (item: Work, name: 'agent' | 'hand' | 'solve' | 'up' | 'verify', bytes: number) =>
    shell(slots.log(item.row.slot, name, bytes))

  const down = async (item: Work, evict: boolean) => {
    const disk = await text(Path.join(directory(item), 'disk'))
    const marked =
      evict &&
      disk !== undefined &&
      (await Fs.stat(disk.trim() + '.run-' + config.run).then(
        () => true,
        () => false,
      ))
    await output(slots.down(item.row.slot, marked ? 'remove' : 'keep'), env)
    if (marked) {
      const gone = await Fs.stat(disk!.trim() + '.ext4').then(
        () => false,
        () => true,
      )
      if (gone)
        for (const suffix of ['.run-' + config.run, '.use', '.lock'])
          await Fs.rm(disk!.trim() + suffix, { force: true })
    }
    work.delete(item.row.id)
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

  const ensureDisk = async (environment: Extract<Eval.Environment, { kind: 'disk' }>) => {
    const prefix = Path.join(cache, 'disks', environment.disk.digest)
    await Fs.mkdir(Path.dirname(prefix), { recursive: true })
    const present = () =>
      Fs.stat(prefix + '.ext4').then(
        () => true,
        () => false,
      )
    if (!(await present())) {
      if (environment.format !== converter.format)
        throw new Error(
          'the environment disk is packed as ' +
            environment.format +
            ', and this runner unpacks ' +
            converter.format,
        )
      const packed = await Store.ensure(stores, { blob: environment.disk, cache })
      let pending = unpacking.get(prefix)
      if (!pending) {
        pending = converter
          .unpack(packed, prefix + '.ext4')
          .then(() => Fs.writeFile(prefix + '.run-' + config.run, ''))
          .finally(() => unpacking.delete(prefix))
        unpacking.set(prefix, pending)
      }
      await pending
      if (config.disks === 'remove') await Fs.rm(packed, { force: true })
    }
    await Host.describe(prefix, environment.meta)
    return prefix
  }

  const hostPolicy = Fs.readFile(process.env['NANOEVAL_SLOT_ENV'] ?? '').then(
    (variables) => Bytes.sha256(variables),
    () => '',
  )

  const prepare = async (item: Work) => {
    const task = item.row.task
    const target = directory(item)
    await Fs.mkdir(target, { recursive: true })
    await save(item)
    const fetch = async (blob: Eval.Blob, name: string) => {
      const file = Path.join(target, name)
      await Fs.rm(file, { force: true })
      await Fs.copyFile(await Store.ensure(stores, { blob, cache }), file)
      await Fs.chmod(file, 0o644)
    }
    await fetch(task.tests, 'tests.tar')
    if (task.solution && item.row.agent.oracle) await fetch(task.solution.archive, 'solution.tar')
    let disk: string | undefined
    if (task.environment.kind === 'disk') disk = await ensureDisk(task.environment)
    else await fetch(task.environment.files, 'environment.tar')
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
    if (cli) await shell(slots.agents(cli.kind, Installed.releases[cli.kind]))
    await shell(
      slots.up(item.row.slot, {
        backend: config.backend,
        cpus: task.resources.cpus,
        ...(disk ? { disk } : {}),
        memoryMb: task.resources.memoryMb,
        network: config.network,
        storageMb: task.resources.storageMb,
      }),
    )
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
    await finish(item, {
      verifier: { code, files: written.map((file) => file.path), ...(oom ? { oom } : {}), reward },
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
          return
        }
        if (code !== 0) {
          const upLog = await slotLog(item, 'up', Protocol.logBytes)
          await upload(item, 'environment.log', upLog)
          return fail(
            item,
            'environment',
            'the task environment failed with exit code ' + code + ': ' + upLog.slice(-2000),
          )
        }
        if (item.row.agent.cli) return startCli(item, item.row.agent.cli)
        const session = await rowCall<Protocol.Session>(item, 'session')
        const file = Path.join(target, 'token')
        await Fs.writeFile(file, session.token + '\n', { mode: 0o600 })
        try {
          await shell(
            slots.hand(item.row.slot, { name: session.name, url: session.url }) +
              ' < ' +
              Sandbox.quote(file),
          )
        } finally {
          await Fs.rm(file, { force: true })
        }
        if (!item.row.agent.oracle) await instruct(item)
        return move(item, 'attach')
      }
      case 'attach': {
        if (!item.row.agent.oracle) await instruct(item)
        const state = await rowCall<Protocol.Agent>(
          item,
          'agent',
          item.instruction === undefined ? {} : { instruction: item.instruction },
        )
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
        return later(item)
      }
      case 'agent': {
        const state = await rowCall<Protocol.Agent>(item, 'agent')
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
        return later(item)
      }
      case 'cli': {
        const code = Slot.exit(await phase(Path.join(target, 'agent.status')))
        if (code === undefined) {
          if (elapsed > (task.agent.timeoutSec + config.limits.attachSec) * 1000)
            return fail(item, 'environment', 'the agent did not report within its deadline')
          return
        }
        return endCli(item, { cli: item.row.agent.cli!, code })
      }
      case 'solve': {
        const code = Slot.exit(await phase(Path.join(target, 'solve.status')))
        if (code === undefined) {
          if (elapsed > (task.agent.timeoutSec + config.limits.attachSec) * 1000)
            return fail(item, 'environment', 'the solution did not report within its deadline')
          return
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
          return
        }
        return collect(item, code)
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
    try {
      await advance(item)
      item.errors = 0
    } catch (error) {
      if (error instanceof GoneError) {
        log('dropped ' + item.row.id + ': ' + error.message)
        await down(item, false).catch(() => {})
        return
      }
      const reason = error instanceof Error ? error.name + ': ' + error.message : String(error)
      item.errors++
      log('attempt ' + item.row.id + ' stumbled in ' + item.stage + ': ' + reason)
      const final = error instanceof Store.MissingError || error instanceof Store.DigestError
      if (final || item.errors > config.limits.stepRetries)
        await fail(item, 'environment', reason).catch(async (failure) => {
          log('attempt ' + item.row.id + ' could not be finished: ' + String(failure))
          await down(item, false).catch(() => {})
        })
      else item.next = Date.now() + config.pollMs
    } finally {
      item.busy = false
    }
  }

  await Fs.mkdir(Path.join(home, 'slots'), { recursive: true })
  await Fs.mkdir(Path.join(cache, 'blobs'), { recursive: true })
  await Fs.copyFile(script, slots.script)
  await shell(
    slots.setup({ backend: config.backend, network: config.network, runtime: Slot.runtime }),
  )
  for (const started = Date.now(); ; ) {
    const code = Slot.exit(await phase(Path.join(home, 'setup.status')))
    if (code === 0) break
    if (code !== undefined || Date.now() - started > config.limits.setupSec * 1000) {
      const error =
        (code === undefined
          ? 'sandbox setup did not finish within ' + config.limits.setupSec + ' s'
          : 'sandbox setup exited with ' + code) +
        ': ' +
        (await shell(slots.log('-', 'setup', Protocol.logBytes))).slice(-2000)
      await call('/hello', { error, runner: config.runner }).catch(() => {})
      throw new RefusedError(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  for (const name of await Fs.readdir(Path.join(home, 'slots'))) {
    const saved = await text(Path.join(home, 'slots', name, 'row.json'))
    if (!saved) {
      await output(slots.down(name, 'keep'), env)
      continue
    }
    const item: Work = {
      ...(JSON.parse(saved) as Saved),
      busy: false,
      delay: firstPollMs,
      errors: 0,
      next: 0,
    }
    work.set(item.row.id, item)
    log('resumed ' + item.row.id + ' in ' + item.stage)
  }

  const capabilities = JSON.parse(await shell(slots.probe())) as Sandbox.Capabilities
  try {
    await call<Config.Runner>('/hello', {
      capabilities,
      held: [...work.values()].map((item) => ({ claim: item.row.claim, id: item.row.id })),
      runner: config.runner,
    } satisfies Protocol.Hello)
  } catch (error) {
    throw new RefusedError(error instanceof Error ? error.message : String(error))
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
      config.backend +
      ' on the ' +
      config.network +
      ' network',
  )

  const load = async (): Promise<Admission.Load> => ({
    ...(capacity.freeDiskMb === undefined ? {} : { freeDiskMb: await freeDiskMb([home, cache]) }),
    memoryMb: [...work.values()].reduce(
      (total, item) => total + Admission.clamp(item.row.task.resources.memoryMb, capacity),
      0,
    ),
    running: work.size,
    starting: [...work.values()].filter((item) => item.stage === 'prepare' || item.stage === 'up')
      .length,
  })
  const report = (current: Admission.Load): Protocol.Report => ({
    ...(current.freeDiskMb === undefined ? {} : { freeDiskMb: current.freeDiskMb }),
    running: current.running,
    starved: Admission.starved(current, capacity),
  })
  const held = () => [...work.values()].map((item) => ({ claim: item.row.claim, id: item.row.id }))

  const stop = () => {
    stopping = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  let beatAt = 0
  let claimAt = 0
  let claiming = false
  let beating = false
  while (!stopping && !(finished && !work.size)) {
    const now = Date.now()
    for (const item of work.values()) if (!item.busy && now >= item.next) void step(item)

    if (!beating && now - beatAt > (config.leaseSec * 1000) / 3) {
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
        }
      })()
    }

    if (!claiming && !finished && now - claimAt >= config.pollMs) {
      claiming = true
      claimAt = now
      void (async () => {
        try {
          const current = await load()
          const offer = Admission.offer(current, capacity)
          if (offer.slots > 0 || Admission.starved(current, capacity)) {
            const answer = await call<Protocol.ClaimResponse>('/claims', {
              offer,
              report: report(current),
              runner: config.runner,
            } satisfies Protocol.ClaimRequest)
            finished = answer.finished
            for (const row of answer.rows) {
              work.set(row.id, {
                at: Date.now(),
                busy: false,
                delay: firstPollMs,
                errors: 0,
                message: '',
                next: 0,
                round: 1,
                row,
                stage: 'prepare',
              })
              log('claimed ' + row.id + ' ' + row.task.name)
            }
            if (answer.rows.length) claimAt = 0
          }
        } catch (error) {
          log('claim failed: ' + String(error))
        } finally {
          claiming = false
        }
      })()
    }
    await new Promise((resolve) => setTimeout(resolve, loopMs))
  }

  if (stopping) {
    log('stopping: releasing ' + work.size + ' attempts')
    await call('/leave', { held: held(), runner: config.runner } satisfies Protocol.Leave).catch(
      () => {},
    )
    for (const item of work.values()) await down(item, false).catch(() => {})
  } else {
    await call('/leave', { held: [], runner: config.runner } satisfies Protocol.Leave).catch(
      () => {},
    )
  }
  log('runner ' + config.runner + ' left')
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
