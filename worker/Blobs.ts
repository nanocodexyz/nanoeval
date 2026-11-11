import type { Env } from './Env.ts'
import * as Storage from './Storage.ts'

const digestPattern = /^[0-9a-f]{64}$/

export function read(env: Env, digest: string): Promise<R2ObjectBody | null> {
  if (!env.BLOBS) return Promise.resolve(null)
  return env.BLOBS.get(digest)
}

export function serve(object: R2ObjectBody | null): Response {
  if (!object) return Storage.json({ error: 'blob not found' }, 404)
  return new Response(object.body, {
    headers: { 'content-length': String(object.size), 'content-type': 'application/octet-stream' },
  })
}

export async function route(
  request: Request,
  env: Env,
  path: readonly string[],
): Promise<Response> {
  const bucket = env.BLOBS
  if (!bucket) return Storage.json({ error: 'this deployment has no BLOBS bucket' }, 501)
  const [digest, uploads, upload, part] = path
  if (!digest || !digestPattern.test(digest))
    return Storage.json({ error: 'a blob is named by its SHA-256 in hex' }, 400)

  if (uploads === undefined) {
    if (request.method === 'HEAD') {
      const head = await bucket.head(digest)
      return new Response(null, {
        headers: head ? { 'content-length': String(head.size) } : {},
        status: head ? 200 : 404,
      })
    }
    if (request.method === 'GET') return serve(await bucket.get(digest))
    if (request.method === 'PUT') {
      try {
        const stored = await bucket.put(digest, request.body, { sha256: digest })
        return Storage.json({ bytes: stored.size, digest }, 201)
      } catch (error) {
        return Storage.json({ error: 'the blob was refused: ' + Storage.message(error) }, 409)
      }
    }
    return Storage.json({ error: 'method not allowed' }, 405)
  }
  if (uploads !== 'uploads') return Storage.json({ error: 'route not found' }, 404)

  if (upload === undefined) {
    if (request.method !== 'POST') return Storage.json({ error: 'method not allowed' }, 405)
    const created = await bucket.createMultipartUpload(digest)
    return Storage.json({ upload: created.uploadId }, 201)
  }
  const resumed = bucket.resumeMultipartUpload(digest, upload)
  if (part !== undefined) {
    if (request.method !== 'PUT') return Storage.json({ error: 'method not allowed' }, 405)
    const number = Number(part)
    if (!Number.isSafeInteger(number) || number < 1 || !request.body)
      return Storage.json({ error: 'a part has a number from 1 and a body' }, 400)
    const uploaded = await resumed.uploadPart(number, request.body)
    return Storage.json({ etag: uploaded.etag, part: uploaded.partNumber })
  }
  if (request.method === 'DELETE') {
    await resumed.abort()
    return Storage.json({ aborted: true })
  }
  if (request.method !== 'POST') return Storage.json({ error: 'method not allowed' }, 405)
  const body = (await request.json().catch(() => null)) as {
    parts?: { etag: string; part: number }[]
  } | null
  if (!Array.isArray(body?.parts))
    return Storage.json({ error: 'completing an upload lists its parts' }, 400)
  const stored = await resumed.complete(
    body.parts.map((entry) => ({ etag: entry.etag, partNumber: entry.part })),
  )
  return Storage.json({ bytes: stored.size, digest }, 201)
}
