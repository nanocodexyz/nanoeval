import * as Http from 'node:http'
import * as Https from 'node:https'
import * as Net from 'node:net'
import type { Duplex } from 'node:stream'
import * as Tls from 'node:tls'

export type Relay = { close(): void; url(remote: string): Promise<string> }

type Origin = { host: string; port: number; secure: boolean }

const address = '127.0.0.1'

const defaults: Readonly<Record<string, number>> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
}

export function direct(url: string): boolean {
  const { hostname, port, protocol } = new URL(url)
  return (
    (protocol === 'http:' || protocol === 'ws:') &&
    port !== '' &&
    /^127(\.[0-9]{1,3}){3}$/.test(hostname)
  )
}

function origin(url: URL): Origin {
  const port = url.port === '' ? defaults[url.protocol] : Number(url.port)
  if (port === undefined)
    throw new Error('a relay reaches http, https, ws and wss only: ' + url.href)
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    secure: url.protocol === 'https:' || url.protocol === 'wss:',
  }
}

function name(to: Origin): string {
  const host = to.host.includes(':') ? '[' + to.host + ']' : to.host
  return to.port === defaults[to.secure ? 'https:' : 'http:'] ? host : host + ':' + to.port
}

function forward(to: Origin, request: Http.IncomingMessage, response: Http.ServerResponse): void {
  const headers = { ...request.headers, host: name(to) }
  delete headers.connection
  const asked = (to.secure ? Https : Http).request(
    { headers, host: to.host, method: request.method, path: request.url, port: to.port },
    (reply) => {
      const answered = { ...reply.headers }
      delete answered.connection
      delete answered['keep-alive']
      delete answered['transfer-encoding']
      response.writeHead(reply.statusCode ?? 502, reply.statusMessage, answered)
      reply.on('error', () => response.destroy())
      reply.pipe(response)
    },
  )
  asked.on('error', () => {
    if (response.headersSent) response.destroy()
    else response.writeHead(502).end()
  })
  response.on('close', () => asked.destroy())
  request.pipe(asked)
}

function tunnel(
  to: Origin,
  input: { head: Buffer; request: Http.IncomingMessage; socket: Duplex },
) {
  const { head, request, socket } = input
  const lines = [request.method + ' ' + request.url + ' HTTP/' + request.httpVersion]
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const header = request.rawHeaders[index]!
    lines.push(
      header + ': ' + (header.toLowerCase() === 'host' ? name(to) : request.rawHeaders[index + 1]),
    )
  }
  const sent = () => {
    remote.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) remote.write(head)
    remote.pipe(socket)
    socket.pipe(remote)
  }
  const remote: Net.Socket = to.secure
    ? Tls.connect(
        { ALPNProtocols: ['http/1.1'], host: to.host, port: to.port, servername: to.host },
        sent,
      )
    : Net.connect({ host: to.host, port: to.port }, sent)
  const end = () => {
    remote.destroy()
    socket.destroy()
  }
  remote.on('error', end)
  remote.on('close', end)
  socket.on('error', end)
  socket.on('close', end)
  return end
}

async function listen(to: Origin, ends: Set<() => void>): Promise<Http.Server> {
  const server = Http.createServer((request, response) => forward(to, request, response))
  server.on('upgrade', (request, socket, head) => {
    const end = tunnel(to, { head, request, socket })
    ends.add(end)
    socket.on('close', () => ends.delete(end))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, address, resolve)
  })
  return server
}

export function create(): Relay {
  const ends = new Set<() => void>()
  const servers = new Map<string, Promise<Http.Server>>()
  let closed = false
  return {
    close: () => {
      closed = true
      for (const end of ends) end()
      for (const opening of servers.values())
        opening.then(
          (server) => {
            server.close()
            server.closeAllConnections()
          },
          () => {},
        )
      servers.clear()
    },
    url: async (remote) => {
      if (closed) throw new Error('the relay is closed')
      const asked = new URL(remote)
      const to = origin(asked)
      const key = (to.secure ? 'tls ' : 'tcp ') + name(to)
      let opening = servers.get(key)
      if (!opening) {
        opening = listen(to, ends)
        servers.set(key, opening)
        opening.catch(() => servers.delete(key))
      }
      const { port } = (await opening).address() as Net.AddressInfo
      const scheme = asked.protocol === 'ws:' || asked.protocol === 'wss:' ? 'ws' : 'http'
      return scheme + '://' + address + ':' + port + asked.pathname + asked.search
    },
  }
}
