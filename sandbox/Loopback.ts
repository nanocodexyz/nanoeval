import * as Crypto from 'node:crypto'
import * as Http from 'node:http'
import * as Https from 'node:https'
import * as Net from 'node:net'
import type { Duplex } from 'node:stream'
import * as Tls from 'node:tls'

export type Relay = {
  close(): void
  open(remote: string, bearer: string): Promise<void>
  url(remote: string): Promise<string>
}

type Origin = { host: string; port: number; secure: boolean }

type Opened = {
  bearer: string
  remote: Net.Socket
  stale?: ReturnType<typeof setTimeout>
  upgraded: Promise<Buffer | undefined>
}

/** An upgrade opened ahead that no hand takes within this is closed. */
const staleMs = 25_000

const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

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
  const remote = connect(to, sent)
  return joined(remote, socket)
}

function connect(to: Origin, connected: () => void): Net.Socket {
  return to.secure
    ? Tls.connect(
        { ALPNProtocols: ['http/1.1'], host: to.host, port: to.port, servername: to.host },
        connected,
      )
    : Net.connect({ host: to.host, port: to.port }, connected)
}

function joined(remote: Net.Socket, socket: Duplex) {
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

function accepted(key: string): string {
  return Crypto.createHash('sha1')
    .update(key + guid)
    .digest('base64')
}

function ahead(to: Origin, input: { bearer: string; path: string }): Opened {
  const key = Crypto.randomBytes(16).toString('base64')
  const lines = [
    'GET ' + input.path + ' HTTP/1.1',
    'Host: ' + name(to),
    'Authorization: Bearer ' + input.bearer,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: ' + key,
    'Sec-WebSocket-Version: 13',
  ]
  const remote = connect(to, () => remote.write(lines.join('\r\n') + '\r\n\r\n'))
  const upgraded = new Promise<Buffer | undefined>((resolve) => {
    let held = Buffer.alloc(0)
    const failed = () => {
      remote.destroy()
      resolve(undefined)
    }
    const heard = (chunk: Buffer) => {
      held = Buffer.concat([held, chunk])
      const end = held.indexOf('\r\n\r\n')
      if (end === -1) return
      remote.off('data', heard)
      remote.pause()
      const [status = '', ...fields] = held.subarray(0, end).toString('latin1').split('\r\n')
      const answer = fields
        .map((field) => field.split(':'))
        .find(([field]) => field!.trim().toLowerCase() === 'sec-websocket-accept')?.[1]
        ?.trim()
      if (!status.startsWith('HTTP/1.1 101 ') || answer !== accepted(key)) return failed()
      resolve(held.subarray(end + 4))
    }
    remote.on('data', heard)
    remote.on('error', failed)
    remote.on('close', failed)
  })
  return { bearer: input.bearer, remote, upgraded }
}

function adoptable(opened: Opened, request: Http.IncomingMessage): boolean {
  return (
    /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1] === opened.bearer &&
    typeof request.headers['sec-websocket-key'] === 'string' &&
    request.headers['sec-websocket-protocol'] === undefined
  )
}

async function adopt(
  to: Origin,
  opened: Opened,
  input: { head: Buffer; request: Http.IncomingMessage; socket: Duplex },
): Promise<() => void> {
  const { head, request, socket } = input
  const early = await opened.upgraded
  if (early === undefined || opened.remote.destroyed || socket.destroyed) return tunnel(to, input)
  const end = joined(opened.remote, socket)
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accepted(request.headers['sec-websocket-key'] as string) +
      '\r\n\r\n',
  )
  if (early.length) socket.write(early)
  if (head.length) opened.remote.write(head)
  opened.remote.pipe(socket)
  socket.pipe(opened.remote)
  return end
}

async function listen(
  to: Origin,
  input: { ends: Set<() => void>; take: (path: string) => Opened | undefined },
): Promise<Http.Server> {
  const { ends } = input
  const server = Http.createServer((request, response) => forward(to, request, response))
  server.on('upgrade', (request, socket, head) => {
    const opened = input.take(request.url ?? '')
    if (opened && !adoptable(opened, request)) opened.remote.destroy()
    const upgrade = { head, request, socket }
    if (opened && adoptable(opened, request)) {
      void adopt(to, opened, upgrade).then((end) => {
        ends.add(end)
        if (socket.destroyed) end()
        else socket.on('close', () => ends.delete(end))
      })
      return
    }
    const end = tunnel(to, upgrade)
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
  const opens = new Map<string, Opened>()
  let closed = false
  const listening = (to: Origin) => {
    const key = (to.secure ? 'tls ' : 'tcp ') + name(to)
    let opening = servers.get(key)
    if (!opening) {
      opening = listen(to, {
        ends,
        take: (path) => {
          const opened = opens.get(key + ' ' + path)
          opens.delete(key + ' ' + path)
          clearTimeout(opened?.stale)
          return opened
        },
      })
      servers.set(key, opening)
      opening.catch(() => servers.delete(key))
    }
    return { key, opening }
  }
  return {
    close: () => {
      closed = true
      for (const opened of opens.values()) opened.remote.destroy()
      opens.clear()
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
    open: async (remote, bearer) => {
      if (closed) throw new Error('the relay is closed')
      const asked = new URL(remote)
      if (asked.protocol !== 'ws:' && asked.protocol !== 'wss:')
        throw new Error('a relay opens WebSocket sessions only: ' + asked.href)
      const to = origin(asked)
      const { key, opening } = listening(to)
      await opening
      const path = asked.pathname + asked.search
      opens.get(key + ' ' + path)?.remote.destroy()
      const opened = ahead(to, { bearer, path })
      opens.set(key + ' ' + path, opened)
      opened.stale = setTimeout(() => opened.remote.destroy(), staleMs)
      opened.stale.unref()
      opened.remote.on('close', () => {
        clearTimeout(opened.stale)
        if (opens.get(key + ' ' + path) === opened) opens.delete(key + ' ' + path)
      })
    },
    url: async (remote) => {
      if (closed) throw new Error('the relay is closed')
      const asked = new URL(remote)
      const to = origin(asked)
      const { opening } = listening(to)
      const { port } = (await opening).address() as Net.AddressInfo
      const scheme = asked.protocol === 'ws:' || asked.protocol === 'wss:' ? 'ws' : 'http'
      return scheme + '://' + address + ':' + port + asked.pathname + asked.search
    },
  }
}
