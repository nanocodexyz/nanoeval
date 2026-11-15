import type * as Config from './Config.ts'
import type * as Pins from './Pins.ts'
import * as Price from './Price.ts'
import * as Result from './Result.ts'

export class InvalidError extends Error {
  override name = 'Scorecard.InvalidError'
}

export const defaults = { draws: 2000, seed: 1 }

export const level = 0.95

export type Run = {
  agents: readonly Config.Agent[]
  attempts: number
  eval: { name: string; version: string }
  id: string
  name: string
  nanocode: Pins.Pins | undefined
  results: readonly Result.Attempt[]
  state: 'finished' | 'running'
}

export type Exclusion = {
  digest: string
  file: string
  names: readonly string[]
  reason?: string | undefined
}

export type Estimate = { high: number | null; low: number | null; value: number | null }

export type Arm = {
  against: { passRateDifference: Estimate; usdPerPassRatio: Estimate | null } | null
  cancelled: number
  errored: number
  excluded: number
  failed: number
  id: string
  label: string
  listed: number
  matched: number
  modelCallsPerAttempt: number | null
  outputTokensPerAttempt: number
  passed: number
  passRate: Estimate
  recorded: number
  run: string
  spec: Config.Agent
  uncosted: number
  unmatched: number
  unscheduled: number
  usdPerAttempt: number | null
  usdPerPass: Estimate | null
}

export type Card = {
  arms: Arm[]
  command: string
  commit: string | null
  draws: number
  eval: { name: string; version: string }
  excluded: {
    digest: string
    file: string
    reason?: string
    tasks: { name: string; rows: number }[]
  } | null
  level: number
  matched: { attempts: number; tasks: number }
  prices: Price.List | null
  reference: string
  runs: {
    arms: string[]
    attempts: number
    id: string
    name: string
    nanocode: Pins.Pins | null
    rows: number
    state: 'finished' | 'running'
  }[]
  seed: number
  tasks: { attempts: number; name: string; passed: number[] }[]
}

export type Cell = { passed: boolean; usd: number }

export type Draw = { passRate: number; usdPerPass: number }

export function verdict(attempt: Pick<Result.Attempt, 'failure' | 'outcome'>): boolean {
  return (
    !(attempt.outcome === 'errored' && attempt.failure?.kind === 'cancelled') &&
    !Result.unscheduled(attempt)
  )
}

export function key(attempt: Pick<Result.Attempt, 'index' | 'task'>): string {
  return attempt.task.name + '#' + attempt.index
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function interval(values: readonly number[]): { high: number | null; low: number | null } {
  const sorted = values
    .map((value) => (Number.isFinite(value) ? value : Infinity))
    .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  const tail = Math.floor((sorted.length * (1 - level)) / 2)
  const bound = (value: number) => (Number.isFinite(value) ? value : null)
  return { high: bound(sorted[sorted.length - 1 - tail]!), low: bound(sorted[tail]!) }
}

function rate(cells: readonly Cell[]): Draw {
  const passed = cells.filter((cell) => cell.passed).length
  const usd = cells.reduce((sum, cell) => sum + cell.usd, 0)
  return { passRate: passed / cells.length, usdPerPass: passed ? usd / passed : Infinity }
}

export function bootstrap(
  arms: readonly (readonly (readonly Cell[])[])[],
  options: bootstrap.Options,
): Draw[][] {
  const random = mulberry32(options.seed)
  const tasks = arms[0]!.length
  const pick = (count: number) => Math.floor(random() * count)
  return Array.from({ length: options.draws }, () => {
    const drawn = Array.from({ length: tasks }, () => pick(tasks))
    return arms.map((arm) =>
      rate(drawn.flatMap((task) => arm[task]!.map(() => arm[task]![pick(arm[task]!.length)]!))),
    )
  })
}

export declare namespace bootstrap {
  type Options = { draws: number; seed: number }
}

function short(name: string): string {
  return name.split('/').at(-1)!
}

function ordered(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function estimate(value: number, drawn: readonly number[]): Estimate {
  return { ...interval(drawn), value: Number.isFinite(value) ? value : null }
}

export type Cost = { basis: 'list' | 'none' | 'recorded'; usd: number }

export function cost(attempt: Result.Attempt, prices: Price.List = {}): Cost | undefined {
  const usage = attempt.usage
  if (!usage)
    return attempt.timing.agentExecution && attempt.agent.provider !== 'oracle'
      ? undefined
      : { basis: 'none', usd: 0 }
  if (usage.costUsd !== undefined) return { basis: 'recorded', usd: usage.costUsd }
  if (!(usage.modelCalls > 0)) return { basis: 'none', usd: 0 }
  const price = prices[attempt.agent.model]
  return price ? { basis: 'list', usd: Price.usd(price, usage) } : undefined
}

export function build(runs: readonly Run[], options: build.Options): Card {
  const first = runs[0]
  if (!first) throw new InvalidError('a scorecard needs a run')
  const other = runs.find((run) => run.eval.version !== first.eval.version)
  if (other)
    throw new InvalidError(
      'run ' +
        other.id +
        ' ran eval ' +
        other.eval.name +
        '@' +
        other.eval.version +
        ' and run ' +
        first.id +
        ' ran ' +
        first.eval.name +
        '@' +
        first.eval.version +
        ': a scorecard compares arms of one eval digest',
    )
  if (!Number.isInteger(options.draws) || options.draws < 1)
    throw new InvalidError('the draws are a whole number above zero, not ' + options.draws)
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)
    throw new InvalidError('the seed is a whole number from 0 to 4294967295, not ' + options.seed)
  const repeated = runs.find((run, at) => runs.findIndex((same) => same.id === run.id) !== at)
  if (repeated) throw new InvalidError('run ' + repeated.id + ' is named twice')

  const ids = runs.flatMap((run) => run.agents.map((agent) => agent.id))
  const names = new Set(options.exclude?.names ?? [])
  const left = (attempt: Result.Attempt) =>
    names.has(attempt.task.name) || names.has(short(attempt.task.name))
  const members = runs.flatMap((run) => {
    const stray = run.results.find(
      (attempt) => !run.agents.some((agent) => agent.id === attempt.agent.id),
    )
    if (stray)
      throw new InvalidError(
        'run ' +
          run.id +
          ' holds a row of arm ' +
          stray.agent.id +
          ', which its config does not name',
      )
    return run.agents.map((agent) => {
      const rows = run.results.filter((attempt) => attempt.agent.id === agent.id)
      const kept = rows.filter((attempt) => !left(attempt))
      const verdicts = new Map<string, Result.Attempt>()
      for (const attempt of kept.filter(verdict)) {
        if (verdicts.has(key(attempt)))
          throw new InvalidError(
            'run ' + run.id + ' holds two rows of arm ' + agent.id + ' for ' + key(attempt),
          )
        verdicts.set(key(attempt), attempt)
      }
      return {
        agent,
        cancelled: kept.filter((attempt) => !verdict(attempt) && !Result.unscheduled(attempt))
          .length,
        excluded: rows.length - kept.length,
        label: ids.filter((id) => id === agent.id).length > 1 ? agent.id + '@' + run.id : agent.id,
        run: run.id,
        unscheduled: kept.filter(Result.unscheduled).length,
        verdicts,
      }
    })
  })
  const reference = members.findIndex((member) => member.label === options.reference)
  if (reference < 0)
    throw new InvalidError(
      'no arm is named ' +
        options.reference +
        ': the arms are ' +
        members.map((member) => member.label).join(', '),
    )

  const keys = [...members[0]!.verdicts.keys()].filter((name) =>
    members.every((member) => member.verdicts.has(name)),
  )
  if (!keys.length)
    throw new InvalidError(
      'the matched set is empty: no task#attempt has a verdict in every one of ' +
        members.map((member) => member.label).join(', '),
    )
  const tasks = [...new Set(keys.map((name) => members[0]!.verdicts.get(name)!.task.name))].sort(
    ordered,
  )
  const matched = members.map((member) =>
    tasks.map((task) =>
      keys
        .map((name) => member.verdicts.get(name)!)
        .filter((attempt) => attempt.task.name === task)
        .sort((one, two) => one.index - two.index),
    ),
  )
  const prices = options.prices ?? {}
  const costs = matched.map((arm) =>
    arm.map((task) => task.map((attempt) => cost(attempt, prices))),
  )
  const based = (at: number, basis: Cost['basis'] | undefined) =>
    costs[at]!.flat().filter((found) => found?.basis === basis).length
  const uncosted = matched.map((_, at) => based(at, undefined))
  const cells = matched.map((arm, at) =>
    arm.map((task, index) =>
      task.map((attempt, row) => ({
        passed: attempt.outcome === 'passed',
        usd: costs[at]![index]![row]?.usd ?? 0,
      })),
    ),
  )
  const point = cells.map((arm) => rate(arm.flat()))
  const drawn = bootstrap(cells, { draws: options.draws, seed: options.seed })
  const costed = (at: number) => uncosted[at] === 0

  return {
    arms: members.map((member, at) => {
      const rows = matched[at]!.flat()
      const count = (outcome: Result.Attempt['outcome']) =>
        rows.filter((attempt) => attempt.outcome === outcome).length
      const used = rows.flatMap((attempt) => (attempt.usage ? [attempt.usage] : []))
      const calls = used.every((usage) => typeof usage.modelCalls === 'number')
      return {
        against:
          at === reference
            ? null
            : {
                passRateDifference: estimate(
                  point[at]!.passRate - point[reference]!.passRate,
                  drawn.map((draw) => draw[at]!.passRate - draw[reference]!.passRate),
                ),
                usdPerPassRatio:
                  costed(at) && costed(reference)
                    ? estimate(
                        point[at]!.usdPerPass / point[reference]!.usdPerPass,
                        drawn.map((draw) => draw[at]!.usdPerPass / draw[reference]!.usdPerPass),
                      )
                    : null,
              },
        cancelled: member.cancelled,
        errored: count('errored'),
        excluded: member.excluded,
        failed: count('failed'),
        id: member.agent.id,
        label: member.label,
        listed: based(at, 'list'),
        matched: rows.length,
        modelCallsPerAttempt: calls
          ? used.reduce((sum, usage) => sum + usage.modelCalls, 0) / rows.length
          : null,
        outputTokensPerAttempt:
          used.reduce((sum, usage) => sum + usage.outputTokens, 0) / rows.length,
        passed: count('passed'),
        passRate: estimate(
          point[at]!.passRate,
          drawn.map((draw) => draw[at]!.passRate),
        ),
        recorded: based(at, 'recorded'),
        run: member.run,
        spec: member.agent,
        uncosted: uncosted[at]!,
        unmatched: member.verdicts.size - rows.length,
        unscheduled: member.unscheduled,
        usdPerAttempt: costed(at)
          ? cells[at]!.flat().reduce((sum, cell) => sum + cell.usd, 0) / rows.length
          : null,
        usdPerPass: costed(at)
          ? estimate(
              point[at]!.usdPerPass,
              drawn.map((draw) => draw[at]!.usdPerPass),
            )
          : null,
      }
    }),
    command: options.command,
    commit: options.commit ?? null,
    draws: options.draws,
    eval: first.eval,
    excluded: options.exclude
      ? {
          digest: options.exclude.digest,
          file: options.exclude.file,
          ...(options.exclude.reason === undefined ? {} : { reason: options.exclude.reason }),
          tasks: options.exclude.names.map((name) => ({
            name,
            rows: runs
              .flatMap((run) => run.results)
              .filter((attempt) => attempt.task.name === name || short(attempt.task.name) === name)
              .length,
          })),
        }
      : null,
    level,
    matched: { attempts: keys.length, tasks: tasks.length },
    prices: options.prices && Object.keys(options.prices).length ? options.prices : null,
    reference: options.reference,
    runs: runs.map((run) => ({
      arms: members.filter((member) => member.run === run.id).map((member) => member.label),
      attempts: run.attempts,
      id: run.id,
      name: run.name,
      nanocode: run.nanocode ?? null,
      rows: run.results.length,
      state: run.state,
    })),
    seed: options.seed,
    tasks: tasks.map((name, task) => ({
      attempts: matched[0]![task]!.length,
      name,
      passed: matched.map(
        (arm) => arm[task]!.filter((attempt) => attempt.outcome === 'passed').length,
      ),
    })),
  }
}

export declare namespace build {
  type Options = {
    command: string
    commit?: string | undefined
    draws: number
    exclude?: Exclusion | undefined
    prices?: Price.List | undefined
    reference: string
    seed: number
  }
}

export function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function range(found: Estimate, format: (value: number) => string): string {
  const side = (value: number | null) => (value === null ? 'no bound' : format(value))
  return '[' + side(found.low) + ', ' + side(found.high) + ']'
}

function figure(found: Estimate, format: (value: number) => string): string {
  return found.value === null ? 'no pass' : format(found.value)
}

export function shown(found: Estimate | null, format: (value: number) => string): string {
  if (!found) return 'not recorded'
  return figure(found, format) + ' <span class="ci">' + range(found, format) + '</span>'
}

function plain(found: Estimate | null, format: (value: number) => string): string {
  return found ? figure(found, format) + ' ' + range(found, format) : 'not recorded'
}

export const percent = (value: number) => (100 * value).toFixed(1)

export const usd = (value: number) => '$' + value.toFixed(3)

export const points = (value: number) => (value > 0 ? '+' : '') + (100 * value).toFixed(1)

export const times = (value: number) => value.toFixed(2)

export function basis(arm: Arm): string {
  if (arm.uncosted) return 'not recorded'
  if (!arm.listed) return 'recorded by the run'
  return arm.recorded
    ? 'recorded by the run and list price from recorded tokens'
    : 'list price from recorded tokens'
}

export function costs(card: Card): string {
  const listed = [
    ...new Set(card.arms.filter((arm) => arm.listed).map((arm) => arm.spec.model)),
  ].sort(ordered)
  return [
    'Cost basis, in matched rows.',
    ...card.arms.map(
      (arm) =>
        arm.label +
        ': ' +
        basis(arm) +
        ' (' +
        arm.recorded +
        ' recorded by the run, ' +
        arm.listed +
        ' at the list price from recorded tokens, ' +
        (arm.matched - arm.recorded - arm.listed - arm.uncosted) +
        ' without a model call at USD 0, ' +
        arm.uncosted +
        ' not recorded).',
    ),
    ...listed.map((model) => {
      const price = card.prices![model]!
      return (
        'List price of ' +
        model +
        ', USD a million tokens: input ' +
        price.inputUsd +
        ', cached input ' +
        price.cachedUsd +
        ', output ' +
        price.outputUsd +
        (price.writeUsd
          ? ', cache write for 5 minutes ' +
            price.writeUsd.fiveMinutes +
            ', for 1 hour ' +
            price.writeUsd.oneHour
          : '') +
        '.'
      )
    }),
    ...(card.arms.some((arm) => arm.uncosted)
      ? ['An arm with a row whose cost is not recorded shows no USD figure, never 0.']
      : []),
  ].join(' ')
}

export function text(card: Card): string {
  return (
    [
      'matched set: ' +
        card.matched.attempts +
        ' task#attempts of ' +
        card.matched.tasks +
        ' tasks, reference ' +
        card.reference,
      ...card.arms.map(
        (arm) =>
          arm.label +
          ': ' +
          arm.matched +
          ' attempts, passed ' +
          arm.passed +
          ', failed ' +
          arm.failed +
          ', errored ' +
          arm.errored +
          ', pass rate ' +
          plain(arm.passRate, percent) +
          ' %, USD a pass ' +
          plain(arm.usdPerPass, usd) +
          (arm.against
            ? ', difference ' +
              plain(arm.against.passRateDifference, points) +
              ' points, USD a pass times ' +
              plain(arm.against.usdPerPassRatio, times)
            : ', reference') +
          ', unmatched ' +
          arm.unmatched +
          ', cancelled ' +
          arm.cancelled +
          ', unscheduled ' +
          arm.unscheduled,
      ),
    ].join('\n') + '\n'
  )
}

export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return (
    '<table><thead><tr>' +
    head.map((cell) => '<th>' + cell + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows
      .map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>')
      .join('\n') +
    '</tbody></table>'
  )
}

const style =
  'body{font:14px/1.45 system-ui,sans-serif;color:#1a1a1a;background:#fff;margin:2rem auto;max-width:76rem;padding:0 1rem}' +
  'h1{font-size:1.6rem;margin:0 0 .3rem}h2{font-size:1.1rem;margin:2rem 0 .5rem}' +
  'p{margin:.4rem 0;max-width:60rem}code,pre,.mono{font:12px/1.4 ui-monospace,monospace}' +
  'pre{background:#f4f4f2;padding:.7rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all}' +
  'table{border-collapse:collapse;margin:.4rem 0}th,td{border:1px solid #d8d8d4;padding:.25rem .55rem;text-align:right;white-space:nowrap}' +
  'th{background:#f4f4f2;font-weight:600}th:first-child,td:first-child{text-align:left}' +
  '.ci{color:#666;font-size:12px}.ref{font-weight:600}'

export function html(card: Card): string {
  const several = card.runs.length > 1
  const percentLevel = Math.round(100 * card.level)
  const name = (arm: Arm) =>
    arm.label === card.reference
      ? '<span class="ref">' + escape(arm.label) + '</span>'
      : escape(arm.label)
  const options = (arm: Arm) =>
    Object.entries(arm.spec)
      .filter((entry) => !['id', 'model', 'provider', 'thinking'].includes(entry[0]))
      .map((entry) => escape(entry[0] + '=' + JSON.stringify(entry[1])))
      .join(' ')
  const results = table(
    [
      'Arm',
      'Passed',
      'Failed',
      'Errored',
      'Pass rate, % [' + percentLevel + ' %]',
      'Difference to ' + escape(card.reference) + ', points',
      'USD an attempt',
      'USD a pass',
      'USD a pass, times ' + escape(card.reference),
      'Output tokens an attempt',
      'Model calls an attempt',
    ],
    card.arms.map((arm) => [
      name(arm),
      String(arm.passed),
      String(arm.failed),
      String(arm.errored),
      shown(arm.passRate, percent),
      arm.against ? shown(arm.against.passRateDifference, points) : 'reference',
      arm.usdPerAttempt === null ? 'not recorded' : usd(arm.usdPerAttempt),
      shown(arm.usdPerPass, usd),
      arm.against ? shown(arm.against.usdPerPassRatio, times) : 'reference',
      arm.outputTokensPerAttempt.toFixed(0),
      arm.modelCallsPerAttempt === null ? 'not recorded' : arm.modelCallsPerAttempt.toFixed(1),
    ]),
  )
  const apart = table(
    [
      'Arm',
      'Rows with a verdict',
      'Matched',
      'Unmatched',
      'Cancelled',
      'Unscheduled',
      'Of excluded tasks',
      'Matched rows without a cost',
    ],
    card.arms.map((arm) => [
      name(arm),
      String(arm.matched + arm.unmatched),
      String(arm.matched),
      String(arm.unmatched),
      String(arm.cancelled),
      String(arm.unscheduled),
      String(arm.excluded),
      String(arm.uncosted),
    ]),
  )
  const specs = table(
    ['Arm', 'Run', 'Provider', 'Model', 'Effort', 'Options'],
    card.arms.map((arm) => [
      name(arm),
      '<span class="mono">' + escape(arm.run) + '</span>',
      escape(arm.spec.provider),
      escape(arm.spec.model),
      escape(arm.spec.thinking ?? 'not set'),
      options(arm) || 'none',
    ]),
  )
  const runs = table(
    ['Run', 'Name', 'State', 'Attempts a task', 'Rows', 'Harness', 'Hands', 'Arms'],
    card.runs.map((run) => [
      '<span class="mono">' + escape(run.id) + '</span>',
      escape(run.name),
      run.state,
      String(run.attempts),
      String(run.rows),
      escape(run.nanocode?.harness ?? 'not recorded'),
      escape(run.nanocode?.hands.join(', ') || 'not recorded'),
      escape(run.arms.join(', ')),
    ]),
  )
  const tasks = table(
    ['Task', 'Attempts', ...card.arms.map(name)],
    card.tasks.map((task) => [
      escape(task.name),
      String(task.attempts),
      ...task.passed.map(String),
    ]),
  )
  const excluded = card.excluded
    ? '<p>The file ' +
      escape(card.excluded.file) +
      ' (sha256 <code>' +
      card.excluded.digest +
      '</code>) names ' +
      card.excluded.tasks.length +
      ' tasks. Their rows are in no count above.' +
      (card.excluded.reason === undefined ? '' : ' Reason: ' + escape(card.excluded.reason)) +
      '</p>' +
      table(
        ['Task', 'Rows left out'],
        card.excluded.tasks.map((task) => [escape(task.name), String(task.rows)]),
      )
    : '<p>No task is excluded.</p>'
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>nanoeval scorecard: ' +
    escape(card.eval.name) +
    '</title><style>' +
    style +
    '</style></head><body>\n<h1>nanoeval scorecard</h1>\n<p>Eval ' +
    escape(card.eval.name) +
    ' <code>' +
    escape(card.eval.version) +
    '</code>. ' +
    card.arms.length +
    ' arms, reference arm <span class="ref">' +
    escape(card.reference) +
    '</span>. Matched set: ' +
    card.matched.attempts +
    ' task#attempts of ' +
    card.matched.tasks +
    ' tasks, each with a verdict in every arm.</p>\n' +
    (several
      ? '<p>The arms come from ' +
        card.runs.length +
        ' runs that share this eval digest. The table of arm specs names the run of each arm.</p>\n'
      : '') +
    '<h2>Arms on the matched set</h2>\n' +
    results +
    '\n<p>' +
    escape(costs(card)) +
    '</p>' +
    '\n<h2>Rows apart from the matched set</h2>\n' +
    apart +
    '\n<h2>Arm specs</h2>\n' +
    specs +
    '\n<h2>Runs</h2>\n' +
    runs +
    '\n<h2>Passes a task</h2>\n' +
    tasks +
    '\n<h2>Excluded tasks</h2>\n' +
    excluded +
    '\n<h2>Method</h2>\n<p>A row with the outcome passed, failed or errored has a verdict. A cancelled row and a row that no runner took, which ends as unscheduled, are not attempts, and each is counted apart. The matched set holds every task#attempt with a verdict in every arm, and every figure of an arm is over its rows of that set. USD is the cost that the run recorded for the row. A row whose model calls carry no cost is priced from its recorded tokens when the command was given a list price of its model, and the line under the table of arms counts such rows. A row without a model call costs nothing, and an arm with a row whose cost is not recorded shows no USD figure.</p>\n<p>Each interval is the ' +
    percentLevel +
    ' % percentile interval of ' +
    card.draws +
    ' draws of a task-clustered bootstrap with seed ' +
    card.seed +
    '. A draw resamples the tasks with replacement, the same tasks for every arm, then resamples the attempts of each drawn task within each arm. A draw without a pass has no finite USD a pass and sorts above every other draw. The same rows, seed and draws give the same numbers.</p>\n' +
    '<h2>Reproduce</h2>\n<pre>' +
    escape(card.command) +
    '</pre>\n<p>nanoeval commit <code>' +
    escape(card.commit ?? 'not recorded: the command did not run from a git checkout') +
    '</code>. The command line leaves out the token.</p>\n</body></html>\n'
  )
}
