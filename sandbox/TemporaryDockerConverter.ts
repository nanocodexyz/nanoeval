import { execFile } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import type * as Eval from '../src/Eval.ts'
import type * as Converter from './Converter.ts'
import * as Host from './Host.ts'

const script = Path.join(import.meta.dirname, 'temporary-docker-convert.sh')

function run(args: readonly string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      [script, ...args],
      { env: { ...Host.environment(), NANOEVAL_HOME: home }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              'the temporary Docker converter failed at ' +
                args[0] +
                ': ' +
                (stderr.trim() || stdout.trim() || error.message).slice(-2000),
            ),
          )
        else resolve(stdout)
      },
    )
  })
}

export function create(options: { home: string }): Converter.Converter {
  let tools: Promise<string> | undefined
  const ready = () => (tools ??= run(['tools'], options.home))
  return {
    format: 'tar-sparse-zstd',
    name: 'temporary-docker',
    async convert(environment, disk) {
      await ready()
      const meta = disk + '.meta.json'
      await run(
        [
          'build',
          environment.image === undefined ? 'dockerfile' : 'ref',
          environment.image ?? environment.context ?? '',
          String(environment.storageMb),
          disk,
          meta,
        ],
        options.home,
      )
      const raw = JSON.parse(await Fs.readFile(meta, 'utf8')) as {
        architecture?: string
        config?: Record<string, unknown>
        digest?: string
      }
      await Fs.rm(meta, { force: true })
      const config = raw.config ?? {}
      const list = (value: unknown) => (Array.isArray(value) ? (value as string[]) : [])
      return {
        architecture: raw.architecture ?? '',
        cmd: list(config['Cmd']),
        digest: raw.digest ?? '',
        entrypoint: list(config['Entrypoint']),
        env: list(config['Env']),
        user: typeof config['User'] === 'string' ? config['User'] : '',
        workdir: typeof config['WorkingDir'] === 'string' ? config['WorkingDir'] : '',
      } satisfies Eval.Meta
    },
    async pack(disk, file) {
      await run(['pack', disk, file], options.home)
    },
    async unpack(file, disk) {
      await run(['unpack', file, disk], options.home)
    },
  }
}
