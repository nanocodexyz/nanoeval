import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rerunConfig } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'
import * as Price from '../src/Price.ts'

test('a model price is three amounts in USD for a million tokens', () => {
  assert.deepEqual(Price.parse('@cf/zai-org/glm-5.3-flash=0.15,0.03,0.50'), [
    '@cf/zai-org/glm-5.3-flash',
    { cachedUsd: 0.03, inputUsd: 0.15, outputUsd: 0.5 },
  ])
  assert.deepEqual(Price.parse('a=b=1,0,2'), ['a=b', { cachedUsd: 0, inputUsd: 1, outputUsd: 2 }])
  assert.deepEqual(Price.parse('claude-opus-5-5=4,0.2,20,5,8'), [
    'claude-opus-5-5',
    { cachedUsd: 0.2, inputUsd: 4, outputUsd: 20, writeUsd: { fiveMinutes: 5, oneHour: 8 } },
  ])
  for (const text of [
    'glm',
    'glm=',
    '=1,2,3',
    'glm=1,2',
    'glm=1,2,3,4',
    'glm=1,,3',
    'glm=1,-2,3',
    'glm=1,2,3,4,-5',
    'glm=1,2,3,4,5,6',
  ])
    assert.throws(
      () => Price.parse(text),
      {
        message:
          'a model price is MODEL=INPUT,CACHED,OUTPUT[,WRITE,WRITE_1H], in USD for a million input tokens, cached input tokens and output tokens, and for a million input tokens written to a cache for 5 minutes and for 1 hour, not ' +
          text,
        name: 'Price.InvalidError',
      },
      text,
    )
  assert.deepEqual(Price.list(['a=1,2,3', 'b=4,5,6']), {
    a: { cachedUsd: 2, inputUsd: 1, outputUsd: 3 },
    b: { cachedUsd: 5, inputUsd: 4, outputUsd: 6 },
  })
  assert.throws(() => Price.list(['a=1,2,3', 'a=4,5,6']), {
    message: 'the model a is given two prices',
  })
})

test('usage is priced by its uncached input, its cached input and its output tokens', () => {
  const price = { cachedUsd: 0.5, inputUsd: 2, outputUsd: 10 }
  assert.equal(
    Price.usd(price, { cachedTokens: 0, inputTokens: 1_000_000, outputTokens: 0 }),
    2,
    'input tokens',
  )
  assert.equal(
    Price.usd(price, { cachedTokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 0 }),
    0.5,
    'input tokens that were read from a cache are in the input tokens',
  )
  assert.equal(
    Price.usd(price, { cachedTokens: 600_000, inputTokens: 1_000_000, outputTokens: 200_000 }),
    0.4 * 2 + 0.6 * 0.5 + 0.2 * 10,
  )
  assert.equal(Price.usd(price, { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }), 0)
  assert.equal(
    Price.usd(price, {
      cacheWriteTokens: 300_000,
      cachedTokens: 600_000,
      inputTokens: 1_000_000,
      outputTokens: 0,
    }),
    0.4 * 2 + 0.6 * 0.5,
    'a price without write amounts prices a written token as input',
  )
})

test('a price with write amounts prices cache writes by their lifetime', () => {
  const price = {
    cachedUsd: 0.2,
    inputUsd: 4,
    outputUsd: 20,
    writeUsd: { fiveMinutes: 5, oneHour: 8 },
  }
  assert.equal(
    Price.usd(price, {
      cacheWriteHourTokens: 100_000,
      cacheWriteTokens: 300_000,
      cachedTokens: 600_000,
      inputTokens: 1_000_000,
      outputTokens: 50_000,
    }),
    0.1 * 4 + 0.6 * 0.2 + 0.2 * 5 + 0.1 * 8 + 0.05 * 20,
  )
  assert.equal(
    Price.usd(price, {
      cacheWriteTokens: 300_000,
      cachedTokens: 600_000,
      inputTokens: 1_000_000,
      outputTokens: 0,
    }),
    0.1 * 4 + 0.6 * 0.2 + 0.3 * 5,
    'a write without a lifetime is a 5 minute write',
  )
})

test('a run keeps the list prices it is given, and refuses one that is no amount', () => {
  const config = {
    agents: [{ id: 'glm', model: 'glm', provider: 'claude' }],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'suite', version: 'a'.repeat(64) },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'priced',
    sandbox: {
      backend: 'dir',
      disks: 'keep',
      max: 1,
      network: 'host',
      pollMs: 250,
      provider: 'local',
      slots: 1,
    },
  }
  const prices = { glm: { cachedUsd: 0.03, inputUsd: 0.15, outputUsd: 0.5 } }
  assert.equal(Config.parse(config).prices, undefined)
  assert.deepEqual(Config.parse({ ...config, prices }).prices, prices)
  const written = { glm: { ...prices.glm, writeUsd: { fiveMinutes: 0.2, oneHour: 0.3 } } }
  assert.deepEqual(Config.parse({ ...config, prices: written }).prices, written)
  assert.throws(
    () => Config.parse({ ...config, prices: { glm: { ...prices.glm, writeUsd: { oneHour: 1 } } } }),
    { message: /prices\.glm\.writeUsd\.fiveMinutes must be a non-negative number/ },
  )
  assert.throws(
    () => Config.parse({ ...config, prices: { glm: { inputUsd: 0.15, outputUsd: 0.5 } } }),
    { message: /prices\.glm\.cachedUsd must be a non-negative number/ },
  )
  assert.throws(() => Config.parse({ ...config, prices: 'glm' }), {
    message: /prices holds a price for each model it names/,
  })
})

test('a rerun keeps the list prices of its run unless its command names its own', () => {
  const own = Config.parse({
    agents: [{ id: 'glm', model: 'glm', provider: 'claude' }],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'suite', version: 'a'.repeat(64) },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'again',
    sandbox: {
      backend: 'dir',
      disks: 'keep',
      max: 1,
      network: 'host',
      pollMs: 250,
      provider: 'local',
      slots: 1,
    },
  })
  const first = { glm: { cachedUsd: 0.03, inputUsd: 0.15, outputUsd: 0.5 } }
  const second = { glm: { cachedUsd: 0.3, inputUsd: 0.3, outputUsd: 1.2 } }
  const parent = { ...own, name: 'first', prices: first }
  assert.deepEqual(rerunConfig(own, { named: new Set(['rerun']), parent }).prices, first)
  assert.deepEqual(
    rerunConfig({ ...own, prices: second }, { named: new Set(['rerun', 'model-price']), parent })
      .prices,
    second,
  )
  assert.equal(rerunConfig(own, { named: new Set(['rerun']), parent: own }).prices, undefined)
})
