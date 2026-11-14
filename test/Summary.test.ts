import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shown, summary } from '../cli/nanoeval.ts'
import * as Result from '../src/Result.ts'

const row = (task: string, index: number, outcome: Result.Attempt['outcome']): Result.Attempt => ({
  agent: { id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' },
  ...(outcome === 'errored'
    ? { failure: { at: 1, kind: 'cancelled' as const, message: 'the run was cancelled' } }
    : {}),
  finishedAt: 2000,
  id: task + index,
  index,
  outcome,
  reward: outcome === 'errored' ? null : outcome === 'passed' ? 1 : 0,
  sandbox: null,
  session: 's',
  startedAt: 1000,
  task: { checksum: 'sha256:' + task, name: 'suite/' + task },
  timing: {},
  usage: null,
})

const status = (results: readonly Result.Attempt[]): Record<string, any> => ({
  agents: Result.summarize(results),
  attempts: results.map((result) => ({
    agent: result.agent.id,
    claims: 1,
    failure: result.failure,
    id: result.id,
    n: result.index,
    outcome: result.outcome,
    task: result.task.name,
  })),
  counts: {
    active: 0,
    errored: results.filter((result) => result.outcome === 'errored').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
    passed: results.filter((result) => result.outcome === 'passed').length,
    total: results.length,
    unclaimed: 0,
  },
  createdAt: 0,
  id: 'run-1',
  name: 'example',
  spend: { modelUsd: 0, sandboxUsd: 0 },
  state: 'finished',
})

const line = (text: string) => text.split('\n').find((entry) => entry.startsWith('haiku: '))

test('the summary says how many tasks a pass@k rates when errors left some out', () => {
  assert.equal(
    line(
      summary(
        status([
          row('one', 1, 'passed'),
          row('one', 2, 'passed'),
          row('two', 1, 'failed'),
          row('two', 2, 'errored'),
          row('three', 1, 'errored'),
          row('three', 2, 'errored'),
        ]),
      ),
    ),
    'haiku: passed 2/6, errored 3, mean reward 0.667 of 3 scored, pass@1 50.0% of 2 tasks, pass@2 100.0% of 1 task',
  )
  assert.equal(
    line(
      summary(
        status([
          row('one', 1, 'passed'),
          row('one', 2, 'failed'),
          row('two', 1, 'failed'),
          row('two', 2, 'failed'),
        ]),
      ),
    ),
    'haiku: passed 1/4, errored 0, mean reward 0.250, pass@1 25.0%, pass@2 50.0%',
  )
})

test('the spend says when it is an estimate and which attempts it leaves out', () => {
  const usage = {
    cacheWriteTokens: 0,
    cachedTokens: 40,
    costUsd: 0.5 as number | undefined,
    inputTokens: 65,
    modelCalls: 1,
    outputTokens: 7,
    toolCalls: 1,
  }
  const results = [
    { ...row('one', 1, 'passed'), usage },
    { ...row('two', 1, 'failed'), usage: { ...usage, costUsd: undefined } },
    { ...row('three', 1, 'errored'), usage: { ...usage, costUsd: undefined, modelCalls: 0 } },
    row('four', 1, 'errored'),
  ]
  assert.equal(Result.uncosted(results), 1)
  const spend = (fields: Record<string, unknown>, key: unknown = null) =>
    summary({ ...status(results), key, spend: { modelUsd: 0.5, sandboxUsd: 0, ...fields } })
      .split('\n')
      .find((entry) => entry.startsWith('spend: '))
  assert.equal(spend({}), 'spend: model $0.5000, sandboxes $0.0000')
  assert.equal(
    spend({ uncostedAttempts: 1, unpricedResponses: 3 }),
    'spend: model $0.5000 estimated from tokens, without 1 attempt whose model calls have no cost, sandboxes $0.0000',
  )
  assert.equal(
    spend({ uncostedAttempts: 2, unpricedResponses: 3 }, { start: {} }),
    'spend: model $0.5000, without 2 attempts whose model calls have no cost, sandboxes $0.0000',
  )
  assert.equal(
    spend({ modelBudgetUsd: 3, sandboxBudgetUsd: 4, sandboxUsd: 2.36 }),
    'spend: model $0.5000 of a budget of $3, sandboxes $2.3600 of a budget of $4',
  )
  const tools = (fields: Record<string, unknown>) =>
    summary({ ...status(results), spend: { modelUsd: 0.5, sandboxUsd: 0, ...fields } })
      .split('\n')
      .find((entry) => entry.startsWith('web searches'))
  assert.equal(tools({}), undefined)
  assert.equal(
    tools({ toolsUsd: 1.944, unpricedTools: 0, webSearches: 162 }),
    'web searches and other tools run by the model provider: 162, $1.9440 of the model spend',
  )
  assert.equal(
    tools({ toolsUsd: 0.12, unpricedTools: 2, webSearches: 14 }),
    'web searches and other tools run by the model provider: 14, $0.1200 of the model spend, 2 unpriced: nothing says what they cost, or whether the cost of their response holds it',
  )
  assert.equal(
    tools({ toolsUsd: 0, unpricedTools: 9, webSearches: 9 }),
    'web searches and other tools run by the model provider: 9, 9 unpriced: nothing says what they cost, or whether the cost of their response holds it',
  )
  assert.equal(
    tools({ webSearches: 9 }),
    'web searches and other tools run by the model provider: 9, counted in the recorded spend only where a response reported them in its cost',
    'a Worker that prices none says so as before',
  )
})

test('the summary names a cancelled run and keeps each row on one line', () => {
  const results = [
    row('one', 1, 'passed'),
    row('two', 1, 'errored'),
    {
      ...row('three', 1, 'errored'),
      failure: { at: 1, kind: 'verifier' as const, message: 'no reward:\n  it wrote none\n' },
    },
  ]
  const lines = summary(status(results)).split('\n')
  assert.equal(lines[0], 'run run-1 (example): finished, cancelled with 1 row not finished')
  assert.equal(lines.at(-2), '  two1 suite/two haiku #1 errored cancelled: the run was cancelled')
  assert.equal(
    lines.at(-1),
    '  three1 suite/three haiku #1 errored verifier: no reward: it wrote none',
  )
  assert.equal(
    summary(status([row('one', 1, 'passed')])).split('\n')[0],
    'run run-1 (example): finished',
  )
})

test('the line of an agent carries its tokens and cost, and the judge has a line of its own', () => {
  const usage = (costUsd: number) => ({
    cacheWriteTokens: 0,
    cachedTokens: 400,
    costUsd,
    inputTokens: 1000,
    modelCalls: 2,
    outputTokens: 50,
    toolCalls: 1,
  })
  const judge = {
    model: 'claude-haiku-4-5',
    provider: 'claude' as const,
    requests: 1,
    usage: { ...usage(0.0028), cachedTokens: 4, inputTokens: 10, outputTokens: 2 },
  }
  const other = { id: 'sol', model: 'gpt-6.1-sol', provider: 'codex' as const }
  const results = [
    { ...row('one', 1, 'passed'), judge, usage: usage(0.0056) },
    { ...row('two', 1, 'failed'), judge, usage: usage(0.0056) },
    { ...row('one', 1, 'passed'), agent: other, judge, usage: usage(0.0168) },
    { ...row('two', 1, 'passed'), agent: other, judge, usage: usage(0.0168) },
  ]
  const lines = summary(status(results)).split('\n')
  assert.equal(
    lines.find((entry) => entry.startsWith('haiku: ')),
    'haiku: passed 1/2, errored 0, mean reward 0.500, pass@1 50.0%, input tokens 2,000 (800 cached), output tokens 100 (reasoning not reported), cost $0.0112',
  )
  assert.equal(
    lines.find((entry) => entry.startsWith('sol: ')),
    'sol: passed 2/2, errored 0, mean reward 1.000, pass@1 100.0%, input tokens 2,000 (800 cached), output tokens 100 (reasoning not reported), cost $0.0336',
  )
  assert.equal(
    lines.find((entry) => entry.startsWith('judge: ')),
    'judge: 4 attempts judged, input tokens 40 (16 cached), output tokens 8, cost $0.0112, beside the agents and in the spend of the run',
  )
  const unpriced = summary(
    status([{ ...row('one', 1, 'passed'), usage: { ...usage(0), costUsd: undefined } }]),
  ).split('\n')
  assert.equal(
    unpriced.find((entry) => entry.startsWith('haiku: ')),
    'haiku: passed 1/1, errored 0, mean reward 1.000, pass@1 100.0%, input tokens 1,000 (400 cached), output tokens 50 (reasoning not reported), cost not known',
  )
  assert.equal(
    unpriced.find((entry) => entry.startsWith('judge: ')),
    undefined,
  )
  assert.equal(
    line(
      summary(
        status([{ ...row('one', 1, 'errored'), usage: { ...usage(0), costUsd: undefined } }]),
      ),
    ),
    'haiku: passed 0/1, errored 1, input tokens 1,000 (400 cached), output tokens 50 (reasoning not reported), cost not known',
  )
  assert.equal(line(summary(status([row('one', 1, 'errored')]))), 'haiku: passed 0/1, errored 1')
  const older = status([row('one', 1, 'passed')])
  delete older['agents'].haiku.judge
  delete older['agents'].haiku.scored
  assert.equal(
    line(summary(older)),
    'haiku: passed 1/1, errored 0, mean reward 1.000, pass@1 100.0%',
  )
})

test('an attempt that was scored after its agent timed out says so in words, and is no error', () => {
  const late = {
    at: 1,
    kind: 'agent_timeout' as const,
    message: 'the agent did not finish within 1800 s',
  }
  const run = status([
    { ...row('one', 1, 'passed'), failure: late },
    { ...row('one', 2, 'failed'), failure: late },
    row('one', 3, 'passed'),
    { ...row('two', 1, 'errored'), failure: late },
  ])
  run['attempts'].push({
    agent: 'haiku',
    claims: 1,
    failure: late,
    id: 'two2',
    n: 2,
    phase: 'verify',
    task: 'suite/two',
  })
  const full = summary(run)
  assert.deepEqual(full.split('\n').slice(-5), [
    '  one1 suite/one haiku #1 passed after the agent timeout (the agent did not finish within 1800 s)',
    '  one2 suite/one haiku #2 failed after the agent timeout (the agent did not finish within 1800 s)',
    '  one3 suite/one haiku #3 passed',
    '  two1 suite/two haiku #1 errored agent_timeout: the agent did not finish within 1800 s',
    '  two2 suite/two haiku #2 verify after the agent timeout (the agent did not finish within 1800 s)',
  ])
  assert.doesNotMatch(full, /(passed|failed|verify) agent_timeout/)
  assert.deepEqual(summary(run, { tasks: true }).split('\n').slice(-2), [
    '  suite/one haiku 2/3 (2 after the agent timeout)',
    '  suite/two haiku 1 errored (agent_timeout) +1 not ended',
  ])
})

test('the summary says how the model of each agent was paid for and reached, and its reasoning tokens', () => {
  const usage = {
    cacheWriteTokens: 0,
    cachedTokens: 400,
    costUsd: 0.01,
    inputTokens: 1000,
    modelCalls: 2,
    outputTokens: 500,
    reasoningTokens: 320,
    toolCalls: 1,
  }
  const route = {
    effort: 'medium',
    host: 'chatgpt.com',
    payer: 'login' as const,
    through: 'relay' as const,
    transport: 'responses_websocket_v2',
  }
  const luna = { id: 'luna', model: 'gpt-6-luna', provider: 'codex' as const }
  const results = [
    { ...row('one', 1, 'passed'), agent: luna, route, usage },
    { ...row('two', 1, 'failed'), agent: luna, route, usage },
    { ...row('three', 1, 'errored'), agent: luna },
    { ...row('one', 1, 'passed'), route: { payer: 'key' as const, transport: 'messages_sse' } },
  ]
  const recorded = {
    ...status(results),
    eval: { name: 'suite', version: 'abc' },
    nanocode: { hands: ['nanocode-cli-1234567'], harness: 'nanocode-ts build-abcdef0' },
  }
  assert.deepEqual(summary(recorded).split('\n').slice(0, 5), [
    'run run-1 (example): finished, cancelled with 1 row not finished',
    'eval: suite@abc',
    'nanocode: nanocode-ts build-abcdef0, hand nanocode-cli-1234567',
    'model route of luna: a plan login through the relay, responses_websocket_v2 to chatgpt.com, effort medium',
    'model route of haiku: the provider key, messages_sse',
  ])
  assert.equal(
    summary(recorded)
      .split('\n')
      .find((entry) => entry.startsWith('luna: ')),
    'luna: passed 1/3, errored 1, mean reward 0.500 of 2 scored, pass@1 50.0% of 2 tasks, input tokens 2,000 (800 cached), output tokens 1,000 (640 reasoning), cost $0.0200',
  )

  const older = status(results)
  delete older['agents'].luna.routes
  delete older['agents'].luna.reasoningTokens
  delete older['agents'].haiku.routes
  assert.deepEqual(summary(older).split('\n').slice(1, 3), [
    'model route of luna: not recorded',
    'model route of haiku: not recorded',
  ])
  assert.equal(
    summary(older)
      .split('\n')
      .find((entry) => entry.startsWith('luna: ')),
    'luna: passed 1/3, errored 1, mean reward 0.500 of 2 scored, pass@1 50.0% of 2 tasks, input tokens 2,000 (800 cached), output tokens 1,000 (reasoning not recorded), cost $0.0200',
  )
  const solved = status([
    { ...row('one', 1, 'passed'), agent: { id: 'oracle', model: 'solution', provider: 'oracle' } },
  ])
  assert.equal(
    summary(solved)
      .split('\n')
      .some((entry) => entry.startsWith('model route')),
    false,
  )
})

test('a run names its reruns, and a run too long for the screen is one line a task', () => {
  const results = [
    row('one', 1, 'passed'),
    row('one', 2, 'failed'),
    row('one', 3, 'passed'),
    row('two', 1, 'errored'),
    row('two', 2, 'errored'),
    {
      ...row('two', 3, 'errored'),
      failure: { at: 1, kind: 'verifier' as const, message: 'no reward' },
    },
    row('three', 1, 'failed'),
    { ...row('three', 2, 'errored'), failure: { at: 1, kind: 'agent' as const, message: 'x' } },
  ]
  const run: Record<string, any> = { ...status(results), reruns: ['run-2', 'run-3'] }
  run['attempts'].push({
    agent: 'haiku',
    claims: 0,
    id: 'three3',
    n: 3,
    phase: 'unclaimed',
    task: 'suite/three',
  })
  const full = summary(run).split('\n')
  assert.equal(
    full.find((entry) => entry.startsWith('reruns: ')),
    'reruns: run-2, run-3 (compare --with-reruns reads this run as it stands after them)',
  )
  assert.equal(full.length, 14)
  const compact = summary(run, { tasks: true }).split('\n')
  assert.deepEqual(compact.slice(-3), [
    '  suite/one haiku 2/3',
    '  suite/two haiku 3 errored (cancelled, verifier)',
    '  suite/three haiku 0/1 +1 errored (agent) +1 not ended',
  ])
  assert.equal(compact.length, 8)
  assert.equal(shown(run, { rows: false, tasks: false }), summary(run))
  assert.equal(shown(run, { height: 14, rows: false, tasks: false }), summary(run))
  assert.equal(
    shown(run, { height: 13, rows: false, tasks: false }),
    summary(run, { tasks: true }) +
      '\n(one line a task so that it fits the screen: --rows lists every attempt)',
  )
  assert.equal(shown(run, { height: 13, rows: true, tasks: false }), summary(run))
  assert.equal(shown(run, { rows: false, tasks: true }), summary(run, { tasks: true }))
})

test('a sandbox is open once its provider answered for it, not while it is asked for after refusals', () => {
  const refused =
    'Gateway.RefusedError: the gateway refused create with 429: {"code":"rate_limited","status":429}'
  const run = (sandboxes: { handle: string | null; state: string }[], endsAt: number | null) => ({
    ...status([row('one', 1, 'passed')]),
    opening: {
      closed: false,
      endsAt,
      failures: 2,
      lastAt: 6000,
      message: refused,
      nextAt: 9000,
      since: 5000,
    },
    sandboxes,
    state: 'running',
  })
  const sandboxes = (text: string) =>
    text.split('\n').find((entry) => entry.startsWith('sandboxes: '))
  const asked = { handle: null, state: 'creating' }
  const working = { handle: 'a', state: 'ready' }
  assert.equal(
    sandboxes(summary(run([{ handle: null, state: 'failed' }, working, asked], null))),
    'sandboxes: 1 open; another could not be opened 2 times since +5 s, and is asked for again at +9 s: ' +
      refused,
  )
  assert.equal(
    sandboxes(summary(run([working, { handle: 'b', state: 'creating' }], null))),
    'sandboxes: 2 open; another could not be opened 2 times since +5 s, and is asked for again at +9 s: ' +
      refused,
  )
  assert.equal(
    sandboxes(summary(run([{ handle: 'a', state: 'failed' }, asked], 20000))),
    'sandboxes: none open; one could not be opened 2 times since +5 s, and is asked for again at +9 s; the rows that wait end as errors at +20 s unless one starts: ' +
      refused,
  )
})

test('a run that lost claims says how many, and why the last one ended', () => {
  const run = (lostClaim?: Record<string, unknown>) => ({
    ...status([row('one', 1, 'passed')]),
    ...(lostClaim ? { lostClaim } : {}),
    lostClaims: lostClaim ? 2 : 0,
  })
  const claims = (text: string) => text.split('\n').filter((entry) => entry.startsWith('claims '))
  assert.deepEqual(claims(summary(run())), [])
  assert.deepEqual(
    claims(
      summary(
        run({
          attempt: 'a00008',
          ending: 'expired',
          error:
            'the lease of the attempt ran out: runner 1 sent no word of it for the 60 s that a lease lasts',
          n: 1,
          phase: 'run',
          runner: 1,
        }),
      ),
    ),
    [
      'claims lost: 2, and what their model calls cost is in the spend of the run and in the cost of no agent; the last, claim 1 of a00008 on runner 1, expired in the run phase: the lease of the attempt ran out: runner 1 sent no word of it for the 60 s that a lease lasts',
    ],
  )
  assert.deepEqual(
    claims(
      summary(run({ attempt: 'a00002', ending: 'released', n: 2, phase: 'setup', runner: 3 })),
    ),
    [
      'claims lost: 2, and what their model calls cost is in the spend of the run and in the cost of no agent; the last, claim 2 of a00002 on runner 3, was released in the setup phase',
    ],
  )
})
