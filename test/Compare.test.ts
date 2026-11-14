import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as Atif from '../src/Atif.ts'
import * as Compare from '../src/Compare.ts'
import type * as Result from '../src/Result.ts'

const usage: Atif.Usage = {
  cacheWriteTokens: 0,
  cachedTokens: 100,
  costUsd: undefined,
  inputTokens: 300,
  modelCalls: 2,
  outputTokens: 20,
  toolCalls: 2,
}

function attempt(
  agent: Result.Attempt['agent'],
  input: { n: number; outcome: Result.Attempt['outcome']; task: string; usage: Atif.Usage | null },
): Result.Attempt {
  return {
    agent,
    ...(input.outcome === 'errored'
      ? { failure: { at: 0, kind: 'agent' as const, message: 'it exited with 1' } }
      : {}),
    finishedAt: 100_000,
    id: 'a0000' + input.n,
    index: 1,
    outcome: input.outcome,
    reward: input.outcome === 'errored' ? null : input.outcome === 'passed' ? 1 : 0,
    sandbox: null,
    session: 's',
    startedAt: 10_000,
    task: { checksum: 'c', name: 'bench/' + input.task },
    timing: { agentExecution: { finishedAt: 80_000, startedAt: 20_000 } },
    usage: input.usage,
  }
}

test('a comparison has one row per agent across runs, and says what is not known', () => {
  const nano = { id: 'nano', model: 'gpt-6.1-sol', provider: 'codex' as const, thinking: 'high' }
  const cli = { id: 'cli', model: 'gpt-6.1-sol', provider: 'codex-cli' as const, thinking: 'high' }
  const runs: Compare.Run[] = [
    {
      attempts: [
        attempt(nano, { n: 1, outcome: 'passed', task: 'one', usage: { ...usage, costUsd: 0.5 } }),
        attempt(cli, { n: 2, outcome: 'failed', task: 'one', usage }),
      ],
      eval: { name: 'bench', version: '0123456789abcdef' },
      id: 'run-1',
      name: 'first',
      state: 'finished',
    },
    {
      attempts: [
        attempt(nano, { n: 1, outcome: 'errored', task: 'two', usage: null }),
        attempt(cli, { n: 2, outcome: 'passed', task: 'two', usage }),
      ],
      eval: { name: 'bench', version: '0123456789abcdef' },
      id: 'run-2',
      name: 'second',
      state: 'running',
    },
  ]
  const [first, second] = Compare.arms(runs)
  assert.deepEqual(
    [first!.agent, first!.harness, first!.model, first!.attempts, first!.passed, first!.errored],
    ['nano', 'nanocode', 'codex:gpt-6.1-sol:high', 2, 1, 1],
  )
  assert.deepEqual(
    [first!.costUsd, first!.priced, first!.metered, first!.runs],
    [0.5, 1, 1, ['run-1', 'run-2']],
  )
  assert.deepEqual(
    [second!.agent, second!.harness, second!.model, second!.failed, second!.costUsd, second!.tasks],
    ['cli', 'codex-cli 0.166.0', 'codex:gpt-6.1-sol:high', 1, null, 2],
  )
  assert.equal(second!.agentSec, 120)
  assert.equal(second!.inputTokens, 600)

  const table = Compare.table(runs)
  assert.match(table, /^run run-1 \(first\): finished, bench@0123456789ab, 2 attempts ended$/m)
  assert.match(
    table,
    /^\| nano \| nanocode \| codex:gpt-6\.1-sol:high \| 2 \| 1 \| 0 \| 1 \| 2 min 0 s \| 3 min 0 s \| 300 \(100\) \| 20 \| \$0\.5000 for 1 of 2 \|$/m,
  )
  assert.match(
    table,
    /^\| cli \| codex-cli 0\.166\.0 \| codex:gpt-6\.1-sol:high \| 2 \| 1 \| 1 \| 0 \| 2 min 0 s \| 3 min 0 s \| 600 \(200\) \| 40 \| not known \|$/m,
  )
  assert.match(table, /^\| one \| passed 1 min 0 s \| failed 1 min 0 s \|$/m)
  assert.match(table, /^\| two \| errored \(agent\) 1 min 0 s \| passed 1 min 0 s \|$/m)
})

test('a direct-tools codex agent is its own arm beside the code-mode one', () => {
  const nanox = { id: 'nanox', model: 'gpt-6-luna', provider: 'codex' as const, thinking: 'high' }
  const nanoxd = { ...nanox, id: 'nanoxd', orchestration: 'direct' as const }
  const runs: Compare.Run[] = [
    {
      attempts: [
        attempt(nanox, { n: 1, outcome: 'passed', task: 'one', usage }),
        attempt(nanoxd, { n: 2, outcome: 'failed', task: 'one', usage }),
      ],
      eval: { name: 'bench', version: '0123456789abcdef' },
      id: 'run-1',
      name: 'arms',
      state: 'finished',
    },
  ]
  assert.deepEqual(
    Compare.arms(runs).map((arm) => [arm.agent, arm.harness, arm.model, arm.passed, arm.failed]),
    [
      ['nanox', 'nanocode', 'codex:gpt-6-luna:high', 1, 0],
      ['nanoxd', 'nanocode', 'codex-direct:gpt-6-luna:high', 0, 1],
    ],
  )
})

test('runs of one agent on different nanocode revisions are separate rows, and a run is set against a baseline', () => {
  const luna = { id: 'luna', model: 'gpt-6-luna', provider: 'codex' as const }
  const priced = { ...usage, costUsd: 0.25 }
  const at = (n: number, index: number, outcome: Result.Attempt['outcome'], task: string) => ({
    ...attempt(luna, { n, outcome, task, usage: priced }),
    index,
  })
  const baseline: Compare.Run = {
    attempts: [
      at(1, 1, 'passed', 'kept'),
      at(2, 2, 'passed', 'kept'),
      at(3, 1, 'passed', 'broken'),
      at(4, 2, 'failed', 'broken'),
      at(5, 1, 'failed', 'fixed'),
      at(6, 2, 'failed', 'fixed'),
      at(7, 1, 'failed', 'hard'),
      at(8, 2, 'errored', 'hard'),
      at(9, 1, 'passed', 'dropped'),
    ],
    eval: { name: 'bench', version: '0123456789abcdef' },
    id: 'run-old',
    name: 'pins',
    nanocode: { hands: ['nanocode-cli-1234567'], harness: 'nanocode-ts build-abcdef0' },
    state: 'finished',
  }
  const run: Compare.Run = {
    attempts: [
      at(1, 1, 'passed', 'kept'),
      at(2, 2, 'failed', 'kept'),
      at(3, 1, 'failed', 'broken'),
      at(4, 2, 'failed', 'broken'),
      at(5, 1, 'failed', 'fixed'),
      at(6, 2, 'passed', 'fixed'),
      at(7, 1, 'failed', 'hard'),
      at(8, 2, 'failed', 'hard'),
      at(9, 1, 'passed', 'added'),
      at(10, 2, 'passed', 'added'),
    ],
    eval: { name: 'bench', version: '0123456789abcdef' },
    id: 'run-new',
    name: 'master',
    nanocode: {
      hands: ['nanocode 0123456789ab'],
      harness: 'nanocode-ts fedcba987654 on nanocode 0123456789ab',
    },
    state: 'finished',
  }

  const [old, now] = Compare.arms([baseline, run])
  assert.deepEqual(
    [old!.harness, old!.runs, old!.passed, now!.harness, now!.runs, now!.passed],
    [
      'nanocode-ts build-abcdef0, hand nanocode-cli-1234567',
      ['run-old'],
      4,
      'nanocode-ts fedcba987654 on nanocode 0123456789ab, hand nanocode 0123456789ab',
      ['run-new'],
      4,
    ],
  )
  const table = Compare.table([baseline, run])
  assert.match(
    table,
    /^run run-new \(master\): finished, bench@0123456789ab, 10 attempts ended, nanocode-ts fedcba987654 on nanocode 0123456789ab, hand nanocode 0123456789ab$/m,
  )
  assert.match(table, /^\| Task \| luna of run-old \| luna of run-new \|$/m)
  assert.match(
    table,
    /^\| fixed \| failed 1 min 0 s, failed 1 min 0 s \| failed 1 min 0 s, passed 1 min 0 s \|$/m,
  )
  assert.match(table, /^\| added \| not run \| passed 1 min 0 s, passed 1 min 0 s \|$/m)

  const [change] = Compare.changes(baseline, run)
  assert.deepEqual(
    change!.tasks.map((task) => [task.name, task.moved, task.chance]),
    [
      ['added', 'only-run', undefined],
      ['broken', 'down', 0.5],
      ['dropped', 'only-baseline', undefined],
      ['fixed', 'up', 0.5],
      ['hard', 'same', undefined],
      ['kept', 'down', 0.5],
    ],
  )
  assert.deepEqual(change!.tasks[1]!.baseline, { errored: 0, passed: 1, scored: 2 })
  assert.deepEqual(change!.tasks[4]!.baseline, { errored: 1, passed: 0, scored: 1 })
  assert.deepEqual(
    [change!.overall.verdict, change!.overall.worse, change!.overall.better, change!.overall.tasks],
    ['none', 0.5, 0.875, 4],
  )
  assert.deepEqual([change!.overall.down, change!.overall.up, change!.overall.same], [2, 1, 1])
  assert.deepEqual(change!.common.rated, { '1': 4, '2': 3 })
  assert.deepEqual(change!.common.baseline, { '1': 0.375, '2': 2 / 3 })
  assert.deepEqual(change!.common.run, { '1': 0.25, '2': 2 / 3 })
  assert.equal(Compare.regressed([change!], 'lost'), false)

  const against = Compare.against(baseline, run)
  assert.match(against, /^luna: run run-new against the baseline run-old$/m)
  assert.match(
    against,
    /^\| nanocode \| nanocode-ts build-abcdef0, hand nanocode-cli-1234567 \| nanocode-ts fedcba987654 on nanocode 0123456789ab, hand nanocode 0123456789ab \|$/m,
  )
  assert.match(against, /^\| Attempts \| 9 \| 10 \|$/m)
  assert.match(against, /^\| Passed \| 4 \| 4 \|$/m)
  assert.match(against, /^\| Errored \| 1 \| 0 \|$/m)
  assert.match(against, /^\| pass@1 \| 50\.0% \| 40\.0% \|$/m)
  assert.match(against, /^\| pass@2 \| 66\.7% of 3 tasks \| 60\.0% \|$/m)
  assert.match(against, /^\| pass@1 on the 4 tasks both sides rate \| 37\.5% \| 25\.0% \|$/m)
  assert.match(against, /^\| pass@2 on the 3 tasks both sides rate \| 66\.7% \| 66\.7% \|$/m)
  assert.match(against, /^\| Input tokens \(cached\) \| 2,700 \(900\) \| 3,000 \(1,000\) \|$/m)
  assert.match(against, /^\| Cost \| \$2\.2500 \| \$2\.5000 \|$/m)
  assert.match(against, /^lost: none$/m)
  assert.match(against, /^gained: none$/m)
  assert.match(
    against,
    /^moved, within noise: broken \(1\/2 to 0\/2, p = 0\.500\), fixed \(0\/2 to 1\/2, p = 0\.500\), kept \(2\/2 to 1\/2, p = 0\.500\)$/m,
  )
  assert.match(against, /^same on both sides: 1 task; solved on both sides: 1, on neither: 1$/m)
  assert.match(against, /^not in the baseline: added$/m)
  assert.match(against, /^only in the baseline: dropped$/m)
  assert.match(
    against,
    /^verdict: no change beyond noise: of the 4 tasks scored on both sides 2 moved down and 1 up \(p = 0\.500 for worse, p = 0\.875 for better\)$/m,
  )
  assert.match(
    against,
    /^rule: lost, gained, regression and improvement are called when .* at most 1 time in 20$/m,
  )
  assert.match(
    against,
    /^with these attempts no single task can be called, its chance cannot fall under 0\.167: one task that flips is not evidence$/m,
  )

  const other: Compare.Run = {
    ...run,
    attempts: [
      attempt({ ...luna, id: 'sol' }, { n: 1, outcome: 'passed', task: 'kept', usage: null }),
    ],
  }
  assert.match(Compare.against(baseline, other), /^\| Attempts \| not run \| 1 \|$/m)
  assert.match(Compare.against(baseline, other), /^the baseline has no agent sol$/m)
})

test('a row that a rerun retried counts once, as its retry, and a run named twice counts once', () => {
  const nano = { id: 'nano', model: 'gpt-6.1-sol', provider: 'codex' as const }
  const first: Compare.Run = {
    attempts: [
      attempt(nano, { n: 1, outcome: 'failed', task: 'one', usage }),
      attempt(nano, { n: 2, outcome: 'errored', task: 'two', usage: null }),
      attempt(nano, { n: 3, outcome: 'passed', task: 'three', usage }),
    ],
    eval: { name: 'bench', version: '0123456789abcdef' },
    id: 'run-1',
    name: 'first',
    state: 'finished',
  }
  const rerun: Compare.Run = {
    attempts: [
      {
        ...attempt(nano, { n: 1, outcome: 'passed', task: 'one', usage }),
        retryOf: { attempt: 'a00001', run: 'run-1' },
      },
      {
        ...attempt(nano, { n: 2, outcome: 'errored', task: 'two', usage: null }),
        retryOf: { attempt: 'a00002', run: 'run-1' },
      },
    ],
    eval: { name: 'bench', version: '0123456789abcdef' },
    id: 'run-2',
    name: 'again',
    state: 'finished',
  }
  const counts = (runs: readonly Compare.Run[]) => {
    const [arm] = Compare.arms(runs)
    return [arm!.attempts, arm!.passed, arm!.failed, arm!.errored, arm!.inputTokens]
  }
  assert.deepEqual(counts([first]), [3, 1, 1, 1, 600])
  assert.deepEqual(counts([first, rerun]), [3, 2, 0, 1, 600])
  assert.deepEqual(counts([rerun, first, first]), [3, 2, 0, 1, 600])
  assert.deepEqual(counts([rerun]), [2, 1, 0, 1, 300])

  const table = Compare.table([first, rerun, first])
  assert.equal(table.split('\n').filter((line) => line.startsWith('run ')).length, 2)
  assert.match(
    table,
    /run run-1 \(first\): finished, bench@0123456789ab, 3 attempts ended, 2 of them retried by a run of this table and left out/,
  )
  assert.match(table, /run run-2 \(again\): finished, bench@0123456789ab, 2 attempts ended\n/)
  assert.match(table, /\| one \| passed 1 min 0 s \|/)
  assert.match(table, /\| two \| errored \(agent\) 1 min 0 s \|/)
})

const one = { id: 'one', model: 'm', provider: 'claude' as const }

function side(id: string, tasks: Record<string, string>, retries?: string): Compare.Run {
  let n = 0
  return {
    attempts: Object.entries(tasks).flatMap(([task, outcomes]) =>
      [...outcomes].map((letter, at) => ({
        ...attempt(one, {
          n: ++n,
          outcome: letter === 'P' ? 'passed' : letter === 'F' ? 'failed' : 'errored',
          task,
          usage: null,
        }),
        id: id + '-' + task + '-' + (at + 1),
        index: at + 1,
        ...(retries
          ? { retryOf: { attempt: retries + '-' + task + '-' + (at + 1), run: retries } }
          : {}),
      })),
    ),
    eval: { name: 'bench', version: '0123456789abcdef' },
    id,
    name: id,
    state: 'finished',
  }
}

test('three attempts a side: a task is lost only when its counts say so, and an error is no verdict', () => {
  const baseline = side('old', {
    broken: 'PPP',
    dropped: 'PPP',
    fixed: 'FFF',
    flaky: 'PPF',
    kept: 'PPP',
    shaky: 'PPE',
    unread: 'PPF',
  })
  const run = side('new', {
    added: 'PPP',
    broken: 'FFF',
    fixed: 'PPP',
    flaky: 'PFF',
    kept: 'PPP',
    shaky: 'PEE',
    unread: 'EEE',
  })
  const [change] = Compare.changes(baseline, run)
  assert.deepEqual(
    change!.tasks.map((task) => [task.name, task.moved, task.chance]),
    [
      ['added', 'only-run', undefined],
      ['broken', 'lost', 1 / 20],
      ['dropped', 'only-baseline', undefined],
      ['fixed', 'gained', 1 / 20],
      ['flaky', 'down', 1 / 2],
      ['kept', 'same', undefined],
      ['shaky', 'same', undefined],
      ['unread', 'unscored', undefined],
    ],
  )
  assert.equal(change!.overall.tasks, 5)
  assert.ok(Math.abs(change!.overall.worse - 0.5) < 1e-12)
  assert.ok(Math.abs(change!.overall.better - (0.5 + 2484 / 8000)) < 1e-12)
  assert.equal(change!.overall.verdict, 'none')
  assert.equal(change!.overall.floor, 1 / 20)
  assert.equal(Compare.regressed([change!], 'regression'), false)
  assert.equal(Compare.regressed([change!], 'lost'), true)

  const against = Compare.against(baseline, run)
  assert.match(against, /^lost: broken \(3\/3 to 0\/3, p = 0\.050\)$/m)
  assert.match(against, /^gained: fixed \(0\/3 to 3\/3, p = 0\.050\)$/m)
  assert.match(against, /^moved, within noise: flaky \(2\/3 to 1\/3, p = 0\.500\)$/m)
  assert.match(against, /^no verdict on a side, so not compared: unread \(2\/3 to 3 errored\)$/m)
  assert.match(against, /^same on both sides: 2 tasks; solved on both sides: 3, on neither: 0$/m)
  assert.match(against, /^\| pass@1 \| 76\.2% \| 72\.2% of 6 tasks \|$/m)
  assert.match(against, /^\| pass@1 on the 5 tasks both sides rate \| 73\.3% \| 66\.7% \|$/m)
  assert.match(against, /^\| pass@3 on the 4 tasks both sides rate \| 75\.0% \| 75\.0% \|$/m)
  assert.match(
    against,
    /^verdict: no change beyond noise: of the 5 tasks scored on both sides 2 moved down and 1 up \(p = 0\.500 for worse, p = 0\.810 for better\)$/m,
  )
  assert.doesNotMatch(against, /no single task can be called/)
})

test('one attempt a side: no task is called, and five that flip one way are a regression', () => {
  const tasks = (outcomes: string) =>
    Object.fromEntries([...outcomes].map((letter, at) => ['t' + (at + 1), letter]))
  const baseline = side('old', tasks('PPPPPPF'))
  const [five] = Compare.changes(baseline, side('new', tasks('FFFFFPF')))
  assert.deepEqual([five!.overall.verdict, five!.overall.worse], ['regression', 1 / 32])
  assert.equal(five!.tasks.filter((task) => task.moved === 'lost').length, 0)
  assert.equal(five!.tasks.filter((task) => task.moved === 'down').length, 5)
  assert.equal(Compare.regressed([five!], 'regression'), true)
  const against = Compare.against(baseline, side('new', tasks('FFFFFPF')))
  assert.match(against, /^lost: none$/m)
  assert.match(
    against,
    /^verdict: regression: of the 7 tasks scored on both sides 5 moved down and 0 up \(p = 0\.031 for worse, p = 1\.000 for better\)$/m,
  )
  assert.match(against, /cannot fall under 0\.500: one task that flips is not evidence$/m)
  const [four] = Compare.changes(baseline, side('new', tasks('FFFFPPF')))
  assert.deepEqual([four!.overall.verdict, four!.overall.worse], ['none', 1 / 16])
  const [mixed] = Compare.changes(baseline, side('new', tasks('FFFFPPP')))
  assert.deepEqual([mixed!.overall.verdict, mixed!.overall.worse], ['none', 6 / 32])
  const [up] = Compare.changes(side('new', tasks('FFFFFPF')), baseline)
  assert.deepEqual([up!.overall.verdict, up!.overall.better], ['improvement', 1 / 32])
})

test('a side is a run with its reruns, and two runs of the same rows are two arms', () => {
  const first = side('old', { one: 'PPF', two: 'EEE' })
  const rerun: Compare.Run = {
    ...side('again', { two: 'PPP' }, 'old'),
  }
  const second = side('new', { one: 'PPF', two: 'PPP' })
  const [alone] = Compare.changes(first, second)
  assert.deepEqual(
    alone!.tasks.map((task) => task.moved),
    ['same', 'unscored'],
  )
  const [both] = Compare.changes([first, rerun], second)
  assert.deepEqual(
    both!.tasks.map((task) => [task.moved, task.baseline]),
    [
      ['same', { errored: 0, passed: 2, scored: 3 }],
      ['same', { errored: 0, passed: 3, scored: 3 }],
    ],
  )
  assert.deepEqual(
    [both!.baseline!.attempts, both!.baseline!.passed, both!.baseline!.errored],
    [6, 5, 0],
  )
  assert.match(
    Compare.against([first, rerun], second),
    /^one: run new against the baseline old with again$/m,
  )
  assert.deepEqual(
    Compare.lineages([second, first, rerun]).map((runs) => runs.map((run) => run.id)),
    [['new'], ['old', 'again']],
  )
  assert.deepEqual(
    Compare.arms([first, rerun, second]).map((arm) => [arm.runs, arm.attempts, arm.passed]),
    [
      [['old', 'again'], 6, 5],
      [['new'], 6, 5],
    ],
  )
  assert.match(
    Compare.table([first, rerun, second]),
    /^\| Task \| one of old and again \| one of new \|$/m,
  )
})

test('the cost of a judge is a column of the table and a row of a comparison, where a run had one', () => {
  const judged = (id: string, costUsd: number): Compare.Run => {
    const run = side(id, { one: 'PF', two: 'PP' })
    return {
      ...run,
      attempts: run.attempts.map((each) => ({
        ...each,
        judge: {
          model: 'claude-haiku-4-5',
          provider: 'claude' as const,
          requests: 1,
          usage: { ...usage, costUsd },
        },
      })),
    }
  }
  const plain = side('plain', { one: 'PF', two: 'PP' })
  const table = Compare.table([judged('old', 0.0028), plain])
  assert.match(table, /\| Estimated cost \| Judge cost \|$/m)
  assert.match(table, /^\| one of old \|.*\| \$0\.0112 \|$/m)
  assert.match(table, /^\| one of plain \|.*\| no judge \|$/m)
  assert.doesNotMatch(Compare.table([plain]), /Judge cost/)
  assert.match(
    Compare.against(judged('old', 0.0028), judged('new', 0.005)),
    /^\| Judge cost \| \$0\.0112 \| \$0\.0200 \|$/m,
  )
  assert.doesNotMatch(Compare.against(plain, side('other', { one: 'PF', two: 'PP' })), /Judge cost/)
})
