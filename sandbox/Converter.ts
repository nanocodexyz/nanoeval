import { execFile } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import type * as Eval from '../src/Eval.ts'
import * as Host from './Host.ts'

export class ConvertError extends Error {
  override name = 'Converter.ConvertError'
}

export class StalledError extends ConvertError {
  override name = 'Converter.StalledError'
}

export type Environment = {
  context?: string
  image?: string
  storageMb: number
}

export type Converter = {
  readonly format: string
  readonly name: string
  convert(environment: Environment, disk: string): Promise<Eval.Meta>
  pack(disk: string, file: string): Promise<void>
  unpack(file: string, disk: string): Promise<void>
}

export type Policy = {
  caBundle?: string
  envFile?: string
  forwards?: readonly string[]
  pullWaitSec?: number
}

export type Built = {
  config: {
    architecture: string
    cmd: readonly string[] | null
    entrypoint: readonly string[] | null
    env: readonly string[]
    user: string
    working_dir: string
  }
  image_digest: string
}

export const stalledCode = 75
export const defaultPath = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export const format = 'nkrdisk1'

const script = Path.join(import.meta.dirname, 'slot.sh')

export function defaultLayers(
  cache: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return env['NANOEVAL_LAYERS'] ?? Path.join(cache, 'oci')
}

export function policy(env: Record<string, string | undefined> = process.env): Policy {
  const forwards = (env['NANOEVAL_SLOT_FORWARD'] ?? '').split(' ').filter(Boolean)
  const wait = env['NANOEVAL_PULL_WAIT_SEC']
  if (wait !== undefined && !/^\d+$/.test(wait))
    throw new ConvertError('NANOEVAL_PULL_WAIT_SEC is a whole number of seconds, not ' + wait)
  return {
    ...(env['NANOEVAL_CA_BUNDLE'] ? { caBundle: env['NANOEVAL_CA_BUNDLE'] } : {}),
    ...(env['NANOEVAL_SLOT_ENV'] ? { envFile: env['NANOEVAL_SLOT_ENV'] } : {}),
    ...(forwards.length ? { forwards } : {}),
    ...(wait === undefined ? {} : { pullWaitSec: Number(wait) }),
  }
}

export function meta(built: Built): Eval.Meta {
  const { config } = built
  return {
    architecture: config.architecture,
    cmd: config.cmd ?? [],
    digest: built.image_digest,
    entrypoint: config.entrypoint ?? [],
    env: config.env.some((line) => line.startsWith('PATH='))
      ? config.env
      : [...config.env, defaultPath],
    user: config.user,
    workdir: config.working_dir,
  }
}

export function run(step: string, command: readonly [program: string, ...arguments: string[]]) {
  const [program, ...rest] = command
  return new Promise<string>((resolve, reject) => {
    execFile(
      program,
      rest,
      { env: Host.environment(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new (error.code === stalledCode ? StalledError : ConvertError)(
              'the converter failed at ' +
                step +
                ': ' +
                (stderr.trim() || stdout.trim() || error.message).slice(-2000),
            ),
          )
        else resolve(stdout)
      },
    )
  })
}

export async function again<T>(work: () => Promise<T>, log?: (line: string) => void): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof StalledError)) throw error
    log?.(error.message + ', so the image is converted again')
    return work()
  }
}

export function create(options: {
  home: string
  layers: string
  log?(line: string): void
  policy?: Policy
}): Converter {
  const krun = Path.join(options.home, 'rt', 'krun', 'nanoeval-krun')
  let tools: Promise<unknown> | undefined
  const image = async (step: string, rest: readonly string[]) => {
    await (tools ??= run('tools', [
      'env',
      'NANOEVAL_HOME=' + options.home,
      'bash',
      script,
      'tools',
    ]))
    return run(step, [krun, 'image', step, ...rest])
  }
  return {
    format,
    name: 'krun-image',
    async convert(environment, disk) {
      const file = disk + '.meta.json'
      const build = () =>
        image('build', [
          ...(environment.image === undefined
            ? [
                '--dockerfile',
                environment.context ?? '',
                ...(options.policy?.caBundle ? ['--ca-bundle', options.policy.caBundle] : []),
                ...(options.policy?.envFile ? ['--env-file', options.policy.envFile] : []),
                ...(options.policy?.forwards ?? []).flatMap((forward) => ['--forward', forward]),
              ]
            : ['--ref', environment.image]),
          ...(options.policy?.pullWaitSec === undefined
            ? []
            : ['--pull-wait', String(options.policy.pullWaitSec)]),
          '--size-mb',
          String(environment.storageMb),
          '--out',
          disk,
          '--meta',
          file,
          '--cache',
          options.layers,
        ])
      await again(build, options.log)
      const built = JSON.parse(await Fs.readFile(file, 'utf8')) as Built
      await Fs.rm(file, { force: true })
      return meta(built)
    },
    async pack(disk, file) {
      await image('pack', [disk, '--out', file])
    },
    async unpack(file, disk) {
      await image('unpack', [file, '--out', disk])
    },
  }
}
