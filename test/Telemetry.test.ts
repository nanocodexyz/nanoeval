import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Atif from '../src/Atif.ts'
import * as Sql from '../src/Sql.ts'
import * as Telemetry from '../src/Telemetry.ts'
import * as Timeline from '../src/Timeline.ts'
import * as Rows from './Rows.ts'

const published = (
  JSON.parse(
    Fs.readFileSync(Path.join(import.meta.dirname, 'fixtures/session-events.json'), 'utf8'),
  ) as { published: Atif.SessionEvent[] }
).published
const log = published.filter((event) => !Telemetry.live(event))
const type = (event: Atif.SessionEvent) => event.event.event?.type ?? event.event.type

function open(): Sql.Sql {
  const sql = Rows.database()
  Sql.setup(sql, Telemetry.tables)
  return sql
}

function read(sql: Sql.Sql, size: number): Atif.SessionEvent[] {
  const all: Atif.SessionEvent[] = []
  for (let from = 0; ; from += size) {
    const events = log.slice(from, from + size)
    const last = from + size >= log.length
    all.push(
      ...Telemetry.merge(
        events,
        Telemetry.read(sql, {
          after: from === 0 ? 0 : log[from - 1]!.seq,
          last,
          through: events.at(-1)?.seq ?? log.at(-1)!.seq,
        }),
      ),
    )
    if (last) return all
  }
}

test('the log of a session holds no model call, and what it hands over beside it does', () => {
  assert.deepEqual(
    log.map((event) => type(event)).filter((name) => name?.startsWith('model.')),
    [],
  )
  assert.equal(Atif.usage(log).modelCalls, 0)
  assert.equal(Timeline.modelRequest(log), undefined)
  assert.deepEqual(
    published.filter(Telemetry.live).map((event) => [type(event), event.seq]),
    [
      ['model.call.completed', 0],
      ['model.call.completed', 0],
      ['model.call.completed', 0],
    ],
  )
})

test('what a session hands over without a place in its log is read back where it was', () => {
  const batches: Record<string, Atif.SessionEvent[][]> = {
    'all at once': [published],
    'one by one': published.map((event) => [event]),
    'each batch ends with a model call': published.reduce<Atif.SessionEvent[][]>(
      (all, event) => {
        all.at(-1)!.push(event)
        if (Telemetry.live(event)) all.push([])
        return all
      },
      [[]],
    ),
  }
  for (const [name, batch] of Object.entries(batches))
    for (const restarted of [false, true])
      for (const size of [1, 5, 128]) {
        const sql = open()
        let waiting = true
        for (const events of batch)
          waiting = Telemetry.record(sql, { events, open: restarted || waiting })
        assert.equal(waiting, false, name)
        assert.deepEqual(read(sql, size), published, name + ', pages of ' + size)
      }
})

test('a model call with nothing logged after it is read at the end, on the last page only', () => {
  const sql = open()
  const cut = published.slice(0, published.findLastIndex(Telemetry.live) + 1)
  assert.equal(Telemetry.record(sql, { events: cut, open: true }), true)
  const before = cut.filter((event) => !Telemetry.live(event))
  const through = before.at(-1)!.seq
  assert.deepEqual(
    Telemetry.read(sql, { after: 0, last: false, through }).map((row) => row.before),
    [16390, 16396],
  )
  const rows = Telemetry.read(sql, { after: 0, last: true, through })
  assert.deepEqual(
    rows.map((row) => row.before),
    [16390, 16396, null],
  )
  assert.deepEqual(Telemetry.merge(before, rows), cut)
})

test('a log that holds its model calls is read as it is', () => {
  const sql = open()
  const stored = published.map((event, index) => ({ ...event, seq: 16385 + index }))
  assert.equal(Telemetry.record(sql, { events: stored, open: true }), false)
  assert.deepEqual(Telemetry.read(sql, { after: 0, last: true, through: stored.at(-1)!.seq }), [])
  assert.deepEqual(Telemetry.merge(stored, []), stored)
  assert.deepEqual(Atif.usage(stored), Atif.usage(published))
})

test('the usage, the steps and the first model request of a session are those of its model calls', () => {
  const sql = open()
  Telemetry.record(sql, { events: published, open: true })
  const events = read(sql, 128)
  assert.deepEqual(Atif.usage(events), {
    cacheWriteTokens: 2484,
    cachedTokens: 21526,
    costUsd: 0.0036082,
    inputTokens: 24018,
    modelCalls: 3,
    outputTokens: 3203,
    toolCalls: 4,
  })
  const trajectory = Atif.fromEvents(events, {
    model: 'claude-haiku-5-5',
    name: 'nanocode',
    session: 'fallback',
    version: 'test',
  })
  assert.deepEqual(
    trajectory.steps.map((step) => [
      step.source,
      step.metrics?.prompt_tokens,
      step.metrics?.extra['call_index'],
      step.tool_calls?.length ?? 0,
      step.observation?.results.length ?? 0,
      step.message,
    ]),
    [
      ['user', undefined, undefined, 0, 0, 'Write the greeting.'],
      ['agent', 7367, 1, 2, 2, 'The files are listed.'],
      ['agent', 7882, 2, 2, 2, 'The files are listed.'],
      ['agent', 8769, 3, 0, 0, 'The greeting is written.'],
    ],
  )
  assert.equal(trajectory.final_metrics.extra.model_calls, 3)
  assert.equal(trajectory.final_metrics.total_prompt_tokens, 24018)
  assert.equal(
    Atif.fromEvents(log, { model: '', name: '', session: '', version: '' }).steps.length,
    2,
  )
  assert.equal(Math.round(Timeline.modelRequest(events)!), 1_794_000_000_796)
})

test('the model calls of a codex session add up to the usage its run reports', () => {
  const at = (seq: number, type: string, payload: Record<string, unknown>): Atif.SessionEvent => ({
    created_at: 1_794_629_796_000 + seq,
    event: { event: { payload, type }, source: 'agent' },
    request_id: 'attempt',
    seq,
  })
  const call = (index: number, usage: { cached: number; input: number; output: number }) =>
    at(0, 'model.call.completed', {
      attempt: 1,
      call_index: index,
      model: 'gpt-6-luna',
      status: 'completed',
      usage: {
        input_tokens: usage.input,
        input_tokens_details: { cached_tokens: usage.cached },
        output_tokens: usage.output,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.input + usage.output,
      },
    })
  const totals = {
    cache_write_input_tokens: 0,
    cached_input_tokens: 155136,
    input_tokens: 171871,
    output_tokens: 2451,
    reasoning_output_tokens: 1610,
    total_tokens: 174322,
  }
  const session = [
    at(16387, 'input.accepted', { input: 'Fix the proof.', session_id: 'session' }),
    at(16388, 'run.started', {
      model: 'gpt-6-luna',
      orchestration: 'local_code_mode',
      transport: 'responses_websocket_v2',
    }),
    call(1, { cached: 70000, input: 80000, output: 1200 }),
    at(16389, 'tool.call', { arguments: '{}', call_id: 'call-1', tool: 'exec' }),
    at(16390, 'tool.result', { call_id: 'call-1', result: 'ok', status: 'completed' }),
    call(2, { cached: 85136, input: 91871, output: 1251 }),
    at(16391, 'assistant.message', { text: 'The proof compiles.' }),
    at(16392, 'run.completed', {
      cost_usd: 0.00445036,
      model_calls: 2,
      status: 'completed',
      usage: totals,
    }),
  ]
  const sql = open()
  assert.equal(Telemetry.record(sql, { events: session, open: true }), false)
  const stored = session.filter((event) => !Telemetry.live(event))
  const events = Telemetry.merge(
    stored,
    Telemetry.read(sql, { after: 0, last: true, through: stored.at(-1)!.seq }),
  )
  assert.deepEqual(events, session)
  assert.equal(Atif.usage(stored).modelCalls, 0)
  assert.deepEqual(Atif.usage(events), {
    cacheWriteTokens: totals.cache_write_input_tokens,
    cachedTokens: totals.cached_input_tokens,
    costUsd: 0.00445036,
    inputTokens: totals.input_tokens,
    modelCalls: 2,
    outputTokens: totals.output_tokens,
    toolCalls: 1,
  })
})
