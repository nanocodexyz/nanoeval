import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as Claim from '../src/Claim.ts'

const requestId = 'attempt'
const session = 'run-a00001-2'
const timing = JSON.stringify({ agentExecution: { finishedAt: 20, startedAt: 10 } })
const row = { claim: 'token-2', failure: null, session, timing }
const sent = (name: string) => JSON.stringify({ request_id: requestId, session: name }) + '\n'
const completed = { message: 'done', state: 'completed' as const, verdict: 'pass' as const }

test('a graded result is of an agent that the claim of its row started', () => {
  assert.equal(
    Claim.unowned({
      row,
      session: {
        branches: 1,
        record: undefined,
        requestId,
        turn: { status: 'completed' },
        turns: sent(session),
      },
    }),
    undefined,
  )
  assert.equal(Claim.unowned({ row }), undefined, 'an installed agent has no session to compare')
  assert.equal(
    Claim.unowned({ row: { ...row, claim: null, session: null } }),
    'no claim holds its row',
  )
  assert.equal(
    Claim.unowned({ row: { ...row, timing: '{}' } }),
    'its claim started no agent execution',
  )
  assert.equal(
    Claim.unowned({
      row,
      session: { branches: 1, record: undefined, requestId, turn: undefined, turns: undefined },
    }),
    'its claim sent no turn to the session ' + session,
  )
  assert.equal(
    Claim.unowned({
      row,
      session: {
        branches: 1,
        record: undefined,
        requestId,
        turn: { status: 'completed' },
        turns: sent('run-a00001-1') + sent(session),
      },
    }),
    'its row keeps a turn of the session run-a00001-1 of another claim',
  )
  assert.equal(
    Claim.unowned({
      row,
      session: {
        branches: 1,
        record: undefined,
        requestId,
        turn: { status: 'cancelled' },
        turns: sent(session),
      },
    }),
    'the verifier graded its sandbox, and the turn of the session ' + session + ' is cancelled',
  )
})

test('a graded result of a branched row is of branches that its claim decided', () => {
  const turns = sent(session) + sent(session + '-verifier-0')
  const record = {
    branches: [completed, { error: 'the turn ended as cancelled', state: 'failed' as const }],
    chosen: 0,
  }

  assert.equal(
    Claim.unowned({
      row,
      session: {
        branches: 2,
        record: { ...record, session },
        requestId,
        turn: { status: 'completed' },
        turns,
      },
    }),
    undefined,
  )
  assert.equal(
    Claim.unowned({
      row,
      session: {
        branches: 2,
        record: { ...record, session: 'run-a00001-1' },
        requestId,
        turn: { status: 'running' },
        turns,
      },
    }),
    'its branches were decided for the session run-a00001-1 of another claim',
    'the record that a request of an earlier claim wrote is no decision of this claim',
  )
  assert.equal(
    Claim.unowned({
      row,
      session: { branches: 2, record: undefined, requestId, turn: { status: 'completed' }, turns },
    }),
    'its claim decided no branch',
  )
  assert.equal(
    Claim.unowned({
      row,
      session: {
        branches: 2,
        record: { ...record, session },
        requestId,
        turn: { status: 'running' },
        turns,
      },
    }),
    'the verifier graded its sandbox, and the turn of the session ' + session + ' is running',
  )
  assert.equal(
    Claim.unowned({
      row: { ...row, failure: '{"at":1,"kind":"agent_timeout","message":"late"}' },
      session: {
        branches: 2,
        record: { ...record, session },
        requestId,
        turn: { status: 'cancelled' },
        turns,
      },
    }),
    undefined,
    'a row whose agent ran out of time is graded with the turn that the run cancelled',
  )
})
