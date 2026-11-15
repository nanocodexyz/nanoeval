import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rerunConfig } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'
import * as Pace from '../src/Pace.ts'

const config = {
  agents: [
    { id: 'glm', model: 'glm', provider: 'claude' },
    { id: 'kimi', model: 'kimi', provider: 'codex' },
  ],
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'suite', version: 'a'.repeat(64) },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'paced',
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

function provider(limit: number): { answers(at: number): boolean } {
  let window = 0
  let earlier = 0
  let current = 0
  return {
    answers(at) {
      const index = Math.floor(at / Pace.minuteMs)
      if (index !== window) {
        earlier = index === window + 1 ? current : 0
        current = 0
        window = index
      }
      const kept = 1 - (at - index * Pace.minuteMs) / Pace.minuteMs
      if (earlier * kept + current >= limit) return false
      current++
      return true
    },
  }
}

function arm(input: { perMin?: number; rows: number; stepMs: number; untilMs: number }): {
  answered: number
  heldMs: number
  refused: number
} {
  const route = provider(20)
  const asks = Array.from({ length: input.rows }, (_, row) => 1 + row * 7)
  let nextAt: number | undefined
  let answered = 0
  let heldMs = 0
  let refused = 0
  for (;;) {
    const row = asks.indexOf(Math.min(...asks))
    const now = asks[row]!
    if (now >= input.untilMs) return { answered, heldMs, refused }
    let at = now
    if (input.perMin !== undefined) {
      const reserved = Pace.reserve({ nextAt, now, perMin: input.perMin })
      nextAt = reserved.nextAt
      heldMs += reserved.waitMs
      at = now + reserved.waitMs
    }
    if (route.answers(at)) {
      answered++
      asks[row] = at + input.stepMs
    } else {
      refused++
      asks[row] = at + 250
    }
  }
}

test('a pace sends the requests of a model one interval apart in the order they came', () => {
  assert.equal(Pace.interval(20), 3000)
  const first = Pace.reserve({ nextAt: undefined, now: 1000, perMin: 20 })
  assert.deepEqual(first, { nextAt: 4000, waitMs: 0 })
  const second = Pace.reserve({ nextAt: first.nextAt, now: 1000, perMin: 20 })
  assert.deepEqual(second, { nextAt: 7000, waitMs: 3000 })
  const third = Pace.reserve({ nextAt: second.nextAt, now: 2500, perMin: 20 })
  assert.deepEqual(third, { nextAt: 10_000, waitMs: 4500 })
  assert.deepEqual(Pace.reserve({ nextAt: third.nextAt, now: 60_000, perMin: 20 }), {
    nextAt: 63_000,
    waitMs: 0,
  })
  assert.equal(Pace.reserve({ nextAt: 0, now: 0, perMin: 7 }).nextAt, 60_000 / 7)
})

test('a request waits on a pace once the last one admitted is more than an interval from its turn', () => {
  assert.equal(Pace.waiting({ nextAt: undefined, now: 1000, perMin: 20 }), false)
  assert.equal(Pace.waiting({ nextAt: 4000, now: 1000, perMin: 20 }), false)
  assert.equal(Pace.waiting({ nextAt: 7000, now: 1000, perMin: 20 }), false)
  assert.equal(Pace.waiting({ nextAt: 7001, now: 1000, perMin: 20 }), true)
  assert.equal(Pace.waiting({ nextAt: 10_000, now: 4000, perMin: 20 }), false)
})

test('the rows a pace feeds come from the requests a minute its rows asked while they were not held', () => {
  assert.equal(Pace.demand([]), undefined)
  assert.equal(Pace.demand([{ busyMs: 90_000, requests: 0 }]), undefined)
  assert.equal(
    Pace.demand([
      { busyMs: 60_000, requests: 3 },
      { busyMs: 120_000, requests: 7 },
      { busyMs: 40_000, requests: 0 },
    ]),
    10 / 3,
  )
  assert.equal(Pace.room({ demand: undefined, perMin: 20, rows: 0 }), 1)
  assert.equal(Pace.room({ demand: undefined, perMin: 20, rows: 1 }), 0)
  assert.equal(Pace.room({ demand: 10 / 3, perMin: 20, rows: 0 }), 6)
  assert.equal(Pace.room({ demand: 10 / 3, perMin: 20, rows: 4 }), 2)
  assert.equal(Pace.room({ demand: 10 / 3, perMin: 20, rows: 6 }), 0)
  assert.equal(Pace.room({ demand: 10 / 3, perMin: 20, rows: 9 }), 0)
  assert.equal(Pace.room({ demand: 3.4, perMin: 20, rows: 5 }), 1)
  assert.equal(Pace.room({ demand: 3.4, perMin: 80, rows: 5 }), 19)
  assert.equal(Pace.room({ demand: 600, perMin: 20, rows: 0 }), 1)
  assert.equal(Pace.room({ demand: 600, perMin: 20, rows: 1 }), 0)
  const stalled = Pace.demand([{ busyMs: -5, requests: 2 }])
  assert.equal(stalled, Number.POSITIVE_INFINITY)
  assert.equal(Pace.room({ demand: stalled, perMin: 20, rows: 0 }), 1)
  assert.equal(Pace.room({ demand: stalled, perMin: 20, rows: 1 }), 0)
})

test('a provider that counts a sliding minute refuses no request of a paced arm and most of an arm without a pace, which is answered no more often', () => {
  const hourMs = 60 * Pace.minuteMs
  for (const rows of [4, 8, 16]) {
    const plain = arm({ rows, stepMs: 5000, untilMs: hourMs })
    const paced = arm({ perMin: 20, rows, stepMs: 5000, untilMs: hourMs })
    assert.equal(paced.refused, 0, rows + ' rows')
    assert.ok(plain.refused > plain.answered, rows + ' rows: ' + JSON.stringify(plain))
    assert.ok(paced.answered >= 1195, rows + ' rows: ' + JSON.stringify(paced))
    assert.ok(paced.answered >= plain.answered - 20, rows + ' rows')
    assert.ok(paced.heldMs > 0)
  }
  const idle = arm({ perMin: 20, rows: 1, stepMs: 5000, untilMs: hourMs })
  assert.deepEqual([idle.refused, idle.heldMs, idle.answered], [0, 0, 720])
})

test('a pace is given for a model of the run, or for every model of it', () => {
  assert.deepEqual(Pace.list(['glm=20', '@cf/moonshotai/kimi=12.5'], ['glm']), {
    '@cf/moonshotai/kimi': 12.5,
    glm: 20,
  })
  assert.deepEqual(Pace.list(['20'], ['glm', 'kimi', 'glm']), { glm: 20, kimi: 20 })
  assert.deepEqual(Pace.list(['a=b=3'], []), { 'a=b': 3 })
  for (const text of ['glm=', 'glm=0', 'glm=-2', 'glm=fast', '=20', ''])
    assert.throws(() => Pace.list([text], ['glm']), { name: 'Pace.InvalidError' }, text)
  assert.throws(() => Pace.list(['glm=20', '30'], ['glm']), {
    message: 'the model glm is given two paces',
  })
  assert.equal(Config.parse(config).paces, undefined)
  assert.deepEqual(Config.parse({ ...config, paces: { glm: 20, kimi: 6 } }).paces, {
    glm: 20,
    kimi: 6,
  })
  assert.deepEqual(
    Config.parse({
      ...config,
      judge: { model: 'haiku', provider: 'claude' },
      paces: { haiku: 50 },
    }).paces,
    { haiku: 50 },
  )
  assert.throws(() => Config.parse({ ...config, paces: { qwen: 20 } }), {
    message: /paces names qwen, the model of no agent and no judge of the run/,
  })
  assert.throws(() => Config.parse({ ...config, paces: { glm: 0 } }), {
    message: /paces\.glm is the requests a minute of the model, above zero/,
  })
  assert.throws(() => Config.parse({ ...config, paces: 20 }), {
    message: /paces holds the requests a minute of each model it names/,
  })
})

test('a rerun keeps the paces of its run unless its command names its own', () => {
  const parent = Config.parse({ ...config, paces: { glm: 20 } })
  const own = Config.parse(config)
  assert.deepEqual(rerunConfig(own, { named: new Set(['rerun']), parent }).paces, { glm: 20 })
  assert.deepEqual(
    rerunConfig(
      { ...own, paces: { glm: 40 } },
      { named: new Set(['rerun', 'model-requests-per-min']), parent },
    ).paces,
    { glm: 40 },
  )
  assert.equal(rerunConfig(own, { named: new Set(['rerun']), parent: own }).paces, undefined)
})
