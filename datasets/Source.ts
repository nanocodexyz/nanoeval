import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'

export class FetchError extends Error {
  override name = 'Source.FetchError'
}

export class StaleError extends Error {
  override name = 'Source.StaleError'
}

export type Store = {
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response>
  root: string
}

export function defaultRoot(env: Record<string, string | undefined> = process.env): string {
  return Path.join(
    env['NANOEVAL_CACHE'] ??
      Path.join(env['XDG_CACHE_HOME'] ?? Path.join(Os.homedir(), '.cache'), 'nanoeval'),
    'sources',
  )
}

export function create(root: string): Store {
  return { fetch: (url, init) => fetch(url, { ...init, redirect: 'follow' }), root }
}

export function sha256(bytes: Uint8Array): string {
  return Crypto.createHash('sha256').update(bytes).digest('hex')
}

export async function get(
  store: Store,
  input: { headers?: Record<string, string>; url: string },
): Promise<Uint8Array> {
  const response = await store.fetch(input.url, input.headers ? { headers: input.headers } : {})
  if (!response.ok) {
    await response.body?.cancel()
    throw new FetchError(input.url + ' answered ' + response.status)
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function keep(path: string, bytes: Uint8Array): Promise<void> {
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  const temporary = path + '.' + Crypto.randomBytes(6).toString('hex')
  await Fs.writeFile(temporary, bytes)
  await Fs.rename(temporary, path)
}

export async function download(
  store: Store,
  input: { headers?: Record<string, string>; sha256: string; url: string },
): Promise<Uint8Array> {
  const path = Path.join(store.root, 'sha256', input.sha256)
  const kept = await Fs.readFile(path).catch(() => undefined)
  if (kept) {
    if (sha256(kept) !== input.sha256) throw new StaleError(path + ' does not hash to its name')
    return kept
  }
  const bytes = await get(store, input)
  const actual = sha256(bytes)
  if (actual !== input.sha256)
    throw new StaleError(
      input.url + ' has SHA-256 ' + actual + ', and ' + input.sha256 + ' is pinned',
    )
  await keep(path, bytes)
  return bytes
}

export async function kept(
  store: Store,
  key: string,
  produce: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const path = Path.join(store.root, key)
  const existing = await Fs.readFile(path).catch(() => undefined)
  if (existing) return existing
  const bytes = await produce()
  await keep(path, bytes)
  return bytes
}
