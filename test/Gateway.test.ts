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
  assert.equal(spent(), 0.094215, 'a termination is recorded and not held against the budget')
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

  const spent = gateway(
    { terminate: '200000' },
    { terminate: () => Response.json({ status: 'terminated' }) },
  )
  await spent.provider.kill({ home: Gateway.home, id: 'sbx-4' })
  assert.deepEqual(
    spent.charges.map((charge) => [charge.description, charge.usd]),
    [['compute.terminate', 0.2]],
    'ending a sandbox is recorded and never refused for the budget, since it ends the spending',
  )
})

test('what the gateway refuses is an error with its answer, and an ended sandbox is killed', async () => {
  const { charges, provider, spent } = gateway(
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

  assert.equal(
    spent(),
    0.0011,
    'what was refused leaves the budget, and a termination was never in it',
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

test('a refusal at any status leaves the spend, and an answer or a silence that proves nothing stays', async () => {
  const unavailable =
    "The gateway cannot pay the network fee to open your key's channel right now: its fee sponsor is out of funds."
  const refusal = (status: number, code: string, detail: string) => () =>
    new Response(JSON.stringify({ code, detail, status }), {
      headers: { 'content-type': 'application/problem+json' },
      status,
    })
  const create = (provider: ReturnType<typeof Gateway.create>) =>
    provider.create({ metadata: {}, template: 'desktop', timeoutSec: 3600 })
  const recorded = (charges: Payment.Charge[]) =>
    charges.map((charge) => [charge.description, charge.amount, charge.usd])

  const refused = gateway(
    { create: '42280', renew: '50835' },
    {
      create: refusal(503, 'unavailable', unavailable),
      renew: refusal(500, 'internal', 'Something failed before the lease was paid.'),
    },
  )
  await assert.rejects(create(refused.provider), /refused create with 503: .*network fee/)
  await assert.rejects(create(refused.provider), /refused create with 503: /)
  await assert.rejects(
    refused.provider.renew!({ home: Gateway.home, id: 'sbx-5' }, 300),
    (error: unknown) =>
      error instanceof Gateway.RefusedError &&
      error.status === 500 &&
      /refused renew with 500: /.test(error.message),
    'a refusal carries its status, so a run tells one that may pass from one that will not',
  )
  assert.deepEqual(recorded(refused.charges), [
    ['compute.create', '42280', 0.04228],
    ['compute.create refused with 503', '-42280', -0.04228],
    ['compute.create', '42280', 0.04228],
    ['compute.create refused with 503', '-42280', -0.04228],
    ['compute.renew', '50835', 0.050835],
    ['compute.renew refused with 500', '-50835', -0.050835],
  ])
  assert.equal(
    refused.charges.reduce((sum, charge) => sum + Math.round(charge.usd * 1e6), 0),
    0,
    'a sandbox the gateway refused to open twice costs the run nothing',
  )
  assert.equal(refused.spent(), 0)

  for (const [status, body] of [
    [502, '<html>502 Bad Gateway</html>'],
    [500, '{"error":"the script threw"}'],
    [503, '"unavailable"'],
  ] as const) {
    const unknown = gateway({ create: '42280' }, { create: () => new Response(body, { status }) })
    await assert.rejects(
      create(unknown.provider),
      new RegExp(
        'paid create was answered ' +
          status +
          ' without a problem of the gateway, which may have been charged',
      ),
    )
    assert.deepEqual(recorded(unknown.charges), [
      ['compute.create', '42280', 0.04228],
      ['compute.create answered ' + status + ' without a problem', '0', 0],
    ])
    assert.equal(unknown.spent(), 0.04228, 'a 5xx that is not the gateway refusing proves nothing')
  }

  for (const [answer, reason] of [
    [
      () => {
        throw new TypeError('the connection was reset')
      },
      /connection was reset/,
    ],
    [
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError('the answer was cut'))
            },
          }),
          { status: 503 },
        ),
      /answer was cut/,
    ],
  ] as const) {
    const silent = gateway({ create: '42280' }, { create: answer })
    await assert.rejects(
      create(silent.provider),
      (error: Error) =>
        error.name === 'Gateway.RequestError' &&
        /did not answer the paid create, which may have been charged/.test(error.message) &&
        reason.test(error.message),
    )
    assert.deepEqual(recorded(silent.charges), [
      ['compute.create', '42280', 0.04228],
      ['compute.create unanswered', '0', 0],
    ])
    assert.equal(silent.spent(), 0.04228, 'a request that left with the key may have been paid')
  }

  for (const fetch of [
    async () => {
      throw new TypeError('no route to the gateway')
    },
    async () => refusal(503, 'unavailable', unavailable)(),
  ]) {
    const budget = Budget.create({ limitUsd: 1 })
    const unpriced = Gateway.create({
      budget,
      fetch,
      key: 'sk-tempo-test',
      onCharge: () => assert.fail('nothing was quoted'),
    })
    await assert.rejects(
      create(unpriced),
      /no route to the gateway|answered 503 to an unpaid create/,
    )
    assert.equal(budget.spentUsd, 0, 'a request that fails before its price leaves nothing behind')
  }
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

test('what a key was charged is read from its usage, through its channel and outside it', async () => {
  const seen: [string, string | undefined][] = []
  const answer = {
    usage: {
      channel: { available: '0', deposit: '6.85', settled: '6.849748', spent: '6.85' },
      limit: { remaining: '0.000803', total: '9.009' },
      wallet: { balance: '0.291803' },
    },
  }
  const read = (body: unknown, status = 200) =>
    Gateway.usage({
      fetch: async (input, init) => {
        seen.push([input, new Headers(init?.headers).get('authorization') ?? undefined])
        return Response.json(body, { status })
      },
      key: 'sk-tempo-test',
      url: 'https://gateway.example/',
    })
  const end = await read(answer)
  assert.deepEqual(end, {
    channelDepositUsd: 6.85,
    channelSpentUsd: 6.85,
    limitRemainingUsd: 0.000803,
    walletUsd: 0.291803,
  })
  assert.deepEqual(seen, [['https://gateway.example/api/keys/me', 'Bearer sk-tempo-test']])
  const start = {
    channelDepositUsd: 3,
    channelSpentUsd: 0.02,
    limitRemainingUsd: 6.009,
    walletUsd: 6.3,
  }
  assert.deepEqual(Gateway.charged(start, end), {
    channelUsd: 6.83,
    outsideUsd: 2.158197,
    usd: 8.988197,
  })
  assert.deepEqual(Gateway.charged(end, end), { channelUsd: 0, outsideUsd: 0, usd: 0 })
  await assert.rejects(read({ status: 401 }, 401), Gateway.RefusedError)
  await assert.rejects(read({ usage: { channel: { spent: '1' } } }), /without its amounts/)
})
