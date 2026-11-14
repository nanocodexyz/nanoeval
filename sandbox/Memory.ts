import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'

export type Limit = { headroomMb: number; limitMb: number }

const mib = 1024 * 1024

export function group(text: string): string | undefined {
  const line = text.split('\n').find((entry) => entry.startsWith('0::'))
  return line?.slice(3) || undefined
}

async function read(file: string): Promise<string | undefined> {
  return Fs.readFile(file, 'utf8').then(
    (content) => content.trim(),
    () => undefined,
  )
}

export async function limit(options: limit.Options): Promise<Limit | undefined> {
  const path = group((await read(options.self)) ?? '')
  if (!path) return undefined
  let found: Limit | undefined
  for (let directory = path; ; directory = Path.posix.dirname(directory)) {
    const at = Path.join(options.cgroups, directory)
    const max = await read(Path.join(at, 'memory.max'))
    if (max !== undefined && /^[0-9]+$/.test(max)) {
      const current = Number((await read(Path.join(at, 'memory.current'))) ?? max)
      const file = Number(
        /^file ([0-9]+)$/m.exec((await read(Path.join(at, 'memory.stat'))) ?? '')?.[1] ?? 0,
      )
      const limitMb = Math.floor(Number(max) / mib)
      const headroomMb = Math.max(0, Math.floor((Number(max) - current + file) / mib))
      found = {
        headroomMb: Math.min(headroomMb, found?.headroomMb ?? headroomMb),
        limitMb: Math.min(limitMb, found?.limitMb ?? limitMb),
      }
    }
    if (directory === '/' || directory === '.') return found
  }
}

export declare namespace limit {
  type Options = { cgroups: string; self: string }
}

export const host: limit.Options = { cgroups: '/sys/fs/cgroup', self: '/proc/self/cgroup' }
