import * as Arms from './Arms.ts'
import * as Baseline from './Baseline.ts'
import * as Compare from './Compare.ts'
import type * as Price from './Price.ts'
import * as Result from './Result.ts'

export const defaults = { attempts: 3, eval: 'terminal-bench-2.1', subset: 'hourly' }

export class RefusedError extends Error {
  override name = 'Loop.RefusedError'
}

export type Given = {
  agent?: string[] | undefined
  attempts?: string | undefined
  backend?: string | undefined
  baseline?: string[] | undefined
  'build-only'?: boolean | undefined
  eval?: string | undefined
  'fail-on'?: string[] | undefined
  limit?: string | undefined
  only?: string[] | undefined
  'only-file'?: string[] | undefined
  oracle?: boolean | undefined
  rerun?: string | undefined
  serve?: boolean | undefined
  slots?: string | undefined
  subset?: string[] | undefined
  task?: string[] | undefined
}

export type Machine = { backend: 'dir' | 'krun' | 'ns'; threads: number }

export type Settings = {
  attempts?: string
  backend?: string
  baseline?: string[]
  eval?: string
  'fail-on'?: string[]
  slots?: string
  subset?: string[]
}

export function settings(given: Given, machine: Machine): Settings {
  const refused = (['build-only', 'rerun', 'serve'] as const).filter((name) => given[name])
  if (refused.length)
    throw new RefusedError(
      'nanoeval loop makes a new run and waits for it: leave out --' + refused.join(' and --'),
    )
  if (!given.oracle && !given.agent?.length)
    throw new RefusedError(
      'nanoeval loop takes its arms from --agent ID=HARNESS:MODEL, one for each, or --oracle',
    )
  if (!given.backend && machine.backend === 'dir')
    throw new RefusedError(
      'this machine has no /dev/kvm and this command is not root, so its slots would be directories of this machine with no isolation: name --backend dir to run the rows so',
    )
  const chosen =
    given.task?.length ||
    given.only?.length ||
    given['only-file']?.length ||
    given.subset?.length ||
    given.limit
  return {
    ...(given.attempts ? {} : { attempts: String(defaults.attempts) }),
    ...(given.backend ? {} : { backend: machine.backend }),
    ...(given.baseline?.length ? {} : { baseline: [Baseline.previous] }),
    ...(given.eval || given.task?.length ? {} : { eval: defaults.eval }),
    ...(given['fail-on']?.length ? {} : { 'fail-on': ['regression'] }),
    ...(given.slots ? {} : { slots: String(machine.threads) }),
    ...(chosen ? {} : { subset: [defaults.subset] }),
  }
}

export function said(given: Given, taken: Settings): string {
  const all = { ...given, ...taken }
  const arms = (all.agent ?? []).map((text) => text.split('=')[0])
  return (
    'loop: ' +
    (all.task?.length
      ? all.task.length + (all.task.length === 1 ? ' task directory' : ' task directories')
      : all.eval + (all.subset?.length ? ', the subset ' + all.subset.join(' and ') : '')) +
    ', ' +
    all.attempts +
    (all.attempts === '1' ? ' attempt a task, ' : ' attempts a task, ') +
    (all.oracle
      ? 'the solutions'
      : arms.length + (arms.length === 1 ? ' arm (' : ' arms (') + arms.join(', ') + ')') +
    ', ' +
    all.slots +
    ' ' +
    all.backend +
    (all.slots === '1' ? ' slot' : ' slots') +
    (taken.slots ? ', one for each thread of this machine' : '') +
    ', against ' +
    (taken.baseline
      ? 'the run before this one where the lab has one'
      : (all.baseline ?? []).join(' and ')) +
    ', exit 3 on ' +
    (all['fail-on'] ?? []).join(' or ')
  )
}

export type Verdict = Compare.Change['overall']['verdict']

export type Against = {
  better: number
  down: number
  gained: string[]
  lost: string[]
  tasks: number
  up: number
  verdict: Verdict
  worse: number
}

export type Arm = Arms.Arm & {
  against: Against | null
  passAtK: Record<string, number>
  rated: Record<string, number>
}

export type Scorecard = {
  arms: Arm[]
  baseline: { names: string[]; runs: string[] } | null
  eval: { name: string; version: string }
  loop: {
    agentErrors: number
    cancelled: number
    infrastructureErrors: number
    infrastructureRate: number | null
    rows: number
    runSec: number
    slots: number
    wallSec: number
  }
  name: string
  run: string
  verdict: Verdict | null
}

function count(kinds: Record<string, number>): number {
  return Object.values(kinds).reduce((sum, n) => sum + n, 0)
}

export function named(
  name: string,
  listed: readonly { id: string; name: string | null; state: string }[],
): string | undefined {
  return listed.find((run) => run.name === name && run.state === 'finished')?.id
}

export function scorecard(
  run: Compare.Run,
  input: {
    baseline: readonly Compare.Run[]
    prices: Price.List
    slots: number
    wallSec: number
  },
): Scorecard {
  const [standing] = Compare.standing([run])
  const summaries = Result.summarize(standing!.attempts)
  const changes = input.baseline.length ? Compare.changes(input.baseline, run) : []
  const arms = Arms.arms([run], input.prices).map((arm): Arm => {
    const change = changes.find((each) => each.agent === arm.agent)
    const moved = (kind: Compare.Moved) =>
      (change?.tasks ?? []).filter((task) => task.moved === kind).map((task) => task.name)
    return {
      ...arm,
      against:
        change?.baseline === undefined
          ? null
          : {
              better: change.overall.better,
              down: change.overall.down,
              gained: moved('gained'),
              lost: moved('lost'),
              tasks: change.overall.tasks,
              up: change.overall.up,
              verdict: change.overall.verdict,
              worse: change.overall.worse,
            },
      passAtK: summaries[arm.agent]?.passAtK ?? {},
      rated: summaries[arm.agent]?.rated ?? {},
    }
  })
  const rows = arms.reduce((sum, arm) => sum + arm.rows, 0)
  const infrastructure = arms.reduce((sum, arm) => sum + count(arm.errors.infrastructure), 0)
  const verdicts = arms.flatMap((arm) => (arm.against ? [arm.against.verdict] : []))
  const side = Compare.standing(input.baseline)
  return {
    arms,
    baseline: side.length
      ? { names: side.map((each) => each.name), runs: side.map((each) => each.id) }
      : null,
    eval: run.eval,
    loop: {
      agentErrors: arms.reduce((sum, arm) => sum + count(arm.errors.agent), 0),
      cancelled: arms.reduce((sum, arm) => sum + count(arm.errors.cancelled), 0),
      infrastructureErrors: infrastructure,
      infrastructureRate: rows ? infrastructure / rows : null,
      rows,
      runSec: rows
        ? (Math.max(...standing!.attempts.map((attempt) => attempt.finishedAt)) -
            Math.min(...standing!.attempts.map((attempt) => attempt.startedAt))) /
          1000
        : 0,
      slots: input.slots,
      wallSec: input.wallSec,
    },
    name: run.name,
    run: run.id,
    verdict: !verdicts.length
      ? null
      : verdicts.includes('regression')
        ? 'regression'
        : verdicts.includes('improvement')
          ? 'improvement'
          : 'none',
  }
}

function percent(value: number | null): string {
  return value === null ? 'not known' : (100 * value).toFixed(1) + '%'
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}

const words: Record<Verdict, string> = {
  improvement: 'improvement',
  none: 'no change beyond noise',
  regression: 'regression',
}

function against(arm: Arm, baseline: Scorecard['baseline']): string {
  if (!baseline) return 'no baseline'
  if (!arm.against) return 'not in the baseline'
  return (
    words[arm.against.verdict] +
    ', ' +
    arm.against.down +
    ' down and ' +
    arm.against.up +
    ' up of ' +
    arm.against.tasks +
    (arm.against.lost.length ? ', lost ' + arm.against.lost.join(' and ') : '') +
    (arm.against.gained.length ? ', gained ' + arm.against.gained.join(' and ') : '')
  )
}

export function text(card: Scorecard): string {
  const ks = [...new Set(card.arms.flatMap((arm) => Object.keys(arm.passAtK)))]
    .map(Number)
    .filter((k) => k > 1)
    .sort((left, right) => left - right)
  const rate = (arm: Arm, k: number) => {
    const value = arm.passAtK[String(k)]
    if (value === undefined) return 'not rated'
    const rated = arm.rated[String(k)]
    return percent(value) + (rated === undefined || rated === arm.tasks ? '' : ' of ' + rated)
  }
  const { loop } = card
  const named = (verdict: Verdict) =>
    card.arms.filter((arm) => arm.against?.verdict === verdict).map((arm) => arm.agent)
  const unpaired = card.arms.filter((arm) => !arm.against).map((arm) => arm.agent)
  return (
    Compare.cells([
      [
        'Arm',
        'Harness',
        'Model',
        'Passed',
        'Pass micro',
        'Pass macro',
        ...ks.map((k) => 'pass@' + k),
        'USD a pass',
        'Cost',
        'Input tokens (cached)',
        'Output tokens',
        'Wall time',
        ...(Arms.bounded(card.arms) ? ['Agent time limit'] : []),
        'Infrastructure errors',
        'Agent or model errors',
        'Cancelled',
        'Against the baseline',
      ],
      ...card.arms.map((arm) => [
        arm.agent,
        arm.harness,
        arm.model,
        arm.passed + '/' + arm.rows,
        percent(arm.passMicro) + ' of ' + arm.scored,
        percent(arm.passMacro) + ' over ' + arm.tasks,
        ...ks.map((k) => rate(arm, k)),
        Arms.perPass(arm),
        Arms.total(arm),
        arm.metered
          ? number(arm.inputTokens) + ' (' + number(arm.cachedTokens) + ')'
          : 'not recorded',
        arm.metered ? number(arm.outputTokens) : 'not recorded',
        Compare.duration(arm.wallSec),
        ...(Arms.bounded(card.arms) ? [Arms.limited(arm)] : []),
        Arms.infrastructure(arm),
        Arms.agent(arm),
        String(count(arm.errors.cancelled)),
        against(arm, card.baseline),
      ]),
    ]) +
    '\nloop: ' +
    loop.rows +
    (loop.rows === 1 ? ' row of ' : ' rows of ') +
    card.arms.length +
    (card.arms.length === 1 ? ' arm in ' : ' arms in ') +
    Compare.duration(loop.wallSec) +
    ' from the start of the command, the run ' +
    Compare.duration(loop.runSec) +
    ' from its first start to its last end on ' +
    loop.slots +
    (loop.slots === 1 ? ' slot' : ' slots') +
    ', infrastructure errors ' +
    loop.infrastructureErrors +
    ' or ' +
    percent(loop.infrastructureRate) +
    ' of the rows, agent or model errors ' +
    loop.agentErrors +
    (loop.cancelled ? ', cancelled ' + loop.cancelled : '') +
    '\nverdict: ' +
    (card.baseline && card.verdict
      ? words[card.verdict] +
        ' against ' +
        card.baseline.names
          .map((name, at) => name + ' (' + card.baseline!.runs[at]!.slice(0, 8) + ')')
          .join(' and ') +
        (['regression', 'improvement', 'none'] as const)
          .flatMap((verdict) =>
            named(verdict).length ? ['; ' + words[verdict] + ': ' + named(verdict).join(', ')] : [],
          )
          .join('') +
        (unpaired.length ? '; not in the baseline: ' + unpaired.join(', ') : '')
      : card.baseline
        ? 'none, the baseline ' + card.baseline.names.join(' and ') + ' holds none of these arms'
        : 'none, the run has no baseline') +
    '\n'
  )
}
