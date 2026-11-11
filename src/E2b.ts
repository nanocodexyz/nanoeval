import * as Bytes from './internal/Bytes.ts'
import type * as Sandbox from './Sandbox.ts'

export class RequestError extends Error {
  override name = 'E2b.RequestError'
}

export class StreamError extends Error {
  override name = 'E2b.StreamError'
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const api = 'https://mpp.e2b.dev'

export const domain = 'e2b.app'

export const envdPort = 49983

export const maxTimeoutSec = 86_400

export const templates = [
  'amp',
  'base',
  'claude',
  'code-interpreter-v1',
  'codex',
  'desktop',
  'openclaw',
  'opencode',
] as const

export type Created = {
  domain?: string | null
  envdAccessToken?: string
  envdVersion?: string
  sandboxID: string
  templateID?: string
}

export const user = 'user'

export function handle(created: Created, options: { envd?: string } = {}): Sandbox.Handle {
  if (typeof created?.sandboxID !== 'string' || !/^[A-Za-z0-9-]+$/.test(created.sandboxID))
    throw new RequestError('E2B returned no sandboxID')
  return {
    home: '/home/' + user + '/.nanoeval',
    id: created.sandboxID,
    ...(created.domain ? { domain: created.domain } : {}),
    ...(created.envdAccessToken ? { token: created.envdAccessToken } : {}),
    ...(created.envdVersion ? { envdVersion: created.envdVersion } : {}),
    ...(options.envd ? { envd: options.envd } : {}),
  }
}

export function connect(handle: Sandbox.Handle, options: connect.Options = {}): Sandbox.Sandbox {
  const plain = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const envd =
    typeof handle['envd'] === 'string'
      ? handle['envd']
      : 'https://' + envdPort + '-' + handle.id + '.' + String(handle['domain'] ?? domain)
  const headers: Record<string, string> = {
    authorization: 'Basic ' + btoa(user + ':'),
    ...(typeof handle['token'] === 'string' ? { 'x-access-token': handle['token'] } : {}),
  }
  return {
    async exec(command) {
      const response = await plain(envd + '/process.Process/Start', {
        method: 'POST',
        headers: {
          ...headers,
          'connect-protocol-version': '1',
          'content-type': 'application/connect+json',
          'keepalive-ping-interval': '50',
        },
        body: envelope({
          process: { args: ['-l', '-c', command], cmd: '/bin/bash' },
          stdin: false,
        }) as Uint8Array<ArrayBuffer>,
      })
      if (!response.ok || !response.body)
        throw new RequestError(
          'envd answered ' + response.status + ': ' + (await response.text()).slice(0, 500),
        )
      return collect(response.body)
    },
    async write(path, data) {
      const response = await plain(
        envd + '/files?' + new URLSearchParams({ path, username: user }),
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: data as Uint8Array<ArrayBuffer>,
        },
      )
      if (!response.ok)
        throw new RequestError(
          'envd refused ' +
            path +
            ' with ' +
            response.status +
            ': ' +
            (await response.text()).slice(0, 500),
        )
      await response.body?.cancel()
    },
  }
}

export declare namespace connect {
  type Options = {
    fetch?: Fetch
  }
}

export function create(options: create.Options): Sandbox.Provider {
  const control = (options.api ?? api).replace(/\/+$/, '')
  const clock = options.now ?? Date.now

  return {
    name: 'e2b',
    connect: (target) => connect(target, options.fetch ? { fetch: options.fetch } : {}),
    async create(input) {
      const template = input.template ?? 'code-interpreter-v1'
      if (!(templates as readonly string[]).includes(template))
        throw new RequestError('E2B over MPP serves ' + templates.join(', ') + ', not ' + template)
      if (
        !Number.isSafeInteger(input.timeoutSec) ||
        input.timeoutSec < 1 ||
        input.timeoutSec > maxTimeoutSec
      )
        throw new RequestError('an E2B sandbox timeout is 1 to ' + maxTimeoutSec + ' seconds')

      const started = clock()
      const response = await options.pay(control + '/sandboxes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          metadata: input.metadata,
          templateID: template,
          timeout: input.timeoutSec,
        }),
      })
      if (!response.ok)
        throw new RequestError(
          'E2B refused the sandbox with ' +
            response.status +
            ': ' +
            (await response.text()).slice(0, 500),
        )
      return {
        expiresAt: started + input.timeoutSec * 1000,
        handle: handle(
          (await response.json()) as Created,
          options.envd ? { envd: options.envd } : {},
        ),
      }
    },
    async kill(handle) {
      const response = await options.pay(control + '/sandboxes/' + encodeURIComponent(handle.id), {
        method: 'DELETE',
      })
      if (!response.ok && response.status !== 404)
        throw new RequestError(
          'E2B refused the kill with ' +
            response.status +
            ': ' +
            (await response.text()).slice(0, 500),
        )
      await response.body?.cancel()
    },
  }
}

export declare namespace create {
  type Options = {
    api?: string
    envd?: string
    fetch?: Fetch
    now?(): number
    pay: Fetch
  }
}

export function envelope(message: unknown): Uint8Array {
  const body = Bytes.fromText(JSON.stringify(message))
  const frame = new Uint8Array(5 + body.length)
  new DataView(frame.buffer).setUint32(1, body.length)
  frame.set(body, 5)
  return frame
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Sandbox.Output> {
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  let exitCode: number | undefined
  let failure: string | undefined

  for await (const frame of frames(stream)) {
    const message = JSON.parse(Bytes.toText(frame.body)) as {
      error?: { code?: string; message?: string }
      event?: {
        data?: { pty?: string; stderr?: string; stdout?: string }
        end?: { error?: string; exitCode?: number; exited?: boolean; status?: string }
      }
    }
    if (frame.end) {
      if (message.error)
        failure = (message.error.code ?? 'error') + ': ' + (message.error.message ?? '')
      continue
    }
    const data = message.event?.data
    if (data?.stdout) stdout.push(Bytes.fromBase64(data.stdout))
    if (data?.stderr) stderr.push(Bytes.fromBase64(data.stderr))
    const end = message.event?.end
    if (end) {
      if (end.exited === false) failure = end.error ?? end.status ?? 'the process did not exit'
      exitCode = end.exitCode ?? 0
    }
  }

  if (failure !== undefined) throw new StreamError('envd ended the command: ' + failure)
  if (exitCode === undefined)
    throw new StreamError('envd closed the stream before the command ended')
  return { exitCode, stderr: text(stderr), stdout: text(stdout) }
}

async function* frames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ body: Uint8Array; end: boolean }> {
  const reader = stream.getReader()
  let buffer = new Uint8Array(0)
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break

    const joined = new Uint8Array(buffer.length + chunk.value.length)
    joined.set(buffer)
    joined.set(chunk.value, buffer.length)
    buffer = joined

    for (;;) {
      if (buffer.length < 5) break
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1)
      if (buffer.length < 5 + length) break
      yield { body: buffer.subarray(5, 5 + length), end: (buffer[0]! & 2) !== 0 }
      buffer = buffer.subarray(5 + length)
    }
  }
  if (buffer.length) throw new StreamError('envd closed the stream inside a frame')
}

function text(chunks: readonly Uint8Array[]): string {
  const decoder = new TextDecoder()
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}
