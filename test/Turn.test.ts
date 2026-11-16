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

test('a session sends the refusal fallback scope of its agent, and nothing without one', () => {
  const claude = { ...turn, model: 'claude-opus-5-5', provider: 'claude' as const }
  assert.equal('refusal_fallback' in Turn.body(claude), false)
  assert.equal(
    Turn.body({ ...claude, refusalFallback: 'return_once' })['refusal_fallback'],
    'return_once',
  )
  assert.equal(Turn.body({ ...claude, refusalFallback: 'session' })['refusal_fallback'], 'session')
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  assert.equal('refusal_fallback' in JSON.parse(Turn.sent(claude, input)), false)
  assert.equal(
    JSON.parse(Turn.sent({ ...claude, refusalFallback: 'return_once' }, input)).refusal_fallback,
    'return_once',
  )
  assert.equal(
    JSON.parse(Turn.sent({ ...claude, refusalFallback: 'session' }, input)).refusal_fallback,
    'session',
  )
})

test('the record of a turn names the cell yield time of its agent, and the turn itself carries none', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const provider of ['claude', 'codex'] as const) {
    const plain = { ...turn, provider }
    assert.equal('cell_yield_ms' in JSON.parse(Turn.sent(plain, input)), false)
    assert.equal(
      JSON.parse(Turn.sent({ ...plain, cellYieldMs: 120_000 }, input)).cell_yield_ms,
      120_000,
    )
    assert.deepEqual(Turn.body({ ...plain, cellYieldMs: 120_000 }), Turn.body(plain))
  }
})

test('a claude session keeps the web search and subagents of its app, as Claude Code has WebSearch and Task', () => {
  const body = Turn.body({ ...turn, model: 'claude-opus-5-5', provider: 'claude' })
  assert.equal('subagents' in body, false)
  assert.equal('web_search' in body, false)
  assert.equal(body['provider'], 'claude')
})

test('a session of a closed task is sent no web search of its provider, and a session of an open task is sent what it was', () => {
  const claude = { ...turn, model: 'claude-opus-5-5', provider: 'claude' as const }
  const open =
    '{"hand":"slot","model":"claude-opus-5-5","payer":"plan","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"high"}'
  assert.equal(JSON.stringify(Turn.body(claude)), open)
  assert.equal(
    JSON.stringify(Turn.body({ ...claude, webSearch: false })),
    open.slice(0, -1) + ',"web_search":false}',
  )
  const codex =
    '{"hand":"slot","model":"gpt-6-luna","payer":"plan","prompt":"Write the greeting.","provider":"codex","request_id":"turn-1","subagents":false,"thinking":"high","web_search":false}'
  assert.equal(JSON.stringify(Turn.body(turn)), codex)
  assert.equal(JSON.stringify(Turn.body({ ...turn, webSearch: false })), codex)
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const session of [claude, turn]) {
    assert.equal('web_search' in JSON.parse(Turn.sent(session, input)), false)
    assert.equal(JSON.parse(Turn.sent({ ...session, webSearch: false }, input)).web_search, false)
  }
})
