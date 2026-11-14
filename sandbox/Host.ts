import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as FsPromises from 'node:fs/promises'
import * as Path from 'node:path'
import type * as Eval from '../src/Eval.ts'

const krun = Path.resolve(import.meta.dirname, '../krun')

export function environment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...(!base['NANOEVAL_KRUN'] && !base['NANOEVAL_KRUN_SOURCE'] && Fs.existsSync(krun)
      ? { NANOEVAL_KRUN_SOURCE: krun }
      : {}),
    ...base,
  }
}

export type Kvm = 'absent' | 'closed' | 'open'

export type Machine = { kvm: Kvm; krunfw: boolean }

export function kvm(device = '/dev/kvm'): Kvm {
  if (!Fs.existsSync(device)) return 'absent'
  try {
    Fs.accessSync(device, Fs.constants.R_OK | Fs.constants.W_OK)
    return 'open'
  } catch {
    return 'closed'
  }
}

export function krunfw(): boolean {
  const name = 'libkrunfw.so.5'
  const listed = spawnSync('ldconfig', ['-p'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: (process.env['PATH'] ?? '') + ':/usr/sbin:/sbin' },
  })
  if (listed.status === 0 && listed.stdout.includes(name)) return true
  return [
    ...(process.env['LD_LIBRARY_PATH'] ?? '').split(':').filter(Boolean),
    '/lib',
    '/usr/lib',
    '/lib64',
    '/usr/lib64',
  ].some((directory) => Fs.existsSync(Path.join(directory, name)))
}

export function machine(): Machine {
  return { krunfw: krunfw(), kvm: kvm() }
}

export function microvm(found: Machine): string | undefined {
  if (found.kvm === 'absent') return 'this machine has no /dev/kvm'
  if (found.kvm === 'closed') return 'this user cannot read and write /dev/kvm'
  if (!found.krunfw) return 'libkrunfw.so.5 is not installed on this machine'
  return undefined
}

export function launcher(env: NodeJS.ProcessEnv = environment()): 'built' | 'given' | 'none' {
  if (env['NANOEVAL_KRUN']) return 'given'
  const source = env['NANOEVAL_KRUN_SOURCE']
  if (!source) return 'none'
  return Fs.existsSync(
    Path.join(env['CARGO_TARGET_DIR'] ?? Path.join(source, 'target'), 'release', 'nanoeval-krun'),
  )
    ? 'built'
    : 'none'
}

let writes = 0

async function replace(file: string, content: string): Promise<void> {
  const temporary = file + '.' + process.pid + '.' + ++writes
  await FsPromises.writeFile(temporary, content)
  await FsPromises.rename(temporary, file)
}

export async function describe(prefix: string, meta: Eval.Meta): Promise<void> {
  await replace(prefix + '.env', meta.env.map((line) => line + '\n').join(''))
  await replace(prefix + '.user', meta.user + '\n')
  await replace(prefix + '.workdir', meta.workdir + '\n')
}
