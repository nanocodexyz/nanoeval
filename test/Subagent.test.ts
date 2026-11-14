import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Atif from '../src/Atif.ts'

const recorded = (name: string): Atif.SessionEvent[] =>
  Fs.readFileSync(Path.join(import.meta.dirname, 'fixtures/subagents', name + '.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Atif.SessionEvent)

const alone = (events: readonly Atif.SessionEvent[]) =>
  events.filter((event) => event.event.source !== 'subagent')

const options = { model: 'fallback', name: 'nanocode', session: 'fallback', version: 'test' }

const shape = (trajectory: Atif.Trajectory): unknown => ({
  id: trajectory.trajectory_id,
  steps: trajectory.steps.map((step) => [
    step.source,
    step.metrics?.prompt_tokens,
    (step.tool_calls ?? []).map((call) => call.function_name).join(' '),
    step.source === 'agent' ? step.message : step.message.slice(0, 19),
  ]),
  under: (trajectory.subagent_trajectories ?? []).map(shape),
})

const every = (trajectory: Atif.Trajectory): Atif.Step[] => [
  ...trajectory.steps,
  ...(trajectory.subagent_trajectories ?? []).flatMap(every),
]

test('the usage of a session counts the model calls, tokens and tool calls of its subagent', () => {
  const own = { cacheWriteTokens: 0, cachedTokens: 0, costUsd: 0.0000112, inputTokens: 32 }
  assert.deepEqual(Atif.usage(alone(recorded('claude'))), {
    ...own,
    modelCalls: 4,
    outputTokens: 16,
    toolCalls: 6,
  })
  assert.deepEqual(Atif.usage(recorded('claude')), {
    cacheWriteTokens: 0,
    cachedTokens: 36,
    costUsd: 0.0000112 + 0.00001836,
    inputTokens: 32 + 3 * 42,
    modelCalls: 4 + 3,
    outputTokens: 16 + 3 * 6,
    toolCalls: 6 + 4,
  })
  const codex = {
    cacheWriteTokens: 0,
    cachedTokens: 4 * 40 + 3 * 20,
    costUsd: 0,
    inputTokens: 4 * 100 + 3 * 60,
    modelCalls: 7,
    outputTokens: 4 * 7 + 3 * 9,
    reasoningTokens: 4 * 3 + 3 * 5,
  }
  assert.deepEqual(Atif.usage(recorded('cells')), { ...codex, toolCalls: 6 + 4 })
  assert.deepEqual(Atif.usage(recorded('direct')), { ...codex, toolCalls: 3 + 2 })
  assert.equal(Atif.usage(alone(recorded('cells'))).inputTokens, 400)
})

test('the steps of a subagent are a trajectory under the one of its session, named by the call that started it', () => {
  const task = 'Act as a specialist'
  const instruction = 'Create a file named'
  assert.deepEqual(shape(Atif.fromEvents(recorded('claude'), options)), {
    id: undefined,
    steps: [
      ['user', undefined, '', instruction],
      ['agent', 8, 'exec spawn_agent', ''],
      ['agent', 8, 'exec wait_agent', ''],
      ['agent', 8, 'exec exec_command', ''],
      ['agent', 8, '', 'The task is complete.'],
    ],
    under: [
      {
        id: 'agent-1',
        steps: [
          ['user', undefined, '', task],
          ['agent', 42, 'exec exec_command', ''],
          ['agent', 42, 'exec submit_result', ''],
          ['agent', 42, '', 'The task is complete.'],
        ],
        under: [],
      },
    ],
  })
  assert.deepEqual(shape(Atif.fromEvents(recorded('direct'), options)), {
    id: undefined,
    steps: [
      ['user', undefined, '', instruction],
      ['agent', 100, 'spawn_agent', ''],
      ['agent', 100, 'wait_agent', ''],
      ['agent', 100, 'exec_command', ''],
      ['agent', 100, '', 'The task is complete.'],
    ],
    under: [
      {
        id: 'agent-1',
        steps: [
          ['user', undefined, '', task],
          ['agent', 60, 'exec_command', ''],
          ['agent', 60, 'submit_result', ''],
          ['agent', 60, '', 'The task is complete.'],
        ],
        under: [],
      },
    ],
  })
  for (const name of ['cells', 'claude', 'direct']) {
    const trajectory = Atif.fromEvents(recorded(name), options)
    const child = trajectory.subagent_trajectories![0]!
    assert.deepEqual(
      trajectory.steps.flatMap((step) =>
        (step.observation?.results ?? []).flatMap((result) =>
          result.subagent_trajectory_ref
            ? [
                step.tool_calls!.find((call) => call.tool_call_id === result.source_call_id)!
                  .function_name,
                result.subagent_trajectory_ref,
              ]
            : [],
        ),
      ),
      ['spawn_agent', [{ trajectory_id: 'agent-1' }]],
      name,
    )
    assert.notEqual(child.session_id, trajectory.session_id)
    assert.equal(child.agent.extra['agent_id'], 1)
    assert.equal(child.agent.extra['role'], 'worker')
    assert.match(trajectory.notes!, /subagents/)
    assert.equal(child.notes, undefined)
    assert.deepEqual(
      [trajectory, child].map((part) => [
        part.final_metrics.extra.model_calls,
        part.final_metrics.total_prompt_tokens,
        part.final_metrics.total_steps,
        part.final_metrics.extra.subagents,
      ]),
      name === 'claude'
        ? [
            [7, 158, 5, 1],
            [3, 126, 4, undefined],
          ]
        : [
            [7, 580, 5, 1],
            [3, 180, 4, undefined],
          ],
      name,
    )
    assert.equal(
      every(trajectory).filter((step) => step.metrics).length,
      trajectory.final_metrics.extra.model_calls,
    )
  }
  const claude = Atif.fromEvents(recorded('claude'), options)
  assert.equal(claude.final_metrics.total_cost_usd, 0.0000112 + 0.00001836)
  assert.equal(claude.subagent_trajectories![0]!.final_metrics.total_cost_usd, 0.00001836)
  assert.equal(Atif.fromEvents(alone(recorded('claude')), options).subagent_trajectories, undefined)
})

test('a message that a codex session publishes before its model call is the message of that call', () => {
  const messages = (trajectory: Atif.Trajectory) =>
    trajectory.steps.map((step) => [step.metrics?.extra['call_index'], step.message])
  const events = recorded('cells')
  const types = events.map((event) => event.event.event?.type)
  assert.ok(
    types.lastIndexOf('assistant.message') < types.lastIndexOf('model.call.completed'),
    'the stream has the message first',
  )
  const trajectory = Atif.fromEvents(events, options)
  assert.deepEqual(messages(trajectory).slice(-2), [
    [3, ''],
    [4, 'The task is complete.'],
  ])
  assert.deepEqual(messages(trajectory.subagent_trajectories![0]!).slice(-2), [
    [2, ''],
    [3, 'The task is complete.'],
  ])
})

test('the cost of a session is not known while a model call of its subagent has no cost', () => {
  const events = recorded('claude')
  const ended = events.findIndex((event) => event.event.update?.event?.type === 'run.completed')
  const open = events.filter((_, index) => index !== ended)
  assert.equal(Atif.usage(open).modelCalls, 7)
  assert.equal(Atif.usage(open).costUsd, undefined)
  assert.equal(Atif.fromEvents(open, options).final_metrics.total_cost_usd, undefined)
  const unpriced = events.map((event, index) =>
    index === ended
      ? {
          ...event,
          event: {
            ...event.event,
            update: {
              ...event.event.update!,
              event: {
                ...event.event.update!.event!,
                payload: { ...event.event.update!.event!.payload, cost_usd: null },
              },
            },
          },
        }
      : event,
  )
  assert.equal(Atif.usage(unpriced).costUsd, undefined)
})

test('a subagent that goes on after its Worker was killed has each model call, input and tool call once', () => {
  const events = recorded('claude-killed-in-subagent')
  const inner = events.flatMap((event) =>
    event.event.source === 'subagent' && event.event.update?.event
      ? [event.event.update.event]
      : [],
  )
  assert.deepEqual(
    inner
      .filter((event) => event.type === 'model.call.completed')
      .map((event) => [event.payload['call_index'], event.payload['timing'].replayed]),
    [
      [1, false],
      [1, true],
      [2, false],
      [3, false],
    ],
    'the stream has the first model call of the subagent again, marked',
  )
  assert.equal(
    inner.filter((event) => event.type === 'input.accepted' && event.payload['kind'] === 'prompt')
      .length,
    2,
    'and its task accepted again',
  )
  assert.equal(
    events.filter((event) => event.event.update?.type === 'added').length,
    2,
    'and the subagent added again',
  )
  const usage = Atif.usage(events)
  assert.deepEqual(
    [usage.modelCalls, usage.inputTokens, usage.cachedTokens, usage.outputTokens, usage.costUsd],
    [7, 158, 36, 34, 0.0000112 + 0.00001836],
  )
  const trajectory = Atif.fromEvents(events, options)
  assert.deepEqual(shape(trajectory), {
    id: undefined,
    steps: [
      ['user', undefined, '', 'Create a file named'],
      ['agent', 8, 'exec spawn_agent', ''],
      ['agent', 8, 'exec wait_agent', ''],
      ['agent', 8, 'exec exec_command', ''],
      ['user', undefined, '', 'Subagent 1 complete'],
      ['agent', 8, '', 'The task is complete.'],
    ],
    under: [
      {
        id: 'agent-1',
        steps: [
          ['user', undefined, '', 'Act as a specialist'],
          ['agent', 42, 'exec', ''],
          ['user', undefined, '', 'A directed message '],
          ['agent', 42, 'exec submit_result', ''],
          ['agent', 42, '', 'The task is complete.'],
        ],
        under: [],
      },
    ],
  })
  assert.equal(trajectory.subagent_trajectories!.length, 1)
  for (const step of every(trajectory)) {
    assert.equal(step.source === 'agent', step.metrics !== undefined, 'step ' + step.step_id)
    const calls = new Set((step.tool_calls ?? []).map((call) => call.tool_call_id))
    for (const result of step.observation?.results ?? [])
      assert.ok(calls.has(result.source_call_id), 'a result is in the step of its call')
  }
})

test('a subagent that takes up its cell after a kill publishes its calls again, and each is counted once', () => {
  const events = recorded('claude-resumed-in-subagent')
  const inner = events.flatMap((event) =>
    event.event.source === 'subagent' && event.event.update?.event
      ? [event.event.update.event]
      : [],
  )
  assert.deepEqual(
    inner.filter((event) => event.type === 'tool.call').map((event) => event.payload['call_id']),
    ['toolu_2', 'toolu_2/code-1', 'toolu_2', 'toolu_2/code-1', 'toolu_4', 'toolu_4/code-1'],
    'the stream has the cell of the subagent and the call inside it twice',
  )
  assert.deepEqual(
    inner
      .filter((event) => event.type === 'model.call.completed')
      .map((event) => event.payload['timing'].replayed),
    [false, true, false, false],
  )
  assert.deepEqual(Atif.usage(events), Atif.usage(recorded('claude')))
  const trajectory = Atif.fromEvents(events, options)
  const whole = Atif.fromEvents(recorded('claude'), options)
  assert.deepEqual(
    (shape(trajectory) as { steps: unknown }).steps,
    (shape(whole) as { steps: unknown }).steps,
  )
  assert.deepEqual(
    trajectory.subagent_trajectories![0]!.steps.map((step) => [
      step.source,
      (step.tool_calls ?? []).length,
      (step.observation?.results ?? []).length,
    ]),
    [
      ['user', 0, 0],
      ['agent', 2, 2],
      ['user', 0, 0],
      ['agent', 2, 2],
      ['agent', 0, 0],
    ],
    'the notice of the restart is a step of the subagent, and nothing else is there twice',
  )
  assert.deepEqual(trajectory.final_metrics, whole.final_metrics)
})

test('a turn that a session is given when its subagent ends is counted with the session', () => {
  const events = recorded('direct-killed-after-subagent')
  const turns = events.flatMap((event) =>
    event.event.source === 'agent' && event.event.event?.type === 'input.accepted'
      ? [String(event.event.event.payload['request_id']).split(':')[0]]
      : [],
  )
  assert.deepEqual(turns, ['attempt', 'attempt', 'subagent-completion'])
  assert.deepEqual(Atif.usage(events), {
    cacheWriteTokens: 0,
    cachedTokens: 5 * 40 + 3 * 20,
    costUsd: 0,
    inputTokens: 5 * 100 + 3 * 60,
    modelCalls: 8,
    outputTokens: 5 * 7 + 3 * 9,
    reasoningTokens: 5 * 3 + 3 * 5,
    toolCalls: 5,
  })
  assert.deepEqual(shape(Atif.fromEvents(events, options)), {
    id: undefined,
    steps: [
      ['user', undefined, '', 'Create a file named'],
      ['agent', 100, 'spawn_agent', ''],
      ['agent', 100, 'wait_agent', ''],
      ['agent', 100, 'exec_command', ''],
      ['agent', 100, '', 'The task is complete.'],
      ['user', undefined, '', 'Subagent 1 complete'],
      ['agent', 100, '', 'The task is complete.'],
    ],
    under: [
      {
        id: 'agent-1',
        steps: [
          ['user', undefined, '', 'Act as a specialist'],
          ['agent', 60, 'exec_command', ''],
          ['agent', 60, 'submit_result', ''],
          ['agent', 60, '', 'The task is complete.'],
        ],
        under: [],
      },
    ],
  })
})

test('a subagent of a subagent is under it, and each trajectory counts what is under it', () => {
  const events = recorded('cells')
  const nested = events.flatMap((event) => {
    const update = event.event.update
    if (event.event.source !== 'subagent' || !update) return []
    const moved =
      update.type === 'added'
        ? { ...update, agent: { ...update.agent, id: 2, parent: 1 } }
        : { ...update, id: 2, parent: 1 }
    return [{ ...event, event: { ...event.event, update: moved } }]
  })
  const trajectory = Atif.fromEvents([...events, ...nested], options)
  const child = trajectory.subagent_trajectories![0]!
  assert.deepEqual(
    [trajectory, child, child.subagent_trajectories![0]!].map((part) => [
      part.trajectory_id,
      part.final_metrics.extra.model_calls,
      part.final_metrics.total_prompt_tokens,
      part.subagent_trajectories?.length,
    ]),
    [
      [undefined, 10, 760, 1],
      ['agent-1', 6, 360, 1],
      ['agent-2', 3, 180, undefined],
    ],
  )
  assert.equal(Atif.usage([...events, ...nested]).modelCalls, 10)
  const looped = nested.map((event) => ({
    ...event,
    event: { ...event.event, update: { ...event.event.update, parent: 2 } },
  }))
  assert.equal(
    Atif.usage([...events, ...looped]).modelCalls,
    10,
    'an agent that names itself as the one that started it is counted under the session',
  )
})
