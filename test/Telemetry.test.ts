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

test('a session that goes on after its host was lost has each input and each model call once', () => {
  const cut = published.findLastIndex(Telemetry.live) + 1
  const again = (event: Atif.SessionEvent): Atif.SessionEvent => {
    const inner = event.event.event!
    const payload =
      inner.type === 'model.call.completed'
        ? { ...inner.payload, attempt: 0, timing: { ...inner.payload['timing'], replayed: true } }
        : inner.payload
    return {
      ...event,
      event: { ...event.event, event: { ...inner, payload } },
      seq: event.seq && event.seq + 16384,
    }
  }
  const recovered = [
    ...published.slice(0, cut),
    ...[published[2]!, published[3]!, published[cut - 1]!].map(again),
    ...published.slice(cut),
  ]
  assert.deepEqual(Atif.usage(recovered), Atif.usage(published))
  const options = { model: '', name: '', session: '', version: '' }
  assert.deepEqual(Atif.fromEvents(recovered, options), Atif.fromEvents(published, options))
})
