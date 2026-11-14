import * as Installed from './Installed.ts'
import * as Pins from './Pins.ts'
import * as Result from './Result.ts'
import * as Route from './Route.ts'
import * as Stats from './Stats.ts'

export type Run = {
  attempts: readonly Result.Attempt[]
  digests?: Readonly<Record<string, string>>
  eval: { name: string; version: string }
  id: string
  name: string
  nanocode?: Pins.Pins
  state: 'finished' | 'running'
}

export type Arm = {
  agent: string
  agentSec: number
  attempts: number
  cachedTokens: number
  costUsd: number | null
  errored: number
  failed: number
  harness: string
  inputTokens: number
  judgeCostUsd: number | null
  judged: number
  key: string
  metered: number
  model: string
  outputTokens: number
  passed: number
  priced: number
  reasoningTokens: number | null
  routes: Route.Route[]
  runs: string[]
  tasks: number
  totalSec: number
}

export type Member = {
  agent: Result.Attempt['agent']
  attempts: Result.Attempt[]
  label: string
  routes: Route.Route[]
  runs: string[]
}

export type Recorded = 'effort' | Route.Aspect

export type Pair = {
  agent: string
  baseline: string[]
  by: 'kind' | 'name' | 'none'
  differs: string[]
  missing: { baseline: Recorded[]; run: Recorded[] }
  reason?: string
  reported: string[]
}

export type Score = { errored: number; passed: number; scored: number }

export type Moved =
  | 'changed'
  | 'down'
  | 'gained'
  | 'lost'
  | 'only-baseline'
  | 'only-run'
  | 'same'
  | 'unscored'
  | 'up'

export type TaskChange = {
  baseline: Score | undefined
  chance?: number
  moved: Moved
  name: string
  run: Score | undefined
}

export type Change = {
  agent: string
  attempts: { baseline: Typical | undefined; run: Typical }
  baseline: Result.AgentSummary | undefined
  common: {
    baseline: Record<string, number>
    rated: Record<string, number>
    run: Record<string, number>
  }
  overall: {
    better: number
    down: number
    floor: number
    same: number
    tasks: number
    up: number
    verdict: 'improvement' | 'none' | 'regression'
    worse: number
  }
  pair: Pair
  routed: boolean
  run: Result.AgentSummary
  tasks: TaskChange[]
}

export type Side = Run | readonly Run[]

export type Typical = { agentSec: number | null; modelCalls: number | null }

export function harness(agent: Result.Attempt['agent'], nanocode?: Pins.Pins): string {
  if (agent.provider === 'oracle') return 'oracle'
  if (Installed.is(agent.provider))
    return agent.provider + ' ' + Installed.releases[agent.provider].version
  return nanocode ? Pins.text(nanocode) : 'nanocode'
}

export function model(agent: Result.Attempt['agent']): string {
  if (agent.provider === 'oracle') return 'the task solution'
  const provider = Installed.is(agent.provider)
    ? Installed.releases[agent.provider].provider
    : kind(agent)
  return provider + ':' + agent.model + (agent.thinking ? ':' + agent.thinking : '')
}

function key(agent: Result.Attempt['agent'], nanocode?: Pins.Pins): string {
  return [
    agent.id,
    agent.provider,
    agent.model,
    agent.thinking ?? '',
    agent.orchestration ?? '',
    agent.preflight ? 'preflight' : '',
    harness(agent, nanocode),
  ].join(' ')
}

function seconds(phase: Result.Phase | undefined): number {
  return phase ? (phase.finishedAt - phase.startedAt) / 1000 : 0
}

export function standing(given: readonly Run[]): Run[] {
  const runs = given.filter((run, at) => given.findIndex((other) => other.id === run.id) === at)
  const retried = new Set(
    runs.flatMap((run) =>
      run.attempts.flatMap((attempt) =>
        attempt.retryOf ? [attempt.retryOf.run + ' ' + attempt.retryOf.attempt] : [],
      ),
    ),
  )
  return runs.map((run) => ({
    ...run,
    attempts: run.attempts.filter((attempt) => !retried.has(run.id + ' ' + attempt.id)),
  }))
}

function row(attempt: Result.Attempt): string {
  return attempt.task.name + ' #' + attempt.index
}

export function arms(given: readonly Run[]): Arm[] {
  const runs = standing(given)
  const found: { arm: Arm; rows: Set<string>; tasks: Set<string> }[] = []
  for (const run of runs) {
    const own = new Map<string, Result.Attempt[]>()
    for (const attempt of run.attempts) {
      const id = key(attempt.agent, run.nanocode)
      own.set(id, [...(own.get(id) ?? []), attempt])
    }
    for (const [id, attempts] of own) {
      const routes = Route.distinct(attempts.map((attempt) => attempt.route))
      let entry = found.find(
        (each) =>
          each.arm.key === id &&
          (!routes.length ||
            !each.arm.routes.length ||
            Route.text(routes) === Route.text(each.arm.routes)) &&
          !attempts.some((attempt) => each.rows.has(row(attempt))),
      )
      if (!entry) {
        const agent = attempts[0]!.agent
        entry = {
          arm: {
            agent: agent.id,
            agentSec: 0,
            attempts: 0,
            cachedTokens: 0,
            costUsd: null,
            errored: 0,
            failed: 0,
            harness: harness(agent, run.nanocode),
            inputTokens: 0,
            judgeCostUsd: null,
            judged: 0,
            key: id,
            metered: 0,
            model: model(agent),
            outputTokens: 0,
            passed: 0,
            priced: 0,
            reasoningTokens: null,
            routes: [],
            runs: [],
            tasks: 0,
            totalSec: 0,
          },
          rows: new Set(),
          tasks: new Set(),
        }
        found.push(entry)
      }
      const arm = entry.arm
      arm.routes = Route.distinct([...arm.routes, ...routes])
      arm.runs.push(run.id)
      for (const attempt of attempts) {
        arm.attempts++
        arm[attempt.outcome]++
        arm.agentSec += seconds(attempt.timing.agentExecution)
        arm.totalSec += (attempt.finishedAt - attempt.startedAt) / 1000
        entry.rows.add(row(attempt))
        entry.tasks.add(attempt.task.name)
        if (attempt.judge) {
          arm.judged++
          if (attempt.judge.usage?.costUsd !== undefined)
            arm.judgeCostUsd = (arm.judgeCostUsd ?? 0) + attempt.judge.usage.costUsd
        }
        if (attempt.usage) {
          arm.metered++
          arm.cachedTokens += attempt.usage.cachedTokens
          arm.inputTokens += attempt.usage.inputTokens
          arm.outputTokens += attempt.usage.outputTokens
          if (typeof attempt.usage.reasoningTokens === 'number')
            arm.reasoningTokens = (arm.reasoningTokens ?? 0) + attempt.usage.reasoningTokens
          if (attempt.usage.costUsd !== undefined) {
            arm.priced++
            arm.costUsd = (arm.costUsd ?? 0) + attempt.usage.costUsd
          }
        }
      }
    }
  }
  for (const entry of found) entry.arm.tasks = entry.tasks.size
  return found.map((entry) => entry.arm)
}

function duration(value: number): string {
  const whole = Math.round(value)
  if (whole < 60) return whole + ' s'
  const minutes = Math.floor(whole / 60)
  return minutes < 60
    ? minutes + ' min ' + (whole % 60) + ' s'
    : Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min'
}

function cells(rows: readonly (readonly string[])[]): string {
  const [head, ...body] = rows
  return [head!, head!.map(() => '---'), ...body]
    .map((row) => '| ' + row.join(' | ') + ' |')
    .join('\n')
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function cost(value: number | null): string {
  return value === null ? 'not known' : '$' + value.toFixed(4)
}

function reasoning(value: number | null | undefined): string {
  return typeof value === 'number' ? number(value) : Route.unrecorded
}

function line(run: Run, ended: number): string {
  return (
    'run ' +
    run.id +
    ' (' +
    run.name +
    '): ' +
    run.state +
    ', ' +
    run.eval.name +
    '@' +
    run.eval.version.slice(0, 12) +
    ', ' +
    ended +
    ' attempts ended' +
    (run.attempts.length === ended
      ? ''
      : ', ' +
        (ended - run.attempts.length) +
        ' of them retried by a run of this table and left out') +
    (run.nanocode ? ', ' + Pins.text(run.nanocode) : '')
  )
}

export function table(given: readonly Run[]): string {
  const runs = standing(given)
  const ended = new Map(given.map((run) => [run.id, run.attempts.length]))
  const all = arms(runs)
  const title = (arm: Arm) =>
    all.filter((other) => other.agent === arm.agent).length === 1
      ? arm.agent
      : arm.agent + ' of ' + arm.runs.map((id) => id.slice(0, 8)).join(' and ')
  const judged = all.some((arm) => arm.judged)
  const summary = cells([
    [
      'Arm',
      'Harness',
      'Model',
      'Model route',
      'Attempts',
      'Passed',
      'Failed',
      'Errored',
      'Agent time',
      'Attempt time',
      'Input tokens (cached)',
      'Output tokens (reasoning)',
      'Estimated cost',
      ...(judged ? ['Judge cost'] : []),
    ],
    ...all.map((arm) => [
      title(arm),
      arm.harness,
      arm.model,
      arm.harness === 'oracle' ? 'none' : Route.text(arm.routes),
      String(arm.attempts),
      String(arm.passed),
      String(arm.failed),
      String(arm.errored),
      duration(arm.agentSec),
      duration(arm.totalSec),
      arm.metered
        ? number(arm.inputTokens) + ' (' + number(arm.cachedTokens) + ')'
        : 'not recorded',
      arm.metered
        ? number(arm.outputTokens) + ' (' + reasoning(arm.reasoningTokens) + ')'
        : 'not recorded',
      cost(arm.costUsd) +
        (arm.costUsd === null || arm.priced === arm.attempts
          ? ''
          : ' for ' + arm.priced + ' of ' + arm.attempts),
      ...(judged ? [arm.judged ? cost(arm.judgeCostUsd) : 'no judge'] : []),
    ]),
  ])

  const names = [
    ...new Set(runs.flatMap((run) => run.attempts.map((attempt) => attempt.task.name))),
  ].sort()
  const outcome = (task: string, arm: Arm) => {
    const own = runs
      .flatMap((run) =>
        run.attempts.filter(
          (attempt) =>
            attempt.task.name === task &&
            arm.runs.includes(run.id) &&
            key(attempt.agent, run.nanocode) === arm.key,
        ),
      )
      .sort((left, right) => left.index - right.index)
    return own.length
      ? own
          .map(
            (attempt) =>
              attempt.outcome +
              (Result.timeout(attempt)
                ? ' ' + Result.afterTimeout
                : attempt.failure
                  ? ' (' + attempt.failure.kind + ')'
                  : '') +
              ' ' +
              duration(seconds(attempt.timing.agentExecution)),
          )
          .join(', ')
      : 'not run'
  }
  const tasks = cells([
    ['Task', ...all.map(title)],
    ...names.map((task) => [task.split('/').at(-1)!, ...all.map((arm) => outcome(task, arm))]),
  ])

  return (
    [...runs.map((run) => line(run, ended.get(run.id)!)), '', summary, '', tasks].join('\n') + '\n'
  )
}

export function lineages(given: readonly Run[]): Run[][] {
  const runs = given.filter((run, at) => given.findIndex((other) => other.id === run.id) === at)
  const sides: Run[][] = []
  for (const run of runs) {
    const parents = new Set(run.attempts.flatMap((attempt) => attempt.retryOf?.run ?? []))
    const children = new Set(
      runs.flatMap((other) =>
        other.attempts.some((attempt) => attempt.retryOf?.run === run.id) ? [other.id] : [],
      ),
    )
    const joined = sides.filter((side) =>
      side.some((other) => parents.has(other.id) || children.has(other.id)),
    )
    const side = [...joined.flat(), run]
    for (const each of joined) sides.splice(sides.indexOf(each), 1)
    sides.push(side)
  }
  return sides.sort((left, right) => runs.indexOf(left[0]!) - runs.indexOf(right[0]!))
}

function side(given: Side): Run[] {
  return standing(Array.isArray(given) ? (given as readonly Run[]) : [given as Run])
}

function typed(agent: Result.Attempt['agent']): string {
  return [
    agent.provider,
    agent.orchestration ?? '',
    agent.preflight ? 'preflight' : '',
    agent.model,
    agent.thinking ?? '',
  ].join(' ')
}

function kind(agent: Result.Attempt['agent']): string {
  return (
    agent.provider +
    (agent.orchestration ? '-' + agent.orchestration : '') +
    (agent.preflight ? '+preflight' : '')
  )
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function efforts(member: Member): string[] {
  const recorded = unique(member.routes.flatMap((route) => route.effort ?? []))
  return recorded.length || !member.agent.thinking ? recorded : [member.agent.thinking]
}

function alike(one: Member, other: Member): boolean {
  if (kind(one.agent) !== kind(other.agent) || one.agent.model !== other.agent.model) return false
  if (!one.agent.thinking && !other.agent.thinking) return true
  const left = efforts(one)
  const right = efforts(other)
  return left.length > 0 && left.join(' ') === right.join(' ')
}

export function members(runs: readonly Run[]): Member[] {
  const found: Member[] = []
  for (const run of runs)
    for (const attempt of run.attempts) {
      let member = found.find(
        (each) => each.label === attempt.agent.id && typed(each.agent) === typed(attempt.agent),
      )
      if (!member) {
        member = {
          agent: attempt.agent,
          attempts: [],
          label: attempt.agent.id,
          routes: [],
          runs: [],
        }
        found.push(member)
      }
      member.attempts.push(attempt)
      if (!member.runs.includes(run.id)) member.runs.push(run.id)
    }
  for (const member of found)
    member.routes = Route.distinct(member.attempts.map((attempt) => attempt.route))
  return found
}

export function planned(
  agents: readonly Result.Attempt['agent'][],
  input: { routes: (agent: Result.Attempt['agent']) => readonly Route.Route[]; run?: string },
): Member[] {
  return agents.map((agent) => ({
    agent,
    attempts: [],
    label: agent.id,
    routes: Route.distinct(input.routes(agent)),
    runs: input.run === undefined ? [] : [input.run],
  }))
}

type Sides = { baseline: readonly Member[]; run: readonly Member[] }

function partners(
  member: Member,
  sides: Sides,
): { by: Pair['by']; found: Member[]; reason?: string } {
  const like = sides.baseline.filter((each) => alike(each, member))
  const same = like.filter((each) => each.label === member.label)
  if (same.length) return { by: 'kind', found: same }
  const labels = (all: readonly Member[]) => unique(all.map((each) => each.label)).join(' and ')
  if (like.length) {
    const twins = sides.run.filter((each) => each !== member && alike(each, member))
    const crowded = like.some((one) =>
      like.some(
        (other) => other.label !== one.label && other.runs.some((run) => one.runs.includes(run)),
      ),
    )
    if (crowded)
      return {
        by: 'none',
        found: [],
        reason:
          'the baseline holds ' +
          labels(like) +
          ', which are all ' +
          model(member.agent) +
          ', and none is named ' +
          member.label,
      }
    if (twins.length)
      return {
        by: 'none',
        found: [],
        reason:
          'the run holds ' +
          labels([member, ...twins]) +
          ', which are all ' +
          model(member.agent) +
          ', and the baseline names it ' +
          labels(like),
      }
    return { by: 'kind', found: like }
  }
  const named = sides.baseline.filter((each) => each.label === member.label)
  return named.length ? { by: 'name', found: named } : { by: 'none', found: [] }
}

function match(member: Member, sides: Sides): { found: Member[]; pair: Pair } {
  const { by, found, reason } = partners(member, sides)
  const differs: string[] = []
  const reported: string[] = []
  const missing: Pair['missing'] = { baseline: [], run: [] }
  const said = (name: string, value: { after: readonly string[]; before: readonly string[] }) =>
    name +
    ' ' +
    value.before.join(' and ') +
    ' in the baseline and ' +
    value.after.join(' and ') +
    ' in the run'
  const lack = (name: Recorded, side: 'both' | 'left' | 'right') => {
    if (side !== 'right') missing.baseline.push(name)
    if (side !== 'left') missing.run.push(name)
  }
  if (found.length && member.agent.provider !== 'oracle') {
    const kinds = unique(found.map((each) => kind(each.agent)))
    if (kinds.join(' ') !== kind(member.agent))
      differs.push(said('harness', { after: [kind(member.agent)], before: kinds }))
    const models = unique(found.map((each) => each.agent.model))
    if (models.join(' ') !== member.agent.model)
      differs.push(said('model', { after: [member.agent.model], before: models }))
    const before = unique(found.flatMap(efforts))
    const after = efforts(member)
    const route = Route.differences(
      found.flatMap((each) => each.routes),
      member.routes,
    )
    for (const each of route.differ)
      (each.aspect === 'payer' ? differs : reported).push(
        said(each.aspect, { after: [each.right], before: [each.left] }),
      )
    for (const each of route.missing) lack(each.aspect, each.side)
    const typed = member.agent.thinking || found.some((each) => each.agent.thinking)
    if (before.length && after.length) {
      if (before.join(' ') !== after.join(' '))
        (typed ? differs : reported).push(said('effort', { after, before }))
    } else if (before.length || after.length) lack('effort', before.length ? 'right' : 'left')
  }
  return {
    found,
    pair: {
      agent: member.label,
      baseline: unique(found.map((each) => each.label)),
      by,
      differs,
      missing,
      ...(reason === undefined ? {} : { reason }),
      reported,
    },
  }
}

export function pairs(baseline: readonly Member[], run: readonly Member[]): Pair[] {
  return run.map((member) => match(member, { baseline, run }).pair)
}

export function unlike(found: readonly Pair[]): string | undefined {
  const differing = found.filter((pair) => pair.differs.length)
  if (!differing.length) return undefined
  return (
    differing
      .map(
        (pair) =>
          pair.agent +
          ' differs from the baseline: ' +
          [...pair.differs, ...pair.reported].join(', '),
      )
      .join('; ') +
    '. A comparison would set two different things against each other: pass --unlike to make it anyway'
  )
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function typical(attempts: readonly Result.Attempt[]): Typical {
  const scored = attempts.filter((attempt) => attempt.outcome !== 'errored')
  return {
    agentSec: median(
      scored.flatMap((attempt) =>
        attempt.timing.agentExecution ? [seconds(attempt.timing.agentExecution)] : [],
      ),
    ),
    modelCalls: median(
      scored.flatMap((attempt) => (attempt.usage ? [attempt.usage.modelCalls] : [])),
    ),
  }
}

function summary(attempts: readonly Result.Attempt[]): Result.AgentSummary | undefined {
  return Result.summarize(
    attempts.map((attempt) => ({ ...attempt, agent: { ...attempt.agent, id: 'agent' } })),
  )['agent']
}

function scores(attempts: readonly Result.Attempt[]): Map<string, Score> {
  const tasks = new Map<string, Score>()
  for (const attempt of attempts) {
    const task = tasks.get(attempt.task.name) ?? { errored: 0, passed: 0, scored: 0 }
    if (attempt.outcome === 'errored') task.errored++
    else task.scored++
    if (attempt.outcome === 'passed') task.passed++
    tasks.set(attempt.task.name, task)
  }
  return tasks
}

function versions(runs: readonly Run[]): Map<string, { checksum: string; digest?: string }> {
  const tasks = new Map<string, { checksum: string; digest?: string }>()
  for (const run of runs)
    for (const attempt of run.attempts) {
      const digest = run.digests?.[attempt.task.name]
      if (!tasks.has(attempt.task.name))
        tasks.set(attempt.task.name, {
          checksum: attempt.task.checksum,
          ...(digest === undefined ? {} : { digest }),
        })
    }
  return tasks
}

export function changes(baseline: Side, run: Side): Change[] {
  const sides = { baseline: side(baseline), run: side(run) }
  const left = members(sides.baseline)
  const right = members(sides.run)
  const held = { baseline: versions(sides.baseline), run: versions(sides.run) }
  const differs = (name: string) => {
    const one = held.baseline.get(name)
    const other = held.run.get(name)
    if (!one || !other) return false
    return one.digest !== undefined && other.digest !== undefined
      ? one.digest !== other.digest
      : one.checksum !== other.checksum
  }
  return right.map((member) => {
    const { found, pair } = match(member, { baseline: left, run: right })
    const paired = found.flatMap((each) => each.attempts)
    const old = scores(paired)
    const now = scores(member.attempts)
    const tasks: TaskChange[] = []
    const both: { baseline: Score; run: Score }[] = []
    for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const was = old.get(name)
      const is = now.get(name)
      const change: TaskChange = {
        baseline: was,
        moved: 'same',
        name: name.split('/').at(-1)!,
        run: is,
      }
      if (!was) change.moved = 'only-run'
      else if (!is) change.moved = 'only-baseline'
      else if (differs(name)) change.moved = 'changed'
      else if (!was.scored || !is.scored) change.moved = 'unscored'
      else {
        both.push({ baseline: was, run: is })
        const tails = Stats.task(was, is)
        const moved = is.passed * was.scored - was.passed * is.scored
        if (moved < 0) {
          change.chance = tails.worse
          change.moved = tails.worse <= Stats.alpha ? 'lost' : 'down'
        } else if (moved > 0) {
          change.chance = tails.better
          change.moved = tails.better <= Stats.alpha ? 'gained' : 'up'
        }
      }
      tasks.push(change)
    }
    const common: Change['common'] = { baseline: {}, rated: {}, run: {} }
    for (let k = 1; ; k++) {
      const rated = both.filter((each) => each.baseline.scored >= k && each.run.scored >= k)
      if (!rated.length) break
      const mean = (name: 'baseline' | 'run') =>
        rated.reduce((total, each) => total + Result.passAt(each[name], k), 0) / rated.length
      common.baseline[String(k)] = mean('baseline')
      common.rated[String(k)] = rated.length
      common.run[String(k)] = mean('run')
    }
    const tails = Stats.overall(both)
    const count = (...moved: Moved[]) => tasks.filter((task) => moved.includes(task.moved)).length
    return {
      agent: member.label,
      attempts: {
        baseline: paired.length ? typical(paired) : undefined,
        run: typical(member.attempts),
      },
      baseline: summary(paired),
      common,
      overall: {
        better: tails.better,
        down: count('down', 'lost'),
        floor: Stats.floor(
          Math.max(0, ...both.map((each) => each.baseline.scored)),
          Math.max(0, ...both.map((each) => each.run.scored)),
        ),
        same: count('same'),
        tasks: both.length,
        up: count('up', 'gained'),
        verdict:
          tails.worse <= Stats.alpha
            ? 'regression'
            : tails.better <= Stats.alpha
              ? 'improvement'
              : 'none',
        worse: tails.worse,
      },
      pair,
      routed: member.agent.provider !== 'oracle',
      run: summary(member.attempts)!,
      tasks,
    }
  })
}

function count(score: Score): string {
  return score.scored
    ? score.passed + '/' + score.scored + (score.errored ? ' +' + score.errored + ' errored' : '')
    : score.errored + ' errored'
}

function chance(value: number): string {
  return value < 0.001 ? 'p < 0.001' : 'p = ' + value.toFixed(3)
}

function named(runs: readonly Run[]): string {
  return runs.length === 1
    ? runs[0]!.id
    : runs[0]!.id +
        ' with ' +
        runs
          .slice(1)
          .map((run) => run.id.slice(0, 8))
          .join(', ')
}

function pins(runs: readonly Run[]): string {
  return (
    [...new Set(runs.map((run) => (run.nanocode ? Pins.text(run.nanocode) : 'not recorded')))].join(
      ' and ',
    ) || 'not recorded'
  )
}

function list(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1)
}

const recorded: Record<Recorded, string> = {
  effort: 'the reasoning effort',
  host: 'the host of the model',
  payer: 'who paid for the model',
  transport: 'the transport to the model',
}

const aspects: readonly Recorded[] = ['payer', 'transport', 'host', 'effort']

export function notes(pair: Pair): string[] {
  const renamed = pair.by === 'kind' && pair.baseline.join(' ') !== pair.agent
  const lacks = (side: 'baseline' | 'run', name: Recorded) => pair.missing[side].includes(name)
  return [
    ...(renamed
      ? [
          'set against ' +
            pair.baseline.join(' and ') +
            ' of the baseline: the same harness and model under another name',
        ]
      : []),
    ...(pair.differs.length
      ? [
          'UNLIKE: ' +
            [...pair.differs, ...pair.reported].join(', ') +
            ': the sides are not the same agent, so the verdict below is not one about the harness',
        ]
      : pair.reported.length
        ? [
            'DIFFERS: ' +
              pair.reported.join(', ') +
              ': the sessions of the harness report this, so the comparison is made, and it may be what moved',
          ]
        : []),
    ...(
      [
        [
          'neither side records ',
          (name: Recorded) => lacks('baseline', name) && lacks('run', name),
        ],
        [
          'the baseline does not record ',
          (name: Recorded) => lacks('baseline', name) && !lacks('run', name),
        ],
        [
          'the run does not record ',
          (name: Recorded) => lacks('run', name) && !lacks('baseline', name),
        ],
      ] as const
    ).flatMap(([said, chosen]) => {
      const names = aspects.filter(chosen)
      return names.length
        ? [
            'warning: ' +
              said +
              list(names.map((name) => recorded[name])) +
              ', so a difference there would not show',
          ]
        : []
    }),
  ]
}

export function regressed(changes: readonly Change[], level: 'lost' | 'regression'): boolean {
  return changes.some(
    (change) =>
      change.overall.verdict === 'regression' ||
      (level === 'lost' && change.tasks.some((task) => task.moved === 'lost')),
  )
}

export function against(baseline: Side, run: Side): string {
  const left = side(baseline)
  const right = side(run)
  const tokens = (summary: Result.AgentSummary | undefined) =>
    summary ? number(summary.inputTokens) + ' (' + number(summary.cachedTokens) + ')' : 'not run'
  const percent = (value: number) => (value * 100).toFixed(1) + '%'
  const some = (value: number) => value + (value === 1 ? ' task' : ' tasks')
  const rate = (summary: Result.AgentSummary | undefined, k: string) => {
    const value = summary?.passAtK[k]
    if (summary === undefined) return 'not run'
    if (value === undefined) return 'not rated'
    const rated = summary.rated[k]
    return (
      percent(value) + (rated === undefined || rated === summary.tasks ? '' : ' of ' + some(rated))
    )
  }
  return (
    changes(left, right)
      .map((change) => {
        const before = change.baseline
        const after = change.run
        const row = (name: 'attempts' | 'errored' | 'failed' | 'passed' | 'tasks') => [
          name[0]!.toUpperCase() + name.slice(1),
          before ? String(before[name]) : 'not run',
          String(after[name]),
        ]
        const ks = [
          ...new Set([...Object.keys(before?.passAtK ?? {}), ...Object.keys(after.passAtK)]),
        ].sort((one, other) => Number(one) - Number(other))
        const listed = (...moved: Moved[]) =>
          change.tasks
            .filter((task) => moved.includes(task.moved))
            .map(
              (task) =>
                task.name +
                ' (' +
                (task.baseline ? count(task.baseline) : 'not run') +
                ' to ' +
                (task.run ? count(task.run) : 'not run') +
                (task.chance === undefined ? '' : ', ' + chance(task.chance)) +
                ')',
            )
            .join(', ') || 'none'
        const names = (moved: Moved) =>
          change.tasks.filter((task) => task.moved === moved).map((task) => task.name)
        const scored = change.tasks.filter((task) => task.baseline?.scored && task.run?.scored)
        const overall = change.overall
        const route = (summary: Result.AgentSummary | undefined) =>
          summary === undefined ? 'not run' : change.routed ? Route.text(summary.routes) : 'none'
        const each = (value: number | null | undefined, unit: (value: number) => string) =>
          value === undefined ? 'not run' : value === null ? 'not known' : unit(value)
        return [
          change.agent + ': run ' + named(right) + ' against the baseline ' + named(left),
          ...notes(change.pair),
          '',
          cells([
            ['', 'Baseline', 'Run'],
            ['nanocode', pins(left), pins(right)],
            ['Model route', route(before), route(after)],
            row('tasks'),
            row('attempts'),
            row('passed'),
            row('failed'),
            row('errored'),
            ...ks.map((k) => ['pass@' + k, rate(before, k), rate(after, k)]),
            ...Object.keys(change.common.rated)
              .filter(
                (k) =>
                  before !== undefined &&
                  (before.rated[k] !== change.common.rated[k] ||
                    after.rated[k] !== change.common.rated[k]),
              )
              .map((k) => [
                'pass@' + k + ' on the ' + some(change.common.rated[k]!) + ' both sides rate',
                percent(change.common.baseline[k]!),
                percent(change.common.run[k]!),
              ]),
            ['Input tokens (cached)', tokens(before), tokens(after)],
            [
              'Output tokens (reasoning)',
              before
                ? number(before.outputTokens) + ' (' + reasoning(before.reasoningTokens) + ')'
                : 'not run',
              number(after.outputTokens) + ' (' + reasoning(after.reasoningTokens) + ')',
            ],
            [
              'Model calls of a scored attempt, median',
              each(change.attempts.baseline?.modelCalls, String),
              each(change.attempts.run.modelCalls, String),
            ],
            [
              'Agent time of a scored attempt, median',
              each(change.attempts.baseline?.agentSec, duration),
              each(change.attempts.run.agentSec, duration),
            ],
            ['Cost', before ? cost(before.costUsd) : 'not run', cost(after.costUsd)],
            ...(before?.judge.attempts || after.judge.attempts
              ? [
                  [
                    'Judge cost',
                    before ? cost(before.judge.costUsd) : 'not run',
                    cost(after.judge.costUsd),
                  ],
                ]
              : []),
          ]),
          '',
          ...(before
            ? [
                'lost: ' + listed('lost'),
                'gained: ' + listed('gained'),
                'moved, within noise: ' + listed('down', 'up'),
                ...(names('unscored').length
                  ? ['no verdict on a side, so not compared: ' + listed('unscored')]
                  : []),
                'same on both sides: ' +
                  some(overall.same) +
                  '; solved on both sides: ' +
                  scored.filter((task) => task.baseline!.passed && task.run!.passed).length +
                  ', on neither: ' +
                  scored.filter((task) => !task.baseline!.passed && !task.run!.passed).length,
                ...(names('changed').length
                  ? [
                      'left out, the task is another in the eval version of the baseline: ' +
                        names('changed').join(', '),
                    ]
                  : []),
                ...(names('only-run').length
                  ? ['not in the baseline: ' + names('only-run').join(', ')]
                  : []),
                ...(names('only-baseline').length
                  ? ['only in the baseline: ' + names('only-baseline').join(', ')]
                  : []),
                'verdict: ' +
                  (overall.verdict === 'none' ? 'no change beyond noise' : overall.verdict) +
                  ': of the ' +
                  some(overall.tasks) +
                  ' scored on both sides ' +
                  overall.down +
                  ' moved down and ' +
                  overall.up +
                  ' up (' +
                  chance(overall.worse) +
                  ' for worse, ' +
                  chance(overall.better) +
                  ' for better)',
                'rule: lost, gained, regression and improvement are called when pass counts this far apart have a chance of ' +
                  Stats.alpha +
                  ' or less under no change (exact one-sided test, the verdict over all tasks together), so each is wrong for an unchanged agent at most 1 time in 20',
                ...(overall.tasks && overall.floor > Stats.alpha
                  ? [
                      'with these attempts no single task can be called, its chance cannot fall under ' +
                        overall.floor.toFixed(3) +
                        ': one task that flips is not evidence',
                    ]
                  : []),
              ]
            : [
                'the baseline has no agent ' +
                  change.agent +
                  (change.pair.reason ? ': ' + change.pair.reason : ''),
              ]),
        ].join('\n')
      })
      .join('\n\n') + '\n'
  )
}
