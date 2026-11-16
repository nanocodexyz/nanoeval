import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Sql from '../src/Sql.ts'
import { Tally } from '../src/Tally.ts'
import * as Rows from './Rows.ts'

const table =
  'CREATE TABLE model_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt TEXT NOT NULL, claim INTEGER NOT NULL, at INTEGER NOT NULL, path TEXT NOT NULL, usage TEXT, cost REAL, tools_usd REAL)'

const insert = (sql: Sql.Sql, attempt: string, cost: number | null, tools: number | null) =>
  sql.run(
    'INSERT INTO model_requests (attempt, claim, at, path, usage, cost, tools_usd) VALUES (?, 1, 0, ?, ?, ?, ?)',
    attempt,
    'messages',
    cost === null && tools === null ? null : '{}',
    cost,
    tools,
  )

const scanned = (sql: Sql.Sql) => {
  const all = sql.all(
    'SELECT attempt, SUM(COALESCE(cost, tools_usd, 0)) AS usd, COUNT(cost) AS priced FROM model_requests GROUP BY attempt',
  )
  const largest = sql.all(
    'SELECT COUNT(*) AS responses, MAX(COALESCE(cost, tools_usd, 0)) AS usd FROM model_requests WHERE usage IS NOT NULL',
  )[0]!
  return {
    largestUsd: largest['responses'] ? (largest['usd'] as number) : undefined,
    priced: all.filter((row) => row['priced']).map((row) => row['attempt'] as string),
    usd: all.reduce((sum, row) => sum + (row['usd'] as number), 0),
  }
}

test('a tally reads what a scan of every model request reads, a new request at a time', () => {
  const sql = Rows.database()
  Sql.setup(sql, [table])
  const tally = new Tally(sql)
  const read = () => {
    const now = tally.read()
    return {
      largestUsd: now.largestUsd,
      priced: ['a', 'b', 'c'].filter((attempt) => now.priced(attempt)),
      usd: now.usd,
    }
  }
  assert.deepEqual(read(), { largestUsd: undefined, priced: [], usd: 0 })
  insert(sql, 'a', null, null)
  assert.deepEqual(read(), scanned(sql))
  insert(sql, 'a', 0.25, null)
  insert(sql, 'b', null, 0.5)
  assert.deepEqual(read(), scanned(sql))
  insert(sql, 'c', 0.125, 0.75)
  insert(sql, 'b', null, null)
  assert.deepEqual(read(), scanned(sql))
  assert.deepEqual(read(), { largestUsd: 0.5, priced: ['a', 'c'], usd: 0.875 })
})

test('a tally reads only the model requests recorded since its last read', () => {
  const inner = Rows.database()
  Sql.setup(inner, [table])
  let rows = 0
  const sql: Sql.Sql = {
    ...inner,
    all: (query, ...bindings) => {
      const read = inner.all(query, ...bindings)
      rows += read.length
      return read
    },
  }
  const tally = new Tally(sql)
  for (let i = 0; i < 1000; i++) insert(inner, 'row-' + (i % 50), 0.001, null)
  assert.equal(tally.read().usd.toFixed(6), '1.000000')
  assert.equal(rows, 1000)
  for (let i = 0; i < 100; i++) {
    insert(inner, 'row-' + i, 0.001, null)
    tally.read()
  }
  assert.equal(rows, 1100, 'each request is read once, not once for every read after it')
  assert.equal(tally.read().usd.toFixed(6), '1.100000')
})
