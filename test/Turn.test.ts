import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Turn from '../src/Turn.ts'

const turn: Turn.Turn = {
  hand: 'slot',
  model: 'gpt-6-luna',
  payer: 'plan',
  prompt: 'Write the greeting.',
  provider: 'codex',
  requestId: 'turn-1',
  thinking: 'high',
}

test('a codex session is created without web search and without subagents, as codex-cli runs', () => {
  assert.deepEqual(Turn.body(turn), {
    hand: 'slot',
    model: 'gpt-6-luna',
    payer: 'plan',
    prompt: 'Write the greeting.',
    provider: 'codex',
    request_id: 'turn-1',
    subagents: false,
    thinking: 'high',
    web_search: false,
  })
  assert.deepEqual(Turn.body({ ...turn, orchestration: 'direct' }), {
    codex_orchestration: 'direct',
    hand: 'slot',
    model: 'gpt-6-luna',
    payer: 'plan',
    prompt: 'Write the greeting.',
    provider: 'codex',
    request_id: 'turn-1',
    subagents: false,
    thinking: 'high',
    web_search: false,
  })
})

test('a turn carries the agent deadline as host policy, in milliseconds', () => {
  assert.deepEqual(
    Turn.body({ ...turn, deadline: { atMs: 1_800_000_000_000, limitMs: 900_000 } })['deadline'],
    { at_ms: 1_800_000_000_000, limit_ms: 900_000 },
  )
  assert.equal('deadline' in Turn.body(turn), false)
})

test('a run sends the deadline of the agent unless its limits say it sends none', () => {
  const input = { limitMs: 900_000, now: 1_800_000_000_000 }
  assert.deepEqual(Turn.deadline({}, input), { atMs: 1_800_000_900_000, limitMs: 900_000 })
  assert.equal(Turn.deadline({ noDeadline: true }, input), undefined)
})

test('the record of a turn that was sent names its deadline, or says that it had none', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  assert.deepEqual(
    JSON.parse(
      Turn.sent({ ...turn, deadline: { atMs: 1_800_000_900_000, limitMs: 900_000 } }, input),
    ),
    {
      at_ms: 1_800_000_000_000,
      deadline: { at_ms: 1_800_000_900_000, limit_ms: 900_000 },
      request_id: 'turn-1',
      session: 'run-a00001',
    },
  )
  const none = Turn.sent(turn, input)
  assert.equal(JSON.parse(none).deadline, null)
  assert.equal(none.endsWith('\n') && none.indexOf('\n') === none.length - 1, true)
  assert.equal(none.includes(turn.prompt), false)
})

test('a claude-direct session asks for the claude orchestration and no codex one', () => {
  const body = Turn.body({
    ...turn,
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
  })
  assert.equal(body['claude_orchestration'], 'direct')
  assert.equal('codex_orchestration' in body, false)
  assert.equal('subagents' in body, false)
})

test('a claude session keeps the web search and subagents of its app, as Claude Code has WebSearch and Task', () => {
  const body = Turn.body({ ...turn, model: 'claude-opus-5-5', provider: 'claude' })
  assert.equal('subagents' in body, false)
  assert.equal('web_search' in body, false)
  assert.equal(body['provider'], 'claude')
})
