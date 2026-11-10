import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Admission from '../src/Admission.ts'
import * as Atif from '../src/Atif.ts'
import * as Budget from '../src/Budget.ts'
import * as Harbor from '../src/Harbor.ts'
import * as Result from '../src/Result.ts'

const agentEvent = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): Atif.SessionEvent => ({
  created_at: 1_794_282_209_000 + seq,
  event: { event: { payload, type }, source: 'agent' },
  request_id: 'attempt',
  seq,
})

const events: Atif.SessionEvent[] = [
  { created_at: 1, event: { type: 'queued' }, request_id: 'attempt', seq: 1 },
  agentEvent(2, 'input.accepted', { input: 'Create todos.txt', session_id: 'session-1' }),
  agentEvent(3, 'run.started', {
    model: 'claude-haiku-4-5',
    orchestration: 'claude',
    transport: 'messages_sse',
  }),
  agentEvent(4, 'model.call.completed', {
    attempt: 1,
    call_index: 1,
    duration_ns: 1_920_000_000,
    model: 'claude-haiku-4-5-20251001',
    status: 'tool_use',
    usage: {
      input_tokens: 5119,
      input_tokens_details: { cache_write_tokens: 5116, cached_tokens: 0 },
      output_tokens: 82,
    },
  }),
  agentEvent(5, 'tool.call', {
    arguments: { code: 'await tools.Bash({ command: "true" })' },
    call_id: 'toolu_1',
    tool: 'exec',
  }),
  agentEvent(6, 'tool.call', {
    arguments: { command: 'true' },
    call_id: 'toolu_1/code-1',
    parent_call_id: 'toolu_1',
    tool: 'Bash',
  }),
  agentEvent(7, 'tool.result', {
    call_id: 'toolu_1/code-1',
    duration_ns: 21_000_000,
    result: { text: '{"exit_code":0}' },
    status: 'completed',
  }),
  agentEvent(8, 'tool.result', {
    call_id: 'toolu_1',
    duration_ns: 31_000_000,
    result: {
      content_blocks: [
        { text: 'Script completed\n', type: 'text' },
        { text: 'ok', type: 'text' },
      ],
    },
    status: 'completed',
  }),
  agentEvent(9, 'model.call.completed', {
    attempt: 1,
    call_index: 2,
    duration_ns: 776_000_000,
    model: 'claude-haiku-4-5-20251001',
    status: 'end_turn',
    usage: {
      input_tokens: 5631,
      input_tokens_details: { cache_write_tokens: 131, cached_tokens: 5494 },
      output_tokens: 31,
    },
  }),
  agentEvent(10, 'assistant.message', { text: 'Done.' }),
  agentEvent(11, 'run.completed', { cost_usd: 0.0102, status: 'completed' }),
]

const attempt = (overrides: Partial<Result.Attempt>): Result.Attempt => ({
  agent: { id: 'haiku', model: 'claude-haiku-4-5', provider: 'claude' },
  finishedAt: 2000,
  id: 'a00001',
  index: 1,
  outcome: 'passed',
  reward: 1,
  sandbox: { backend: 'docker', id: 1, provider: 'local', slot: 'run-a00001' },
  session: 'run-a00001',
  startedAt: 1000,
  task: { checksum: 'sha256:00', name: 'suite/one' },
  timing: { agentExecution: { finishedAt: 1900, startedAt: 1200 } },
  usage: Atif.usage(events),
  ...overrides,
})

test('session events project to an ATIF-v1.7 trajectory', () => {
  const trajectory = Atif.fromEvents(events, {
    model: 'claude-haiku-4-5',
    name: 'nanocode',
    session: 'fallback',
    version: '1',
  })
  assert.equal(trajectory.schema_version, 'ATIF-v1.7')
  assert.equal(trajectory.session_id, 'session-1')
  assert.deepEqual(
    trajectory.steps.map((step) => step.source),
    ['user', 'agent', 'agent'],
  )
  assert.equal(trajectory.steps[0]!.message, 'Create todos.txt')
  assert.deepEqual(
    trajectory.steps[1]!.tool_calls!.map((call) => call.function_name),
    ['exec', 'Bash'],
  )
  assert.equal(trajectory.steps[1]!.observation!.results.length, 2)
  assert.equal(trajectory.steps[1]!.observation!.results[1]!.content, 'Script completed\nok')
  assert.equal(trajectory.steps[1]!.metrics!.cached_tokens, 0)
  assert.equal(trajectory.steps[2]!.message, 'Done.')
  assert.deepEqual(trajectory.final_metrics, {
    total_prompt_tokens: 10750,
    total_completion_tokens: 113,
    total_cached_tokens: 5494,
    total_cost_usd: 0.0102,
    total_steps: 3,
    extra: { cache_write_input_tokens: 5247, model_calls: 2, tool_calls: 2 },
  })
})

test('usage is absent cost, not zero cost, when no run reports one', () => {
  assert.equal(Atif.usage(events.slice(0, 5)).costUsd, undefined)
})

test('outcomes follow the verifier reward, and infrastructure failures are errors', () => {
  assert.equal(Result.outcome(1, undefined), 'passed')
  assert.equal(Result.outcome(0, undefined), 'failed')
  assert.equal(Result.outcome(0.5, undefined), 'failed')
  assert.equal(Result.outcome(null, { at: 1, kind: 'environment', message: 'lost' }), 'errored')
  assert.equal(Result.outcome(1, { at: 1, kind: 'agent_timeout', message: 'late' }), 'passed')
  assert.equal(Result.outcome(1, { at: 1, kind: 'verifier_timeout', message: 'late' }), 'errored')
})

test('pass@k counts a task solved when any of its first k attempts passed', () => {
  const attempts = [
    attempt({ id: 'a1', index: 1, outcome: 'failed', reward: 0 }),
    attempt({ id: 'a2', index: 2 }),
    attempt({ id: 'a3', index: 1, task: { checksum: 'sha256:01', name: 'suite/two' } }),
    attempt({
      id: 'a4',
      index: 2,
      outcome: 'errored',
      reward: null,
      task: { checksum: 'sha256:01', name: 'suite/two' },
      usage: null,
    }),
  ]
  const summary = Result.summarize(attempts)['haiku']!
  assert.deepEqual(summary.passAtK, { '1': 0.5, '2': 1 })
  assert.equal(summary.passed, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.errored, 1)
  assert.equal(summary.tasks, 2)
  assert.ok(Math.abs(summary.costUsd! - 0.0306) < 1e-9)
})

test('a run exports as a Harbor job directory', () => {
  const failed = attempt({
    failure: { at: 1500, kind: 'environment', message: 'the hand exited with 1' },
    id: 'a2',
    index: 2,
    outcome: 'errored',
    reward: null,
    usage: null,
  })
  const files = Harbor.files({
    artifacts: { a00001: { 'agent/trajectory.json': '{}' } },
    attempts: [attempt({}), failed],
    job: { finishedAt: 3000, id: 'job-1', name: 'example', startedAt: 500 },
    running: 0,
    source: 'example',
    total: 2,
    version: '0.1.0',
  })
  assert.deepEqual(Object.keys(files).sort(), [
    'one__haiku__1/agent/trajectory.json',
    'one__haiku__1/result.json',
    'one__haiku__2/result.json',
    'result.json',
  ])

  const trial = JSON.parse(files['one__haiku__1/result.json']!)
  assert.equal(trial.task_name, 'suite/one')
  assert.deepEqual(trial.verifier_result, { rewards: { reward: 1 } })
  assert.equal(trial.agent_result.n_input_tokens, 10750)
  assert.equal(trial.agent_result.n_cache_tokens, 5494)
  assert.equal(trial.agent_info.model_info.provider, 'anthropic')
  assert.equal(trial.exception_info, null)
  assert.equal(trial.agent_execution.started_at, '1970-01-01T00:00:01.200Z')

  const errored = JSON.parse(files['one__haiku__2/result.json']!)
  assert.equal(errored.verifier_result, null)
  assert.equal(errored.exception_info.exception_type, 'EnvironmentError')

  const job = JSON.parse(files['result.json']!)
  assert.equal(job.n_total_trials, 2)
  assert.equal(job.stats.n_errored_trials, 1)
  assert.deepEqual(job.stats.evals['haiku__example'].pass_at_k, { '1': 1, '2': 1 })
  assert.deepEqual(job.stats.evals['haiku__example'].exception_stats, {
    EnvironmentError: ['one__haiku__2'],
  })
})

test('admission needs a free slot and memory at once, and clamps oversized tasks', () => {
  const capacity = { memoryMb: 1024, slots: 2 }
  assert.ok(Admission.admits({ memoryMb: 0, running: 0 }, capacity, 512))
  assert.ok(!Admission.admits({ memoryMb: 768, running: 1 }, capacity, 512))
  assert.ok(!Admission.admits({ memoryMb: 256, running: 2 }, capacity, 128))
  assert.ok(Admission.admits({ memoryMb: 0, running: 0 }, capacity, 4096))
  assert.ok(!Admission.admits({ memoryMb: 256, running: 1 }, capacity, 4096))

  const sandboxes = [
    { capacity, id: 1, load: { memoryMb: 1024, running: 1 } },
    { capacity, id: 2, load: { memoryMb: 0, running: 0 } },
  ]
  assert.equal(Admission.place(sandboxes, 256)!.id, 2)
  assert.equal(Admission.place(sandboxes.slice(0, 1), 256), undefined)
})

test('a budget refuses the charge that would pass its limit', () => {
  const budget = Budget.create({ limitUsd: 0.02, spentUsd: 0.008721 })
  budget.charge(0.008721, 'Create sandbox')
  assert.equal(budget.spentUsd, 0.017442)
  assert.throws(() => budget.charge(0.008721, 'Create sandbox'), Budget.ExceededError)
  assert.equal(budget.spentUsd, 0.017442)
  assert.equal(budget.remaining(), 0.002558)
  budget.charge(0.0001, 'Kill sandbox')
  assert.throws(() => Budget.create({ limitUsd: -1 }))
})
