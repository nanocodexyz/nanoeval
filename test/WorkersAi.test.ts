import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Proxy from '../src/Proxy.ts'

const chat = 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions'

test('a Workers AI request keeps its address, or goes through the AI Gateway that is named', () => {
  assert.equal(Proxy.workersAi(chat), chat)
  assert.equal(
    Proxy.workersAi(chat, 'https://gateway.ai.cloudflare.com/v1/abc/nanoeval/workers-ai/'),
    'https://gateway.ai.cloudflare.com/v1/abc/nanoeval/workers-ai/v1/chat/completions',
  )
  assert.equal(Proxy.workersAi('https://api.openai.com/v1/chat/completions'), undefined)
  assert.equal(
    Proxy.workersAi('https://api.cloudflare.com/client/v4/accounts/abc/ai/run/x'),
    undefined,
  )
})

test('the meter of a Workers AI request leaves out the cost it reports', () => {
  const line =
    'data: ' +
    JSON.stringify({
      choices: [],
      usage: {
        completion_tokens: 7,
        cost: 0.5,
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }) +
    '\n'
  const reported = Proxy.meter('codex')
  reported.push(line)
  assert.equal(reported.usage()?.costUsd, 0.5)
  const priced = Proxy.meter('codex', { cost: false })
  priced.push(line)
  assert.deepEqual(priced.usage(), {
    cacheWriteTokens: 0,
    cachedTokens: 80,
    inputTokens: 100,
    outputTokens: 7,
  })
})
