import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Hold from '../src/Hold.ts'
import * as Sse from '../src/Sse.ts'

test('a held request ends when it is released, when its time is up, or when a later one takes its place', async () => {
  const holds = Hold.create()
  const released = holds.wait('claim:1', 60_000)
  const other = holds.wait('claim:2', 60_000)
  assert.equal(holds.size(), 2)
  assert.ok(holds.has('claim:1') && !holds.has('claim:3'))
  holds.release((key) => key === 'claim:1')
  assert.equal(await released, 'released')
  assert.equal(holds.size(), 1)

  const earlier = holds.wait('claim:1', 60_000)
  const later = holds.wait('claim:1', 60_000)
  assert.equal(await earlier, 'superseded')
  assert.equal(holds.size(), 2)

  assert.equal(await holds.wait('row:a00001:agent', 5), 'timeout')
  holds.release()
  assert.deepEqual(await Promise.all([other, later]), ['released', 'released'])
  assert.equal(holds.size(), 0)
})

test('a release after the hold ended changes nothing', async () => {
  const holds = Hold.create()
  const first = holds.wait('claim:1', 1)
  assert.equal(await first, 'timeout')
  holds.release()
  const second = holds.wait('claim:1', 60_000)
  holds.release()
  assert.equal(await second, 'released')
})

test('an event stream is read message by message, and what is cut stays for the next read', () => {
  const first = Sse.parse(
    'id: 7\ndata: {"seq":7}\n\n: keepalive\n\nevent: live\ndata: {"a":1}\n\nid: 8\ndata: {"se',
  )
  assert.deepEqual(first.messages, [
    { data: '{"seq":7}', id: '7' },
    { data: '{"a":1}', event: 'live' },
  ])
  assert.equal(first.rest, 'id: 8\ndata: {"se')
  const second = Sse.parse(first.rest + 'q":8}\n\n')
  assert.deepEqual(second.messages, [{ data: '{"seq":8}', id: '8' }])
  assert.equal(second.rest, '')
  assert.deepEqual(Sse.parse('data: one\ndata: two\n\n').messages, [{ data: 'one\ntwo' }])
})
