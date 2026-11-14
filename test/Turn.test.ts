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

test('a claude session keeps the web search and subagents of its app, as Claude Code has WebSearch and Task', () => {
  const body = Turn.body({ ...turn, model: 'claude-opus-5-5', provider: 'claude' })
  assert.equal('subagents' in body, false)
  assert.equal('web_search' in body, false)
  assert.equal(body['provider'], 'claude')
})
