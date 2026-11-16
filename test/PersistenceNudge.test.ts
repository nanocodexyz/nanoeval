import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'
import * as Installed from '../src/Installed.ts'
import * as Turn from '../src/Turn.ts'

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'persistence-nudge',
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

const turn: Turn.Turn = {
  hand: 'slot',
  model: 'claude-opus-5-5',
  prompt: 'Write the greeting.',
  provider: 'claude',
  requestId: 'turn-1',
  thinking: 'medium',
}

const usage =
  /\[:subagents=off\]\[:clearing_cache_floors=on\]\[:verification_requested=on\]\[:persistence_nudge=on\], not x=/

const nudge = 'nano-med-nudge=claude:claude-opus-5-5:medium:persistence_nudge=on'

const retry =
  'nano-med-retry-nudge=claude:claude-opus-5-5:medium:finish_retries=1:persistence_nudge=on'

const direct =
  'nano-dn=claude-direct:claude-opus-5-5:high:brief_finish=on:yield_share=25:finish_retries=1:finish_check=on:finish_ambiguity=on:tool_result_clearing=2/10000:clearing_cache_floors=on:persistence_nudge=on'

test('an agent names persistence_nudge last in the order of the options, and its text reads back', () => {
  assert.deepEqual(parseAgent(nudge), {
    id: 'nano-med-nudge',
    model: 'claude-opus-5-5',
    persistenceNudge: true,
    provider: 'claude',
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent(retry), {
    finishRetries: 1,
    id: 'nano-med-retry-nudge',
    model: 'claude-opus-5-5',
    persistenceNudge: true,
    provider: 'claude',
    thinking: 'medium',
  })
  assert.deepEqual(parseAgent(direct), {
    briefFinish: true,
    clearingCacheFloors: true,
    finishAmbiguity: true,
    finishCheck: true,
    finishRetries: 1,
    id: 'nano-dn',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    persistenceNudge: true,
    provider: 'claude',
    thinking: 'high',
    toolResultClearing: { atLeastTokens: 10000, keep: 2 },
    yieldShare: 25,
  })
  for (const text of [
    nudge,
    retry,
    direct,
    'a=claude:claude-opus-5-5:persistence_nudge=on',
    'b=claude+preflight:claude-sonnet-5-5:low:yield_share=50:persistence_nudge=on',
    'c=claude:claude-opus-5-5:medium:finish_check=on:persistence_nudge=on',
    'd=claude:claude-opus-5-5:medium:finish_retries=2:finish_check=on:persistence_nudge=on',
    'e=claude:claude-opus-5-5:medium:skip_finish_check=on:persistence_nudge=on',
    'f=claude:claude-opus-5-5:medium:persist_finish=on:persistence_nudge=on',
    'g=claude:claude-opus-5-5:medium:fold_finish=on:subagents=off:clearing_cache_floors=on:persistence_nudge=on',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  for (const text of [
    'x=claude:claude-opus-5-5:medium:persistence_nudge=',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=1',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=true',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=off',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=ON',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=once',
    'x=claude:claude-opus-5-5:medium:persistence_nudge',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=on:finish_retries=1',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=on:finish_check=on',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=on:clearing_cache_floors=on',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=on:verification_requested=on',
    'x=claude:claude-opus-5-5:medium:persistence_nudge=on:persistence_nudge=on',
    'x=claude:claude-opus-5-5:medium:persistence_nudges=on',
    'x=claude:claude-opus-5-5:medium:persistenceNudge=on',
  ])
    assert.throws(() => parseAgent(text), usage)
})

test('the configuration takes persistenceNudge for a claude agent and refuses bad values and every other harness', () => {
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [
        parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
        parseAgent(nudge),
        parseAgent(retry),
        parseAgent(direct),
        parseAgent('nano-check=claude:claude-opus-5-5:medium:finish_check=on:persistence_nudge=on'),
        parseAgent(
          'nano-skip=claude:claude-opus-5-5:medium:skip_finish_check=on:persistence_nudge=on',
        ),
      ],
    }).agents.map((agent) => [
      agent.id,
      agent.persistenceNudge,
      agent.finishRetries,
      agent.finishCheck,
      agent.skipFinishCheck,
    ]),
    [
      ['nano-med-plain', undefined, undefined, undefined, undefined],
      ['nano-med-nudge', true, undefined, undefined, undefined],
      ['nano-med-retry-nudge', true, 1, undefined, undefined],
      ['nano-dn', true, 1, true, undefined],
      ['nano-check', true, undefined, true, undefined],
      ['nano-skip', true, undefined, undefined, true],
    ],
  )
  assert.equal(Config.finishLevers.includes('persistenceNudge'), true)
  assert.equal(Config.agentKeys.includes('persistenceNudge'), true)
  const plain = Config.parse({
    ...config,
    agents: [parseAgent('nano-med-plain=claude:claude-opus-5-5:medium')],
  })
  assert.equal(
    JSON.stringify(plain.agents),
    '[{"id":"nano-med-plain","model":"claude-opus-5-5","provider":"claude","thinking":"medium"}]',
  )
  assert.equal(
    JSON.stringify(
      Config.parse({
        ...config,
        agents: [
          {
            ...parseAgent('nano-med-plain=claude:claude-opus-5-5:medium'),
            persistenceNudge: undefined,
          },
        ],
      }).agents,
    ),
    JSON.stringify(plain.agents),
  )
  assert.equal(
    JSON.stringify(Config.parse({ ...config, agents: [parseAgent(retry)] }).agents),
    '[{"finishRetries":1,"id":"nano-med-retry-nudge","model":"claude-opus-5-5","persistenceNudge":true,"provider":"claude","thinking":"medium"}]',
  )
  for (const persistenceNudge of [false, 'on', 1, null])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', persistenceNudge, provider: 'claude' }],
        }),
      /x has a persistenceNudge that is not true/,
    )
  for (const provider of ['codex', 'oracle', ...Installed.kinds])
    assert.throws(
      () =>
        Config.parse({
          ...config,
          agents: [{ id: 'x', model: 'm', persistenceNudge: true, provider }],
        }),
      /x has a persistenceNudge, which only a claude session takes/,
    )
  for (const text of [
    'x=codex:gpt-6-luna:high:persistence_nudge=on',
    'x=codex-direct:gpt-6-luna:high:persistence_nudge=on',
    'x=codex-code-mode:gpt-6-luna:high:persistence_nudge=on',
    'x=codex-jobs:gpt-6-luna:high:persistence_nudge=on',
    'x=codex:gpt-6-luna:high:persist_finish=on:persistence_nudge=on',
    ...Installed.harnesses.map((harness) => 'x=' + harness + ':m:persistence_nudge=on'),
  ])
    assert.throws(
      () => Config.parse({ ...config, agents: [parseAgent(text)] }),
      /x has a persistenceNudge, which only a claude session takes/,
    )
})

test('a turn sends persistence_nudge only for an agent that names it, and an agent without it sends the same bytes', () => {
  const input = { at: 1_800_000_000_000, session: 'run-a00001' }
  for (const orchestration of [undefined, 'direct'] as const) {
    const plain = { ...turn, ...(orchestration ? { orchestration } : {}) }
    const retried = { ...plain, finishRetries: 1 } as const
    const others = {
      ...plain,
      briefFinish: true,
      finishAmbiguity: true,
      finishCheck: true,
      finishRetries: 2,
      persistFinish: true,
      toolResultClearing: { atLeastTokens: 10000, keep: 2 },
      yieldShare: 25,
    } as const
    for (const named of [plain, retried, others]) {
      assert.equal('persistence_nudge' in Turn.body(named), false)
      assert.equal('persistence_nudge' in JSON.parse(Turn.sent(named, input)), false)
      const withNudge = { ...named, persistenceNudge: true } as const
      const { persistence_nudge: sent, ...body } = Turn.body(withNudge)
      assert.equal(sent, true)
      assert.deepEqual(body, Turn.body(named))
      const { persistence_nudge: recorded, ...rest } = JSON.parse(Turn.sent(withNudge, input))
      assert.equal(recorded, true)
      assert.deepEqual(rest, JSON.parse(Turn.sent(named, input)))
      assert.equal(
        JSON.stringify(Turn.body({ ...named, persistenceNudge: undefined })),
        JSON.stringify(Turn.body(named)),
      )
      assert.equal(
        Turn.sent({ ...named, persistenceNudge: undefined }, input),
        Turn.sent(named, input),
      )
    }
  }
  assert.equal(
    JSON.stringify(Turn.body(turn)),
    '{"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, persistenceNudge: true })),
    '{"persistence_nudge":true,"hand":"slot","model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, finishRetries: 1 })),
    '{"hand":"slot","finish_retries":1,"model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    JSON.stringify(Turn.body({ ...turn, finishRetries: 1, persistenceNudge: true })),
    '{"persistence_nudge":true,"hand":"slot","finish_retries":1,"model":"claude-opus-5-5","prompt":"Write the greeting.","provider":"claude","request_id":"turn-1","thinking":"medium"}',
  )
  assert.equal(
    Turn.sent(turn, input),
    '{"at_ms":1800000000000,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
  assert.equal(
    Turn.sent({ ...turn, persistenceNudge: true }, input),
    '{"at_ms":1800000000000,"persistence_nudge":true,"deadline":null,"request_id":"turn-1","session":"run-a00001"}\n',
  )
})
