import * as Dns from 'node:dns/promises'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import type * as Net from 'node:net'

export class RefusedError extends Error {
  override name = 'Archive.RefusedError'
}

export const port = 80

export const archives: Readonly<Record<string, string>> = {
  'deb.debian.org': 'archive.debian.org',
  'security.debian.org': 'archive.debian.org',
}

export const line = "verifier package served from the distribution's archive: "

export type Origin = (name: string) => { host: string; port: number }

export type Open = { address: string; close(): void }

function ask(origin: Origin, name: string, request: Http.IncomingMessage) {
  return new Promise<Http.IncomingMessage>((resolve, reject) => {
    const headers = { ...request.headers, host: name }
    delete headers.connection
    Http.request({ ...origin(name), headers, method: request.method, path: request.url }, resolve)
      .on('error', reject)
      .end()
  })
}

async function answer(
  options: open.Options,
  request: Http.IncomingMessage,
  response: Http.ServerResponse,
): Promise<void> {
  const origin = options.origin ?? ((host) => ({ host, port }))
  const name = (request.headers.host ?? '').replace(/:[0-9]+$/, '').toLowerCase()
  const archive = (options.archives ?? archives)[name]
  if (archive === undefined) {
    response.writeHead(421).end()
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end()
    return
  }
  let reply = await ask(origin, name, request)
  if (reply.statusCode === 404 && request.url?.includes('/pool/')) {
    const archived = await ask(origin, archive, request)
    if (archived.statusCode === 200 || archived.statusCode === 206) {
      reply.resume()
      reply = archived
      if (request.method === 'GET') await Fs.appendFile(options.log, name + request.url + '\n')
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
      server.listen(options.port ?? port, address, () => resolve(undefined))
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
    if (failed.code === 'EACCES')
      throw new RefusedError(
        'the package archive of a verifier listens on port ' +
          (options.port ?? port) +
          ' of a loopback address, which this user may not: run the runner as root or lower net.ipv4.ip_unprivileged_port_start to it',
      )
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

export async function names(
  services: (name: string) => Promise<{ name: string }[]> = Dns.resolveSrv,
): Promise<string[]> {
  const found = await Promise.all(
    Object.keys(archives).map(async (name) => [
      name,
      ...(await services('_http._tcp.' + name).catch(() => [])).map((service) =>
        service.name.replace(/\.$/, '').toLowerCase(),
      ),
    ]),
  )
  return [...new Set(found.flat())]
}

export async function served(log: string): Promise<string[]> {
  const text = await Fs.readFile(log, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
}
