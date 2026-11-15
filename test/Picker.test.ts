import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as Branch from '../src/Branch.ts'
import * as Config from '../src/Config.ts'
import * as Picker from '../src/Picker.ts'

const done = (message = ''): Branch.Outcome => ({ message, state: 'completed', verdict: 'unknown' })

const verified = (
  verdict: Picker.Verdict,
  confidence: number,
  output?: string,
): Picker.Verification => ({ confidence, ...(output ? { output } : {}), usd: 0.1, verdict })

test('parse reads the last verdict, confidence and output of the verifier', () => {
  assert.deepEqual(
    Picker.parse(
      'VERIFIER: FAIL\nlater I checked again\nVERIFIER: PASS\nCONFIDENCE: 88\nOUTPUT: /app/out.txt 42',
    ),
    { confidence: 88, output: '/app/out.txt 42', verdict: 'pass' },
  )
  assert.deepEqual(Picker.parse('**VERIFIER:** unsure\nCONFIDENCE: 140\nOUTPUT: none'), {
    confidence: 100,
    verdict: 'unsure',
  })
  assert.deepEqual(Picker.parse('no verdict at all'), { confidence: 0, verdict: 'unsure' })
})

test('the prompt carries the task and the log, and nothing of what the branch said', () => {
  const prompt = Picker.prompt({ instruction: 'Write /app/answer.txt', log: '$ ls\n[exit 0]\n' })
  assert.match(prompt, /Write \/app\/answer.txt/)
  assert.match(prompt, /\$ ls/)
  assert.doesNotMatch(prompt, /SELF-CHECK/)
})

test('the log keeps commands, exit codes and writes of the branch, never its messages', () => {
  const event = (type: string, payload: { [key: string]: unknown }) => ({
    event: { event: { payload, type } },
    request_id: 'attempt',
  })
  const events = [
    event('tool.call', { arguments: { cmd: 'pytest -q' }, call_id: '1', tool: 'exec_command' }),
    event('tool.result', {
      call_id: '1',
      structured_result: { exit_code: 1, output: '1 failed' },
      tool: 'exec_command',
    }),
    event('tool.call', { arguments: { file_path: '/app/a.py' }, call_id: '2', tool: 'Write' }),
    event('message', { text: 'SELF-CHECK: PASS, all good' }),
  ] as never
  const log = Picker.log(events, { requestId: 'attempt' })
  assert.match(log, /\$ pytest -q\n\[exit 1\]/)
  assert.match(log, /\[wrote\] \/app\/a.py/)
  assert.doesNotMatch(log, /SELF-CHECK/)
})

test('choose keeps the branch the verifier passed over one it failed', () => {
  const picked = Picker.choose(
    [done(), done(), done()],
    [verified('fail', 90), verified('unsure', 40), verified('pass', 80)],
  )
  assert.equal(picked.chosen, 2)
  assert.equal(picked.evidence, 'verifier')
})

test('choose breaks a tie of verdicts by agreement on the output, then by confidence', () => {
  const agreed = Picker.choose(
    [done(), done(), done()],
    [verified('pass', 99, 'x=1'), verified('pass', 70, 'x=2'), verified('pass', 60, 'x=2')],
  )
  assert.equal(agreed.chosen, 1)
  assert.equal(agreed.evidence, 'agreement+confidence')
  assert.deepEqual(agreed.agreement, [0, 1, 1])
  const confident = Picker.choose([done(), done()], [verified('pass', 60), verified('pass', 90)])
  assert.equal(confident.chosen, 1)
  assert.equal(confident.evidence, 'confidence')
  const even = Picker.choose([done(), done()], [verified('pass', 90), verified('pass', 90)])
  assert.deepEqual([even.chosen, even.evidence], [0, 'index'])
})

test('choose never keeps a branch that did not complete over one that did', () => {
  const picked = Picker.choose([{ state: 'timeout' }, done()], [undefined, verified('fail', 90)])
  assert.equal(picked.chosen, 1)
})

test('a lazy trunk forks unless the verifier passed it with confidence', () => {
  const options = { deadlineAt: 2_000, now: 1_000 }
  assert.equal(Picker.forkReason(done(), verified('pass', 90), options), undefined)
  assert.equal(Picker.forkReason(done(), verified('pass', 50), options), 'verifier_unsure')
  assert.equal(Picker.forkReason(done(), verified('unsure', 90), options), 'verifier_unsure')
  assert.equal(Picker.forkReason(done(), verified('fail', 90), options), 'verifier_fail')
  assert.equal(Picker.forkReason({ state: 'timeout' }, undefined, options), 'unverified')
  assert.equal(
    Picker.forkReason(done(), verified('fail', 90), { deadlineAt: 1_000, now: 1_000 }),
    undefined,
    'a trunk past its deadline is kept rather than forked',
  )
})

test('a probe slot takes a slot of its own for each branch', () => {
  assert.equal(Picker.slots({ branches: 3, picker: 'verify' }), 6)
  assert.equal(Picker.slots({ branches: 3 }), 3)
  assert.equal(Picker.slots({}), 1)
})

const config = (agent: { [key: string]: unknown }) => ({
  agents: [{ id: 'a', model: 'claude-opus-5-5', provider: 'claude', ...agent }],
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'picker',
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

test('the Worker refuses an agent key it does not know, rather than running another arm', () => {
  assert.throws(
    () => Config.parse(config({ branches: 3, lazyGate: true })),
    /does not know \(lazyGate\)/,
  )
})

test('a picker needs branches, and verifier_model needs a picker', () => {
  assert.throws(() => Config.parse(config({ picker: 'verify' })), /only an agent that branches/)
  assert.throws(
    () => Config.parse(config({ branches: 3, verifierModel: 'claude-sonnet-5-5' })),
    /only an agent with a picker/,
  )
  const [agent] = Config.parse(
    config({ branches: 3, picker: 'verify_lazy', verifierModel: 'claude-sonnet-5-5' }),
  ).agents
  assert.equal(agent?.picker, 'verify_lazy')
  assert.equal(agent?.lazy, true, 'a lazy picker forks lazily')
  assert.equal(agent?.verifierModel, 'claude-sonnet-5-5')
  assert.equal(Picker.model(agent!), 'claude-sonnet-5-5')
  assert.equal(Picker.model({ model: 'm', provider: 'claude' }), Picker.defaultModel)
})
