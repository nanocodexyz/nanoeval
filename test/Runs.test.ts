import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Runs from '../src/Runs.ts'
import * as Sql from '../src/Sql.ts'
import * as Rows from './Rows.ts'

const entry = (id: string, createdAt: number): Runs.Entry => ({
  attempts: 4,
  createdAt,
  eval: { name: 'terminal-bench-2.1', version: 'a'.repeat(64) },
  id,
  name: 'run-' + id,
})

test('the runs of a deployment are listed newest first, with their counts once they ended', () => {
  const sql = Rows.database()
  Sql.setup(sql, Runs.tables)
  Sql.setup(sql, Runs.tables)
  assert.deepEqual(Runs.list(sql), [])
  Runs.created(sql, entry('first', 1000))
  Runs.created(sql, entry('second', 2000))
  Runs.created(sql, entry('third', 3000))
  Runs.created(sql, { ...entry('first', 9000), name: 'again' })
  Runs.ended(sql, { errored: 1, failed: 0, finishedAt: 2500, id: 'second', passed: 3 })
  Runs.ended(sql, { errored: 0, failed: 0, finishedAt: 2600, id: 'unknown', passed: 0 })

  const listed = Runs.list(sql)
  assert.deepEqual(
    listed.map((run) => [run.id, run.state, run.name, run.createdAt]),
    [
      ['third', 'running', 'run-third', 3000],
      ['second', 'finished', 'run-second', 2000],
      ['first', 'running', 'run-first', 1000],
    ],
    'a run is listed once, as it was created',
  )
  assert.deepEqual(listed[1], {
    counts: { active: 0, errored: 1, failed: 0, passed: 3, total: 4, unclaimed: 0 },
    createdAt: 2000,
    eval: { name: 'terminal-bench-2.1', version: 'a'.repeat(64) },
    finishedAt: 2500,
    id: 'second',
    name: 'run-second',
    state: 'finished',
  })
  assert.equal(listed[0]!.counts, null, "the counts of a run that still runs are the run's to say")
  assert.deepEqual(
    Runs.list(sql, 2).map((run) => run.id),
    ['third', 'second'],
  )
})
