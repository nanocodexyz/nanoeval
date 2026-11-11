import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as FsPromises from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type * as Eval from '../src/Eval.ts'

export class DigestError extends Error {
  override name = 'Store.DigestError'
}

export class MissingError extends Error {
  override name = 'Store.MissingError'
}

export class RequestError extends Error {
  override name = 'Store.RequestError'
}

export type Store = {
  readonly name: string
  fetch(digest: string, file: string): Promise<boolean>
  has(digest: string): Promise<boolean>
  put(digest: string, file: string): Promise<void>
}

export const partBytes = 64 * 1024 * 1024

export function defaultRoot(env: Record<string, string | undefined> = process.env): string {
  return (
    env['NANOEVAL_STORE'] ??
    Path.join(
      env['XDG_DATA_HOME'] ?? Path.join(Os.homedir(), '.local', 'share'),
      'nanoeval',
      'store',
    )
  )
}

export function defaultCache(env: Record<string, string | undefined> = process.env): string {
  return (
    env['NANOEVAL_CACHE'] ??
    Path.join(env['XDG_CACHE_HOME'] ?? Path.join(Os.homedir(), '.cache'), 'nanoeval')
  )
}

export async function digest(file: string): Promise<Eval.Blob> {
  const hash = Crypto.createHash('sha256')
  let bytes = 0
  for await (const chunk of Fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { bytes, digest: hash.digest('hex') }
}

async function place(source: string, target: string): Promise<void> {
  await FsPromises.mkdir(Path.dirname(target), { recursive: true })
  const staged = target + '.' + process.pid + '-' + Crypto.randomBytes(4).toString('hex')
  try {
    await FsPromises.link(source, staged).catch(() => FsPromises.copyFile(source, staged))
    await FsPromises.rename(staged, target)
  } finally {
    await FsPromises.rm(staged, { force: true })
  }
}

export function directory(root: string): Store {
  const path = (name: string) => Path.join(root, 'sha256', name.slice(0, 2), name)
  const exists = (name: string) =>
    FsPromises.stat(path(name)).then(
      (stat) => stat.isFile(),
      () => false,
    )
  return {
    name: 'directory ' + root,
    async fetch(name, file) {
      if (!(await exists(name))) return false
      await place(path(name), file)
      return true
    },
    has: exists,
    async put(name, file) {
      if (await exists(name)) return
      await place(file, path(name))
      await FsPromises.chmod(path(name), 0o444)
    },
  }
}

export function remote(options: remote.Options): Store {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const base = options.base.replace(/\/+$/, '')
  const call = async (path: string, init: RequestInit, accept: readonly number[] = []) => {
    const response = await send(base + path, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + options.token },
    })
    if (!response.ok && !accept.includes(response.status))
      throw new RequestError(
        (init.method ?? 'GET') +
          ' ' +
          path +
          ' answered ' +
          response.status +
          ': ' +
          (await response.text()).slice(0, 500),
      )
    return response
  }
  return {
    name: 'remote ' + base,
    async fetch(name, file) {
      const response = await call('/' + name, {}, [404])
      if (response.status === 404 || !response.body) {
        await response.body?.cancel()
        return false
      }
      await FsPromises.mkdir(Path.dirname(file), { recursive: true })
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        Fs.createWriteStream(file),
      )
      return true
    },
    async has(name) {
      const response = await call('/' + name, { method: 'HEAD' }, [404])
      return response.ok
    },
    async put(name, file) {
      const { size } = await FsPromises.stat(file)
      if (size <= partBytes) {
        await call('/' + name, {
          body: (await FsPromises.readFile(file)) as Uint8Array<ArrayBuffer>,
          method: 'PUT',
        })
        return
      }
      const { upload } = (await (
        await call('/' + name + '/uploads', { method: 'POST' })
      ).json()) as { upload: string }
      const handle = await FsPromises.open(file, 'r')
      const parts: { etag: string; part: number }[] = []
      try {
        for (let offset = 0, part = 1; offset < size; offset += partBytes, part++) {
          const buffer = Buffer.alloc(Math.min(partBytes, size - offset))
          await handle.read(buffer, 0, buffer.length, offset)
          parts.push(
            (await (
              await call('/' + name + '/uploads/' + encodeURIComponent(upload) + '/' + part, {
                body: buffer as Uint8Array<ArrayBuffer>,
                method: 'PUT',
              })
            ).json()) as { etag: string; part: number },
          )
        }
      } finally {
        await handle.close()
      }
      await call('/' + name + '/uploads/' + encodeURIComponent(upload), {
        body: JSON.stringify({ parts }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    },
  }
}

export declare namespace remote {
  type Options = {
    base: string
    fetch?(input: string, init?: RequestInit): Promise<Response>
    token: string
  }
}

export async function add(store: Store, file: string): Promise<Eval.Blob> {
  const blob = await digest(file)
  if (!(await store.has(blob.digest))) await store.put(blob.digest, file)
  return blob
}

export async function addBytes(
  store: Store,
  input: { bytes: Uint8Array; scratch: string },
): Promise<Eval.Blob> {
  const name = Crypto.createHash('sha256').update(input.bytes).digest('hex')
  if (!(await store.has(name))) {
    await FsPromises.mkdir(input.scratch, { recursive: true })
    const file = Path.join(input.scratch, name + '.' + process.pid)
    await FsPromises.writeFile(file, input.bytes)
    try {
      await store.put(name, file)
    } finally {
      await FsPromises.rm(file, { force: true })
    }
  }
  return { bytes: input.bytes.length, digest: name }
}

export async function ensure(
  stores: readonly Store[],
  input: { blob: Eval.Blob; cache: string },
): Promise<string> {
  const file = Path.join(input.cache, 'blobs', input.blob.digest)
  const present = await FsPromises.stat(file).then(
    () => true,
    () => false,
  )
  if (present) return file
  const staged = file + '.' + process.pid + '-' + Crypto.randomBytes(4).toString('hex')
  try {
    let found: Store | undefined
    for (const store of stores)
      if (await store.fetch(input.blob.digest, staged)) {
        found = store
        break
      }
    if (!found)
      throw new MissingError(
        'no store holds the blob ' +
          input.blob.digest +
          ': asked ' +
          stores.map((store) => store.name).join(', '),
      )
    const actual = await digest(staged)
    if (actual.digest !== input.blob.digest)
      throw new DigestError(
        'the blob ' +
          input.blob.digest +
          ' from the ' +
          found.name +
          ' store hashes to ' +
          actual.digest,
      )
    await FsPromises.rename(staged, file)
  } finally {
    await FsPromises.rm(staged, { force: true })
  }
  return file
}
