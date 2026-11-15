import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summary } from '../cli/nanoeval.ts'
import * as Arms from '../src/Arms.ts'
import * as Fallback from '../src/Fallback.ts'
import type * as Result from '../src/Result.ts'
import * as Retry from '../src/Retry.ts'

const said = 'claude-code exited with 1: API Error: 400 ' + Fallback.refusal('claude-haiku-4-5')

test('a run serves an installed agent the models a session falls back to from its model, and no other', () => {
  const served = (model: string) => Fallback.served({ model, provider: 'claude' })
  assert.deepEqual(served('claude-opus-5-5'), [
    'claude-opus-5-5',
    'claude-opus-4-8',
    'claude-opus-5',
  ])
  assert.deepEqual(served('claude-opus-5'), ['claude-opus-5', 'claude-opus-4-8'])
  assert.deepEqual(served('claude-opus-4-8'), ['claude-opus-4-8', 'claude-opus-5'])
  assert.deepEqual(served('claude-sonnet-5-5'), [
    'claude-sonnet-5-5',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-5',
  ])
  assert.deepEqual(served('claude-haiku-4-5'), [
    'claude-haiku-4-5',
    'claude-opus-4-8',
    'claude-opus-5',
  ])
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']) {
    assert.equal(served(model).includes('claude-opus-4-6'), false)
    assert.equal(served(model).includes(undefined as unknown as string), false)
  }
  assert.deepEqual(Fallback.served({ model: 'gpt-5.6-sol', provider: 'codex' }), ['gpt-5.6-sol'])
  assert.deepEqual(Fallback.models({ model: 'claude-opus-5-5', provider: 'codex' }), [])
})

test('an agent that ends on a model the run refused is an error of the run, and one that went on is not', () => {
  const failure = { at: 7, kind: 'agent' as const, message: said }
  assert.deepEqual(Retry.unserved({ failure, requests: [{}, {}, { refusal: 'model' }] }), {
    at: 7,
    kind: 'environment',
    message: Retry.unservedPrefix + ': ' + said,
  })
  assert.equal(Retry.unserved({ failure, requests: [{ refusal: 'model' }, {}] }), undefined)
  assert.equal(Retry.unserved({ failure, requests: [] }), undefined)
  assert.equal(
    Retry.unserved({
      failure: { at: 7, kind: 'agent_timeout', message: 'the agent ran out of time' },
      requests: [{ refusal: 'model' }],
    }),
    undefined,
  )
  const ended = Retry.unserved({ failure, requests: [{ refusal: 'model' }] })!
  assert.equal(
    Retry.infrastructure({ failure: ended, statuses: [200, 400] }),
    undefined,
    'the same request would be refused again, so the attempt is not retried',
  )
  assert.equal(Retry.modelRefused(ended), true)
  assert.equal(Retry.modelRefused(failure), true, 'an attempt recorded before the run said so')
  assert.equal(Retry.modelRefused({ kind: 'agent', message: 'claude-code exited with 1' }), false)
  assert.equal(Retry.modelRefused({ kind: 'verifier', message: said }), false)
  assert.equal(
    Retry.modelRefused({ kind: 'environment', message: 'the slot ran out of disk' }),
    false,
  )
})

const row = (
  index: number,
  failure?: Pick<Result.Failure, 'kind' | 'message'>,
): Result.Attempt => ({
  agent: { id: 'cc', model: 'claude-opus-5-5', provider: 'claude-code' },
  ...(failure ? { failure: { at: 1, ...failure } } : {}),
  finishedAt: 2000,
  id: 'a' + index,
  index,
  outcome: failure ? 'errored' : 'passed',
  reward: failure ? null : 1,
  sandbox: null,
  session: 's',
  startedAt: 1000,
  task: { checksum: 'sha256:a', name: 'suite/a' },
  timing: {},
  usage: null,
})

test('arms and status name the attempts that a refused model ended, as infrastructure errors', () => {
  const attempts = [
    row(1),
    row(2, { kind: 'agent', message: said }),
    row(3, { kind: 'environment', message: Retry.unservedPrefix + ': ' + said }),
    row(4, { kind: 'agent', message: 'claude-code exited with 1' }),
  ]
  const [arm] = Arms.arms([
    {
      attempts,
      eval: { name: 'suite', version: 'a'.repeat(64) },
      id: 'one',
      name: 'run-one',
      state: 'finished',
    },
  ])
  assert.deepEqual(arm!.errors, {
    agent: { agent: 1 },
    cancelled: {},
    infrastructure: { [Arms.unserved]: 2 },
  })
  assert.match(
    Arms.line(arm!),
    /errors: infrastructure 2 or 50\.0% of its rows \(model not served 2\), agent or model 1 \(agent 1\)$/,
  )
  const text = summary({
    agents: {},
    attempts: attempts.map((attempt) => ({
      agent: attempt.agent.id,
      claims: 1,
      failure: attempt.failure,
      id: attempt.id,
      n: attempt.index,
      outcome: attempt.outcome,
      task: attempt.task.name,
    })),
    counts: { active: 0, errored: 3, failed: 0, passed: 1, total: 4, unclaimed: 0 },
    createdAt: 0,
    id: 'run-1',
    name: 'example',
    spend: { modelUsd: 0, sandboxUsd: 0 },
    state: 'finished',
  })
  assert.equal(
    text.split('\n').find((entry) => entry.startsWith(Arms.unserved)),
    'model not served: 2 attempts of cc errored because the run refused a model that the agent asked for, an infrastructure error and no failure of the agent',
  )
  assert.equal(
    summary({
      agents: {},
      attempts: [],
      counts: { active: 0, errored: 0, failed: 0, passed: 0, total: 0, unclaimed: 0 },
      createdAt: 0,
      id: 'run-1',
      name: 'example',
      spend: { modelUsd: 0, sandboxUsd: 0 },
      state: 'finished',
    }).includes(Arms.unserved),
    false,
  )
})
