import { execFile } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import type * as Eval from '../src/Eval.ts'
import * as Host from './Host.ts'

export class ConvertError extends Error {
  override name = 'Converter.ConvertError'
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

export const defaultPath = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export const format = 'nkrdisk1'

const script = Path.join(import.meta.dirname, 'slot.sh')

export function defaultLayers(
  cache: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return env['NANOEVAL_LAYERS'] ?? Path.join(cache, 'oci')
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

function run(step: string, command: readonly [program: string, ...arguments: string[]]) {
  const [program, ...rest] = command
  return new Promise<string>((resolve, reject) => {
    execFile(
      program,
      rest,
      { env: Host.environment(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new ConvertError(
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

export function create(options: { home: string; layers: string }): Converter {
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
      await image('build', [
        ...(environment.image === undefined
          ? ['--dockerfile', environment.context ?? '']
          : ['--ref', environment.image]),
        '--size-mb',
        String(environment.storageMb),
        '--out',
        disk,
        '--meta',
        file,
        '--cache',
        options.layers,
      ])
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
