import type * as Atif from './Atif.ts'
import type * as Result from './Result.ts'

export const classes = [
  'code_mode_overhead',
  'environment',
  'give_up',
  'harness_error',
  'prompt_tool_mismatch',
  'timeout',
  'tool_selection',
  'wrong_solution',
] as const

export type Class = (typeof classes)[number]

export const descriptions: Record<Class, string> = {
  code_mode_overhead:
    'Code Mode cost the attempt: scripts that failed to run, or far more model calls than the passing competitor',
  environment: 'the sandbox got in the way: missing commands, network, disk or memory',
  give_up: 'the agent ended its turn saying it could not finish, or stopped with little work done',
  harness_error:
    'the attempt errored outside the agent: no trajectory, an internal or verifier error',
  prompt_tool_mismatch:
    'the agent called tools that do not exist or with arguments their schema refuses',
  timeout: 'the agent ran out of time, or its commands kept timing out',
  tool_selection: 'tool calls kept failing: the agent picked commands or tools that did not work',
  wrong_solution: 'the agent finished normally and the verifier rejected its work',
}

export const weights = {
  codeModeCallRatio: 2,
  envError: 1,
  failedCall: 0.5,
  giveUpPhrase: 5,
  outcome: 10,
  residual: 1.5,
  scriptError: 1,
  timedOutCall: 1,
  unknownTool: 2,
}

const patterns = {
  environment:
    /no space left on device|command not found|could not resolve host|temporary failure in name resolution|network is unreachable|unable to locate package|read-only file system|cannot allocate memory|out of memory|oom-kill/i,
  giveUp:
    /\b(i (cannot|can't|am unable to|was unable to|could not|couldn't|was not able to)|unable to (complete|finish|solve)|(is|was) not (possible|feasible)|giving up|i'm sorry)\b/i,
  script: /script (failed|error)|syntaxerror|referenceerror|typeerror:/i,
  timedOut: /timed out|timeout expired|deadline exceeded|exit code 124\b|killed after/i,
  unknownTool:
    /unknown tool|no such tool|tool_not_available|is not a (known|valid) tool|unknown field|invalid arguments|missing required (argument|parameter|field)/i,
}

const codeModeTools = new Set(['exec', 'wait'])

const okStatuses = new Set(['', 'completed', 'ok', 'success', 'succeeded'])

export type Summary = {
  codeModeCalls: number
  envErrors: string[]
  failedCalls: number
  finalMessage: string
  modelCalls: number
  scriptErrors: string[]
  steps: number
  timedOutCalls: string[]
  toolCalls: number
  toolSeconds: Record<string, number>
  tools: Record<string, number>
  unknownTools: string[]
}

export type Side = {
  agent: string
  attempt: string
  durationSec: number | null
  failure: Result.Failure | null
  outcome: Result.Attempt['outcome']
  run: string
  summary: Summary | null
  verifierTail: string
}

export type Case = {
  competitor: Side | null
  failed: Side
  task: string
}

export type Verdict = {
  class: Class
  reason: string
  scores: Record<Class, number>
  source: 'heuristic' | 'llm'
}

export type Classified = Case & { verdict: Verdict }

export type Report = {
  classes: {
    agents: Record<string, number>
    class: Class
    count: number
    description: string
    examples: {
      attempt: string
      competitor: string | null
      reason: string
      run: string
      task: string
    }[]
    tasks: Record<string, number>
  }[]
  failures: number
  runs: string[]
  sources: Record<string, number>
  tasks: { competitor: number; failures: Record<string, number>; task: string }[]
  withoutCompetitor: number
}

export function steps(trajectory: Atif.Trajectory): Atif.Step[] {
  return [
    ...trajectory.steps,
    ...(trajectory.subagent_trajectories ?? []).flatMap((child) => steps(child)),
  ]
}

function excerpt(text: string, pattern: RegExp, width: number): string {
  const found = pattern.exec(text)
  if (!found) return ''
  const start = Math.max(0, found.index - width)
  return text
    .slice(start, found.index + found[0].length + width)
    .replace(/\s+/g, ' ')
    .trim()
}

export function summarize(trajectory: Atif.Trajectory, width: number): Summary {
  const all = steps(trajectory)
  const names = new Map<string, string>()
  const summary: Summary = {
    codeModeCalls: 0,
    envErrors: [],
    failedCalls: 0,
    finalMessage: '',
    modelCalls: 0,
    scriptErrors: [],
    steps: all.length,
    timedOutCalls: [],
    toolCalls: 0,
    toolSeconds: {},
    tools: {},
    unknownTools: [],
  }
  for (const step of all) {
    if (step.metrics) summary.modelCalls++
    if (step.source === 'agent' && step.message.trim()) summary.finalMessage = step.message.trim()
    for (const call of step.tool_calls ?? []) {
      names.set(call.tool_call_id, call.function_name)
      summary.toolCalls++
      summary.tools[call.function_name] = (summary.tools[call.function_name] ?? 0) + 1
      if (codeModeTools.has(call.function_name)) summary.codeModeCalls++
    }
    for (const result of step.observation?.results ?? []) {
      const name = names.get(result.source_call_id) ?? ''
      const failed =
        !okStatuses.has(result.extra.status.toLowerCase()) ||
        (result.extra.exit_code !== undefined && result.extra.exit_code !== 0)
      if (failed) summary.failedCalls++
      if (result.extra.duration_ns !== null)
        summary.toolSeconds[name] =
          (summary.toolSeconds[name] ?? 0) + result.extra.duration_ns / 1e9
      const env = excerpt(result.content, patterns.environment, width)
      if (env) summary.envErrors.push(env)
      const timed = excerpt(result.content, patterns.timedOut, width)
      if (timed) summary.timedOutCalls.push(timed)
      const unknown = excerpt(result.content, patterns.unknownTool, width)
      if (unknown) summary.unknownTools.push(name + ': ' + unknown)
      if (codeModeTools.has(name)) {
        const script = excerpt(result.content, patterns.script, width)
        if (script) summary.scriptErrors.push(script)
      }
    }
  }
  return summary
}

function zero(): Record<Class, number> {
  return Object.fromEntries(classes.map((name) => [name, 0])) as Record<Class, number>
}

export function classify(entry: Case): Verdict {
  const scores = zero()
  const reasons: Record<Class, string[]> = Object.fromEntries(
    classes.map((name) => [name, [] as string[]]),
  ) as Record<Class, string[]>
  const { failed, competitor } = entry
  const failure = failed.failure
  scores.wrong_solution = weights.residual
  reasons.wrong_solution.push(
    'finished and the verifier said no' +
      (failed.verifierTail ? ': ' + lastLine(failed.verifierTail) : ''),
  )
  if (failure?.kind === 'agent_timeout' || failure?.kind === 'verifier_timeout') {
    scores.timeout += weights.outcome
    reasons.timeout.push(failure.kind + ': ' + failure.message)
  } else if (failure?.kind === 'environment') {
    scores.environment += weights.outcome
    reasons.environment.push('environment error: ' + failure.message)
  } else if (failed.outcome === 'errored' && failure) {
    scores.harness_error += weights.outcome
    reasons.harness_error.push(failure.kind + ' error: ' + failure.message)
  }
  const summary = failed.summary
  if (!summary) {
    scores.harness_error += weights.outcome
    reasons.harness_error.push('no trajectory was recorded')
    return pick(scores, reasons)
  }
  if (summary.modelCalls === 0 && summary.toolCalls === 0) {
    scores.harness_error += weights.outcome
    reasons.harness_error.push('the trajectory holds no model call and no tool call')
  }
  scores.environment += summary.envErrors.length * weights.envError
  reasons.environment.push(...summary.envErrors.slice(0, 1))
  scores.timeout += summary.timedOutCalls.length * weights.timedOutCall
  reasons.timeout.push(
    ...summary.timedOutCalls.slice(0, 1).map((text) => 'a command timed out: ' + text),
  )
  scores.prompt_tool_mismatch += summary.unknownTools.length * weights.unknownTool
  reasons.prompt_tool_mismatch.push(...summary.unknownTools.slice(0, 1))
  scores.code_mode_overhead += summary.scriptErrors.length * weights.scriptError
  reasons.code_mode_overhead.push(
    ...summary.scriptErrors.slice(0, 1).map((text) => 'script error: ' + text),
  )
  const other = competitor?.summary
  if (summary.codeModeCalls > 0 && other && other.modelCalls > 0) {
    const ratio = summary.modelCalls / other.modelCalls
    if (ratio >= weights.codeModeCallRatio) {
      scores.code_mode_overhead += ratio
      reasons.code_mode_overhead.push(
        summary.modelCalls +
          ' model calls against ' +
          other.modelCalls +
          ' for the passing competitor',
      )
    }
  }
  if (patterns.giveUp.test(summary.finalMessage)) {
    scores.give_up += weights.giveUpPhrase
    reasons.give_up.push('final message: ' + excerpt(summary.finalMessage, patterns.giveUp, 80))
  }
  if (!failure && other && summary.toolCalls * 2 < other.toolCalls) {
    scores.give_up += weights.residual
    reasons.give_up.push(
      'stopped after ' +
        summary.toolCalls +
        ' tool calls against ' +
        other.toolCalls +
        ' for the passing competitor',
    )
  }
  const explained =
    summary.envErrors.length +
    summary.timedOutCalls.length +
    summary.unknownTools.length +
    summary.scriptErrors.length
  const unexplained = Math.max(0, summary.failedCalls - explained)
  scores.tool_selection += unexplained * weights.failedCall
  if (unexplained)
    reasons.tool_selection.push(unexplained + ' of ' + summary.toolCalls + ' tool calls failed')
  return pick(scores, reasons)
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .at(-1)
      ?.trim() ?? ''
  )
}

function pick(scores: Record<Class, number>, reasons: Record<Class, string[]>): Verdict {
  const best = classes.reduce((top, name) => (scores[name] > scores[top] ? name : top), classes[0])
  return { class: best, reason: reasons[best].join('; '), scores, source: 'heuristic' }
}

export function pair(
  attempts: readonly (Result.Attempt & { run: string })[],
  failing: RegExp,
): {
  competitor: (Result.Attempt & { run: string }) | null
  failed: Result.Attempt & { run: string }
}[] {
  const passing = attempts.filter((attempt) => attempt.outcome === 'passed')
  return attempts
    .filter((attempt) => attempt.outcome !== 'passed' && failing.test(attempt.agent.id))
    .map((failed) => {
      const same = passing.filter((attempt) => attempt.task.name === failed.task.name)
      const ranked = [
        ...same.filter((attempt) => attempt.run === failed.run && !failing.test(attempt.agent.id)),
        ...same.filter((attempt) => attempt.run !== failed.run && !failing.test(attempt.agent.id)),
        ...same.filter((attempt) => attempt.run === failed.run && failing.test(attempt.agent.id)),
        ...same.filter((attempt) => attempt.run !== failed.run && failing.test(attempt.agent.id)),
      ]
      return { competitor: ranked[0] ?? null, failed }
    })
}

export function report(
  cases: readonly Classified[],
  input: { examples: number; runs: string[] },
): Report {
  const grouped = new Map<Class, Classified[]>()
  for (const entry of cases)
    grouped.set(entry.verdict.class, [...(grouped.get(entry.verdict.class) ?? []), entry])
  const counts = (items: readonly string[]) =>
    items.reduce<Record<string, number>>(
      (all, item) => ({ ...all, [item]: (all[item] ?? 0) + 1 }),
      {},
    )
  const tasks = new Map<string, Classified[]>()
  for (const entry of cases) tasks.set(entry.task, [...(tasks.get(entry.task) ?? []), entry])
  return {
    classes: [...grouped.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([name, items]) => ({
        agents: counts(items.map((item) => item.failed.agent)),
        class: name,
        count: items.length,
        description: descriptions[name],
        examples: items.slice(0, input.examples).map((item) => ({
          attempt: item.failed.attempt,
          competitor: item.competitor
            ? item.competitor.run +
              '/' +
              item.competitor.attempt +
              ' (' +
              item.competitor.agent +
              ')'
            : null,
          reason: item.verdict.reason,
          run: item.failed.run,
          task: item.task,
        })),
        tasks: counts(items.map((item) => item.task)),
      })),
    failures: cases.length,
    runs: input.runs,
    sources: counts(cases.map((entry) => entry.verdict.source)),
    tasks: [...tasks.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([task, items]) => ({
        competitor: items.filter((item) => item.competitor).length,
        failures: counts(items.map((item) => item.verdict.class)),
        task,
      })),
    withoutCompetitor: cases.filter((entry) => !entry.competitor).length,
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ')
}

export function markdown(value: Report): string {
  const lines = [
    '# Failure classes',
    '',
    value.failures +
      ' failed attempts from runs ' +
      value.runs.join(', ') +
      '; ' +
      value.withoutCompetitor +
      ' had no passing competitor. Classified by: ' +
      Object.entries(value.sources)
        .map(([name, count]) => name + ' ' + count)
        .join(', ') +
      '.',
    '',
    '| Rank | Class | Count | Share | Agents | Tasks |',
    '| --- | --- | --- | --- | --- | --- |',
    ...value.classes.map(
      (entry, index) =>
        '| ' +
        (index + 1) +
        ' | ' +
        entry.class +
        ' | ' +
        entry.count +
        ' | ' +
        (value.failures ? Math.round((entry.count / value.failures) * 100) : 0) +
        '% | ' +
        Object.entries(entry.agents)
          .map(([name, count]) => name + ' ' + count)
          .join(', ') +
        ' | ' +
        Object.entries(entry.tasks)
          .map(([name, count]) => name + ' ' + count)
          .join(', ') +
        ' |',
    ),
    '',
  ]
  for (const entry of value.classes) {
    lines.push('## ' + entry.class + ' (' + entry.count + ')', '', entry.description + '.', '')
    lines.push('| Run | Attempt | Task | Competitor | Reason |', '| --- | --- | --- | --- | --- |')
    for (const example of entry.examples)
      lines.push(
        '| ' +
          example.run +
          ' | ' +
          example.attempt +
          ' | ' +
          example.task +
          ' | ' +
          (example.competitor ?? 'none') +
          ' | ' +
          cell(example.reason) +
          ' |',
      )
    lines.push('')
  }
  lines.push(
    '## By task',
    '',
    '| Task | Failures | With competitor | Classes |',
    '| --- | --- | --- | --- |',
  )
  for (const task of value.tasks) {
    const total = Object.values(task.failures).reduce((sum, count) => sum + count, 0)
    lines.push(
      '| ' +
        task.task +
        ' | ' +
        total +
        ' | ' +
        task.competitor +
        ' | ' +
        Object.entries(task.failures)
          .map(([name, count]) => name + ' ' + count)
          .join(', ') +
        ' |',
    )
  }
  return lines.join('\n') + '\n'
}

export function prompt(entry: Case): string {
  return [
    'Classify why the failed attempt of an AI coding agent on a Terminal-Bench task failed, compared with a passing attempt of another agent on the same task.',
    'Answer with one JSON object and nothing else: {"class": one of ' +
      JSON.stringify(classes) +
      ', "reason": one sentence citing the evidence}.',
    'Classes:',
    ...classes.map((name) => '- ' + name + ': ' + descriptions[name]),
    'Task: ' + entry.task,
    'Failed attempt: ' + JSON.stringify(entry.failed),
    'Passing competitor: ' + JSON.stringify(entry.competitor),
  ].join('\n')
}

export class AnswerError extends Error {
  override name = 'Mine.AnswerError'
}

export function answer(text: string, heuristic: Verdict): Verdict {
  const found = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!found)
    throw new AnswerError('the model answered without a JSON object: ' + text.slice(0, 200))
  const parsed = JSON.parse(found) as { class?: string; reason?: string }
  if (!classes.includes(parsed.class as Class))
    throw new AnswerError('the model named no known class: ' + found.slice(0, 200))
  return {
    ...heuristic,
    class: parsed.class as Class,
    reason: String(parsed.reason ?? ''),
    source: 'llm',
  }
}
