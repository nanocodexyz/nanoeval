import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import type * as Net from 'node:net'

export const port = 80

export const archives: Readonly<Record<string, string>> = {
  'deb.debian.org': 'archive.debian.org',
  'security.debian.org': 'archive.debian.org',
}

export const line = "verifier package served from the distribution's archive: "

export type Origin = (name: string) => { host: string; port: number }

export type Open = { address: string; close(): void }

type Asked = { name: string; path: string; request: Http.IncomingMessage }

function ask(origin: Origin, asked: Asked) {
  return new Promise<Http.IncomingMessage>((resolve, reject) => {
    const headers = { ...asked.request.headers, host: asked.name }
    delete headers.connection
    Http.request(
      { ...origin(asked.name), headers, method: asked.request.method, path: asked.path },
      resolve,
    )
      .on('error', reject)
      .end()
  })
}

function target(request: Http.IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? '', 'http://' + (request.headers.host ?? ''))
  } catch {
    return undefined
  }
}

async function answer(
  options: open.Options,
  request: Http.IncomingMessage,
  response: Http.ServerResponse,
): Promise<void> {
  const origin = options.origin ?? ((host) => ({ host, port }))
  const asked = target(request)
  const name = asked?.hostname ?? ''
  const archive = (options.archives ?? archives)[name]
  if (asked?.protocol !== 'http:' || archive === undefined) {
    response.writeHead(421).end()
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return
  }
  const path = asked.pathname + asked.search
  let reply = await ask(origin, { name, path, request })
  if (reply.statusCode === 404 && path.includes('/pool/')) {
    const archived = await ask(origin, { name: archive, path, request })
    if (archived.statusCode === 200 || archived.statusCode === 206) {
      reply.resume()
      reply = archived
      if (request.method === 'GET') await Fs.appendFile(options.log, name + path + '\n')
    } else archived.resume()
  }
  const headers = { ...reply.headers }
  delete headers.connection
  delete headers['keep-alive']
  delete headers['transfer-encoding']
  response.writeHead(reply.statusCode ?? 502, headers)
  reply.on('error', () => response.destroy())
  reply.pipe(response)
}

function loopback(): string {
  return '127.' + crypto.getRandomValues(new Uint8Array(3)).join('.')
}

export async function open(options: open.Options): Promise<Open> {
  for (;;) {
    const address = options.address ?? loopback()
    const server = Http.createServer((request, response) => {
      answer(options, request, response).catch(() => {
        if (response.headersSent) response.destroy()
        else response.writeHead(502).end()
      })
    })
    const failed = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      server.once('error', resolve)
      server.listen(options.port ?? 0, address, () => resolve(undefined))
    })
    if (!failed)
      return {
        address: address + ':' + (server.address() as Net.AddressInfo).port,
        close: () => {
          server.close()
          server.closeAllConnections()
        },
      }
    if (failed.code === 'EADDRINUSE' && options.address === undefined) continue
    throw failed
  }
}

export declare namespace open {
  type Options = {
    address?: string
    archives?: Readonly<Record<string, string>>
    log: string
    origin?: Origin
    port?: number
  }
}

export async function served(log: string): Promise<string[]> {
  const text = await Fs.readFile(log, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
}
