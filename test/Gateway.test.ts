import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Budget from '../src/Budget.ts'
import * as Config from '../src/Config.ts'
import * as Gateway from '../src/Gateway.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import type * as Payment from '../src/Payment.ts'

type Seen = { authorization: string | undefined; body: unknown; headers: Headers; path: string }

const offer = (operation: string, amount: string, currency: string) =>
  'Payment id="' +
  operation +
  '-' +
  currency +
  '", realm="gateway.example", method="tempo", intent="session", request="' +
  Buffer.from(JSON.stringify({ amount, currency, unitType: 'request' })).toString('base64url') +
  '", description="compute.' +
  operation +
  '", expires="2099-01-01T00:00:00.000Z", opaque="e30"'

const challenge = (operation: string, amount: string) =>
  offer(operation, amount, 'first') + ', ' + offer(operation, amount, 'second')

function gateway(
  prices: Record<string, string>,
  answers: Record<string, () => Response>,
): {
  charges: Payment.Charge[]
  provider: ReturnType<typeof Gateway.create>
  seen: Seen[]
  spent(): number
} {
  const seen: Seen[] = []
  const charges: Payment.Charge[] = []
  const budget = Budget.create({ limitUsd: 0.1 })
  const provider = Gateway.create({
    budget,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      const path = new URL(input).pathname
      const operation = path.slice('/v1/compute/'.length)
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body as Uint8Array)
      seen.push({ authorization: headers.get('authorization') ?? undefined, body, headers, path })
      assert.equal(new URL(input).origin, 'https://gateway.example')
      assert.equal(init?.method, 'POST')
      assert.equal(headers.get('gateway-app'), Gateway.app)
      if (!headers.has('authorization'))
        return new Response('{"status":402}', {
          headers: { 'www-authenticate': challenge(operation, prices[operation]!) },
          status: 402,
        })
      assert.equal(
        charges.filter((charge) => charge.usd > 0).length,
        seen.filter((entry) => entry.authorization).length,
        'the charge is recorded before the paid request leaves',
      )
      return answers[operation]!()
    },
    key: 'sk-tempo-test',
    onCharge: (charge) => void charges.push(charge),
    url: 'https://gateway.example/',
  })
  return { charges, provider, seen, spent: () => budget.spentUsd }
}

test('a challenge of the gateway is read as the price of the request', () => {
  assert.deepEqual(Gateway.quote(challenge('create', '42280')), {
    amount: '42280',
    currency: 'first',
    description: 'compute.create',
    intent: 'session',
    method: 'tempo',
    realm: 'gateway.example',
    usd: 0.04228,
  })
  assert.throws(() => Gateway.quote(null), /without a price/)
  assert.throws(() => Gateway.quote('Payment id="x", request="not-json"'), /not JSON/)
  assert.throws(
    () => Gateway.quote(offer('create', '0.5', 'first')),
    /base-unit integer/,
    'an amount that is not base units is refused, not rounded',
  )
})

test('a gateway sandbox is asked its price, charged to the budget and then paid with the key', async () => {
  const now = 1_800_000_000_000
  const { charges, provider, seen, spent } = gateway(
    { create: '42280', exec: '100', renew: '50835', terminate: '100', write: '1000' },
    {
      create: () =>
        Response.json({
          expiresAt: now + 3_600_000,
          paidUntil: now + 300_000,
          provider: 'e2b',
          sandboxId: 'sbx-1',
        }),
      exec: () => Response.json({ exitCode: 3, stderr: 'no', stdout: 'yes', timedOut: false }),
      renew: () => Response.json({ paidUntil: now + 600_000, sandboxId: 'sbx-1' }),
      terminate: () => Response.json({ status: 'terminated' }),
      write: () => Response.json({}),
    },
  )
  const created = await provider.create({
    leaseSec: 300,
    metadata: { nanoeval_run: 'r' },
    template: 'desktop',
    timeoutSec: 3600,
  })
  assert.deepEqual(created, {
    expiresAt: now + 3_600_000,
    handle: { home: Gateway.home, id: 'sbx-1' },
    paidUntil: now + 300_000,
  })
  const sandbox = provider.connect(created.handle)
  await sandbox.write(Gateway.home + '/runner.json', Bytes.fromText('{}'))
  assert.deepEqual(await sandbox.exec('exit 3'), { exitCode: 3, stderr: 'no', stdout: 'yes' })
  assert.deepEqual(await provider.renew!(created.handle, 300), { paidUntil: now + 600_000 })
  await provider.kill(created.handle)

  assert.deepEqual(
    seen.map((entry) => [entry.path.slice('/v1/compute/'.length), entry.authorization]),
    ['create', 'write', 'exec', 'renew', 'terminate'].flatMap((operation) => [
      [operation, undefined],
      [operation, 'Bearer sk-tempo-test'],
    ]),
    'every paid request follows an unpaid one that named its price',
  )
  assert.deepEqual(seen[1]!.body, {
    image: 'desktop',
    lease: 300,
    provider: 'e2b',
    timeout: 3600,
  })
  assert.deepEqual(seen[0]!.body, seen[1]!.body)
  assert.equal(seen[3]!.headers.get('gateway-path'), Gateway.home + '/runner.json')
  assert.equal(seen[3]!.headers.get('gateway-sandbox'), 'sbx-1')
  assert.equal(seen[3]!.headers.get('gateway-size'), '2')
  assert.deepEqual(seen[5]!.body, {
    command: ['bash', '-lc', 'exit 3'],
    sandboxId: 'sbx-1',
    timeout: Gateway.execSec,
  })
  assert.deepEqual(seen[7]!.body, { sandboxId: 'sbx-1', seconds: 300 })
  assert.deepEqual(seen[9]!.body, { sandboxId: 'sbx-1' })
  assert.deepEqual(
    charges.map((charge) => [charge.description, charge.usd]),
    [
      ['compute.create', 0.04228],
      ['compute.write', 0.001],
      ['compute.exec', 0.0001],
      ['compute.renew', 0.050835],
      ['compute.terminate', 0.0001],
    ],
  )
  assert.equal(spent(), 0.094315)
})

test('a lease is never longer than the lifetime, and the default template is named', async () => {
  const { provider, seen } = gateway(
    { create: '1000' },
    { create: () => Response.json({ expiresAt: 2, paidUntil: 1, sandboxId: 'sbx-2' }) },
  )
  await provider.create({ metadata: {}, template: undefined, timeoutSec: 120 })
  assert.deepEqual(seen[1]!.body, {
    image: Gateway.template,
    lease: 120,
    provider: 'e2b',
    timeout: 120,
  })
  await assert.rejects(
    provider.create({ metadata: {}, template: undefined, timeoutSec: Gateway.maxTimeoutSec + 1 }),
    /1 to 86400 seconds/,
  )
  assert.equal(seen.length, 2, 'a lifetime the gateway does not sell is refused before asking')
})

test('a price over the budget is refused before the key is used', async () => {
  const { charges, provider, seen } = gateway({ create: '100001' }, {})
  await assert.rejects(
    provider.create({ metadata: {}, template: 'desktop', timeoutSec: 3600 }),
    (error: Error) =>
      error.name === 'Budget.ExceededError' && /compute\.create/.test(error.message),
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.authorization, undefined)
  assert.deepEqual(charges, [])
})

test('what the gateway refuses is an error with its answer, and an ended sandbox is killed', async () => {
  const { charges, provider } = gateway(
    { create: '1000', exec: '100', renew: '1000', terminate: '100' },
    {
      create: () => Response.json({ sandboxId: 'sbx-3' }),
      exec: () => Response.json({ exitCode: 0, stderr: '', stdout: '', timedOut: true }),
      renew: () => new Response('{"detail":"It is already paid until it ends"}', { status: 409 }),
      terminate: () => new Response('{"detail":"Sandbox sbx-3 ended."}', { status: 404 }),
    },
  )
  const handle = { home: Gateway.home, id: 'sbx-3' }
  await assert.rejects(
    provider.create({ metadata: {}, template: 'desktop', timeoutSec: 60 }),
    /no sandbox with a lease/,
  )
  await assert.rejects(provider.connect(handle).exec('sleep 1000'), /did not finish within 120 s/)
  await assert.rejects(provider.renew!(handle, 300), /refused renew with 409: .*already paid/)
  await provider.kill(handle)
  assert.deepEqual(
    charges.map((charge) => [charge.description, charge.usd]),
    [
      ['compute.create', 0.001],
      ['compute.exec', 0.0001],
      ['compute.renew', 0.001],
      ['compute.renew refused with 409', -0.001],
      ['compute.terminate', 0.0001],
      ['compute.terminate refused with 404', -0.0001],
    ],
    'what the gateway refused is written back, and what it answered stays paid',
  )

  const free = Gateway.create({
    budget: Budget.create({ limitUsd: 1 }),
    fetch: async () => Response.json({ sandboxId: 'free' }),
    key: 'sk-tempo-test',
    onCharge: () => assert.fail('nothing was quoted'),
  })
  await assert.rejects(
    free.create({ metadata: {}, template: 'desktop', timeoutSec: 60 }),
    /answered 200 to an unpaid create instead of its price/,
  )
})

test('a run takes the gateway as its provider with a lease no shorter than a claim lease', () => {
  const config = (sandbox: Record<string, unknown>) => ({
    agents: [{ id: 'oracle', model: 'solution', provider: 'oracle' }],
    attempts: 1,
    budget: { sandboxUsd: 1 },
    eval: { name: 'samples' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'run',
    sandbox: {
      backend: 'ns',
      max: 1,
      network: 'private',
      pollMs: 250,
      provider: 'gateway',
      slots: 3,
      ...sandbox,
    },
  })
  assert.equal(Config.parse(config({})).sandbox.provider, 'gateway')
  assert.equal(Config.parse(config({})).sandbox.leaseSec, undefined)
  assert.equal(Config.parse(config({ leaseSec: 60 })).sandbox.leaseSec, 60)
  assert.throws(() => Config.parse(config({ leaseSec: 59 })), /at least limits\.leaseSec/)
  assert.throws(() => Config.parse(config({ provider: 'modal' })), /e2b, gateway, local/)
})
