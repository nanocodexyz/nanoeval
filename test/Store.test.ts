import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Store from '../sandbox/Store.ts'

const temporary = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-store-'))
const sha256 = (bytes: Uint8Array) => Crypto.createHash('sha256').update(bytes).digest('hex')

function bucket() {
  const objects = new Map<string, Buffer>()
  const uploads = new Map<string, Map<number, Buffer>>()
  const requests: string[] = []
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    requests.push(method + ' ' + url.pathname)
    if ((init.headers as Record<string, string>)['authorization'] !== 'Bearer secret')
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    const [digest, , upload, part] = url.pathname.replace('/v1/blobs/', '').split('/')
    const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0)
    if (upload === undefined && url.pathname.endsWith('/uploads')) {
      uploads.set('u1', new Map())
      return Response.json({ upload: 'u1' }, { status: 201 })
    }
    if (part !== undefined) {
      uploads.get(upload!)!.set(Number(part), body)
      return Response.json({ etag: 'e' + part, part: Number(part) })
    }
    if (upload !== undefined) {
      const { parts } = JSON.parse(body.toString()) as { parts: { part: number }[] }
      objects.set(
        digest!,
        Buffer.concat(parts.map((entry) => uploads.get(upload)!.get(entry.part)!)),
      )
      return Response.json({ digest }, { status: 201 })
    }
    if (method === 'PUT') {
      if (sha256(body) !== digest) return Response.json({ error: 'mismatch' }, { status: 409 })
      objects.set(digest!, body)
      return Response.json({ digest }, { status: 201 })
    }
    const found = objects.get(digest!)
    if (!found) return new Response(method === 'HEAD' ? null : 'missing', { status: 404 })
    return new Response(method === 'HEAD' ? null : (found as Uint8Array<ArrayBuffer>))
  }
  return { fetch, objects, requests }
}

test('a directory store keeps a blob under its digest and a reader verifies it', async () => {
  const root = temporary()
  const store = Store.directory(Path.join(root, 'store'))
  const file = Path.join(root, 'payload')
  Fs.writeFileSync(file, 'an environment disk\n')
  const blob = await Store.add(store, file)
  assert.equal(blob.digest, sha256(Buffer.from('an environment disk\n')))
  assert.equal(blob.bytes, 20)
  assert.equal(await store.has(blob.digest), true)
  assert.equal(await store.has('0'.repeat(64)), false)
  assert.deepEqual(await Store.add(store, file), blob)
  const kept = Path.join(root, 'store', 'sha256', blob.digest.slice(0, 2), blob.digest)
  assert.equal(Fs.readFileSync(kept, 'utf8'), 'an environment disk\n')
  assert.equal(Fs.statSync(kept).mode & 0o222, 0)

  const cache = Path.join(root, 'cache')
  Fs.mkdirSync(Path.join(cache, 'blobs'), { recursive: true })
  const cached = await Store.ensure([store], { blob, cache })
  assert.equal(cached, Path.join(cache, 'blobs', blob.digest))
  assert.equal(Fs.readFileSync(cached, 'utf8'), 'an environment disk\n')
  Fs.rmSync(Path.join(root, 'store'), { force: true, recursive: true })
  assert.equal(await Store.ensure([store], { blob, cache }), cached)

  const small = await Store.addBytes(store, { bytes: Buffer.from('tests'), scratch: root })
  assert.equal(small.digest, sha256(Buffer.from('tests')))
  Fs.rmSync(root, { force: true, recursive: true })
})

test('a blob that does not match its digest is refused and not kept', async () => {
  const root = temporary()
  const store = Store.directory(Path.join(root, 'store'))
  const file = Path.join(root, 'payload')
  Fs.writeFileSync(file, 'right')
  const blob = await Store.add(store, file)
  const kept = Path.join(root, 'store', 'sha256', blob.digest.slice(0, 2), blob.digest)
  Fs.chmodSync(kept, 0o644)
  Fs.writeFileSync(kept, 'wrong')
  const cache = Path.join(root, 'cache')
  Fs.mkdirSync(Path.join(cache, 'blobs'), { recursive: true })
  await assert.rejects(Store.ensure([store], { blob, cache }), Store.DigestError)
  assert.deepEqual(Fs.readdirSync(Path.join(cache, 'blobs')), [])
  await assert.rejects(
    Store.ensure([store], { blob: { bytes: 1, digest: 'f'.repeat(64) }, cache }),
    Store.MissingError,
  )
  Fs.rmSync(root, { force: true, recursive: true })
})

test('the remote store uploads small blobs whole and large ones in parts', async () => {
  const root = temporary()
  const remote = bucket()
  const store = Store.remote({
    base: 'https://worker.example/v1/blobs',
    fetch: remote.fetch,
    token: 'secret',
  })
  const small = Path.join(root, 'small')
  Fs.writeFileSync(small, 'tests archive')
  const first = await Store.add(store, small)
  assert.deepEqual(remote.requests, [
    'HEAD /v1/blobs/' + first.digest,
    'PUT /v1/blobs/' + first.digest,
  ])
  assert.equal(await store.has(first.digest), true)

  const large = Path.join(root, 'large')
  const bytes = Crypto.randomBytes(Store.partBytes + 1024)
  Fs.writeFileSync(large, bytes)
  remote.requests.length = 0
  const second = await Store.add(store, large)
  assert.deepEqual(remote.requests, [
    'HEAD /v1/blobs/' + second.digest,
    'POST /v1/blobs/' + second.digest + '/uploads',
    'PUT /v1/blobs/' + second.digest + '/uploads/u1/1',
    'PUT /v1/blobs/' + second.digest + '/uploads/u1/2',
    'POST /v1/blobs/' + second.digest + '/uploads/u1',
  ])
  assert.equal(sha256(remote.objects.get(second.digest)!), second.digest)

  const cache = Path.join(root, 'cache')
  Fs.mkdirSync(Path.join(cache, 'blobs'), { recursive: true })
  const local = Store.directory(Path.join(root, 'empty'))
  const cached = await Store.ensure([local, store], { blob: second, cache })
  assert.ok(Fs.readFileSync(cached).equals(bytes))

  remote.objects.set(first.digest, Buffer.from('tampered'))
  await assert.rejects(Store.ensure([local, store], { blob: first, cache }), Store.DigestError)
  const denied = Store.remote({
    base: 'https://worker.example/v1/blobs',
    fetch: remote.fetch,
    token: 'wrong',
  })
  await assert.rejects(denied.has(first.digest), Store.RequestError)
  Fs.rmSync(root, { force: true, recursive: true })
})
