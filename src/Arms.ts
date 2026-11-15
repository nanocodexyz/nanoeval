import * as Compare from './Compare.ts'
import * as Price from './Price.ts'
import * as Result from './Result.ts'
import * as Retry from './Retry.ts'
import * as Unsound from './Unsound.ts'

export type Class = 'agent' | 'cancelled' | 'infrastructure' | 'limit' | 'task'

export const classes: Record<Result.FailureKind, Class> = {
  agent: 'agent',
  agent_out_of_memory: 'agent',
  agent_timeout: 'agent',
  budget: 'agent',
  cancelled: 'cancelled',
  environment: 'infrastructure',
  internal: 'infrastructure',
  unscheduled: 'infrastructure',
  verifier: 'infrastructure',
  verifier_limit: 'limit',
  verifier_timeout: 'infrastructure',
}

export const unrecorded = 'unrecorded'

export const unserved = 'model not served'

export type Arm = {
  agent: string
  agentLimits: string[]
  cachedTokens: number
  costUsd: number | null
  errored: number
  errors: Record<Class, Record<string, number>>
  failed: number
  harness: string
  inputTokens: number
  listed: number
  metered: number
  model: string
  name: string
  outputTokens: number
  passMacro: number | null
  passMicro: number | null
  passed: number
  priced: number
  rows: number
  run: string
  scored: number
  tasks: number
  usdPerPass: number | null
  verifierLimits: string[]
  waitSec: number
  waits: number
  wallSec: number
}

function cost(
  attempt: Result.Attempt,
  prices: Price.List,
): { listed: boolean; usd: number } | undefined {
  const usage = attempt.usage
  if (!usage) return undefined
  if (usage.costUsd !== undefined) return { listed: usage.costBy === 'list', usd: usage.costUsd }
  const price = prices[attempt.agent.model]
  return price ? { listed: true, usd: Price.usd(price, usage) } : undefined
}

export function arms(
  given: readonly Compare.Run[],
  input: { prices?: Price.List; unsound?: Unsound.List } = {},
): Arm[] {
  const { prices = {}, unsound = {} } = input
  const found: Arm[] = []
  for (const run of Compare.standing(given)) {
    const own = new Map<string, Result.Attempt[]>()
    for (const attempt of run.attempts)
      own.set(attempt.agent.id, [...(own.get(attempt.agent.id) ?? []), attempt])
    for (const [agent, attempts] of own) {
      const arm: Arm = {
        agent,
        agentLimits: Result.limits(attempts),
        cachedTokens: 0,
        costUsd: null,
        errored: 0,
        errors: { agent: {}, cancelled: {}, infrastructure: {}, limit: {}, task: {} },
        failed: 0,
        harness: Compare.harness(attempts[0]!.agent, run.nanocode),
        inputTokens: 0,
        listed: 0,
        metered: 0,
        model:
          attempts[0]!.agent.provider === 'oracle'
            ? Compare.model(attempts[0]!.agent)
            : attempts[0]!.agent.model +
              (attempts[0]!.agent.thinking ? ':' + attempts[0]!.agent.thinking : ''),
        name: run.name,
        outputTokens: 0,
        passMacro: null,
        passMicro: null,
        passed: 0,
        priced: 0,
        rows: attempts.length,
        run: run.id,
        scored: 0,
        tasks: 0,
        usdPerPass: null,
        verifierLimits: Result.verifierLimits(attempts),
        waitSec: 0,
        waits: 0,
        wallSec:
          (Math.max(...attempts.map((attempt) => attempt.finishedAt)) -
            Math.min(...attempts.map((attempt) => attempt.startedAt))) /
          1000,
      }
      const tasks = new Map<string, { passed: number; scored: number }>()
      for (const attempt of attempts) {
        arm[attempt.outcome]++
        if (attempt.outcome === 'errored') {
          const kind = attempt.failure?.kind
          const gone = Unsound.gone(attempt, unsound)
          const refused = attempt.failure !== undefined && Retry.modelRefused(attempt.failure)
          const kinds =
            arm.errors[gone ? 'task' : kind && !refused ? classes[kind] : 'infrastructure']
          const key = gone
            ? Unsound.short(attempt.task.name)
            : refused
              ? unserved
              : (kind ?? unrecorded)
          kinds[key] = (kinds[key] ?? 0) + 1
        } else {
          const task = tasks.get(attempt.task.name) ?? { passed: 0, scored: 0 }
          tasks.set(attempt.task.name, task)
          task.scored++
          if (attempt.outcome === 'passed') task.passed++
        }
        if (attempt.modelWaits) {
          arm.waits += attempt.modelWaits.count
          arm.waitSec += attempt.modelWaits.sec
        }
        if (attempt.usage) {
          arm.metered++
          arm.cachedTokens += attempt.usage.cachedTokens
          arm.inputTokens += attempt.usage.inputTokens
          arm.outputTokens += attempt.usage.outputTokens
        }
        const priced = cost(attempt, prices)
        if (priced) {
          arm.priced++
          if (priced.listed) arm.listed++
          arm.costUsd = (arm.costUsd ?? 0) + priced.usd
        }
      }
      arm.scored = arm.passed + arm.failed
      arm.tasks = tasks.size
      if (arm.scored) {
        arm.passMicro = arm.passed / arm.scored
        arm.passMacro =
          [...tasks.values()].reduce((sum, task) => sum + task.passed / task.scored, 0) / tasks.size
      }
      if (arm.costUsd !== null && arm.passed && arm.priced === arm.metered)
        arm.usdPerPass = arm.costUsd / arm.passed
      found.push(arm)
    }
  }
  return found
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function percent(value: number | null): string {
  return value === null ? 'not known' : (100 * value).toFixed(1) + '%'
}

function usd(value: number): string {
  return '$' + value.toFixed(4)
}

export function capital(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1)
}

function count(kinds: Record<string, number>): number {
  return Object.values(kinds).reduce((sum, n) => sum + n, 0)
}

function kinds(found: Record<string, number>): string {
  const named = Object.entries(found).sort(([left], [right]) => left.localeCompare(right))
  return named.length ? ' (' + named.map(([kind, n]) => kind + ' ' + n).join(', ') + ')' : ''
}

function share(arm: Arm, found: Record<string, number>): string {
  const n = count(found)
  return n + (n ? ' or ' + percent(n / arm.rows) + ' of its rows' : '') + kinds(found)
}

export function infrastructure(arm: Arm): string {
  return share(arm, arm.errors.infrastructure)
}

export function task(arm: Arm): string {
  return share(arm, arm.errors.task)
}

export function apart(found: readonly Arm[]): boolean {
  return found.some((arm) => count(arm.errors.task))
}

export function agent(arm: Arm): string {
  return count(arm.errors.agent) + kinds(arm.errors.agent)
}

export function total(arm: Arm): string {
  if (arm.costUsd === null) return arm.metered ? 'not known' : 'no model usage'
  const bare = arm.metered - arm.priced
  return (
    usd(arm.costUsd) +
    (arm.listed === arm.priced && arm.listed
      ? ' at list prices'
      : arm.listed
        ? ', ' + arm.listed + ' of ' + arm.priced + ' attempts at list prices'
        : '') +
    (bare
      ? ', without ' +
        bare +
        (bare === 1 ? ' attempt that has' : ' attempts that have') +
        ' no cost'
      : '')
  )
}

export function perPass(arm: Arm): string {
  if (arm.costUsd === null) return arm.metered ? 'not known' : 'no model usage'
  if (arm.usdPerPass !== null) return usd(arm.usdPerPass)
  return arm.passed ? 'not known' : 'no pass'
}

export function limited(arm: Arm): string {
  return arm.agentLimits.join(' and ')
}

export function bounded(found: readonly Arm[]): boolean {
  return found.some((arm) => limited(arm) !== Result.ownLimit)
}

export function verifierLimit(arm: Arm): string {
  return arm.verifierLimits.join(' and ')
}

export function verifierBounded(found: readonly Arm[]): boolean {
  return found.some((arm) => verifierLimit(arm) !== Result.ownLimit || count(arm.errors.limit) > 0)
}

export function verifierLimited(arm: Arm): string {
  const n = count(arm.errors.limit)
  return n + (n ? ' or ' + percent(n / arm.rows) + ' of its rows' : '')
}

function waited(arm: Arm): string {
  return arm.waits + ' (' + Math.round(arm.waitSec) + ' s)'
}

export function line(arm: Arm): string {
  const cancelled = count(arm.errors.cancelled)
  return (
    arm.name +
    ' ' +
    arm.agent +
    ' (' +
    arm.harness +
    ', ' +
    arm.model +
    '): passed ' +
    arm.passed +
    '/' +
    arm.rows +
    ' rows, pass micro ' +
    percent(arm.passMicro) +
    ' of ' +
    arm.scored +
    ' scored, pass macro ' +
    percent(arm.passMacro) +
    ' over ' +
    arm.tasks +
    (arm.tasks === 1 ? ' task, ' : ' tasks, ') +
    (arm.costUsd === null
      ? arm.metered
        ? 'cost not known'
        : 'no model usage'
      : (arm.usdPerPass !== null
          ? usd(arm.usdPerPass) + ' a pass'
          : arm.passed
            ? 'USD a pass not known'
            : 'no pass') +
        ' (' +
        total(arm) +
        ')') +
    (arm.metered
      ? ', input tokens ' +
        number(arm.inputTokens) +
        ' (' +
        number(arm.cachedTokens) +
        ' cached), output tokens ' +
        number(arm.outputTokens)
      : '') +
    ', wall time ' +
    Compare.duration(arm.wallSec) +
    (bounded([arm]) ? ', agent time limit ' + limited(arm) : '') +
    (verifierBounded([arm]) ? ', verifier time limit ' + verifierLimit(arm) : '') +
    (arm.waits ? ', model waits ' + waited(arm) : '') +
    ', errors: infrastructure ' +
    infrastructure(arm) +
    (apart([arm]) ? ', task dependency gone ' + task(arm) : '') +
    ', agent or model ' +
    agent(arm) +
    (verifierBounded([arm]) ? ', ' + Result.verifierLimited + ' ' + verifierLimited(arm) : '') +
    (cancelled ? ', cancelled ' + cancelled : '')
  )
}

export function table(found: readonly Arm[]): string {
  return (
    Compare.cells([
      [
        'Run',
        'Arm',
        'Harness',
        'Model',
        'Passed',
        'Pass micro',
        'Pass macro',
        'USD a pass',
        'Cost',
        'Input tokens (cached)',
        'Output tokens',
        'Wall time',
        ...(bounded(found) ? ['Agent time limit'] : []),
        ...(verifierBounded(found) ? ['Verifier time limit'] : []),
        'Model waits',
        'Infrastructure errors',
        ...(apart(found) ? ['Task dependency gone'] : []),
        'Agent or model errors',
        ...(verifierBounded(found) ? [capital(Result.verifierLimited)] : []),
        'Cancelled',
      ],
      ...found.map((arm) => [
        arm.name,
        arm.agent,
        arm.harness,
        arm.model,
        arm.passed + '/' + arm.rows,
        percent(arm.passMicro) + ' of ' + arm.scored,
        percent(arm.passMacro) + ' over ' + arm.tasks,
        perPass(arm),
        total(arm),
        arm.metered
          ? number(arm.inputTokens) + ' (' + number(arm.cachedTokens) + ')'
          : 'not recorded',
        arm.metered ? number(arm.outputTokens) : 'not recorded',
        Compare.duration(arm.wallSec),
        ...(bounded(found) ? [limited(arm)] : []),
        ...(verifierBounded(found) ? [verifierLimit(arm)] : []),
        arm.waits ? waited(arm) : '0',
        infrastructure(arm),
        ...(apart(found) ? [task(arm)] : []),
        agent(arm),
        ...(verifierBounded(found) ? [verifierLimited(arm)] : []),
        String(count(arm.errors.cancelled)),
      ]),
    ]) + '\n'
  )
}
