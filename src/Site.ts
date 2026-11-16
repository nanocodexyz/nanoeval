import type * as Compare from './Compare.ts'
import type * as Config from './Config.ts'
import * as Price from './Price.ts'
import * as Scorecard from './Scorecard.ts'

export class InvalidError extends Error {
  override name = 'Site.InvalidError'
}

export type Exclude =
  | { file: string; reason: string }
  | { reason: string; tasks: readonly string[] }

export type Input = {
  arms?: readonly string[]
  from: 'file' | 'worker'
  name: string
}

export type Manifest = {
  date?: string
  note?: string
  prices: Price.List
  sections: readonly Section[]
  title: string
}

export type Section = {
  draws: number
  exclude?: Exclude
  id: string
  inputs: readonly Input[]
  labels: Readonly<Record<string, string>>
  note?: string
  reference: string
  seed: number
  title: string
}

export type Site = {
  command: string
  commit: string | undefined
  inputs: readonly { digest: string; name: string }[]
  manifest: Manifest
  sections: readonly { card: Scorecard.Card; section: Section }[]
}

export const reserved = ['index', 'manifest']

function fail(message: string): never {
  throw new InvalidError(message)
}

function record(value: unknown, input: { keys: readonly string[]; where: string }) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(input.where + ' is an object with ' + input.keys.join(', '))
  const found = value as Record<string, unknown>
  const unknown = Object.keys(found).find((key) => !input.keys.includes(key))
  if (unknown !== undefined)
    fail(input.where + ' has the key ' + unknown + ', and takes ' + input.keys.join(', '))
  return found
}

function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(where + ' is a string that is not empty')
  return value
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.length)
    fail(where + ' is a list of strings that is not empty')
  return value.map((item) => string(item, 'each of ' + where))
}

function whole(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(where + ' is a whole number')
  return value
}

function sources(value: unknown, input: { key: 'file' | 'run'; where: string }): Input[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(input.where + ' is a list')
  return value.map((item): Input => {
    const from = input.key === 'file' ? 'file' : 'worker'
    if (typeof item === 'string') return { from, name: string(item, 'each of ' + input.where) }
    const found = record(item, { keys: ['arms', input.key], where: 'each of ' + input.where })
    return {
      ...(found['arms'] === undefined
        ? {}
        : { arms: strings(found['arms'], 'arms of ' + input.where) }),
      from,
      name: string(found[input.key], input.key + ' of ' + input.where),
    }
  })
}

function exclusion(value: unknown, where: string): Exclude {
  const found = record(value, { keys: ['file', 'reason', 'tasks'], where })
  const reason = string(found['reason'], 'reason of ' + where)
  if ((found['file'] === undefined) === (found['tasks'] === undefined))
    fail(where + ' names its tasks under tasks or in a file, one of the two')
  return found['file'] === undefined
    ? { reason, tasks: strings(found['tasks'], 'tasks of ' + where) }
    : { file: string(found['file'], 'file of ' + where), reason }
}

export function parse(text: string): Manifest {
  const top = record(
    (() => {
      try {
        return JSON.parse(text) as unknown
      } catch (error) {
        return fail('the manifest is not JSON: ' + (error as Error).message)
      }
    })(),
    {
      keys: ['date', 'draws', 'note', 'prices', 'sections', 'seed', 'title'],
      where: 'the manifest',
    },
  )
  const given = top['sections']
  if (!Array.isArray(given) || !given.length)
    fail('sections of the manifest is a list that is not empty')
  const sections = given.map((item, at): Section => {
    const where = 'section ' + (at + 1)
    const found = record(item, {
      keys: [
        'draws',
        'exclude',
        'id',
        'labels',
        'note',
        'reference',
        'results',
        'runs',
        'seed',
        'title',
      ],
      where,
    })
    const id = string(found['id'], 'id of ' + where)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || reserved.includes(id))
      fail(
        'id of ' +
          where +
          ' names its page with a to z, 0 to 9 and -, and is not ' +
          reserved.join(' or ') +
          ': ' +
          id,
      )
    const inputs = [
      ...sources(found['results'], { key: 'file', where: 'results of ' + where }),
      ...sources(found['runs'], { key: 'run', where: 'runs of ' + where }),
    ]
    if (!inputs.length) fail(where + ' names a result file under results or a run under runs')
    const labels = found['labels'] ?? {}
    if (typeof labels !== 'object' || labels === null || Array.isArray(labels))
      fail('labels of ' + where + ' is an object of an arm to its label')
    return {
      draws:
        whole(found['draws'], 'draws of ' + where) ??
        whole(top['draws'], 'draws of the manifest') ??
        Scorecard.defaults.draws,
      ...(found['exclude'] === undefined
        ? {}
        : { exclude: exclusion(found['exclude'], 'exclude of ' + where) }),
      id,
      inputs,
      labels: Object.fromEntries(
        Object.entries(labels).map(([arm, label]) => [
          arm,
          string(label, 'label of ' + arm + ' in ' + where),
        ]),
      ),
      ...(found['note'] === undefined ? {} : { note: string(found['note'], 'note of ' + where) }),
      reference: string(found['reference'], 'reference of ' + where),
      seed:
        whole(found['seed'], 'seed of ' + where) ??
        whole(top['seed'], 'seed of the manifest') ??
        Scorecard.defaults.seed,
      title: string(found['title'], 'title of ' + where),
    }
  })
  const twice = sections.find((section, at) =>
    sections.some((other, index) => index < at && other.id === section.id),
  )
  if (twice) fail('two sections have the id ' + twice.id)
  return {
    ...(top['date'] === undefined ? {} : { date: string(top['date'], 'date of the manifest') }),
    ...(top['note'] === undefined ? {} : { note: string(top['note'], 'note of the manifest') }),
    prices:
      top['prices'] === undefined
        ? {}
        : Price.list(strings(top['prices'], 'prices of the manifest')),
    sections,
    title: string(top['title'], 'title of the manifest'),
  }
}

export function run(given: Compare.Run, input: Pick<Input, 'arms' | 'name'>): Scorecard.Run {
  if (
    typeof given?.id !== 'string' ||
    !Array.isArray(given.attempts) ||
    typeof given.eval?.version !== 'string'
  )
    fail(
      input.name +
        ' does not hold the results of a run, what a Worker answers for /v1/runs/RUN/results',
    )
  const held = new Map(
    given.attempts.map((attempt) => [attempt.agent.id, attempt.agent as Config.Agent]),
  )
  const missing = input.arms?.find((arm) => !held.has(arm))
  if (missing !== undefined)
    fail(
      input.name +
        ' holds no row of the arm ' +
        missing +
        ': its arms are ' +
        [...held.keys()].join(', '),
    )
  const agents = input.arms ? input.arms.map((arm) => held.get(arm)!) : [...held.values()]
  const results = given.attempts.filter((attempt) =>
    agents.some((agent) => agent.id === attempt.agent.id),
  )
  if (!results.length) fail(input.name + ' holds no row')
  return {
    agents,
    attempts: results.reduce((most, attempt) => Math.max(most, attempt.index), 0),
    eval: given.eval,
    id: given.id,
    name: given.name,
    nanocode: given.nanocode,
    results,
    state: given.state,
  }
}

export function card(section: Section, input: card.Input): Scorecard.Card {
  const built = Scorecard.build(input.runs, {
    command: input.command,
    commit: input.commit,
    draws: section.draws,
    exclude: input.exclude,
    prices: input.prices,
    reference: section.reference,
    seed: section.seed,
  })
  const unknown = Object.keys(section.labels).find(
    (label) => !built.arms.some((arm) => arm.label === label),
  )
  if (unknown !== undefined)
    fail(
      'section ' +
        section.id +
        ' labels the arm ' +
        unknown +
        ', and its arms are ' +
        built.arms.map((arm) => arm.label).join(', '),
    )
  return built
}

export declare namespace card {
  type Input = {
    command: string
    commit: string | undefined
    exclude: Scorecard.Exclusion | undefined
    prices: Price.List
    runs: readonly Scorecard.Run[]
  }
}

export function digests(inputs: Site['inputs']): string {
  return inputs.map((input) => input.digest + '  ' + input.name + '\n').join('')
}

const style =
  'body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;background:#fff;margin:0}' +
  'main{max-width:1180px;margin:0 auto;padding:32px 24px 64px}h1{font-size:26px;margin:0 0 4px}' +
  'h2{font-size:18px;margin:40px 0 10px;padding-top:16px;border-top:1px solid #e5e5e5}' +
  'p,li{max-width:900px}.sub{color:#666;margin:0}.wrap{overflow-x:auto}' +
  'table{border-collapse:collapse;width:100%;margin:8px 0 12px;font-size:12.5px}' +
  'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}' +
  'th{font-weight:600;color:#555;border-bottom:1px solid #ccc;background:#fafafa}' +
  'td{font-variant-numeric:tabular-nums}.ci{color:#666}.basis{color:#555;font-size:12.5px}' +
  'pre{background:#f6f6f6;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;white-space:pre-wrap;word-break:break-all}' +
  'code{background:#f6f6f6;padding:1px 4px;border-radius:3px;font-size:12px}a{color:#0b57d0}footer{color:#666;font-size:12px}'

function spec(arm: Scorecard.Arm): string {
  return [arm.spec.provider, arm.spec.model, arm.spec.thinking ?? 'effort not set'].join(' : ')
}

function part(found: Site['sections'][number], at: number): string {
  const { card: built, section } = found
  const escape = Scorecard.escape
  const percentLevel = Math.round(100 * built.level)
  const name = (arm: Scorecard.Arm) => {
    const label = section.labels[arm.label]
    return label === undefined
      ? escape(arm.label)
      : escape(label) + ' <span class="ci">' + escape(arm.label) + '</span>'
  }
  const reference = built.arms.find((arm) => arm.label === built.reference)
  const against = escape(section.labels[built.reference] ?? built.reference)
  const rows = Scorecard.table(
    [
      'Arm',
      'Spec',
      'Matched rows / tasks',
      'Passed / failed / errored',
      'Pass rate, % [' + percentLevel + ' %]',
      'USD an attempt',
      'USD a pass [' + percentLevel + ' %]',
      'Difference to ' + against + ', points [' + percentLevel + ' %]',
      'USD a pass, times ' + against + ' [' + percentLevel + ' %]',
      'Cost basis',
    ],
    built.arms.map((arm) => [
      name(arm),
      escape(spec(arm)),
      arm.matched + ' / ' + built.matched.tasks,
      arm.passed + ' / ' + arm.failed + ' / ' + arm.errored,
      Scorecard.shown(arm.passRate, Scorecard.percent),
      arm.usdPerAttempt === null ? 'not recorded' : Scorecard.usd(arm.usdPerAttempt),
      Scorecard.shown(arm.usdPerPass, Scorecard.usd),
      arm.against ? Scorecard.shown(arm.against.passRateDifference, Scorecard.points) : 'reference',
      arm.against
        ? arm === reference
          ? 'reference'
          : Scorecard.shown(arm.against.usdPerPassRatio, Scorecard.times)
        : 'reference',
      Scorecard.basis(arm),
    ]),
  )
  const runs = built.runs
    .map(
      (held) =>
        escape(held.name) +
        ' <code>' +
        escape(held.id) +
        '</code> (' +
        held.state +
        ', ' +
        held.rows +
        ' rows, harness ' +
        escape(held.nanocode?.harness ?? 'not recorded') +
        ', hands ' +
        escape(held.nanocode?.hands.join(', ') || 'not recorded') +
        ')',
    )
    .join('; ')
  const apart = built.arms
    .map(
      (arm) =>
        escape(arm.label) +
        ' ' +
        arm.unmatched +
        ' unmatched, ' +
        arm.cancelled +
        ' cancelled, ' +
        arm.unscheduled +
        ' unscheduled, ' +
        arm.excluded +
        ' of excluded tasks',
    )
    .join('; ')
  const excluded = built.excluded
    ? 'Excluded: ' +
      built.excluded.tasks.length +
      ' tasks named by ' +
      escape(built.excluded.file) +
      ' (sha256 <code>' +
      built.excluded.digest +
      '</code>), ' +
      built.excluded.tasks.reduce((sum, task) => sum + task.rows, 0) +
      ' rows: ' +
      escape(built.excluded.tasks.map((task) => task.name).join(', ')) +
      '. Reason: ' +
      escape(built.excluded.reason ?? 'not stated') +
      '.'
    : 'No task is excluded.'
  return (
    '<section id="' +
    section.id +
    '"><h2>' +
    (at + 1) +
    '. ' +
    escape(section.title) +
    '</h2>\n' +
    (section.note === undefined ? '' : '<p>' + escape(section.note) + '</p>\n') +
    '<p>Eval ' +
    escape(built.eval.name) +
    ' <code>' +
    escape(built.eval.version) +
    '</code>. Run ' +
    runs +
    '. Matched set: ' +
    built.matched.attempts +
    ' task#attempts of ' +
    built.matched.tasks +
    ' tasks, each with a verdict in every arm. Intervals: ' +
    built.draws +
    ' draws of a task-clustered bootstrap, seed ' +
    built.seed +
    '.</p>\n<div class="wrap">' +
    rows +
    '</div>\n<p class="basis">' +
    escape(Scorecard.costs(built)) +
    '</p>\n<p class="basis">Rows outside the matched set: ' +
    apart +
    '.</p>\n<p>' +
    excluded +
    '</p>\n<p>Whole card: <a href="' +
    section.id +
    '.html">' +
    section.id +
    '.html</a>, <a href="' +
    section.id +
    '.json">' +
    section.id +
    '.json</a>.</p>\n</section>\n'
  )
}

export function html(site: Site): string {
  const escape = Scorecard.escape
  const manifest = site.manifest
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' +
    escape(manifest.title) +
    '</title><style>' +
    style +
    '</style></head><body><main>\n<h1>' +
    escape(manifest.title) +
    '</h1>\n' +
    (manifest.date === undefined ? '' : '<p class="sub">' + escape(manifest.date) + '</p>\n') +
    (manifest.note === undefined ? '' : '<p>' + escape(manifest.note) + '</p>\n') +
    '<p>Every figure is computed from the input files listed under Inputs, by the command under Reproduce. A cost that no file records is shown as not recorded, never as 0.</p>\n' +
    site.sections.map(part).join('') +
    '<section id="inputs"><h2>Inputs</h2>\n<p>The sha256 of every input file, as in <a href="inputs.sha256">inputs.sha256</a>. The manifest is <a href="manifest.json">manifest.json</a>.</p>\n<div class="wrap">' +
    Scorecard.table(
      ['File', 'sha256'],
      site.inputs.map((input) => [escape(input.name), '<code>' + input.digest + '</code>']),
    ) +
    '</div>\n</section>\n<section id="reproduce"><h2>Reproduce</h2>\n<footer><p>Generated from nanoeval commit <code>' +
    escape(site.commit ?? 'not recorded: the command did not run from a git checkout') +
    '</code> with the command</p>\n<pre>' +
    escape(site.command) +
    '</pre>\n<p>The same input files, manifest and commit write the same bytes. The command line leaves out the token.</p></footer>\n</section>\n</main></body></html>\n'
  )
}
