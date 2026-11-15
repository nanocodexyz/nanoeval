import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Memory from './Memory.ts'

async function read(file: string): Promise<string | undefined> {
  return Fs.readFile(file, 'utf8').then(
    (content) => content.trim(),
    () => undefined,
  )
}

export function allowed(status: string): number[] | undefined {
  const list = /^Cpus_allowed_list:\s*([0-9,-]+)$/m.exec(status)?.[1]
  return list?.split(',').flatMap((range) => {
    const [first, last = first] = range.split('-').map(Number)
    return Array.from({ length: last! - first! + 1 }, (_, index) => first! + index)
  })
}

export function quota(max: string): number | undefined {
  const found = /^([0-9]+) ([0-9]+)$/.exec(max.trim())
  return found ? Number(found[1]) / Number(found[2]) : undefined
}

export async function limit(options: limit.Options): Promise<number | undefined> {
  let found = allowed((await read(options.status)) ?? '')?.length
  const path = Memory.group((await read(options.self)) ?? '')
  if (!path) return found
  for (let directory = path; ; directory = Path.posix.dirname(directory)) {
    const share = quota((await read(Path.join(options.cgroups, directory, 'cpu.max'))) ?? '')
    if (share !== undefined) found = Math.min(share, found ?? share)
    if (directory === '/' || directory === '.') return found
  }
}

export declare namespace limit {
  type Options = Memory.limit.Options & { status: string }
}

export function threads(online: number, limited: number | undefined): number {
  return Math.max(1, Math.floor(Math.min(online, limited ?? online)))
}

export const host: limit.Options = { ...Memory.host, status: '/proc/self/status' }
