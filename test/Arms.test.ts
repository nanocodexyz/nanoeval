import assert from 'node:assert/strict'
import { test } from 'node:test'
import { armsText } from '../cli/nanoeval.ts'
import * as Arms from '../src/Arms.ts'
import type * as Atif from '../src/Atif.ts'
import type * as Compare from '../src/Compare.ts'
import type * as Result from '../src/Result.ts'
import type * as Unsound from '../src/Unsound.ts'
import * as Verdict from '../src/Verdict.ts'

const glm = '@cf/zai-org/glm-5.3-flash'

const used = (tokens: Partial<Atif.Usage>): Atif.Usage => ({
  cacheWriteTokens: 0,
  cachedTokens: 0,
  costUsd: undefined,
  inputTokens: 0,
  modelCalls: 1,
  outputTokens: 0,
  toolCalls: 0,
  ...tokens,
})

const row = (
  task: string,
  index: number,
  given: {
    agent?: Result.Attempt['agent']
    at?: [startedAt: number, finishedAt: number]
    kind?: Result.FailureKind
    message?: string
    outcome: Result.Attempt['outcome']
    retryOf?: Result.Attempt['retryOf']
    usage?: Atif.Usage
  },
): Result.Attempt => ({
  agent: given.agent ?? { api: 'chat', id: 'fx', model: glm, provider: 'fx' },
  ...(given.kind
    ? { failure: { at: 1, kind: given.kind, message: given.message ?? 'it ended' } }
    : {}),
  finishedAt: given.at?.[1] ?? 2000,
  id: task + index,
  index,
  outcome: given.outcome,
  ...(given.retryOf ? { retryOf: given.retryOf } : {}),
  reward: given.outcome === 'errored' ? null : given.outcome === 'passed' ? 1 : 0,
  sandbox: null,
  session: 's',
  startedAt: given.at?.[0] ?? 1000,
  task: { checksum: 'sha256:' + task, name: 'suite/' + task },
  timing: {},
  usage: given.usage ?? null,
})

const run = (id: string, attempts: readonly Result.Attempt[]): Compare.Run => ({
  attempts,
  eval: { name: 'suite', version: 'a'.repeat(64) },
  id,
  name: 'run-' + id,
  state: 'finished',
})

const tokens = { cachedTokens: 600_000, inputTokens: 1_000_000, outputTokens: 200_000 }
const prices = { [glm]: { cachedUsd: 0.05, inputUsd: 0.15, outputUsd: 0.5 } }
const listUsd = 0.4 * 0.15 + 0.6 * 0.05 + 0.2 * 0.5

const open = run('one', [
  row('a', 1, { at: [1000, 31_000], outcome: 'passed', usage: used(tokens) }),
  row('a', 2, { outcome: 'passed', usage: used(tokens) }),
  row('a', 3, { outcome: 'passed', usage: used(tokens) }),
  row('b', 1, { outcome: 'passed', usage: used(tokens) }),
  row('b', 2, { at: [2000, 126_000], outcome: 'failed', usage: used(tokens) }),
  row('c', 1, { kind: 'verifier', outcome: 'errored', usage: used(tokens) }),
  row('c', 2, { kind: 'verifier_timeout', outcome: 'errored', usage: used(tokens) }),
  row('d', 1, { kind: 'agent', outcome: 'errored', usage: used({ modelCalls: 0 }) }),
  row('d', 2, { kind: 'budget', outcome: 'errored' }),
  row('d', 3, { kind: 'cancelled', outcome: 'errored' }),
  row('e', 1, { kind: 'agent_timeout', outcome: 'failed', usage: used(tokens) }),
  row('e', 2, { outcome: 'errored' }),
])

test('an arm is its passes, its two pass rates, its cost, its tokens, its time and its errors', () => {
  const [arm, ...rest] = Arms.arms([open], { prices })
  assert.deepEqual(rest, [])
  assert.deepEqual(arm, {
    agent: 'fx',
    agentLimits: ["the task's own"],
    cachedTokens: 8 * 600_000,
    costUsd: arm!.costUsd,
    errored: 6,
    errors: {
      agent: { agent: 1, budget: 1 },
      cancelled: { cancelled: 1 },
      infrastructure: { unrecorded: 1, verifier: 1, verifier_timeout: 1 },
      limit: {},
      task: {},
    },
    failed: 2,
    harness: 'fx-chat 0.0.17',
    inputTokens: 8 * 1_000_000,
    listed: 9,
    metered: 9,
    model: glm,
    name: 'run-one',
    outputTokens: 8 * 200_000,
    passMacro: (1 + 1 / 2 + 0) / 3,
    passMicro: 4 / 6,
    passed: 4,
    priced: 9,
    rows: 12,
    run: 'one',
    scored: 6,
    tasks: 3,
    usdPerPass: arm!.costUsd! / 4,
    verifierLimits: ["the task's own"],
    waitSec: 0,
    waits: 0,
    wallSec: 125,
  })
  assert.ok(Math.abs(arm!.costUsd! - 8 * listUsd) < 1e-12, 'eight attempts with tokens, at list')
  assert.equal(
    Arms.line(arm!),
    'run-one fx (fx-chat 0.0.17, ' +
      glm +
      '): passed 4/12 rows, pass micro 66.7% of 6 scored, pass macro 50.0% over 3 tasks, ' +
      '$0.3800 a pass ($1.5200 at list prices), ' +
      'input tokens 8,000,000 (4,800,000 cached), output tokens 1,600,000, wall time 2 min 5 s, ' +
      'errors: infrastructure 3 or 25.0% of its rows (unrecorded 1, verifier 1, verifier_timeout 1), ' +
      'agent or model 2 (agent 1, budget 1), cancelled 1',
  )
})

test('a cost that was reported stands, and an attempt without one is said', () => {
  const reported = run('two', [
    row('a', 1, { outcome: 'passed', usage: used({ ...tokens, costUsd: 0.25 }) }),
    row('b', 1, { outcome: 'passed', usage: used({ ...tokens, costBy: 'list', costUsd: 0.5 }) }),
    row('c', 1, { outcome: 'failed', usage: used(tokens) }),
  ])
  const [bare] = Arms.arms([reported])
  assert.deepEqual(
    [bare!.costUsd, bare!.priced, bare!.listed, bare!.metered, bare!.usdPerPass],
    [0.75, 2, 1, 3, 0.375],
  )
  assert.match(
    Arms.line(bare!),
    /, \$0\.3750 a pass \(\$0\.7500, 1 of 2 attempts at list prices, without 1 attempt that has no cost\), input/,
  )
  const [priced] = Arms.arms([reported], { prices })
  assert.ok(Math.abs(priced!.costUsd! - 0.75 - listUsd) < 1e-12, 'a price is no second cost')
  assert.deepEqual([priced!.priced, priced!.listed], [3, 2])

  const [unknown] = Arms.arms([
    run('three', [row('a', 1, { outcome: 'failed', usage: used(tokens) })]),
  ])
  assert.match(Arms.line(unknown!), /over 1 task, cost not known, input tokens 1,000,000 /)
  const [unpassed] = Arms.arms(
    [run('three', [row('a', 1, { outcome: 'failed', usage: used(tokens) })])],
    { prices },
  )
  assert.match(
    Arms.line(unpassed!),
    /pass micro 0\.0% of 1 scored, pass macro 0\.0% over 1 task, no pass \(\$0\.1900 at list prices\), /,
  )
  const oracle = { id: 'oracle', model: 'oracle', provider: 'oracle' as const }
  const [solved] = Arms.arms([
    run('four', [
      row('a', 1, { agent: oracle, outcome: 'passed' }),
      row('b', 1, { agent: oracle, kind: 'environment', outcome: 'errored' }),
    ]),
  ])
  assert.equal(
    Arms.line(solved!),
    'run-four oracle (oracle, the task solution): passed 1/2 rows, pass micro 100.0% of 1 scored, ' +
      'pass macro 100.0% over 1 task, no model usage, wall time 1 s, ' +
      'errors: infrastructure 1 or 50.0% of its rows (environment 1), agent or model 0',
  )
  const [none] = Arms.arms([run('five', [row('a', 1, { kind: 'agent', outcome: 'errored' })])])
  assert.match(
    Arms.line(none!),
    /pass micro not known of 0 scored, pass macro not known over 0 tasks, /,
  )
})

test('one run prints a line an arm, several runs a table, and both are JSON on request', () => {
  const sonnet = { id: 'sonnet', model: 'claude-sonnet-5', provider: 'claude' as const }
  const two = run('two', [
    row('a', 1, { outcome: 'passed', usage: used({ ...tokens, costUsd: 0.25 }) }),
    row('a', 1, { agent: sonnet, outcome: 'failed', usage: used({ ...tokens, costUsd: 1 }) }),
  ])
  const lines = armsText([two], { json: false, prices: [] })
  assert.deepEqual(
    lines.split('\n').map((line) => line.split(':')[0]),
    ['run-two fx (fx-chat 0.0.17, ' + glm + ')', 'run-two sonnet (nanocode, claude-sonnet-5)', ''],
  )
  const table = armsText([open, two], { json: false, prices: [glm + '=0.15,0.05,0.50'] })
  assert.deepEqual(table.split('\n'), [
    '| Run | Arm | Harness | Model | Passed | Pass micro | Pass macro | USD a pass | Cost | Input tokens (cached) | Output tokens | Wall time | Model waits | Infrastructure errors | Agent or model errors | Cancelled |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| run-one | fx | fx-chat 0.0.17 | ' +
      glm +
      ' | 4/12 | 66.7% of 6 | 50.0% over 3 | $0.3800 | $1.5200 at list prices | 8,000,000 (4,800,000) | 1,600,000 | 2 min 5 s | 0 | 3 or 25.0% of its rows (unrecorded 1, verifier 1, verifier_timeout 1) | 2 (agent 1, budget 1) | 1 |',
    '| run-two | fx | fx-chat 0.0.17 | ' +
      glm +
      ' | 1/1 | 100.0% of 1 | 100.0% over 1 | $0.2500 | $0.2500 | 1,000,000 (600,000) | 200,000 | 1 s | 0 | 0 | 0 | 0 |',
    '| run-two | sonnet | nanocode | claude-sonnet-5 | 0/1 | 0.0% of 1 | 0.0% over 1 | no pass | $1.0000 | 1,000,000 (600,000) | 200,000 | 1 s | 0 | 0 | 0 | 0 |',
    '',
  ])
  assert.deepEqual(
    JSON.parse(armsText([open, two], { json: true, prices: [glm + '=0.15,0.05,0.50'] })),
    JSON.parse(JSON.stringify(Arms.arms([open, two], { prices }))),
  )
  assert.throws(() => armsText([two], { json: false, prices: ['glm'] }), {
    name: 'Price.InvalidError',
  })
})

test('an attempt that a rerun of the table retried counts once, as its retry', () => {
  const first = run('one', [
    row('a', 1, { outcome: 'passed' }),
    row('b', 1, { kind: 'environment', outcome: 'errored' }),
  ])
  const rerun = run('two', [
    row('b', 1, { outcome: 'passed', retryOf: { attempt: 'b1', run: 'one' } }),
  ])
  assert.deepEqual(
    Arms.arms([first, rerun]).map((arm) => [arm.run, arm.passed, arm.rows, arm.errored]),
    [
      ['one', 1, 1, 0],
      ['two', 1, 1, 0],
    ],
  )
  assert.deepEqual(
    Arms.arms([first]).map((arm) => [arm.run, arm.passed, arm.rows, arm.errored]),
    [['one', 1, 2, 1]],
  )
})

test('an arm sums the model requests its run held or asked again, and the seconds they waited', () => {
  const held = run('held', [
    { ...row('a', 1, { outcome: 'passed' }), modelWaits: { count: 3, sec: 7.4 } },
    { ...row('b', 1, { outcome: 'failed' }), modelWaits: { count: 2, sec: 3.2 } },
    row('c', 1, { outcome: 'passed' }),
  ])
  const [arm] = Arms.arms([held])
  assert.deepEqual([arm!.waits, arm!.waitSec], [5, 7.4 + 3.2])
  assert.match(Arms.line(arm!), /, wall time 1 s, model waits 5 \(11 s\), errors: /)
  assert.match(Arms.table([arm!]), / \| 1 s \| 5 \(11 s\) \| 0 \| /)
  assert.doesNotMatch(Arms.line(Arms.arms([open])[0]!), /model waits/)
})

test('an arm of a run that bounds the time of its agents says the limit, and a table that holds one says it of every arm', () => {
  const bounded = run('bounded', [
    { ...row('a', 1, { outcome: 'passed' }), agentMaxSec: 600 },
    { ...row('b', 1, { kind: 'agent_timeout', outcome: 'failed' }), agentMaxSec: 600 },
  ])
  const [arm] = Arms.arms([bounded])
  const [plain] = Arms.arms([open])
  assert.deepEqual(arm!.agentLimits, ['600 s'])
  assert.match(Arms.line(arm!), /, wall time 1 s, agent time limit 600 s, errors: /)
  assert.doesNotMatch(Arms.line(plain!), /agent time limit/)
  assert.doesNotMatch(Arms.table([plain!]), /Agent time limit/)
  const table = Arms.table([arm!, plain!]).split('\n')
  assert.match(table[0]!, / \| Wall time \| Agent time limit \| Model waits \| /)
  assert.match(table[2]!, / \| 1 s \| 600 s \| 0 \| /)
  assert.match(table[3]!, / \| 2 min 5 s \| the task's own \| 0 \| /)
  const mixed = run('mixed', [
    { ...row('a', 1, { outcome: 'passed' }), agentMaxSec: 600 },
    row('b', 1, { outcome: 'passed' }),
  ])
  assert.match(
    Arms.line(Arms.arms([mixed])[0]!),
    /, agent time limit 600 s and the task's own, errors: /,
    'rows under two limits are one arm that says both',
  )
})

test('an error of a task whose dependency is gone is counted apart, when its verifier says so and the list names its version', () => {
  const withdrawn =
    Verdict.withdrawnPrefix +
    ', so its tests did not run: E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/c/curl/curl_7.74.0-1.3%2bdeb11u16_amd64.deb  404  Not Found [IP: 151.101.66.132 80]'
  const lost = { kind: 'verifier' as const, message: withdrawn, outcome: 'errored' as const }
  const entry = (task: string): Unsound.Entry => ({
    checksum: 'sha256:' + task,
    reason: 'its verifier installs curl from an archive that is gone.',
    task,
    upstream: 'https://example.com/' + task,
  })
  const unsound = { suite: ['qemu-alpine-ssh', 'qemu-startup', 'stale'].map(entry) }
  const real = run('real', [
    row('a', 1, { outcome: 'passed' }),
    row('a', 2, { outcome: 'failed' }),
    row('qemu-alpine-ssh', 1, { kind: 'agent', outcome: 'errored' }),
    row('qemu-alpine-ssh', 2, lost),
    row('qemu-alpine-ssh', 3, lost),
    row('qemu-startup', 1, lost),
    row('qemu-startup', 2, lost),
    row('qemu-startup', 3, lost),
    row('stale', 1, { kind: 'verifier', outcome: 'errored' }),
    row('unlisted', 1, lost),
  ])
  const [arm] = Arms.arms([real], { unsound })
  assert.deepEqual(arm!.errors, {
    agent: { agent: 1 },
    cancelled: {},
    infrastructure: { verifier: 2 },
    limit: {},
    task: { 'qemu-alpine-ssh': 2, 'qemu-startup': 3 },
  })
  assert.equal(arm!.errored, 8)
  assert.ok(
    Arms.line(arm!).endsWith(
      ', errors: infrastructure 2 or 20.0% of its rows (verifier 2), task dependency gone 5 or 50.0% of its rows (qemu-alpine-ssh 2, qemu-startup 3), agent or model 1 (agent 1)',
    ),
    Arms.line(arm!),
  )
  const [unread] = Arms.arms([real])
  assert.deepEqual(unread!.errors.infrastructure, { verifier: 7 })
  assert.deepEqual(unread!.errors.task, {})
  assert.doesNotMatch(Arms.line(unread!), /task dependency gone/)
  const sound = run('sound', [row('a', 1, { outcome: 'passed' })])
  const [header, , first, second] = armsText([real, sound], {
    json: false,
    prices: [],
    unsound,
  }).split('\n')
  assert.match(
    header!,
    / \| Infrastructure errors \| Task dependency gone \| Agent or model errors \| /,
  )
  assert.match(
    first!,
    / \| 2 or 20\.0% of its rows \(verifier 2\) \| 5 or 50\.0% of its rows \(qemu-alpine-ssh 2, qemu-startup 3\) \| 1 \(agent 1\) \| 0 \|$/,
  )
  assert.match(second!, / \| 0 \| 0 \| 0 \| 0 \|$/)
  assert.doesNotMatch(armsText([real, sound], { json: false, prices: [] }), /Task dependency gone/)
})

test('rows whose verifier the limit of the run ended are counted apart from both classes of errors', () => {
  const bounded = run('bounded', [
    { ...row('a', 1, { outcome: 'passed' }), verifierMaxSec: 240 },
    { ...row('a', 2, { kind: 'verifier_limit', outcome: 'errored' }), verifierMaxSec: 240 },
    { ...row('b', 1, { kind: 'verifier_timeout', outcome: 'errored' }), verifierMaxSec: 240 },
    { ...row('b', 2, { outcome: 'failed' }), verifierMaxSec: 240 },
  ])
  const [arm] = Arms.arms([bounded])
  const [plain] = Arms.arms([open])
  assert.deepEqual(arm!.verifierLimits, ['240 s'])
  assert.deepEqual(arm!.errors, {
    agent: {},
    cancelled: {},
    infrastructure: { verifier_timeout: 1 },
    limit: { verifier_limit: 1 },
    task: {},
  })
  assert.deepEqual([arm!.passed, arm!.failed, arm!.errored, arm!.scored], [1, 1, 2, 2])
  assert.equal(arm!.passMicro, 0.5, 'a row the limit ended is a trial of neither')
  assert.match(
    Arms.line(arm!),
    /, wall time 1 s, verifier time limit 240 s, errors: infrastructure 1 or 25\.0% of its rows \(verifier_timeout 1\), agent or model 0, verifier ended by the run's limit 1 or 25\.0% of its rows$/,
  )
  assert.doesNotMatch(Arms.line(plain!), /verifier time limit|ended by the run's limit/)
  assert.doesNotMatch(Arms.table([plain!]), /Verifier/)
  const table = Arms.table([arm!, plain!]).split('\n')
  assert.match(table[0]!, / \| Wall time \| Verifier time limit \| Model waits \| /)
  assert.match(
    table[0]!,
    / \| Agent or model errors \| Verifier ended by the run's limit \| Cancelled \|$/,
  )
  assert.match(
    table[2]!,
    / \| 1 s \| 240 s \| 0 \| 1 or 25\.0% of its rows \(verifier_timeout 1\) \| 0 \| 1 or 25\.0% of its rows \| 0 \|$/,
  )
  assert.match(table[3]!, / \| 2 min 5 s \| the task's own \| 0 \| .* \| 0 \| 1 \|$/)
  const none = run('none', [{ ...row('a', 1, { outcome: 'passed' }), verifierMaxSec: 240 }])
  assert.match(
    Arms.line(Arms.arms([none])[0]!),
    /, verifier time limit 240 s, errors: infrastructure 0, agent or model 0, verifier ended by the run's limit 0$/,
    'an arm under the limit says so when the limit ended nothing',
  )
})
