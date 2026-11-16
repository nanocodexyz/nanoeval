import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Installed from '../src/Installed.ts'
import * as Turn from '../src/Turn.ts'

const base: Turn.Turn = { model: '@cf/zai-org/glm-5.3-flash', prompt: 'p', provider: 'codex', requestId: 'r' }

test('a codex turn sends its output cap to the session as max_output_tokens', () => {
  const capped = Turn.body({ ...base, maxOutputTokens: Installed.leaderboard.replyLimit })
  assert.equal(capped.max_output_tokens, Installed.leaderboard.replyLimit)
  const { max_output_tokens: _, ...rest } = capped
  assert.deepEqual(rest, Turn.body(base))
  assert.equal('max_output_tokens' in Turn.body(base), false)
})

test('a claude turn sends no codex output cap', () => {
  const claude = Turn.body({ ...base, maxOutputTokens: 1000, provider: 'claude' })
  assert.equal('max_output_tokens' in claude, false)
})
