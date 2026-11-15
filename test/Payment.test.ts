import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { Credential } from 'mppx'
import { Session } from 'mppx/tempo'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import * as Budget from '../src/Budget.ts'
import * as Payment from '../src/Payment.ts'

const account = privateKeyToAccount(generatePrivateKey())
const currency = '0x20c000000000000000000000b9537d11c60e8b50'
const escrow = '0x4d50500000000000000000000000000000000000'
const recipient = '0xb10ACa684083730D93D68EcB71486b17bDf71460'
const zero = '0x0000000000000000000000000000000000000000'

const offer = (id: string, intent: string, extra: Record<string, unknown> = {}) =>
  'Payment id="' +
  id +
  '", realm="mpp.example", method="tempo", intent="' +
  intent +
  '", request="' +
  Buffer.from(
    JSON.stringify({
      amount: '2209',
      currency,
      methodDetails: {
        chainId: 4217,
        feePayer: true,
        ...(intent === 'session' ? { escrowContract: escrow, sessionProtocol: 'v2' } : {}),
      },
      recipient,
      ...(intent === 'session' ? { suggestedDeposit: '1000000', unitType: 'request' } : {}),
      ...extra,
    }),
  ).toString('base64url') +
  '", description="Create sandbox", expires="2099-01-01T00:00:00.000Z"'

type Seen = { authorization: string | undefined; body: string; session: string | undefined }

const seen: Seen[] = []
let refuse = false
let server: Http.Server
let base: string

before(async () => {
  server = Http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const authorization = request.headers.authorization
    seen.push({
      authorization,
      body: Buffer.concat(chunks).toString(),
      session: request.headers['payment-session'] as string | undefined,
    })
    if (!authorization?.startsWith('Payment ')) {
      response.writeHead(402, {
        'www-authenticate': [offer('charge', 'charge'), offer('session', 'session')].join(', '),
      })
      response.end('{}')
      return
    }
    response.writeHead(refuse ? 409 : 204).end(refuse ? 'no channel' : undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
})

after(() => server.close())

const descriptor = {
  authorizedSigner: zero,
  expiringNonceHash: `0x${'11'.repeat(32)}`,
  operator: zero,
  payee: recipient,
  payer: account.address,
  salt: `0x${'22'.repeat(32)}`,
  token: currency,
} as const

const channelId = Session.Precompile.Channel.computeId({ ...descriptor, chainId: 4217, escrow })

const opened = async (wallet: Payment.Wallet) => {
  await wallet.channels.set({
    chainId: 4217,
    channelId,
    cumulativeAmount: 6627n,
    deposit: 1_000_000n,
    descriptor,
    escrow,
    opened: true,
  })
}

test('a session offer is taken before a charge offer, each kept in the order offered', () => {
  const candidates = [
    { challenge: { id: 'c1', intent: 'charge' } },
    { challenge: { id: 's1', intent: 'session' } },
    { challenge: { id: 'c2', intent: 'charge' } },
    { challenge: { id: 's2', intent: 'session' } },
  ]
  assert.deepEqual(
    Payment.prefer(candidates).map((candidate) => candidate.challenge.id),
    ['s1', 's2', 'c1', 'c2'],
  )
})

test('the payer keeps the unpaid request of a session offer to close the channel on', async () => {
  const wallet = Payment.wallet()
  const pay = Payment.payer({
    account,
    budget: Budget.create({ limitUsd: 0.001 }),
    onCharge: () => {},
    wallet,
  })
  await assert.rejects(
    pay(base + '/sandboxes', {
      body: '{"templateID":"base"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  )
  const kept = wallet.kv.keys('probe:')
  assert.deepEqual(kept, ['probe:POST ' + base + '/sandboxes'])
  assert.equal(
    (JSON.parse(wallet.kv.get(kept[0]!)!) as Payment.Probe).body,
    '{"templateID":"base"}',
  )
})

test('close signs the cumulative amount of each open channel and forgets the channel', async () => {
  const wallet = Payment.wallet()
  await opened(wallet)
  wallet.kv.set(
    'probe:POST ' + base + '/sandboxes',
    JSON.stringify({
      body: '{"templateID":"base"}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: base + '/sandboxes',
    } satisfies Payment.Probe),
  )
  assert.equal(Payment.open(wallet), 1)
  seen.length = 0
  refuse = false
  const result = await Payment.close({ account, wallet })
  assert.deepEqual(result.unclosed, [])
  assert.equal(result.closed.length, 1)
  assert.equal(result.closed[0]!.amount, '6627')
  assert.equal(seen.length, 2)
  assert.equal(seen[0]!.session, channelId)
  assert.equal(seen[1]!.body, '{"templateID":"base"}')
  const credential = Credential.deserialize<{ action: string; cumulativeAmount: string }>(
    seen[1]!.authorization!,
  )
  assert.equal(credential.payload.action, 'close')
  assert.equal(credential.payload.cumulativeAmount, '6627')
  assert.equal(credential.challenge.intent, 'session')
  assert.equal(Payment.open(wallet), 0)
})

test('a refused close keeps the channel and says why', async () => {
  const wallet = Payment.wallet()
  await opened(wallet)
  wallet.kv.set(
    'probe:POST ' + base + '/sandboxes',
    JSON.stringify({
      headers: {},
      method: 'POST',
      url: base + '/sandboxes',
    } satisfies Payment.Probe),
  )
  refuse = true
  const result = await Payment.close({ account, wallet })
  refuse = false
  assert.equal(result.closed.length, 0)
  assert.match(result.unclosed[0]!.error, /refused with 409: no channel/)
  assert.equal(Payment.open(wallet), 1)
})

test('a channel with no recorded session request is reported, not dropped', async () => {
  const wallet = Payment.wallet()
  await opened(wallet)
  const result = await Payment.close({ account, wallet })
  assert.match(result.unclosed[0]!.error, /no recorded request offered a session/)
  assert.equal(Payment.open(wallet), 1)
})
