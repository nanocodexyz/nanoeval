import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Baseline from '../src/Baseline.ts'

const luna = { id: 'luna', model: 'gpt-6-luna', provider: 'codex' as const }
const pins = { hand: 'nanocode-cli-1234567', harness: 'nanocode-ts build-abcdef0' }
const wanted: Baseline.Wanted = {
  agents: [luna],
  eval: { name: 'bench', version: '0123456789abcdef' },
  not: ['run-new'],
  pins,
  tasks: ['bench/one', 'bench/two'],
}

function candidate(id: string, changed: Partial<Baseline.Candidate> = {}): Baseline.Candidate {
  return {
    agents: [luna, { id: 'sol', model: 'gpt-6.1-sol', provider: 'codex', thinking: 'high' }],
    cancelled: false,
    eval: wanted.eval,
    id,
    nanocode: { hands: [pins.hand], harness: pins.harness },
    rerun: false,
    state: 'finished',
    tasks: ['bench/one', 'bench/three', 'bench/two'],
    ...changed,
  }
}

test('a baseline by rule is a finished run on the pinned builds that holds the tasks and the agents', () => {
  assert.equal(Baseline.misfit(candidate('a'), wanted), undefined)
  assert.equal(
    Baseline.misfit(candidate('a', { tasks: ['bench/two', 'bench/one'], agents: [luna] }), wanted),
    undefined,
  )
  const reason = (changed: Partial<Baseline.Candidate>) =>
    Baseline.misfit(candidate('a', changed), wanted)
  assert.equal(reason({ id: 'run-new' }), 'one of the runs it would be set against')
  assert.equal(reason({ state: 'running' }), 'not finished')
  assert.equal(reason({ cancelled: true }), 'cancelled')
  assert.equal(reason({ rerun: true }), 'a rerun')
  assert.equal(
    reason({ eval: { name: 'bench', version: 'fedcba9876543210' } }),
    'of another eval version',
  )
  assert.equal(
    reason({ eval: { name: 'other', version: wanted.eval.version } }),
    'of another eval version',
  )
  assert.equal(
    reason({
      nanocode: {
        hands: [pins.hand],
        harness: 'nanocode-ts 0123456789ab on nanocode fedcba987654',
      },
    }),
    'on other builds',
  )
  assert.equal(
    reason({ nanocode: { hands: ['nanocode 0123456789ab'], harness: pins.harness } }),
    'on other builds',
  )
  assert.equal(
    reason({ nanocode: { hands: [pins.hand, 'sha256 0123456789ab'], harness: pins.harness } }),
    'on other builds',
  )
  assert.equal(reason({ nanocode: { hands: [], harness: null } }), 'on other builds')
  assert.equal(reason({ agents: [{ ...luna, id: 'moon' }] }), 'without these agents')
  assert.equal(reason({ agents: [{ ...luna, model: 'gpt-6-sol' }] }), 'without these agents')
  assert.equal(reason({ agents: [{ ...luna, thinking: 'high' }] }), 'without these agents')
  assert.equal(reason({ agents: [{ ...luna, orchestration: 'direct' }] }), 'without these agents')
  assert.equal(reason({ tasks: ['bench/one'] }), 'without these tasks')
})

test('the latest run that fits is taken, and a search that finds none says what it read', async () => {
  const runs = [
    candidate('run-new'),
    candidate('r5', { state: 'running' }),
    candidate('r4', { rerun: true }),
    candidate('r3', { nanocode: { hands: ['nanocode 0123456789ab'], harness: pins.harness } }),
    candidate('r2'),
    candidate('r1'),
  ]
  const read: string[] = []
  const input = {
    ids: runs.map((run) => run.id),
    read: async (id: string) => {
      read.push(id)
      return runs.find((run) => run.id === id)!
    },
  }
  assert.equal((await Baseline.latest(wanted, input)).id, 'r2')
  assert.deepEqual(read, ['run-new', 'r5', 'r4', 'r3', 'r2'])
  await assert.rejects(Baseline.latest({ ...wanted, tasks: ['bench/nine'] }, input), {
    message:
      'no finished run of bench@0123456789ab on nanocode-ts build-abcdef0, hand nanocode-cli-1234567 holds this task with luna: of the runs listed, 1 a rerun, 1 not finished, 1 on other builds, 1 one of the runs it would be set against, 2 without these tasks. Make one on the pinned builds, or name a baseline by its id',
    name: 'Baseline.MissingError',
  })
  await assert.rejects(
    Baseline.latest(wanted, { ids: [], read: input.read }),
    /: no run is listed\. /,
  )
})
