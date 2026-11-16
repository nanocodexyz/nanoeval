import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'omit-media',
  sandbox: {
    backend: 'krun',
    max: 1,
    network: 'private',
    pollMs: 250,
    provider: 'local',
    slots: 2,
    timeoutSec: 3600,
  },
}

const media = 'nano-haiku-media=claude:claude-haiku-5-5:medium:omit_media_on_empty_cut=on'

test('an agent names omit_media_on_empty_cut last in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(media), {
    id: 'nano-haiku-media',
    model: 'claude-haiku-5-5',
    omitMediaOnEmptyCut: true,
    provider: 'claude',
    thinking: 'medium',
  })
  for (const text of [
    media,
    'a=claude:claude-sonnet-5-5:clearing_cache_floors=on:omit_media_on_empty_cut=on',
    'b=claude-direct:claude-haiku-5-5:high:finish_retries=2:omit_media_on_empty_cut=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-haiku-5-5:omit_media_on_empty_cut=',
    'x=claude:claude-haiku-5-5:omit_media_on_empty_cut=off',
    'x=claude:claude-haiku-5-5:omit_media_on_empty_cut=on:clearing_cache_floors=on',
  ])
    assert.throws(() => parseAgent(text), /not x=/)
})

test('the configuration takes omitMediaOnEmptyCut for a claude agent only', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [parseAgent('plain=claude:claude-haiku-5-5:medium'), parseAgent(media)],
    }).agents.map((agent) => [agent.id, agent.omitMediaOnEmptyCut]),
    [
      ['plain', undefined],
      ['nano-haiku-media', true],
    ],
  )
  assert.equal(Config.finishLevers.includes('omitMediaOnEmptyCut'), true)
  assert.equal(Config.agentKeys.includes('omitMediaOnEmptyCut'), true)
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', omitMediaOnEmptyCut: 'on', provider: 'claude' }],
      }),
    /x has a omitMediaOnEmptyCut that is not true/,
  )
})
