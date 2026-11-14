import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as Atif from '../src/Atif.ts'
import * as Harbor from '../src/Harbor.ts'
import * as Result from '../src/Result.ts'
import * as Stats from '../src/Stats.ts'
import * as Watch from '../src/Watch.ts'

const file = {
  budget: { daily_runs: 20, daily_usd: 10, run_usd: 1 },
  eval: {
    agents: ['sonnet=claude:claude-sonnet-5-5', 'luna=codex:gpt-6-luna'],
    attempts: 2,
    name: 'bench',
    slots: 4,
    tasks: ['alpha', 'beta', 'gamma'],
  },
  nanocode: { branch: 'master', repository: 'https://example.test/nanocode' },
  nanocode_ts: { branch: 'master', repository: 'https://example.test/nanocode-ts' },
  state: 'state',
}

const settings = Watch.config(file)

const usage: Atif.Usage = {
  cacheWriteTokens: 0,
  cachedTokens: 400,
  costUsd: 0.01,
  inputTokens: 1000,
  modelCalls: 2,
  outputTokens: 50,
  toolCalls: 2,
}

function attempt(input: {
  agent: string
  index: number
  mark: string
  task: string
}): Result.Attempt {
  const failure: Result.Failure | undefined =
    input.mark === 'e'
      ? { at: 0, kind: 'verifier', message: 'the verifier wrote no reward' }
      : input.mark === 't'
        ? { at: 0, kind: 'agent_timeout', message: 'the agent ran out of time' }
        : undefined
  const reward = input.mark === 'e' ? null : input.mark === 'p' ? 1 : 0
  return {
    agent: { id: input.agent, model: 'm', provider: 'claude' },
    ...(failure ? { failure } : {}),
    finishedAt: 2000,
    id: 'a' + input.index,
    index: input.index,
    outcome: Result.outcome(reward, failure),
    reward,
    sandbox: null,
    session: 's',
    startedAt: 0,
    task: { checksum: 'c', name: 'bench/' + input.task },
    timing: {},
    usage,
  }
}

function job(attempts: readonly Result.Attempt[], total = attempts.length) {
  const files = Harbor.files({
    artifacts: {},
    attempts,
    job: { finishedAt: 2000, id: 'run', name: 'job', startedAt: 0 },
    running: 0,
    source: 'bench',
    total,
    version: 'v',
  })
  return {
    result: JSON.parse(files['result.json']!),
    trials: Object.entries(files)
      .filter(([path]) => path.includes('/') && path.endsWith('/result.json'))
      .map(([, contents]) => JSON.parse(contents)),
  }
}

function evaluate(
  lines: readonly Watch.Line[],
  input: {
    marks(agent: string, task: string): string
    request: Watch.Request
    settings?: Watch.Config
  },
): Watch.Evaluation {
  const own = input.settings ?? settings
  const state = Watch.replay(lines, own)
  const intent: Watch.Intent = {
    baseline: input.request.role === 'baseline' ? null : (state.baseline?.id ?? null),
    confirm: [],
    errors: {},
    id: 'e' + (lines.length + 1),
    marks: {},
    phase: { kind: 'open' },
    queue: [],
    request: input.request,
    rounds: { build: 1, confirm: 0, errored: 0, main: 0 },
    startedAt: '2026-11-14T00:00:00Z',
    steps: [],
    usage: {},
  }
  const positions = new Map<string, number>()
  for (;;) {
    const round = Watch.next(own, { evidence: state.evidence, intent })
    if (!round) break
    if (round.purpose === 'confirm')
      intent.confirm = round.calls.flatMap((call) =>
        call.agents.flatMap((agent) => (call.tasks as string[]).map((task) => ({ agent, task }))),
      )
    intent.rounds[round.purpose]++
    for (const call of round.calls) {
      const rows: Result.Attempt[] = []
      for (const agent of call.agents)
        for (const task of call.tasks as string[])
          for (let index = 1; index <= call.attempts; index++) {
            const sequence = input.marks(agent, task)
            const position = positions.get(agent + ' ' + task) ?? 0
            positions.set(agent + ' ' + task, position + 1)
            rows.push(
              attempt({
                agent,
                index,
                mark: sequence[Math.min(position, sequence.length - 1)]!,
                task,
              }),
            )
          }
      const { charged, usd } = Watch.record(intent, Watch.rows(job(rows)))
      intent.steps.push({
        charged,
        exit: 0,
        finishedAt: '2026-11-14T00:00:01Z',
        log: 'log',
        purpose: round.purpose,
        startedAt: '2026-11-14T00:00:00Z',
        usd,
      })
    }
  }
  return Watch.conclude(own, {
    evidence: state.evidence,
    finishedAt: '2026-11-14T00:00:0' + (lines.length % 10) + 'Z',
    intent,
  })
}

const agents = ['sonnet', 'luna']
const tasks = ['alpha', 'beta', 'gamma']

function chain(prefix: string, times: readonly number[]): Watch.Chain {
  const commits = times.map((at, index) => ({
    at,
    sha: prefix + (index + 1),
    subject: 'change ' + prefix + (index + 1),
  }))
  return { commits, head: commits.at(-1)?.sha ?? prefix + '0', rewritten: false }
}

const origin = { nanocode: 'n0', nanocodeTs: 't0' }

function baseline(): Watch.Evaluation {
  return evaluate([], {
    marks: () => 'p',
    request: { agents, attempts: 4, pair: origin, role: 'baseline', tasks },
  })
}

test('the configuration takes its defaults from the attempts, and refuses what it cannot mean', () => {
  assert.equal(settings.baseline.alpha, 0.05)
  assert.equal(settings.baseline.window, 2)
  assert.equal(settings.bisect, 'auto')
  assert.deepEqual(settings.retries, { build: 1, errored: 1, run: 1 })
  assert.deepEqual(settings.eval.agents[1], { id: 'luna', spec: 'codex:gpt-6-luna' })
  assert.deepEqual(Watch.config({ ...file, nanocode_ts: { revision: 'pinned' } }).nanocodeTs, {
    revision: 'pinned',
  })
  assert.equal(Watch.config({ ...file, eval: { ...file.eval, tasks: 'all' } }).eval.tasks, 'all')
  const refused = (change: Record<string, unknown>, message: RegExp) =>
    assert.throws(
      () => Watch.config({ ...file, ...change }),
      (error: Error) => {
        assert.equal(error.name, 'Watch.ConfigError')
        assert.match(error.message, message)
        return true
      },
    )
  refused({ polling: 3 }, /has no setting polling/)
  refused({ budget: { ...file.budget, daily_usd: 0.5 } }, /no run would ever start/)
  refused({ budget: { daily_runs: 20, daily_usd: 10 } }, /budget.run_usd/)
  refused({ limits: { run_sec: 600 } }, /limits.stop_sec/)
  refused({ eval: { ...file.eval, agents: ['sonnet'] } }, /ID=HARNESS:MODEL/)
  refused({ eval: { ...file.eval, tasks: ['alpha', 'alpha'] } }, /twice/)
  refused({ eval: { ...file.eval, attempts: 0 } }, /at least 1/)
  refused({ nanocode: { ...file.nanocode, revision: 'pinned' } }, /not both/)
  refused({ hook: { command: ['notify'], on: ['lost'] } }, /hook.on names verdicts/)
  refused({ bisect: 'always' }, /"auto" or "off"/)
})

test('the exact test gives the chance that the revision passes this seldom', () => {
  const close = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-12)
  close(Stats.task({ passed: 2, scored: 2 }, { passed: 0, scored: 4 }).worse, 1 / 15)
  close(Stats.task({ passed: 4, scored: 4 }, { passed: 0, scored: 4 }).worse, 1 / 70)
  close(Stats.task({ passed: 3, scored: 3 }, { passed: 0, scored: 3 }).worse, 1 / 20)
  close(Stats.task({ passed: 6, scored: 6 }, { passed: 2, scored: 4 }).worse, 28 / 210)
  close(Stats.task({ passed: 4, scored: 4 }, { passed: 4, scored: 4 }).worse, 1)
  close(Stats.task({ passed: 0, scored: 4 }, { passed: 0, scored: 2 }).worse, 1)
})

test('the window is the fewest accepted runs after which a task that always passed can be lost', () => {
  assert.equal(Watch.window({ alpha: 0.05, attempts: 1 }), 5)
  assert.equal(Watch.window({ alpha: 0.05, attempts: 2 }), 2)
  assert.equal(Watch.window({ alpha: 0.05, attempts: 3 }), 1)
  assert.equal(Watch.window({ alpha: 0.01, attempts: 2 }), 3)
  assert.equal(Watch.window({ alpha: 0.001, attempts: 2 }), 5)
})

test('a task is lost or gained only after its rerun, and only when chance would seldom do it', () => {
  const rule = { alpha: 0.05, attempts: 2 }
  const kind = (base: [number, number] | undefined, revision: [number, number, 'confirmed'?]) =>
    Watch.judge(rule, {
      base: base ? { passed: base[0], scored: base[1] } : undefined,
      confirmed: revision[2] === 'confirmed',
      revision: { passed: revision[0], scored: revision[1] },
    }).kind
  assert.equal(kind([4, 4], [0, 2]), 'suspect')
  assert.equal(kind([4, 4], [0, 4, 'confirmed']), 'lost')
  assert.equal(kind([4, 4], [1, 4, 'confirmed']), 'moved')
  assert.equal(kind([2, 2], [0, 2]), 'moved')
  assert.equal(kind([2, 2], [0, 4, 'confirmed']), 'moved')
  assert.equal(kind([4, 4], [1, 2]), 'moved')
  assert.equal(kind([6, 6], [1, 2]), 'suspect')
  assert.equal(kind([6, 6], [2, 4, 'confirmed']), 'moved')
  assert.equal(kind([6, 6], [1, 4, 'confirmed']), 'lost')
  assert.equal(kind([0, 4], [2, 2]), 'suspect')
  assert.equal(kind([0, 4], [4, 4, 'confirmed']), 'gained')
  assert.equal(kind([0, 4], [1, 4, 'confirmed']), 'moved')
  assert.equal(kind([4, 4], [2, 2]), 'same')
  assert.equal(kind([2, 4], [1, 2]), 'same')
  assert.equal(kind(undefined, [0, 2]), 'new')
  assert.equal(kind([0, 0], [0, 2]), 'new')
})

test('the rows of a job are those the run exported: an error is no score, a timeout is one', () => {
  const attempts = [
    attempt({ agent: 'sonnet', index: 1, mark: 'p', task: 'alpha' }),
    attempt({ agent: 'sonnet', index: 2, mark: 'f', task: 'alpha' }),
    attempt({ agent: 'luna', index: 1, mark: 'e', task: 'alpha' }),
    attempt({ agent: 'luna', index: 2, mark: 't', task: 'alpha' }),
  ]
  const rows = Watch.rows(job(attempts))
  assert.deepEqual(rows.map((row) => [row.agent, row.task, row.index, row.outcome]).sort(), [
    ['luna', 'alpha', 1, 'errored'],
    ['luna', 'alpha', 2, 'failed'],
    ['sonnet', 'alpha', 1, 'passed'],
    ['sonnet', 'alpha', 2, 'failed'],
  ])
  assert.deepEqual(
    rows.map((row) => row.outcome).sort(),
    attempts.map((entry) => entry.outcome).sort(),
  )
  const errored = rows.find((row) => row.outcome === 'errored')!
  assert.equal(errored.error, 'VerifierError: the verifier wrote no reward')
  assert.equal(rows[0]!.inputTokens, 1000)
  assert.equal(rows[0]!.cachedTokens, 400)
  assert.equal(rows[0]!.costUsd, 0.01)

  const short = job(attempts, 6)
  assert.throws(() => Watch.rows(short), /4 of its 6 trials/)
  const running = job(attempts)
  running.result.finished_at = null
  assert.throws(
    () => Watch.rows(running),
    (error: Error) => error.name === 'Watch.JobError',
  )
  const twice = job([
    attempt({ agent: 'sonnet', index: 1, mark: 'p', task: 'alpha' }),
    {
      ...attempt({ agent: 'sonnet', index: 2, mark: 'p', task: 'alpha' }),
      task: { checksum: 'c', name: 'other/alpha' },
    },
  ])
  assert.throws(() => Watch.rows(twice), /two tasks of the job are called alpha/)
})

test('pass@1 and pass@k are those the run reports, and an unpriced row reserves the budget', () => {
  const marks: Record<string, string> = { alpha: 'pf', beta: 'fp', gamma: 'ff' }
  const attempts = Object.entries(marks).flatMap(([task, sequence]) =>
    [...sequence].map((mark, index) => attempt({ agent: 'sonnet', index: index + 1, mark, task })),
  )
  const into = { errors: {}, marks: {}, usage: {} }
  assert.deepEqual(Watch.record(into, Watch.rows(job(attempts))), {
    charged: 'recorded',
    usd: 0.06,
  })
  assert.deepEqual(into.marks, { sonnet: marks })
  const summary = Watch.summarize(into, { agents: ['sonnet'], k: 2 })['sonnet']!
  const reported = Result.summarize(attempts)['sonnet']!
  assert.equal(summary.pass1, reported.passAtK['1'])
  assert.equal(summary.passK, reported.passAtK['2'])
  assert.equal(summary.pass1, 1 / 3)
  assert.equal(summary.passK, 2 / 3)
  assert.deepEqual(
    [summary.attempts, summary.passed, summary.failed, summary.errored, summary.tasks],
    [6, 2, 4, 0, 3],
  )
  assert.deepEqual(
    [summary.inputTokens, summary.cachedTokens, summary.outputTokens, summary.costUsd],
    [6000, 2400, 300, 0.06],
  )

  const unpriced = { ...attempt({ agent: 'sonnet', index: 1, mark: 'p', task: 'alpha' }) }
  unpriced.usage = { ...usage, costUsd: undefined }
  const other = { errors: {}, marks: {}, usage: {} }
  assert.equal(Watch.record(other, Watch.rows(job([unpriced]))).charged, 'reserved')
  assert.equal(Watch.summarize(other, { agents: ['sonnet'], k: 2 })['sonnet']!.costUsd, null)

  const errored = { errors: {} as Record<string, number>, marks: {}, usage: {} }
  Watch.record(
    errored,
    Watch.rows(
      job([
        attempt({ agent: 'sonnet', index: 1, mark: 'e', task: 'alpha' }),
        attempt({ agent: 'sonnet', index: 2, mark: 'p', task: 'alpha' }),
      ]),
    ),
  )
  const scored = Watch.summarize(errored, { agents: ['sonnet'], k: 2 })['sonnet']!
  assert.deepEqual([scored.pass1, scored.passK, scored.errored], [1, 1, 1])
  assert.deepEqual(errored.errors, { 'VerifierError: the verifier wrote no reward': 1 })
})

test('the command is called with the pair, the subset and the budget, and nothing else', () => {
  const pair = { nanocode: 'a'.repeat(40), nanocodeTs: 'b'.repeat(40) }
  const own = Watch.config({
    ...file,
    eval: { ...file.eval, options: ['--codex-login', '/login.json'] },
    revision: { lab: '/lab', options: ['--sdk', 'pinned'] },
  })
  const lead = [
    'revision',
    '--nanocode',
    pair.nanocode,
    '--nanocode-repository',
    'https://example.test/nanocode',
    '--nanocode-ts',
    pair.nanocodeTs,
    '--nanocode-ts-repository',
    'https://example.test/nanocode-ts',
    '--lab',
    '/lab',
    '--sdk',
    'pinned',
  ]
  assert.deepEqual(Watch.invocation(own, { pair }), [...lead, '--build-only'])
  assert.deepEqual(
    Watch.invocation(own, {
      call: { agents: ['luna'], attempts: 2, tasks: ['beta', 'gamma'] },
      name: 'watch-1',
      out: '/state/jobs/1',
      pair,
    }),
    [
      ...lead,
      '--eval',
      'bench',
      '--only',
      'beta',
      '--only',
      'gamma',
      '--agent',
      'luna=codex:gpt-6-luna',
      '--attempts',
      '2',
      '--model-budget-usd',
      '1',
      '--slots',
      '4',
      '--name',
      'watch-1',
      '--out',
      '/state/jobs/1',
      '--codex-login',
      '/login.json',
    ],
  )
  const held = Watch.config({
    ...file,
    eval: { ...file.eval, slots: undefined, tasks: 'all' },
    nanocode_ts: { revision: 'pinned' },
  })
  assert.deepEqual(
    Watch.invocation(held, {
      call: { agents: ['sonnet', 'luna'], attempts: 4, tasks: 'all' },
      name: 'n',
      out: '/o',
      pair: { nanocode: pair.nanocode, nanocodeTs: 'pinned' },
    }),
    [
      'revision',
      '--nanocode',
      pair.nanocode,
      '--nanocode-repository',
      'https://example.test/nanocode',
      '--nanocode-ts',
      'pinned',
      '--eval',
      'bench',
      '--agent',
      'sonnet=claude:claude-sonnet-5-5',
      '--agent',
      'luna=codex:gpt-6-luna',
      '--attempts',
      '4',
      '--model-budget-usd',
      '1',
      '--name',
      'n',
      '--out',
      '/o',
    ],
  )
})

test('the first baseline runs the attempts of a whole window and compares nothing', () => {
  const chains = { nanocode: chain('n', []), nanocodeTs: chain('t', []) }
  const action = Watch.plan(settings, { chains, state: Watch.replay([], settings) })
  assert.deepEqual(action, {
    kind: 'evaluate',
    request: { agents, attempts: 4, pair: origin, role: 'baseline', tasks },
  })
  const line = baseline()
  assert.equal(line.verdict, 'baseline')
  assert.equal(line.k, 2)
  assert.equal(line.steps.length, 1)
  assert.equal(line.marks['sonnet']!['alpha'], 'pppp')
  const state = Watch.replay([line], settings)
  assert.deepEqual(state.evidence['luna']!['gamma'], { passed: 4, scored: 4 })
  assert.deepEqual(Watch.plan(settings, { chains, state }), {
    kind: 'idle',
    reason: 'up to date at nanocode n0 nanocode-ts t0',
  })
})

test('a revision that moved is rerun on the tasks that moved, and is lost only when the rerun agrees', () => {
  const lines: Watch.Line[] = [baseline()]
  const request: Watch.Request = {
    agents,
    attempts: 2,
    pair: { nanocode: 'n1', nanocodeTs: 't0' },
    role: 'head',
    tasks,
  }
  const lost = evaluate(lines, {
    marks: (agent, task) => (agent === 'luna' && task === 'beta' ? 'f' : 'p'),
    request,
  })
  assert.equal(lost.verdict, 'regression')
  assert.deepEqual(
    lost.steps.map((step) => step.purpose),
    ['main', 'confirm'],
  )
  assert.equal(lost.marks['luna']!['beta'], 'ffff')
  assert.equal(lost.marks['luna']!['alpha'], 'pp')
  assert.equal(lost.marks['sonnet']!['beta'], 'pp')
  assert.deepEqual(
    lost.changes.map((change) => [
      change.agent,
      change.task,
      change.kind,
      change.base,
      change.revision,
    ]),
    [['luna', 'beta', 'lost', { passed: 4, scored: 4 }, { passed: 0, scored: 4 }]],
  )
  assert.ok(Math.abs(lost.changes[0]!.p - 1 / 70) < 1e-12)

  const noise = evaluate(lines, {
    marks: (agent, task) => (agent === 'luna' && task === 'beta' ? 'ffpp' : 'p'),
    request,
  })
  assert.equal(noise.verdict, 'ok')
  assert.equal(noise.marks['luna']!['beta'], 'ffpp')
  assert.deepEqual(
    noise.changes.map((change) => [change.task, change.kind]),
    [['beta', 'moved']],
  )

  const half = evaluate(lines, {
    marks: (agent, task) => (agent === 'luna' && task === 'beta' ? 'pf' : 'p'),
    request,
  })
  assert.equal(half.verdict, 'ok')
  assert.deepEqual(
    half.steps.map((step) => step.purpose),
    ['main'],
  )
})

test('an errored attempt is run again once, and a task without its attempts makes the revision incomplete', () => {
  const lines: Watch.Line[] = [baseline()]
  const request: Watch.Request = {
    agents,
    attempts: 2,
    pair: { nanocode: 'n1', nanocodeTs: 't0' },
    role: 'head',
    tasks,
  }
  const repaired = evaluate(lines, {
    marks: (agent, task) => (agent === 'sonnet' && task === 'alpha' ? 'ep' : 'p'),
    request,
  })
  assert.equal(repaired.verdict, 'ok')
  assert.deepEqual(
    repaired.steps.map((step) => step.purpose),
    ['main', 'errored'],
  )
  assert.equal(repaired.marks['sonnet']!['alpha'], 'epp')
  assert.equal(repaired.summary['sonnet']!.errored, 1)

  const stuck = evaluate(lines, {
    marks: (agent, task) => (agent === 'sonnet' && task === 'alpha' ? 'pe' : 'p'),
    request,
  })
  assert.equal(stuck.verdict, 'incomplete')
  assert.deepEqual(
    stuck.steps.map((step) => step.purpose),
    ['main', 'errored'],
  )
  assert.match(
    stuck.detail!,
    /1 task has too few scored attempts: sonnet\/alpha, 2 x VerifierError/,
  )
  assert.equal(
    Watch.replay([...lines, stuck], settings).baseline!.id,
    lines[0]!.type === 'evaluation' ? lines[0]!.id : '',
  )

  const dead = evaluate(lines, { marks: () => 'e', request })
  assert.equal(dead.verdict, 'incomplete')
  assert.deepEqual(
    dead.steps.map((step) => step.purpose),
    ['main'],
  )

  const both = evaluate(lines, {
    marks: (agent, task) =>
      task === 'gamma' ? 'f' : agent === 'sonnet' && task === 'alpha' ? 'e' : 'p',
    request,
  })
  assert.equal(both.verdict, 'regression')
})

test('reruns ask each agent for its own tasks, and agents with the same tasks share a run', () => {
  const lines: Watch.Line[] = [baseline()]
  const state = Watch.replay(lines, settings)
  const intent: Watch.Intent = {
    baseline: state.baseline!.id,
    confirm: [],
    errors: {},
    id: 'e',
    marks: {
      luna: { alpha: 'ff', beta: 'ff', gamma: 'pp' },
      sonnet: { alpha: 'ff', beta: 'pp', gamma: 'pe' },
    },
    phase: { kind: 'open' },
    queue: [],
    request: {
      agents,
      attempts: 2,
      pair: { nanocode: 'n1', nanocodeTs: 't0' },
      role: 'head',
      tasks,
    },
    rounds: { build: 1, confirm: 0, errored: 0, main: 1 },
    startedAt: '',
    steps: [],
    usage: {},
  }
  assert.deepEqual(Watch.next(settings, { evidence: state.evidence, intent }), {
    calls: [{ agents: ['sonnet'], attempts: 1, tasks: ['gamma'] }],
    purpose: 'errored',
  })
  intent.rounds.errored = 1
  intent.marks['sonnet']!['gamma'] = 'pep'
  assert.deepEqual(Watch.next(settings, { evidence: state.evidence, intent }), {
    calls: [
      { agents: ['sonnet'], attempts: 2, tasks: ['alpha'] },
      { agents: ['luna'], attempts: 2, tasks: ['alpha', 'beta'] },
    ],
    purpose: 'confirm',
  })
  intent.marks['luna']!['beta'] = 'pp'
  assert.deepEqual(Watch.next(settings, { evidence: state.evidence, intent }), {
    calls: [{ agents: ['sonnet', 'luna'], attempts: 2, tasks: ['alpha'] }],
    purpose: 'confirm',
  })
  intent.rounds.confirm = 1
  assert.equal(Watch.next(settings, { evidence: state.evidence, intent }), undefined)
})

test('the baseline is the attempts of the last accepted revisions, and starts again where a task changed', () => {
  const lines: Watch.Line[] = [baseline()]
  const head = (n: number, marks: (agent: string, task: string) => string) =>
    evaluate(lines, {
      marks,
      request: {
        agents,
        attempts: 2,
        pair: { nanocode: 'n' + n, nanocodeTs: 't0' },
        role: 'head',
        tasks,
      },
    })
  lines.push(head(1, () => 'p'))
  let state = Watch.replay(lines, settings)
  assert.equal(state.baseline!.pair.nanocode, 'n1')
  assert.deepEqual(state.evidence['sonnet']!['alpha'], { passed: 6, scored: 6 })
  lines.push(head(2, (agent, task) => (agent === 'sonnet' && task === 'alpha' ? 'pfpp' : 'p')))
  state = Watch.replay(lines, settings)
  assert.equal(state.baseline!.pair.nanocode, 'n2')
  assert.deepEqual(state.evidence['sonnet']!['alpha'], { passed: 5, scored: 6 })
  assert.deepEqual(state.evidence['luna']!['alpha'], { passed: 4, scored: 4 })

  const regression = head(3, (agent, task) => (agent === 'luna' && task === 'gamma' ? 'f' : 'p'))
  lines.push(regression)
  state = Watch.replay(lines, settings)
  assert.equal(regression.verdict, 'regression')
  assert.equal(state.baseline!.pair.nanocode, 'n2')
  assert.deepEqual(state.evidence['luna']!['gamma'], { passed: 4, scored: 4 })

  lines.push({ at: '2026-11-14T01:00:00Z', evaluation: regression.id, type: 'accept' })
  state = Watch.replay(lines, settings)
  assert.equal(state.baseline!.pair.nanocode, 'n3')
  assert.deepEqual(state.evidence['luna']!['gamma'], { passed: 0, scored: 4 })
  assert.deepEqual(state.evidence['luna']!['alpha'], { passed: 4, scored: 4 })

  const fixed = head(4, () => 'p')
  lines.push(fixed)
  assert.equal(fixed.verdict, 'ok')
  assert.deepEqual(
    fixed.changes.map((change) => [change.agent, change.task, change.kind]),
    [
      ['sonnet', 'alpha', 'moved'],
      ['luna', 'gamma', 'gained'],
    ],
  )
  state = Watch.replay(lines, settings)
  assert.deepEqual(state.evidence['luna']!['gamma'], { passed: 4, scored: 4 })

  const other = Watch.config({ ...file, eval: { ...file.eval, tasks: [...tasks, 'delta'] } })
  assert.equal(Watch.replay(lines, other).baseline, undefined)
  const model = Watch.config({
    ...file,
    eval: { ...file.eval, agents: ['sonnet=claude:claude-sonnet-5-5', 'luna=codex:gpt-6.1-sol'] },
  })
  assert.equal(Watch.replay(lines, model).baseline, undefined)
  const fewer = Watch.config({ ...file, eval: { ...file.eval, tasks: ['alpha'] } })
  assert.equal(Watch.replay(lines, fewer).baseline!.pair.nanocode, 'n4')
})

test('the two branches become one line of pairs by the dates of their commits', () => {
  const chains = { nanocode: chain('n', [10, 20, 40]), nanocodeTs: chain('t', [15, 20]) }
  assert.deepEqual(
    Watch.path(origin, chains).map((point) => point.pair.nanocode + ' ' + point.pair.nanocodeTs),
    ['n0 t0', 'n1 t0', 'n1 t1', 'n2 t1', 'n2 t2', 'n3 t2'],
  )
  assert.deepEqual(Watch.path(origin, chains).at(-1)!.step, {
    repository: 'nanocode',
    sha: 'n3',
    subject: 'change n3',
  })
  assert.deepEqual(Watch.head(chains), { nanocode: 'n3', nanocodeTs: 't2' })
})

test('the newest pair is evaluated first, and the first losing commit is found among the ones behind it', () => {
  const chains = {
    nanocode: chain('n', [10, 20, 30, 40, 50, 60]),
    nanocodeTs: chain('t', [25, 45]),
  }
  const marks = (pair: Watch.Pair) => (agent: string, task: string) =>
    Number(pair.nanocode.slice(1)) >= 4 && agent === 'sonnet' && task === 'beta' ? 'f' : 'p'
  const lines: Watch.Line[] = [baseline()]
  const order: string[] = []
  let culprit: Watch.Culprit | undefined
  for (;;) {
    const action = Watch.plan(settings, { chains, state: Watch.replay(lines, settings) })
    if (action.kind === 'idle') {
      culprit = action.culprit
      assert.match(action.reason, /first losing commit nanocode n4 "change n4"/)
      break
    }
    order.push(action.request.role + ' ' + Watch.key(action.request.pair))
    if (action.request.role === 'bisect') {
      assert.deepEqual(action.request.tasks, ['beta'])
      assert.deepEqual(action.request.agents, ['sonnet'])
      assert.deepEqual(action.request.lost, [{ agent: 'sonnet', task: 'beta' }])
    } else assert.deepEqual(action.request.covers, { nanocode: 6, nanocodeTs: 2 })
    lines.push(evaluate(lines, { marks: marks(action.request.pair), request: action.request }))
  }
  assert.deepEqual(order, ['head n6 t2', 'bisect n3 t1', 'bisect n4 t2', 'bisect n4 t1'])
  assert.deepEqual(culprit, {
    commits: [{ repository: 'nanocode', sha: 'n4', subject: 'change n4' }],
    good: { nanocode: 'n3', nanocodeTs: 't1' },
  })
  assert.deepEqual(
    lines.map((line) => (line.type === 'evaluation' ? line.verdict : line.type)),
    ['baseline', 'regression', 'good', 'bad', 'bad'],
  )
  assert.equal(Watch.replay(lines, settings).baseline!.pair.nanocode, 'n0')

  const off = Watch.config({ ...file, bisect: 'off' })
  const stands = Watch.plan(off, { chains, state: Watch.replay(lines.slice(0, 2), off) })
  assert.equal(stands.kind, 'idle')
  assert.match(
    (stands as { reason: string }).reason,
    /lost sonnet\/beta against nanocode n0 nanocode-ts t0, and bisect is off/,
  )
  const asked = Watch.plan(off, {
    bisect: true,
    chains,
    state: Watch.replay(lines.slice(0, 2), off),
  })
  assert.equal(asked.kind, 'evaluate')

  const more = { nanocode: chain('n', [10, 20, 30, 40, 50, 60, 70]), nanocodeTs: chains.nanocodeTs }
  const newer = Watch.plan(settings, { chains: more, state: Watch.replay(lines, settings) })
  assert.equal(newer.kind === 'evaluate' && newer.request.role, 'head')
  lines.push(
    evaluate(lines, { marks: () => 'p', request: (newer as { request: Watch.Request }).request }),
  )
  const fixed = Watch.replay(lines, settings)
  assert.equal(fixed.baseline!.pair.nanocode, 'n7')
  const still = {
    nanocode: { commits: [], head: 'n7', rewritten: false },
    nanocodeTs: { commits: [], head: 't2', rewritten: false },
  }
  assert.deepEqual(Watch.plan(settings, { chains: still, state: fixed }), {
    kind: 'idle',
    reason: 'up to date at nanocode n7 nanocode-ts t2',
  })
})

test('a build that failed is tried once more and then left, and the search goes around it', () => {
  const chains = { nanocode: chain('n', [10, 20, 30, 40]), nanocodeTs: chain('t', []) }
  const failed = (lines: readonly Watch.Line[], request: Watch.Request): Watch.Evaluation => {
    const state = Watch.replay(lines, settings)
    return Watch.conclude(settings, {
      evidence: state.evidence,
      finishedAt: '2026-11-14T00:00:09Z',
      intent: {
        baseline: state.baseline?.id ?? null,
        confirm: [],
        errors: {},
        id: 'f' + lines.length,
        marks: {},
        phase: {
          failure: { detail: 'the build ended with status 101', verdict: 'build_failed' },
          kind: 'failed',
        },
        queue: [],
        request,
        rounds: { build: 1, confirm: 0, errored: 0, main: 0 },
        startedAt: '',
        steps: [
          {
            exit: 101,
            finishedAt: '',
            log: '/state/logs/build.log',
            purpose: 'build',
            startedAt: '',
            usd: 0,
          },
        ],
        usage: {},
      },
    })
  }
  const lines: Watch.Line[] = [baseline()]
  const plan = () => Watch.plan(settings, { chains, state: Watch.replay(lines, settings) })
  const first = plan() as { kind: 'evaluate'; request: Watch.Request }
  lines.push(failed(lines, first.request))
  assert.equal((lines.at(-1) as Watch.Evaluation).verdict, 'build_failed')
  const second = plan()
  assert.deepEqual(second, first)
  lines.push(failed(lines, first.request))
  const third = plan()
  assert.deepEqual(third, {
    kind: 'idle',
    reason:
      'nanocode n4 nanocode-ts t0 is not tried again: its build failed 2 times, log /state/logs/build.log',
  })
  lines.push({ at: '2026-11-14T02:00:00Z', type: 'retry' })
  assert.deepEqual(plan(), first)

  lines.push(
    evaluate(lines, {
      marks: (agent, task) => (agent === 'luna' && task === 'alpha' ? 'f' : 'p'),
      request: first.request,
    }),
  )
  const middle = plan() as { kind: 'evaluate'; request: Watch.Request }
  assert.equal(middle.request.pair.nanocode, 'n2')
  lines.push(failed(lines, middle.request), failed(lines, middle.request))
  const around = plan() as { kind: 'evaluate'; request: Watch.Request }
  assert.equal(around.request.pair.nanocode, 'n1')
  lines.push(evaluate(lines, { marks: () => 'p', request: around.request }))
  const last = plan() as { kind: 'evaluate'; request: Watch.Request }
  assert.equal(last.request.pair.nanocode, 'n3')
  lines.push(evaluate(lines, { marks: () => 'f', request: last.request }))
  const end = plan()
  assert.equal(end.kind, 'idle')
  assert.deepEqual(
    (end as { culprit: Watch.Culprit }).culprit.commits.map((commit) => commit.sha),
    ['n2', 'n3'],
  )
  assert.match((end as { reason: string }).reason, /one of 2 that could not be told apart/)
})

test('runs stop for the day at the cap in runs or in dollars, counted with what is reserved', () => {
  const step = (purpose: Watch.Purpose, at: { startedAt: string; usd: number }): Watch.Step => ({
    exit: 0,
    finishedAt: at.startedAt,
    log: 'log',
    purpose,
    ...at,
  })
  const steps = [
    step('build', { startedAt: '2026-11-14T01:00:00Z', usd: 0 }),
    step('main', { startedAt: '2026-11-14T01:01:00Z', usd: 0.25 }),
    step('confirm', { startedAt: '2026-11-14T23:59:59Z', usd: 1 }),
    step('main', { startedAt: '2026-11-15T00:00:00Z', usd: 0.5 }),
  ]
  assert.deepEqual(Watch.spend(steps, '2026-11-14'), { runs: 2, usd: 1.25 })
  assert.deepEqual(Watch.spend(steps, '2026-11-15'), { runs: 1, usd: 0.5 })
  const budget = { dailyRuns: 3, dailyUsd: 2, runUsd: 1 }
  assert.equal(Watch.admit(budget, { runs: 2, usd: 1 }), undefined)
  assert.match(Watch.admit(budget, { runs: 3, usd: 0 })!, /3 of the 3 runs of the day are used/)
  assert.match(Watch.admit(budget, { runs: 1, usd: 1.25 })!, /\$1.2500 of the \$2 of the day/)
})

test('the scoreboard and the line of a verdict say what was lost, what it cost and what stands', () => {
  const chains = { nanocode: chain('n', [10, 20]), nanocodeTs: chain('t', []) }
  const lines: Watch.Line[] = [baseline()]
  const head = (
    Watch.plan(settings, { chains, state: Watch.replay(lines, settings) }) as {
      request: Watch.Request
    }
  ).request
  const state = Watch.replay(lines, settings)
  const regression = evaluate(lines, {
    marks: (agent, task) => (agent === 'luna' && task === 'gamma' ? 'f' : 'p'),
    request: head,
  })
  lines.push(regression)
  assert.equal(
    Watch.sentence(regression),
    'nanocode n2 nanocode-ts t0: REGRESSION, lost luna/gamma 4/4 -> 0/4 (p 0.014); ' +
      'sonnet pass@1 100.0% pass@2 100.0%; luna pass@1 66.7% pass@2 66.7%; 2 runs, $0.1400',
  )
  const after = Watch.replay(lines, settings)
  const found = Watch.search(settings, { chains, regression, state: after })
  assert.deepEqual('pair' in found && found.pair, { nanocode: 'n1', nanocodeTs: 't0' })
  const bisect = (Watch.plan(settings, { chains, state: after }) as { request: Watch.Request })
    .request
  const good = evaluate(lines, { marks: () => 'p', request: bisect })
  const closed = Watch.search(settings, {
    chains,
    regression,
    state: Watch.replay([...lines, good], settings),
  })
  assert.ok('culprit' in closed)
  lines.push({ ...good, culprit: closed.culprit })
  assert.equal(
    Watch.sentence(lines.at(-1) as Watch.Evaluation),
    'nanocode n1 nanocode-ts t0: bisect, loses nothing; first losing commit nanocode n2 "change n2"; ' +
      'luna pass@1 100.0% pass@2 100.0%; 1 run, $0.0200',
  )
  const board = Watch.scoreboard(settings, { at: '2026-11-14T03:00:00Z', lines })
  assert.match(board, /^# nanoeval watch\n/)
  assert.match(
    board,
    /Eval bench, 3 tasks \(alpha, beta, gamma\), 2 attempts a task, agents sonnet \(claude:claude-sonnet-5-5\), luna \(codex:gpt-6-luna\)/,
  )
  assert.match(board, /## Baseline\n\nnanocode n0 nanocode-ts t0, accepted/)
  assert.match(board, /\| gamma \| 4\/4 \| 4\/4 \|/)
  assert.match(
    board,
    /## Standing regression\n\nnanocode n2 nanocode-ts t0 \(evaluation e2\) lost luna\/gamma 4\/4 -> 0\/4 \(p 0.014\)\. The first losing commit nanocode n2 "change n2"\./,
  )
  assert.match(
    board,
    /\| n2 \| t0 \| watch \| regression, covers 2 \+ 0 commits \| luna \| 66.7% \| 66.7% @2 \|  \| gamma \| 8,000 \(3,200\) \| 400 \| \$0.0800 \| 2 \|/,
  )
  assert.match(board, /\| n0 \| t0 \| watch \| baseline \| sonnet \| 100.0% \| 100.0% @2 \|/)
  assert.ok(board.indexOf('| n1 | t0 | bisect |') < board.indexOf('| n2 | t0 | watch |'))

  const text = Watch.comparison(settings, { evidence: state.evidence, line: regression, state })
  assert.match(text, /against the baseline nanocode n0 nanocode-ts t0/)
  assert.match(
    text,
    /\| luna \| codex:gpt-6-luna \| 100.0% -> 66.7% \| 100.0% -> 66.7% \| 4 \| 4 \| 0 \|/,
  )
  assert.match(text, /\| gamma \| 4\/4 \| 2\/2 pp \|  \| 4\/4 \| 0\/4 ffff \| lost \(p 0.014\) \|/)
})
