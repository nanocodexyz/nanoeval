import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { test } from 'node:test'
import * as Loopback from '../sandbox/Loopback.ts'

type Seen = { authorization: string | undefined; host: string | undefined; url: string | undefined }

async function upstream() {
  const seen: Seen[] = []
  const note = (request: Http.IncomingMessage) =>
    seen.push({
      authorization: request.headers.authorization,
      host: request.headers.host,
      url: request.url,
    })
  const server = Http.createServer((request, response) => {
    note(request)
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' })
      response.write('data: first\n\n')
      setImmediate(() => response.end(Buffer.concat(chunks)))
    })
  })
  const sockets = new Set<Duplex>()
  server.on('upgrade', (request, socket) => {
    note(request)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        Crypto.createHash('sha1')
          .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64') +
        '\r\n\r\n',
    )
    let held = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      held = Buffer.concat([held, chunk])
      for (;;) {
        const frame = unmasked(held)
        if (!frame) return
        held = held.subarray(frame.size)
        socket.write(frame.bytes)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
      server.closeAllConnections()
    },
    host: 'localhost:' + (server.address() as AddressInfo).port,
    seen,
  }
}

function unmasked(held: Buffer): { bytes: Buffer; size: number } | undefined {
  if (held.length < 2) return undefined
  const short = held[1]! & 127
  const wide = short === 126 ? 2 : short === 127 ? 8 : 0
  if (held.length < 2 + wide + 4) return undefined
  const length =
    wide === 2 ? held.readUInt16BE(2) : wide === 8 ? Number(held.readBigUInt64BE(2)) : short
  const size = 2 + wide + 4 + length
  if (held.length < size) return undefined
  const mask = held.subarray(2 + wide, 2 + wide + 4)
  const payload = Buffer.from(held.subarray(2 + wide + 4, size))
  for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!
  return {
    bytes: Buffer.concat([
      held.subarray(0, 1),
      Buffer.from([short]),
      held.subarray(2, 2 + wide),
      payload,
    ]),
    size,
  }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('the socket did not open')))
  })
}

function next(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(event.data), { once: true }),
  )
}

test('only a plain address on 127.x.x.x with a port is reached without a relay', () => {
  for (const url of ['ws://127.0.0.1:8787/sessions/a/hands', 'http://127.3.2.1:8080/v1'])
    assert.ok(Loopback.direct(url), url)
  for (const url of [
    'wss://worker.example/sessions/a/hands',
    'https://worker.example/v1',
    'ws://localhost:8787/sessions/a/hands',
    'ws://127.0.0.1/sessions/a/hands',
    'wss://127.0.0.1:8787/sessions/a/hands',
    'http://10.0.2.2:8787/v1',
  ])
    assert.ok(!Loopback.direct(url), url)
})

test('a relay passes a session and a model request to the host of their address unchanged, on one loopback port of the machine', async () => {
  const remote = await upstream()
  const relay = Loopback.create()
  try {
    const session = await relay.url('ws://' + remote.host + '/sessions/a%20b/hands?name=hand')
    const endpoint = await relay.url('http://' + remote.host + '/v1/runs/r/model/row')
    assert.match(session, /^ws:\/\/127\.0\.0\.1:[0-9]+\/sessions\/a%20b\/hands\?name=hand$/)
    assert.ok(Loopback.direct(session) && Loopback.direct(endpoint))
    assert.equal(new URL(session).host, new URL(endpoint).host, 'one listener for one host')
    assert.equal(
      await relay.url('ws://' + remote.host + '/sessions/c/hands'),
      session.replace('a%20b', 'c').replace('?name=hand', ''),
    )
    assert.notEqual(new URL(session).host, remote.host)

    const socket = new WebSocket(session, {
      headers: { authorization: 'Bearer of-the-session' },
    } as never)
    socket.binaryType = 'arraybuffer'
    await opened(socket)
    socket.send('a text frame')
    assert.equal(await next(socket), 'a text frame')
    const bytes = new Uint8Array(Crypto.randomBytes(1 << 20))
    socket.send(bytes)
    assert.deepEqual(new Uint8Array((await next(socket)) as ArrayBuffer), bytes)

    const answer = await fetch(endpoint + '/v1/messages?beta=true', {
      body: 'the body of a model request',
      headers: { authorization: 'Bearer of-the-row' },
      method: 'POST',
    })
    assert.equal(answer.status, 201)
    assert.equal(answer.headers.get('x-upstream'), 'yes')
    assert.equal(answer.headers.get('content-type'), 'text/event-stream')
    assert.equal(await answer.text(), 'data: first\n\nthe body of a model request')

    assert.deepEqual(remote.seen, [
      {
        authorization: 'Bearer of-the-session',
        host: remote.host,
        url: '/sessions/a%20b/hands?name=hand',
      },
      {
        authorization: 'Bearer of-the-row',
        host: remote.host,
        url: '/v1/runs/r/model/row/v1/messages?beta=true',
      },
    ])

    const ended = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()))
    relay.close()
    await ended
    await assert.rejects(fetch(endpoint), 'a closed relay listens no more')
    await assert.rejects(
      relay.url('ws://' + remote.host + '/sessions/a/hands'),
      /the relay is closed/,
    )
  } finally {
    relay.close()
    remote.close()
  }
})

test('a relay answers 502 for a host that refuses and ends a session that cannot reach it', async () => {
  const gone = Http.createServer()
  await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve))
  const host = 'localhost:' + (gone.address() as AddressInfo).port
  await new Promise((resolve) => gone.close(resolve))
  const relay = Loopback.create()
  try {
    assert.equal((await fetch(await relay.url('http://' + host + '/v1'))).status, 502)
    const socket = new WebSocket(await relay.url('ws://' + host + '/sessions/a/hands'))
    await assert.rejects(opened(socket))
  } finally {
    relay.close()
  }
})

test('a relay opens a session ahead and hands that upgrade to the first matching hand, or tunnels anew', async () => {
  const remote = await upstream()
  const relay = Loopback.create()
  try {
    const target = 'ws://' + remote.host + '/sessions/early/hands'
    await relay.open(target, 'the-hand-token')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(remote.seen.length, 1, 'the upgrade went upstream before any hand')
    assert.equal(remote.seen[0]!.authorization, 'Bearer the-hand-token')

    const session = await relay.url(target)
    const socket = new WebSocket(session, {
      headers: { authorization: 'Bearer the-hand-token' },
    } as never)
    socket.binaryType = 'arraybuffer'
    await opened(socket)
    socket.send('through the early upgrade')
    assert.equal(await next(socket), 'through the early upgrade')
    const bytes = new Uint8Array(Crypto.randomBytes(1 << 18))
    socket.send(bytes)
    assert.deepEqual(new Uint8Array((await next(socket)) as ArrayBuffer), bytes)
    assert.equal(remote.seen.length, 1, 'the hand took the early upgrade')
    socket.close()

    await relay.open(target, 'the-hand-token')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const other = new WebSocket(session, { headers: { authorization: 'Bearer another' } } as never)
    await opened(other)
    other.send('fresh')
    assert.equal(await next(other), 'fresh')
    assert.equal(remote.seen.at(-1)!.authorization, 'Bearer another', 'another bearer tunnels anew')
    other.close()
  } finally {
    relay.close()
    remote.close()
  }
})
