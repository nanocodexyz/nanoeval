import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as Budget from '../src/Budget.ts'
import * as E2b from '../src/E2b.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Payment from '../src/Payment.ts'

const challenge =
  'Payment id="3cI7UxYdbAVOQr5yPepiWrQMs44FX3d_VRG5U2e0xlQ", realm="mpp.e2b.dev", method="tempo", intent="charge", request="eyJhbW91bnQiOiI4NzIxIiwiY3VycmVuY3kiOiIweDIwYzAwMDAwMDAwMDAwMDAwMDAwMDAwMDZhMzdEQTVDOTk2ODc0QkUiLCJtZXRob2REZXRhaWxzIjp7ImNoYWluSWQiOjQyMTcsImZlZVBheWVyIjp0cnVlLCJtYWNoaW5lVG9rZW5FbmFibGVkIjp0cnVlLCJzdXBwb3J0ZWRNb2RlcyI6WyJwdWxsIl19LCJyZWNpcGllbnQiOiIweGIxMEFDYTY4NDA4MzczMEQ5M0Q2OEVjQjcxNDg2YjE3YkRmNzE0NjAifQ", description="Create sandbox - 2 vCPU, 512 MiB, 300s", expires="2099-01-01T00:00:00.000Z", opaque="eyJfbXBweF9ub25jZSI6IjB4MGM5YzljNzQzZTNjYjkyODY3M2Y0YzVmYWY1ZGYzNzUzMzJjMWQzZWMyYzhhMDUxNjgzMzRjZjY5MWUyZDJkYSIsIl9tcHB4X3Njb3BlIjoiZTJiOlBPU1Q6L3NhbmRib3hlcyJ9"'

const offered = (() => {
  const field = (name: string) => new RegExp(name + '="([^"]*)"').exec(challenge)![1]!
  const request = JSON.parse(Buffer.from(field('request'), 'base64url').toString()) as {
    currency: string
    methodDetails: Record<string, unknown>
    recipient: string
  }
  const other = '0x20c0000000000000000000000000000000000000'
  const variant = (id: string, intent: string, body: unknown) =>
    'Payment id="' +
    id +
    '", realm="mpp.e2b.dev", method="tempo", intent="' +
    intent +
    '", request="' +
    Buffer.from(JSON.stringify(body)).toString('base64url') +
    '", description="' +
    field('description') +
    '", expires="2099-01-01T00:00:00.000Z"'
  const session = (currency: string) => ({
    ...request,
    currency,
    methodDetails: { ...request.methodDetails, operator: request.recipient, sessionProtocol: 'v2' },
    suggestedDeposit: '1000000',
    unitType: 'request',
  })
  return [
    challenge,
    variant('second-charge', 'charge', { ...request, currency: other }),
    variant('first-session', 'session', session(request.currency)),
    variant('second-session', 'session', session(other)),
  ].join(', ')
})()

type Seen = { body: string; headers: Http.IncomingHttpHeaders; method: string; url: string }

const seen: Seen[] = []
let server: Http.Server
let base: string

const frame = (flags: number, message: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(message))
  const head = Buffer.alloc(5)
  head[0] = flags
  head.writeUInt32BE(body.length, 1)
  return Buffer.concat([head, body])
}

before(async () => {
  server = Http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const url = request.url ?? ''
    seen.push({
      body: body.toString('latin1'),
      headers: request.headers,
      method: request.method!,
      url,
    })

    if (url === '/sandboxes' || url.startsWith('/sandboxes/')) {
      if (!request.headers.authorization?.startsWith('Payment ')) {
        response.writeHead(402, {
          'content-type': 'application/problem+json',
          'www-authenticate': offered,
        })
        response.end(JSON.stringify({ status: 402, title: 'Payment Required' }))
        return
      }
      if (request.method === 'DELETE') {
        response.writeHead(204).end()
        return
      }
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          alias: 'base',
          clientID: 'client1',
          envdAccessToken: 'envd-token',
          envdVersion: '0.10.0',
          sandboxID: 'sandbox1',
          templateID: 'base',
          trafficAccessToken: 'traffic-token',
        }),
      )
      return
    }
    if (
      (url === '/process.Process/Start' || url.startsWith('/files?')) &&
      request.headers['x-access-token'] !== 'envd-token'
    ) {
      response.writeHead(401).end()
      return
    }
    if (url === '/process.Process/Start') {
      const message = JSON.parse(body.subarray(5).toString()) as { process: { args: string[] } }
      const command = message.process.args.at(-1)!
      response.writeHead(200, { 'content-type': 'application/connect+json' })
      if (command === 'lost') {
        response.end(
          Buffer.concat([
            frame(0, { event: { start: { pid: 7 } } }),
            frame(2, { error: { code: 'unavailable', message: 'sandbox was lost' } }),
          ]),
        )
        return
      }
      const stream = Buffer.concat([
        frame(0, { event: { start: { pid: 7 } } }),
        frame(0, { event: { data: { stdout: Buffer.from('héllo ').toString('base64') } } }),
        frame(0, { event: { data: { stderr: Buffer.from('warn\n').toString('base64') } } }),
        frame(0, { event: { data: { stdout: Buffer.from('wörld\n').toString('base64') } } }),
        frame(0, {
          event: {
            end:
              command === 'false'
                ? { exitCode: 1, exited: true, status: 'exit status 1' }
                : { exited: true, status: 'exit status 0' },
          },
        }),
        frame(2, {}),
      ])
      response.write(stream.subarray(0, 9))
      setTimeout(() => {
        response.write(stream.subarray(9, 40))
        response.end(stream.subarray(40))
      }, 5)
      return
    }
    if (url.startsWith('/files?')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{ name: 'slot.sh', path: url, type: 'file' }]))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
})

after(() => server.close())

const paid: E2b.Fetch = async (input, init) => {
  const probe = await fetch(input, init)
  if (probe.status !== 402) return probe
  await probe.body?.cancel()
  return fetch(input, {
    ...init,
    headers: { ...init?.headers, authorization: 'Payment test-credential' },
  })
}

test('a sandbox is created through the paying fetch and driven through envd', async () => {
  seen.length = 0
  const provider = E2b.create({ api: base, envd: base, now: () => 1_000_000, pay: paid })
  const created = await provider.create({
    metadata: { nanoeval_run: 'run-1' },
    template: 'code-interpreter-v1',
    timeoutSec: 600,
  })
  assert.deepEqual(created, {
    expiresAt: 1_600_000,
    handle: {
      envd: base,
      envdVersion: '0.10.0',
      home: '/home/user/.nanoeval',
      id: 'sandbox1',
      token: 'envd-token',
    },
  })
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), {
    metadata: { nanoeval_run: 'run-1' },
    templateID: 'code-interpreter-v1',
    timeout: 600,
  })

  const sandbox = provider.connect(created.handle)
  assert.deepEqual(await sandbox.exec('echo'), {
    exitCode: 0,
    stderr: 'warn\n',
    stdout: 'héllo wörld\n',
  })
  const start = seen.at(-1)!
  assert.equal(start.headers['x-access-token'], 'envd-token')
  assert.equal(start.headers['content-type'], 'application/connect+json')
  assert.equal(start.headers['connect-protocol-version'], '1')
  assert.equal(start.headers.authorization, 'Basic ' + btoa('user:'))
  assert.deepEqual(JSON.parse(start.body.slice(5)), {
    process: { args: ['-l', '-c', 'echo'], cmd: '/bin/bash' },
    stdin: false,
  })

  assert.equal((await sandbox.exec('false')).exitCode, 1)
  await assert.rejects(sandbox.exec('lost'), E2b.StreamError)

  await sandbox.write('/home/user/.nanoeval/slot.sh', Bytes.fromText('#!/bin/sh\n'))
  const upload = seen.at(-1)!
  assert.equal(upload.method, 'POST')
  assert.equal(upload.url, '/files?path=%2Fhome%2Fuser%2F.nanoeval%2Fslot.sh&username=user')
  assert.equal(upload.body, '#!/bin/sh\n')

  await assert.rejects(
    E2b.connect({ ...created.handle, token: 'another-token' }).exec('echo'),
    E2b.RequestError,
    'envd refuses a command without the access token of its sandbox',
  )

  await provider.kill(created.handle)
  assert.equal(seen.at(-1)!.method, 'DELETE')
  assert.equal(seen.at(-1)!.url, '/sandboxes/sandbox1')
})

test('templates and lifetimes outside what E2B serves over MPP are refused before paying', async () => {
  seen.length = 0
  const provider = E2b.create({ api: base, pay: paid })
  await assert.rejects(
    provider.create({ metadata: {}, template: 'my-custom-template', timeoutSec: 600 }),
    E2b.RequestError,
  )
  await assert.rejects(
    provider.create({ metadata: {}, template: 'base', timeoutSec: 86_401 }),
    E2b.RequestError,
  )
  assert.equal(seen.length, 0)
})

test('an envelope round-trips through the stream collector', async () => {
  const bytes = E2b.envelope({ event: { end: { exitCode: 3, exited: true } } })
  const output = await E2b.collect(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream())
  assert.deepEqual(output, { exitCode: 3, stderr: '', stdout: '' })
  await assert.rejects(
    E2b.collect(new Blob([bytes.subarray(0, 7) as Uint8Array<ArrayBuffer>]).stream()),
    E2b.StreamError,
  )
  await assert.rejects(E2b.collect(new Blob([]).stream()), E2b.StreamError)
})

test('a charge amount is base units of a six-decimal token', () => {
  assert.equal(Payment.usd('8721'), 0.008721)
  assert.equal(Payment.usd('2483020'), 2.48302)
  assert.throws(() => Payment.usd('0.5'))
})

test('the payer refuses a challenge over budget without creating a credential', async () => {
  const charges: Payment.Charge[] = []
  const pay = Payment.payer({
    account: privateKeyToAccount(generatePrivateKey()),
    budget: Budget.create({ limitUsd: 0.005 }),
    onCharge: (charge) => void charges.push(charge),
  })
  seen.length = 0
  await assert.rejects(
    pay(base + '/sandboxes', { method: 'POST', body: '{}' }),
    (error: Error) =>
      error.name === 'Budget.ExceededError' ||
      String(error.cause).includes('Budget.ExceededError') ||
      error.message.includes('budget'),
  )
  assert.equal(charges.length, 0)
  assert.ok(seen.every((request) => !request.headers.authorization))
})
