import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rerunSelection } from '../cli/nanoeval.ts'

test('a rerun takes the attempts that failed, that errored, or both', () => {
  const none = { errored: false, failed: false, oracle: false }
  assert.equal(rerunSelection(none), 'unpassed')
  assert.equal(rerunSelection({ ...none, failed: true }), 'failed')
  assert.equal(rerunSelection({ ...none, errored: true }), 'errored')
  assert.equal(rerunSelection({ errored: true, failed: true, oracle: false }), 'unpassed')
})

test('a rerun refuses the options it would not follow', () => {
  const none = { errored: false, failed: false, oracle: false }
  assert.throws(() => rerunSelection({ ...none, attempts: '5' }), /leave out --attempts,/)
  assert.throws(
    () => rerunSelection({ ...none, eval: 'other', limit: '1' }),
    /leave out --eval and --limit, and narrow it with --failed, --errored, --only or --agent$/,
  )
  assert.throws(() => rerunSelection({ ...none, oracle: true }), /leave out --oracle,/)
  assert.throws(() => rerunSelection({ ...none, task: ['tasks/one'] }), /leave out --task,/)
  assert.equal(rerunSelection({ ...none, task: [] }), 'unpassed')
})
