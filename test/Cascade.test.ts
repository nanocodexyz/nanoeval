import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import { test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Cascade from '../src/Cascade.ts'
import * as Config from '../src/Config.ts'
import * as Picker from '../src/Picker.ts'
import * as Proxy from '../src/Proxy.ts'

const spec =
  'nano-cv=codex:@cf/deepseek-ai/deepseek-v4.1-flash-1017:low:branches=2:picker=verify_lazy:verifier_model=claude-haiku-5-5:fix_provider=claude:fix_model=claude-opus-5-5:fix_thinking=medium:verifier_provider=claude:verifier_thinking=medium:executor_share=50:verifier_share=10'

const config = (agent: { [key: string]: unknown }) => ({
  agents: [
    {
      branches: 2,
      id: 'a',
      model: 'm',
      picker: 'verify_lazy',
      provider: 'codex',
      ...agent,
    },
  ],
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'cascade',
  sandbox: {
    backend: 'krun',
    max: 1,
    network: 'private',
    pollMs: 250,
    provider: 'local',
    slots: 2,
    timeoutSec: 3600,
  },
})

test('a cascade agent reads from its keys and prints back to the same text', () => {
  const agent = parseAgent(spec)
  assert.equal(agent.fixProvider, 'claude')
  assert.equal(agent.fixModel, 'claude-opus-5-5')
  assert.equal(agent.fixThinking, 'medium')
  assert.equal(agent.verifierProvider, 'claude')
  assert.equal(agent.verifierThinking, 'medium')
  assert.equal(agent.executorShare, 50)
  assert.equal(agent.verifierShare, 10)
  assert.equal(agentText(agent), spec)
  assert.deepEqual(parseAgent(agentText(agent)), agent)
  const short =
    'cv=codex:m:branches=2:picker=verify_lazy:fix_provider=codex:fix_model=gpt-fix:verifier_share=5'
  assert.equal(agentText(parseAgent(short)), short)
  const [parsed] = Config.parse(config(agent)).agents
  assert.equal(parsed?.fixModel, 'claude-opus-5-5')
  assert.equal(parsed?.verifierShare, 10)
  assert.equal(Picker.model(parsed!), 'claude-haiku-5-5')
  assert.equal(Picker.provider(parsed!), 'claude')
})

test('a cascade refuses keys that do not fit together', () => {
  const refuses = (agent: { [key: string]: unknown }, pattern: RegExp) =>
    assert.throws(() => Config.parse(config(agent)), pattern)
  refuses({ fixModel: 'f' }, /a fixModel and no fixProvider/)
  refuses(
    { branches: 3, fixModel: 'f', fixProvider: 'claude' },
    /only an agent with verify_lazy and two branches/,
  )
  refuses(
    { fixModel: 'f', fixProvider: 'claude', picker: 'verify' },
    /only an agent with verify_lazy and two branches/,
  )
  refuses({ fixProvider: 'claude' }, /a fixProvider, which only an agent with a fixModel/)
  refuses({ fixThinking: 'high' }, /a fixThinking, which only an agent with a fixModel/)
  refuses({ fixModel: 'f', fixProvider: 'other' }, /fixProvider/)
  refuses({ fixModel: 'f', fixProvider: 'claude', fixThinking: 'loud' }, /fixThinking/)
  refuses({ executorShare: 50 }, /an executorShare, which only an agent with a fixModel/)
  refuses({ verifierShare: 10 }, /a verifierShare, which only an agent with a fixModel/)
  refuses({ executorShare: 0, fixModel: 'f', fixProvider: 'claude' }, /whole percent/)
  refuses({ fixModel: 'f', fixProvider: 'claude', verifierShare: 101 }, /whole percent/)
  refuses(
    { executorShare: 90, fixModel: 'f', fixProvider: 'claude', verifierShare: 10 },
    /leave the fix no time/,
  )
  refuses({ executorShare: 95, fixModel: 'f', fixProvider: 'claude' }, /leave the fix no time/)
  refuses(
    { branches: undefined, picker: undefined, verifierProvider: 'codex' },
    /a verifierProvider, which only an agent with a picker/,
  )
  refuses(
    { branches: undefined, picker: undefined, verifierThinking: 'low' },
    /a verifierThinking, which only an agent with a picker/,
  )
  refuses({ verifierProvider: 'claude' }, /names no verifierModel/)
  assert.equal(
    Config.parse(config({ verifierProvider: 'codex', verifierThinking: 'high' })).agents[0]
      ?.verifierThinking,
    'high',
    'a plain verifier picker takes a verifier provider and thinking without a cascade',
  )
  assert.throws(() => parseAgent('a=codex:m:fix_provider=other'), /fix_provider=claude\|codex/)
  assert.throws(() => parseAgent('a=codex:m:executor_share=x'), /executor_share=1\.\.100/)
})

test('the executor gets its share of the agent time, and the verifier its own', () => {
  assert.equal(
    Cascade.executorDeadline({}, { limitMs: 600_000, startedAt: 1_000 }),
    301_000,
    'half the time by default',
  )
  assert.equal(
    Cascade.executorDeadline({ executorShare: 70 }, { limitMs: 600_000, startedAt: 0 }),
    420_000,
  )
  assert.equal(Cascade.verifierLimitMs({}, { agentMs: 600_000, limitMs: 900_000 }), 60_000)
  assert.equal(
    Cascade.verifierLimitMs({ verifierShare: 20 }, { agentMs: 600_000, limitMs: 90_000 }),
    90_000,
    'never past the limit a verifier has without a cascade',
  )
})

test('the fix branch runs on the fix model, provider and thinking, and the executor on its own', () => {
  const agent = parseAgent(spec)
  assert.deepEqual(Cascade.stage(agent, 0), {
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    provider: 'codex',
    thinking: 'low',
  })
  assert.deepEqual(Cascade.stage(agent, 1), {
    model: 'claude-opus-5-5',
    provider: 'claude',
    thinking: 'medium',
  })
  const plain = parseAgent('p=codex:m:branches=2:picker=verify_lazy')
  assert.deepEqual(Cascade.stage(plain, 1), { model: 'm', provider: 'codex' })
  assert.equal(Cascade.fixing(plain, 1), false)
  assert.deepEqual(
    Cascade.bare({ escalateModel: 'x', model: 'm', refusalFallback: 'y' } as never),
    { model: 'm' },
    'the fix does not escalate to the models the executor escalates to',
  )
})

test('the handoff carries the task and the verdict, never a transcript', () => {
  const long = 'x'.repeat(5000) + 'the last line'
  const text = Cascade.handoff({
    instruction: 'Write hello to greeting.txt.',
    verifier: { confidence: 80, message: long, verdict: 'fail' },
  })
  assert.ok(text.startsWith('Write hello to greeting.txt.\n\n---\n\n'))
  assert.match(text, /An independent check of the sandbox found it unfinished/)
  assert.match(text, /Verdict of the check: FAIL, confidence 80\./)
  assert.match(text, /the last line/)
  assert.ok(!text.includes('x'.repeat(Cascade.messageBytes + 1)), 'the message is trimmed')
  assert.match(text, /Finish the task in place/)
  const timedOut = Cascade.handoff({ instruction: 'Do it.', verifier: undefined })
  assert.match(timedOut, /ran out of its time or stopped before it finished/)
  assert.ok(!timedOut.includes('Verdict'))
})

const draftSpec =
  'cv-son-opus-draft=claude:claude-sonnet-5-5:medium:branches=2:picker=verify_lazy:verifier_model=claude-haiku-5-5:fix_provider=claude:fix_model=claude-opus-5-5:fix_thinking=medium:verifier_thinking=medium:fix_handoff=draft'

const draftEnd =
  "\n\nThe files and processes it left are still in this sandbox. Finish the task in place. Treat the previous work as a draft. Before you build on it, judge whether its approach can meet the task on every input the task describes, not only the example it was tried on. If the check's doubts point at the method rather than a detail, replace the method. Verify on inputs that differ from the ones the previous agent used. Verify the result yourself before you finish."

const sweep = (kind?: Cascade.Handoff) => {
  const hash = Crypto.createHash('sha256')
  for (const verdict of ['fail', 'pass', 'unsure', undefined] as const)
    for (const confidence of [0, 69, 100])
      for (const message of [
        '',
        ' two\nlines \n',
        'x'.repeat(Cascade.messageBytes),
        'y'.repeat(Cascade.messageBytes + 1) + 'the last line',
      ])
        for (const instruction of ['Do it.', 'Line one.\n\nLine two.\n'])
          hash.update(
            Cascade.handoff({
              instruction,
              kind,
              verifier: verdict ? { confidence, message, verdict } : undefined,
            }) + '\u0000',
          )
  return hash.digest('hex')
}

test('a cascade names the draft handoff last, and nothing but a cascade takes it', () => {
  const agent = parseAgent(draftSpec)
  assert.equal(agent.fixHandoff, 'draft')
  assert.equal(agentText(agent), draftSpec)
  assert.deepEqual(parseAgent(agentText(agent)), agent)
  assert.equal(Config.parse(config(agent)).agents[0]?.fixHandoff, 'draft')
  const plain = parseAgent(draftSpec.replace(':fix_handoff=draft', ''))
  assert.ok(!('fixHandoff' in plain))
  assert.ok(!('fixHandoff' in Config.parse(config(plain)).agents[0]!))
  const refuses = (agent: { [key: string]: unknown }, pattern: RegExp) =>
    assert.throws(() => Config.parse(config(agent)), pattern)
  refuses({ fixHandoff: 'draft' }, /a fixHandoff, which only an agent with a fixModel/)
  refuses(
    { branches: undefined, fixHandoff: 'draft', picker: undefined },
    /a fixHandoff, which only an agent with a fixModel/,
  )
  refuses({ fixHandoff: 'continue', fixModel: 'f', fixProvider: 'claude' }, /fixHandoff/)
  assert.throws(() => parseAgent('a=codex:m:fix_handoff=other'), /fix_handoff=draft/)
  assert.throws(
    () => parseAgent('a=codex:m:fix_handoff=draft:verifier_share=5'),
    /\[:verifier_share=1\.\.100\]\[:fix_handoff=draft\], not a=/,
  )
})

test('a cascade without the draft handoff sends the text it sent before', () => {
  const instruction = 'Write hello to greeting.txt.'
  const start =
    instruction +
    '\n\n---\n\nAnother agent already worked on this task in this sandbox, and its work is not done. '
  const found = 'An independent check of the sandbox found it unfinished.'
  const end =
    '\n\nThe files and processes it left are still in this sandbox. Finish the task in place: start from the current state, fix what is wrong or missing, and verify the result yourself before you finish.'
  const sent: readonly (readonly [Cascade.Verifier | undefined, string])[] = [
    [
      { confidence: 80, message: 'greeting.txt is empty\n', verdict: 'fail' },
      start +
        found +
        '\n\nVerdict of the check: FAIL, confidence 80.\n\nWhat the check reported:\ngreeting.txt is empty' +
        end,
    ],
    [
      { confidence: 40, message: '', verdict: 'pass' },
      start + found + '\n\nVerdict of the check: PASS, confidence 40.' + end,
    ],
    [
      { confidence: 0, message: 'no verdict line', verdict: 'unsure' },
      start +
        found +
        '\n\nVerdict of the check: UNSURE, confidence 0.\n\nWhat the check reported:\nno verdict line' +
        end,
    ],
    [
      undefined,
      start +
        'It ran out of its time or stopped before it finished, so nothing checked its work.' +
        end,
    ],
  ]
  for (const [verifier, text] of sent) {
    assert.equal(Cascade.handoff({ instruction, verifier }), text)
    assert.equal(Cascade.handoff({ instruction, kind: 'continue', verifier }), text)
  }
  const before = '401c82d4c6285d1455d3e8f0374dbe06578982f011b7d8d555510a098b50cdb9'
  assert.equal(
    sweep(),
    before,
    'the digest of 96 handoffs, as the code before the option wrote them',
  )
  assert.equal(sweep('continue'), before)
  assert.notEqual(sweep('draft'), before)
})

test('the draft handoff has the fix judge the method before it builds on the work', () => {
  const instruction = 'Write hello to greeting.txt.'
  const start =
    instruction +
    '\n\n---\n\nAnother agent already worked on this task in this sandbox, and its work is not done. '
  assert.equal(
    Cascade.handoff({
      instruction,
      kind: 'draft',
      verifier: { confidence: 0, message: 'no verdict line', verdict: 'unsure' },
    }),
    start +
      'An independent check could not confirm the work is correct.' +
      '\n\nVerdict of the check: UNSURE, confidence 0.\n\nWhat the check reported:\nno verdict line' +
      draftEnd,
  )
  for (const verdict of ['fail', 'pass'] as const)
    assert.equal(
      Cascade.handoff({
        instruction,
        kind: 'draft',
        verifier: { confidence: 40, message: '', verdict },
      }),
      start +
        'An independent check of the sandbox found it unfinished.' +
        '\n\nVerdict of the check: ' +
        verdict.toUpperCase() +
        ', confidence 40.' +
        draftEnd,
    )
  assert.equal(
    Cascade.handoff({ instruction, kind: 'draft', verifier: undefined }),
    start +
      'It ran out of its time or stopped before it finished, so nothing checked its work.' +
      draftEnd.replace(
        " If the check's doubts point at the method rather than a detail, replace the method.",
        '',
      ),
    'no check ran, so the text names no doubts of a check',
  )
  assert.equal(
    Cascade.usage({
      branchUsd: 1,
      executorTimedOut: false,
      fixUsd: 0.5,
      fork: { at: 1, reason: 'verifier_unsure', state: 'fork' } as never,
      handoff: 'draft',
      verifierUsd: 0,
    }).handoff,
    'draft',
  )
})

test('after a fork the fix is graded when it finished or timed out with work, else the executor', () => {
  const done = { message: '', state: 'completed', verdict: 'unknown' } as const
  assert.equal(Cascade.pick([done, done], { worked: true }), 1)
  assert.equal(Cascade.pick([done, { state: 'timeout' }], { worked: true }), 1)
  assert.equal(Cascade.pick([done, { state: 'timeout' }], { worked: false }), 0)
  assert.equal(Cascade.pick([done, { error: 'x', state: 'failed' }], { worked: true }), 0)
  assert.equal(Cascade.pick([{ state: 'timeout' }, undefined], { worked: true }), 0)
})

test('the usage of a cascade splits the branches into executor and fix', () => {
  assert.deepEqual(
    Cascade.usage({
      branchUsd: 3,
      executorTimedOut: false,
      fixUsd: 2.5,
      fork: { at: 1, reason: 'verifier_fail', state: 'fork' } as never,
      verifierUsd: 0.25,
    }),
    {
      escalated: true,
      execUsd: 0.5,
      executorTimedOut: false,
      fixUsd: 2.5,
      handoff: 'continue',
      reason: 'verifier_fail',
      verifierUsd: 0.25,
    },
  )
  assert.equal(
    Cascade.usage({
      branchUsd: 1,
      executorTimedOut: false,
      fixUsd: 0,
      fork: undefined,
      verifierUsd: 0,
    }).escalated,
    false,
  )
})

test('the requests of the fix are metered by the branch of their session', () => {
  const run = '0d6c29c9-f885-4e7c-bff4-23d0045679a0'
  assert.equal(Proxy.session(run + '-a7-1-branch-1')?.branch, 1)
  assert.equal(Proxy.session(run + '-a7-1')?.branch, undefined)
  assert.equal(Proxy.session(Picker.session(run + '-a7-1', 0))?.verifier, 0)
})

test('the cheat scan covers the cascade verifier, which runs as any verifier does', () => {
  const events = [
    {
      event: {
        event: {
          payload: { arguments: { cmd: 'cat /tests/test.sh' }, call_id: '1', tool: 'exec_command' },
          type: 'tool.call',
        },
      },
      request_id: Picker.requestId,
    },
  ] as never
  assert.deepEqual(Picker.hiddenReads(events, { requestId: Picker.requestId }), [
    'cat /tests/test.sh',
  ])
})
