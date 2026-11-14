import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exitStatus, gates } from '../cli/nanoeval.ts'
import * as Compare from '../src/Compare.ts'
import type * as Result from '../src/Result.ts'

const agent = { id: 'one', model: 'm', provider: 'claude' as const }

function run(id: string, tasks: Record<string, string>): Compare.Run {
  return {
    attempts: Object.entries(tasks).flatMap(([task, outcomes]) =>
      [...outcomes].map((letter, at): Result.Attempt => {
        const outcome = letter === 'P' ? 'passed' : letter === 'F' ? 'failed' : 'errored'
        return {
          agent,
          finishedAt: 2,
          id: id + '-' + task + '-' + at,
          index: at + 1,
          outcome,
          reward: outcome === 'errored' ? null : outcome === 'passed' ? 1 : 0,
          sandbox: null,
          session: 's',
          startedAt: 1,
          task: { checksum: 'c', name: 'bench/' + task },
          timing: {},
          usage: null,
        }
      }),
    ),
    eval: { name: 'bench', version: '0123456789abcdef' },
    id,
    name: id,
    state: 'finished',
  }
}

test('the gates of --fail-on are named one by one or as a list, and another word is refused', () => {
  assert.deepEqual([...gates(undefined)], [])
  assert.deepEqual([...gates(['regression'])], ['regression'])
  assert.deepEqual(
    [...gates(['regression,any-failure', 'lost'])],
    ['regression', 'any-failure', 'lost'],
  )
  assert.throws(
    () => gates(['regresion']),
    /--fail-on takes regression, lost or any-failure, not regresion/,
  )
})

test('the exit status is the one of before without a gate, and 3, 4 and 1 in that order with one', () => {
  const broken = Compare.changes(
    run('old', { a: 'PPP', b: 'PPP', c: 'FFF' }),
    run('new', { a: 'FFF', b: 'PPP', c: 'FFF' }),
  )
  const noisy = Compare.changes(
    run('old', { a: 'PPP', b: 'PPP', c: 'PPF' }),
    run('new', { a: 'PPP', b: 'PPP', c: 'PFF' }),
  )
  const mixed = Compare.changes(
    run('old', { a: 'PPP', b: 'FFF', c: 'PPF' }),
    run('new', { a: 'FFF', b: 'PPP', c: 'PPF' }),
  )
  assert.equal(broken[0]!.overall.verdict, 'regression')
  assert.equal(noisy[0]!.overall.verdict, 'none')
  assert.equal(mixed[0]!.overall.verdict, 'none')
  const none = new Set<never>()
  const all = gates(['regression', 'any-failure'])
  const failed = { errored: 0, failed: 2 }
  const errored = { errored: 1, failed: 0 }
  const clean = { errored: 0, failed: 0 }

  assert.equal(exitStatus({ changes: broken, counts: failed, on: none, waited: true }), 0)
  assert.equal(exitStatus({ changes: broken, counts: errored, on: none, waited: true }), 1)
  assert.equal(exitStatus({ changes: broken, counts: errored, on: none, waited: false }), 0)

  const regression = gates(['regression'])
  assert.equal(exitStatus({ changes: broken, counts: failed, on: regression, waited: true }), 3)
  assert.equal(exitStatus({ changes: noisy, counts: failed, on: regression, waited: true }), 0)
  assert.equal(exitStatus({ changes: mixed, counts: failed, on: regression, waited: true }), 0)
  assert.equal(exitStatus({ changes: noisy, counts: errored, on: regression, waited: true }), 1)
  assert.equal(exitStatus({ changes: mixed, counts: failed, on: gates(['lost']), waited: true }), 3)
  assert.equal(exitStatus({ changes: noisy, counts: failed, on: gates(['lost']), waited: true }), 0)
  const any = gates(['any-failure'])
  assert.equal(exitStatus({ changes: [], counts: failed, on: any, waited: true }), 4)
  assert.equal(exitStatus({ changes: [], counts: errored, on: any, waited: false }), 4)
  assert.equal(exitStatus({ changes: [], counts: clean, on: any, waited: true }), 0)
  assert.equal(exitStatus({ changes: broken, counts: errored, on: all, waited: true }), 3)
  assert.equal(exitStatus({ changes: noisy, counts: errored, on: all, waited: true }), 4)
  assert.equal(exitStatus({ changes: noisy, counts: clean, on: all, waited: true }), 0)
})
