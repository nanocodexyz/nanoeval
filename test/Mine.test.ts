import assert from 'node:assert/strict'
import { test } from 'node:test'
import type * as Atif from '../src/Atif.ts'
import * as Mine from '../src/Mine.ts'
import type * as Result from '../src/Result.ts'

type Call = { content: string; exit?: number; name: string; status?: string }

function trajectory(
  calls: readonly Call[],
  final: string,
  modelCalls = calls.length + 1,
): Atif.Trajectory {
  const steps: Atif.Step[] = calls.map((call, index) => ({
    message: '',
    observation: {
      results: [
        {
          content: call.content,
          extra: {
            duration_ns: 1,
            status: call.status ?? 'completed',
            ...(call.exit === undefined ? {} : { exit_code: call.exit }),
          },
          source_call_id: 'c' + index,
        },
      ],
    },
    source: 'agent',
    step_id: index + 1,
    tool_calls: [{ arguments: {}, function_name: call.name, tool_call_id: 'c' + index }],
    ...(index < modelCalls
      ? { metrics: { cached_tokens: 0, completion_tokens: 1, extra: {}, prompt_tokens: 1 } }
      : {}),
  }))
  const extra = Array.from({ length: Math.max(0, modelCalls - calls.length) }, (_, index) => ({
    message: index === modelCalls - calls.length - 1 ? final : '',
    metrics: { cached_tokens: 0, completion_tokens: 1, extra: {}, prompt_tokens: 1 },
    source: 'agent' as const,
    step_id: calls.length + index + 1,
  }))
  return {
    agent: { extra: {}, model_name: 'm', name: 'nanocode', version: '1' },
    final_metrics: {
      extra: { cache_write_input_tokens: 0, model_calls: modelCalls, tool_calls: calls.length },
      total_cached_tokens: 0,
      total_completion_tokens: 0,
      total_prompt_tokens: 0,
      total_steps: steps.length + extra.length,
    },
    schema_version: 'ATIF-v1.7',
    session_id: 's',
    steps: [...steps, ...extra],
  }
}

function side(input: {
  agent?: string
  failure?: Result.Failure
  outcome?: Result.Attempt['outcome']
  trajectory: Atif.Trajectory | null
  verifier?: string
}): Mine.Side {
  return {
    agent: input.agent ?? 'nanox',
    attempt: 'a00001',
    durationSec: 10,
    failure: input.failure ?? null,
    outcome: input.outcome ?? 'failed',
    run: 'r',
    summary: input.trajectory ? Mine.summarize(input.trajectory, 40) : null,
    verifierTail: input.verifier ?? '',
  }
}

const bash = (content: string, exit = 0): Call => ({ content, exit, name: 'bash' })
const passing = side({
  agent: 'cx',
  outcome: 'passed',
  trajectory: trajectory([bash('ok'), bash('ok'), bash('ok'), bash('ok')], 'done'),
})

test('a failure is classed by the strongest evidence in its attempt and trajectory', () => {
  const cases: [Mine.Class, Mine.Side][] = [
    [
      'timeout',
      side({
        failure: { at: 1, kind: 'agent_timeout', message: 'after 900 s' },
        trajectory: trajectory([bash('ok')], ''),
      }),
    ],
    [
      'harness_error',
      side({
        failure: { at: 1, kind: 'internal', message: 'lost' },
        outcome: 'errored',
        trajectory: null,
      }),
    ],
    ['harness_error', side({ trajectory: null })],
    [
      'environment',
      side({
        failure: { at: 1, kind: 'environment', message: 'disk' },
        outcome: 'errored',
        trajectory: trajectory([], ''),
      }),
    ],
    [
      'environment',
      side({
        trajectory: trajectory(
          [
            bash('apt: E: Unable to locate package x', 100),
            bash('No space left on device', 1),
            bash('ok'),
            bash('ok'),
          ],
          'done',
        ),
      }),
    ],
    [
      'prompt_tool_mismatch',
      side({
        trajectory: trajectory(
          [
            { content: 'unknown tool: apply_patch', name: 'apply_patch', status: 'error' },
            bash('ok'),
            bash('ok'),
            bash('ok'),
          ],
          'done',
        ),
      }),
    ],
    [
      'code_mode_overhead',
      side({
        trajectory: trajectory(
          [
            { content: 'Script failed: SyntaxError: x', name: 'exec' },
            { content: 'Script failed', name: 'exec' },
            bash('ok'),
            bash('ok'),
          ],
          'done',
        ),
      }),
    ],
    [
      'give_up',
      side({
        trajectory: trajectory(
          [bash('ok'), bash('ok'), bash('ok'), bash('ok')],
          'I was unable to finish the interpreter in time.',
        ),
      }),
    ],
    ['give_up', side({ trajectory: trajectory([bash('ok')], 'Done.') })],
    [
      'tool_selection',
      side({
        trajectory: trajectory(
          [bash('err', 1), bash('err', 2), bash('err', 1), bash('err', 1), bash('ok')],
          'done',
        ),
      }),
    ],
    [
      'wrong_solution',
      side({
        trajectory: trajectory([bash('ok'), bash('ok'), bash('ok'), bash('ok')], 'done'),
        verifier: 'FAILED test_x\n1 failed',
      }),
    ],
  ]
  for (const [expected, failed] of cases)
    assert.equal(
      Mine.classify({ competitor: passing, failed, task: 't' }).class,
      expected,
      JSON.stringify(failed.summary),
    )
})

test('Code Mode with many more model calls than the passing competitor is overhead', () => {
  const failed = side({
    trajectory: trajectory(
      [{ content: 'ok', name: 'exec' }, bash('ok'), bash('ok'), bash('ok')],
      'done',
      20,
    ),
  })
  const verdict = Mine.classify({ competitor: passing, failed, task: 't' })
  assert.equal(verdict.class, 'code_mode_overhead')
  assert.match(verdict.reason, /20 model calls against 5/)
})

test('subagent trajectories are summarized with their parent', () => {
  const parent = trajectory([bash('ok')], 'done')
  parent.subagent_trajectories = [trajectory([bash('timed out after 600 s', 124)], '')]
  const summary = Mine.summarize(parent, 20)
  assert.equal(summary.toolCalls, 2)
  assert.equal(summary.timedOutCalls.length, 1)
  assert.equal(summary.failedCalls, 1)
  assert.equal(summary.toolSeconds['bash'], 2e-9)
})

function attempt(
  run: string,
  agent: string,
  task: string,
  outcome: Result.Attempt['outcome'],
  id: string,
): Result.Attempt & { run: string } {
  return {
    agent: { id: agent, model: 'm', provider: 'codex' },
    finishedAt: 0,
    id,
    index: 0,
    outcome,
    reward: outcome === 'passed' ? 1 : 0,
    run,
    sandbox: null,
    session: 's',
    startedAt: 0,
    task: { checksum: 'c', name: task },
    timing: {},
    usage: null,
  }
}

test('a failure is paired with a passing competitor of the same run first, then of another run, then a passing nano attempt', () => {
  const all = [
    attempt('r1', 'nanox', 'a', 'failed', '1'),
    attempt('r2', 'cx', 'a', 'passed', '2'),
    attempt('r1', 'cx', 'a', 'passed', '3'),
    attempt('r1', 'nanox', 'b', 'errored', '4'),
    attempt('r1', 'nanox', 'b', 'passed', '5'),
    attempt('r1', 'nanox', 'c', 'failed', '6'),
    attempt('r1', 'cx', 'c', 'failed', '7'),
  ]
  const pairs = Mine.pair(all, /^nano/)
  assert.deepEqual(
    pairs.map((found) => [found.failed.id, found.competitor?.id ?? null]),
    [
      ['1', '3'],
      ['4', '5'],
      ['6', null],
    ],
  )
})

test('the report ranks classes by count and keeps example attempts', () => {
  const failed = side({ trajectory: null })
  const verdict = (name: Mine.Class): Mine.Verdict => ({
    class: name,
    reason: 'r',
    scores: {} as Record<Mine.Class, number>,
    source: 'heuristic',
  })
  const cases: Mine.Classified[] = [
    {
      competitor: passing,
      failed: { ...failed, attempt: 'a1' },
      task: 'x',
      verdict: verdict('timeout'),
    },
    {
      competitor: null,
      failed: { ...failed, attempt: 'a2' },
      task: 'y',
      verdict: verdict('timeout'),
    },
    {
      competitor: passing,
      failed: { ...failed, attempt: 'a3' },
      task: 'x',
      verdict: verdict('give_up'),
    },
  ]
  const value = Mine.report(cases, { examples: 1, runs: ['r'] })
  assert.deepEqual(
    value.classes.map((entry) => [entry.class, entry.count, entry.examples.length]),
    [
      ['timeout', 2, 1],
      ['give_up', 1, 1],
    ],
  )
  assert.equal(value.withoutCompetitor, 1)
  assert.deepEqual(value.tasks[0], {
    competitor: 2,
    failures: { give_up: 1, timeout: 1 },
    task: 'x',
  })
  assert.match(Mine.markdown(value), /\| 1 \| timeout \| 2 \| 67% \|/)
})

test('a model answer must name a known class', () => {
  const heuristic = Mine.classify({
    competitor: null,
    failed: side({ trajectory: null }),
    task: 't',
  })
  assert.equal(
    Mine.answer('ok {"class": "give_up", "reason": "said so"}', heuristic).class,
    'give_up',
  )
  assert.throws(() => Mine.answer('{"class": "bad"}', heuristic), Mine.AnswerError)
  assert.throws(() => Mine.answer('no json', heuristic), Mine.AnswerError)
})
