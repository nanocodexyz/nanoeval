import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Baseline from '../src/Baseline.ts'
import * as Compare from '../src/Compare.ts'
import type * as Config from '../src/Config.ts'
import type * as Route from '../src/Route.ts'

const luna = { id: 'luna', model: 'gpt-6-luna', provider: 'codex' as const }
const sol = { id: 'sol', model: 'gpt-6.1-sol', provider: 'codex' as const, thinking: 'high' }
const pins = { hand: 'nanocode-cli-1234567', harness: 'nanocode-ts build-abcdef0' }
const gateway: Route.Route = {
  effort: 'medium',
  host: 'api.openai.com',
  payer: 'gateway',
  transport: 'responses_https_sse',
}
const login: Route.Route = {
  effort: 'medium',
  host: 'chatgpt.com',
  payer: 'login',
  through: 'relay',
  transport: 'responses_websocket_v2',
}
const members = (agents: readonly Config.Agent[], routes: readonly Route.Route[] = []) =>
  Compare.planned(agents, { routes: () => routes, run: 'a' })
const wanted: Baseline.Wanted = {
  eval: { name: 'bench' },
  members: Compare.planned([luna], { routes: () => [] }),
  not: ['run-new'],
  rule: { kind: 'latest', pins },
  tasks: { 'bench/one': 'd1', 'bench/two': 'd2' },
}

function candidate(id: string, changed: Partial<Baseline.Candidate> = {}): Baseline.Candidate {
  return {
    cancelled: false,
    eval: { name: 'bench', version: '0123456789abcdef' },
    id,
    members: members([luna, sol]),
    nanocode: { hands: [pins.hand], harness: pins.harness },
    rerun: false,
    state: 'finished',
    tasks: { 'bench/one': 'd1', 'bench/three': 'd3', 'bench/two': 'd2' },
    ...changed,
  }
}

test('a baseline by rule is a finished run on the pinned builds that holds the tasks and the agents', () => {
  assert.equal(Baseline.misfit(candidate('a'), wanted), undefined)
  assert.equal(
    Baseline.misfit(
      candidate('a', {
        members: members([luna]),
        tasks: { 'bench/two': 'd2', 'bench/one': 'd1' },
      }),
      wanted,
    ),
    undefined,
  )
  const reason = (changed: Partial<Baseline.Candidate>) =>
    Baseline.misfit(candidate('a', changed), wanted)
  assert.equal(reason({ id: 'run-new' }), 'one of the runs it would be set against')
  assert.equal(reason({ state: 'running' }), 'not finished')
  assert.equal(reason({ cancelled: true }), 'cancelled')
  assert.equal(reason({ rerun: true }), 'a rerun')
  assert.equal(reason({ eval: { name: 'other', version: '0123456789abcdef' } }), 'of another eval')
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
  assert.equal(
    reason({ members: members([{ ...luna, model: 'gpt-6-sol' }]) }),
    'without these agents',
  )
  assert.equal(
    reason({ members: members([{ ...luna, orchestration: 'direct' }]) }),
    'without these agents',
  )
  assert.equal(reason({ members: members([sol]) }), 'without these agents')
  assert.equal(reason({ tasks: { 'bench/one': 'd1' } }), 'without these tasks')
})

test('a run of another version of the eval is a baseline when it holds the same tasks, by their digests', () => {
  const reason = (changed: Partial<Baseline.Candidate>) =>
    Baseline.misfit(candidate('a', changed), wanted)
  assert.equal(reason({ eval: { name: 'bench', version: 'fedcba9876543210' } }), undefined)
  assert.equal(
    reason({
      eval: { name: 'bench', version: 'fedcba9876543210' },
      tasks: { 'bench/one': 'd1', 'bench/two': 'another' },
    }),
    'with another version of these tasks',
  )
})

test('a baseline named by a revision or as the run before is on any builds and holds at least one of the tasks', () => {
  const master = { hands: ['nanocode 0123456789ab'], harness: 'nanocode-ts aa on nanocode bb' }
  const before: Baseline.Wanted = { ...wanted, rule: { kind: 'previous' } }
  const revision: Baseline.Wanted = {
    ...wanted,
    rule: { hand: 'nanocode 0123456789ab', kind: 'revision' },
  }
  assert.equal(Baseline.misfit(candidate('a', { nanocode: master }), before), undefined)
  assert.equal(Baseline.misfit(candidate('a'), before), undefined)
  assert.equal(Baseline.misfit(candidate('a', { nanocode: master }), revision), undefined)
  assert.equal(Baseline.misfit(candidate('a'), revision), 'on other builds')
  assert.equal(Baseline.misfit(candidate('a', { tasks: { 'bench/one': 'd1' } }), before), undefined)
  assert.deepEqual(Baseline.shared(candidate('a', { tasks: { 'bench/one': 'd1' } }), before), [
    'bench/one',
  ])
  assert.equal(
    Baseline.misfit(candidate('a', { tasks: { 'bench/nine': 'd9' } }), before),
    'without a task of these',
  )
  assert.equal(
    Baseline.misfit(candidate('a', { tasks: { 'bench/one': 'another' } }), before),
    'with another version of these tasks',
  )
  assert.equal(Baseline.misfit(candidate('a', { rerun: true }), before), 'a rerun')
  assert.equal(
    Baseline.misfit(candidate('a', { members: members([luna], [gateway]) }), {
      ...before,
      members: Compare.planned([luna], { routes: () => [login] }),
    }),
    'on another model route',
  )
  assert.equal(
    Baseline.said(before, candidate('a', { nanocode: master, tasks: { 'bench/one': 'd1' } })),
    'the run before this one, the latest finished run of bench on nanocode-ts aa on nanocode bb, hand nanocode 0123456789ab that holds 1 of these 2 tasks with luna',
  )
  assert.equal(
    Baseline.said(wanted, candidate('a')),
    'the latest finished run of bench on nanocode-ts build-abcdef0, hand nanocode-cli-1234567 that holds these tasks with luna',
  )
})

test('a baseline is named by an id, by a rule or by a revision', () => {
  assert.equal(Baseline.named('latest'), 'latest')
  assert.equal(Baseline.named('previous'), 'previous')
  assert.equal(Baseline.named('01234567-89ab-4cde-8f01-23456789abcd'), 'id')
  assert.equal(Baseline.named('pinned'), 'revision')
  assert.equal(Baseline.named('0a9ed13f2337'), 'revision')
  assert.equal(Baseline.named('master'), 'revision')
})

test('a baseline by rule holds the agent by what it is, whatever it was named', () => {
  const reason = (agents: readonly Config.Agent[], asked: Baseline.Wanted = wanted) =>
    Baseline.misfit(candidate('a', { members: members(agents) }), asked)
  assert.equal(reason([{ ...luna, id: 'nano-codex' }]), undefined)
  assert.equal(reason([{ ...luna, id: 'nano-codex', thinking: 'high' }]), 'without these agents')
  assert.equal(
    reason([
      { ...luna, id: 'one' },
      { ...luna, id: 'other' },
    ]),
    'without these agents',
    'two agents of the run are what is asked for, and neither has its name',
  )
  assert.equal(reason([{ ...luna, id: 'one' }, luna]), undefined)
  const high = {
    ...wanted,
    members: Compare.planned([{ ...luna, thinking: 'high' }], { routes: () => [] }),
  }
  assert.equal(reason([{ ...luna, id: 'nano-codex', thinking: 'high' }], high), undefined)
  assert.equal(reason([{ ...luna, thinking: 'low' }], high), 'without these agents')
  assert.equal(
    Baseline.misfit(candidate('a', { members: members([luna], [gateway]) }), high),
    'without these agents',
    'the session of the run reported another effort than the one asked for',
  )
})

test('a baseline by rule was paid for and reached as the run it is set against', () => {
  const paid = (routes: readonly Route.Route[]) => ({
    ...wanted,
    members: Compare.planned([luna], { routes: () => routes }),
  })
  const reason = (routes: readonly Route.Route[], asked: Baseline.Wanted) =>
    Baseline.misfit(
      candidate('a', { members: members([{ ...luna, id: 'nano-codex' }], routes) }),
      asked,
    )
  assert.equal(reason([gateway], paid([gateway])), undefined)
  assert.equal(reason([gateway], paid([{ payer: 'gateway' }])), undefined)
  assert.equal(reason([gateway], paid([login])), 'on another model route')
  assert.equal(
    reason([gateway], paid([{ payer: 'login', through: 'relay' }])),
    'on another model route',
  )
  assert.equal(reason([login], paid([{ payer: 'login' }])), 'on another model route')
  assert.equal(
    reason([{ ...gateway, transport: 'responses_websocket_v2' }], paid([gateway])),
    undefined,
    'a transport is what the harness of a run reported, and the comparison says that it differs',
  )
  assert.equal(reason([gateway, login], paid([login])), 'on another model route')
  assert.equal(reason([], paid([login])), 'without a record of who paid for their models')
  assert.equal(reason([gateway], wanted), undefined)
  assert.equal(reason([], wanted), undefined)
  const oracle = { id: 'oracle', model: 'solution', provider: 'oracle' as const }
  assert.equal(
    Baseline.misfit(candidate('a', { members: members([oracle]) }), {
      ...wanted,
      members: Compare.planned([oracle], { routes: () => [] }),
    }),
    undefined,
  )
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
  assert.equal((await Baseline.find(wanted, input)).id, 'r2')
  assert.deepEqual(read, ['run-new', 'r5', 'r4', 'r3', 'r2'])
  assert.equal((await Baseline.find({ ...wanted, rule: { kind: 'previous' } }, input)).id, 'r3')
  await assert.rejects(
    Baseline.find({ ...wanted, rule: { hand: 'nanocode ffffffffffff', kind: 'revision' } }, input),
    {
      message:
        'no finished run of bench on the hand nanocode ffffffffffff holds one of these 2 tasks with luna: of the runs listed, 1 a rerun, 1 not finished, 3 on other builds, 1 one of the runs it would be set against. Name a baseline by its id',
      name: 'Baseline.MissingError',
    },
  )
  await assert.rejects(Baseline.find({ ...wanted, tasks: { 'bench/nine': 'd9' } }, input), {
    message:
      'no finished run of bench on nanocode-ts build-abcdef0, hand nanocode-cli-1234567 holds this task with luna: of the runs listed, 1 a rerun, 1 not finished, 1 on other builds, 1 one of the runs it would be set against, 2 without these tasks. Make one on the pinned builds, or name a baseline by its id',
    name: 'Baseline.MissingError',
  })
  await assert.rejects(
    Baseline.find(wanted, { ids: [], read: input.read }),
    /: no run is listed\. /,
  )
})
