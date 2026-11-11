import type { Env } from './Env.ts'
import * as Storage from './Storage.ts'

const digestPattern = /^[0-9a-f]{64}$/

export class RangeError extends Error {
  override name = 'Blobs.RangeError'
}

export function offset(request: Request): number {
  const header = request.headers.get('range')
  if (header === null) return 0
  const match = /^bytes=(\d+)-$/.exec(header)
  if (!match) throw new RangeError('a blob is read from one offset to its end: ' + header)
  return Number(match[1])
}

export async function read(env: Env, digest: string, from = 0): Promise<Response> {
  let object: R2ObjectBody | null
  try {
    object = env.BLOBS ? await env.BLOBS.get(digest, from ? { range: { offset: from } } : {}) : null
  } catch (error) {
    return Storage.json({ error: 'the range was refused: ' + Storage.message(error) }, 416)
  }
  if (!object) return Storage.json({ error: 'blob not found' }, 404)
  return new Response(object.body, {
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(object.size - from),
      'content-type': 'application/octet-stream',
      ...(from
        ? { 'content-range': 'bytes ' + from + '-' + (object.size - 1) + '/' + object.size }
        : {}),
    },
    status: from ? 206 : 200,
  })
}

export async function serve(request: Request, env: Env, digest: string): Promise<Response> {
  let from: number
  try {
    from = offset(request)
  } catch (error) {
    return Storage.json({ error: Storage.message(error) }, 416)
  }
  return read(env, digest, from)
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
    if (request.method === 'GET') return serve(request, env, digest)
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
