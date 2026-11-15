import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'

export type Peer = { slots: number; threads?: readonly number[] }

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function directory(cache: string): string {
  return Path.join(cache, 'runners')
}

export function file(options: file.Options): string {
  return Path.join(directory(options.cache), options.pid + '.' + options.run + '.json')
}

export declare namespace file {
  type Options = { cache: string; pid: number; run: string }
}

export function held(own: readonly number[] | undefined, peers: readonly Peer[]): number {
  return peers.reduce((total, peer) => {
    if (!own || !peer.threads?.length) return total + peer.slots
    const shared = peer.threads.filter((thread) => own.includes(thread)).length
    return total + (peer.slots * shared) / peer.threads.length
  }, 0)
}

export async function others(options: others.Options): Promise<Peer[]> {
  const found = new Map<number, Peer>()
  for (const name of await Fs.readdir(directory(options.cache)).catch(() => [])) {
    const pid = Number(name.split('.')[0])
    if (!Number.isInteger(pid) || pid === options.pid || !options.alive(pid)) continue
    const peer = parse(
      await Fs.readFile(Path.join(directory(options.cache), name), 'utf8').catch(() => ''),
    )
    if (peer && peer.slots > (found.get(pid)?.slots ?? 0)) found.set(pid, peer)
  }
  return [...found.values()]
}

export declare namespace others {
  type Options = { alive(pid: number): boolean; cache: string; pid: number }
}

export function parse(text: string): Peer | undefined {
  try {
    const { slots, threads } = JSON.parse(text) as { slots?: unknown; threads?: unknown }
    if (!Number.isInteger(slots) || (slots as number) < 1) return undefined
    return {
      slots: slots as number,
      ...(Array.isArray(threads) && threads.every((thread) => Number.isInteger(thread))
        ? { threads: threads as number[] }
        : {}),
    }
  } catch {
    return undefined
  }
}

export async function write(path: string, peer: Peer): Promise<void> {
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, JSON.stringify(peer))
}
