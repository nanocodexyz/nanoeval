import * as Compare from './Compare.ts'
import * as Result from './Result.ts'
import { withdrawnPrefix } from './Verdict.ts'

export class InvalidError extends Error {
  override name = 'Unsound.InvalidError'
}

export type Entry = {
  checksum: string
  reason: string
  task: string
  upstream: string
}

export type List = Record<string, readonly Entry[]>

export type Verdict = {
  outcome: 'errored' | 'failed' | 'passed'
  passed: number
  standing: readonly Result.Attempt[]
  task: string
}

export type Check = {
  moved: { entry: Entry; held: string }[]
  sound: Verdict[]
  unsound: (Verdict & { entry: Entry })[]
}

export function parse(text: string, file: string): List {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new InvalidError(file + ' is not JSON: ' + (error as Error).message)
  }
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
  const filled = (candidate: unknown) => typeof candidate === 'string' && candidate.trim() !== ''
  const entry = (candidate: unknown) =>
    object(candidate) &&
    typeof candidate['checksum'] === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(candidate['checksum']) &&
    filled(candidate['reason']) &&
    filled(candidate['task']) &&
    typeof candidate['upstream'] === 'string' &&
    /^https:\/\/\S+$/.test(candidate['upstream'])
  if (
    !object(value) ||
    !Object.values(value).every((entries) => Array.isArray(entries) && entries.every(entry))
  )
    throw new InvalidError(
      file +
        ' has to hold {"DATASET": [{"task": "its id", "checksum": "sha256:...", "reason": "what fails and why", "upstream": "https://... of its report"}, ...]}',
    )
  const list = value as List
  const seen = new Set<string>()
  for (const each of entries(list)) {
    if (seen.has(each.checksum))
      throw new InvalidError(file + ' lists ' + each.checksum + ' (' + each.task + ') twice')
    seen.add(each.checksum)
  }
  return list
}

function entries(list: List): Entry[] {
  return Object.values(list).flat()
}

export function find(list: List, checksum: string): Entry | undefined {
  return entries(list).find((entry) => entry.checksum === checksum)
}

export function split(
  attempts: readonly Result.Attempt[],
  list: List,
): { sound: Result.Attempt[]; unsound: Result.Attempt[] } {
  const listed = new Set(entries(list).map((entry) => entry.checksum))
  return {
    sound: attempts.filter((attempt) => !listed.has(attempt.task.checksum)),
    unsound: attempts.filter((attempt) => listed.has(attempt.task.checksum)),
  }
}

export function gone(attempt: Result.Attempt, list: List): boolean {
  return (
    attempt.outcome === 'errored' &&
    attempt.failure?.kind === 'verifier' &&
    attempt.failure.message.startsWith(withdrawnPrefix) &&
    find(list, attempt.task.checksum) !== undefined
  )
}

export function short(name: string): string {
  return name.split('/').at(-1)!
}

function names(attempts: readonly Result.Attempt[]): string[] {
  return [...new Set(attempts.map((attempt) => short(attempt.task.name)))].sort()
}

function some(count: number, kind = 'task'): string {
  return count + ' ' + kind + (count === 1 ? '' : 's')
}

function rates(summary: Result.AgentSummary): string {
  return Object.entries(summary.passAtK)
    .map(([k, value]) => {
      const rated = summary.rated[k]
      return (
        ', pass@' +
        k +
        ' ' +
        (value * 100).toFixed(1) +
        '%' +
        (rated === undefined || rated === summary.tasks ? '' : ' of ' + some(rated))
      )
    })
    .join('')
}

function counts(summary: Result.AgentSummary): string {
  return (
    some(summary.tasks, 'sound task') +
    ': passed ' +
    summary.passed +
    '/' +
    summary.attempts +
    ', errored ' +
    summary.errored +
    rates(summary)
  )
}

function apart(attempts: readonly Result.Attempt[], unsound: readonly Result.Attempt[]): string {
  return (
    'unsound, set apart: ' +
    names(unsound).length +
    ' of ' +
    some(names(attempts).length) +
    ', whose own solution does not pass its verifier (nanoeval oracle says why): ' +
    names(unsound).join(', ')
  )
}

export function summary(attempts: readonly Result.Attempt[], list: List): string[] {
  const { sound, unsound } = split(attempts, list)
  if (!unsound.length) return []
  const kept = Result.summarize(sound)
  const lost = unsound.filter((attempt) => gone(attempt, list))
  return [
    ...Object.keys(Result.summarize(unsound)).map((agent) =>
      kept[agent] ? agent + ' on its ' + counts(kept[agent]) : agent + ' ran no sound task',
    ),
    apart(attempts, unsound),
    ...(lost.length
      ? [
          'task dependency gone: ' +
            some(lost.length, 'errored attempt') +
            ' of ' +
            names(lost).join(', ') +
            ', whose verifier could not install from its package archive, which answered 404, as for its own solution: counted apart from the infrastructure errors',
        ]
      : []),
  ]
}

export function against(input: {
  baseline: readonly Compare.Run[]
  list: List
  run: readonly Compare.Run[]
}): string {
  const left = Compare.standing(input.baseline).flatMap((run) => run.attempts)
  const right = Compare.standing(input.run).flatMap((run) => run.attempts)
  const all = [...left, ...right]
  const { unsound } = split(all, input.list)
  if (!unsound.length) return ''
  const before = Result.summarize(split(left, input.list).sound)
  const after = Result.summarize(split(right, input.list).sound)
  const side = (summary: Result.AgentSummary | undefined) =>
    summary ? counts(summary) : 'no sound task'
  return (
    [
      ...Object.keys(Result.summarize(right)).flatMap((agent) => [
        agent + ' on the sound tasks only:',
        '  baseline: ' + side(before[agent]),
        '  run: ' + side(after[agent]),
      ]),
      apart(all, unsound),
    ].join('\n') + '\n'
  )
}

export function check(runs: readonly Compare.Run[], list: List): Check {
  const strangers = runs.flatMap((run) =>
    run.attempts.some((attempt) => attempt.agent.provider !== 'oracle') ? [run.id] : [],
  )
  if (strangers.length)
    throw new InvalidError(
      strangers.join(' and ') +
        (strangers.length === 1 ? ' is not an oracle run' : ' are not oracle runs') +
        ': the check reads runs made with --oracle, where each task ran its own solution',
    )
  const tasks = new Map<string, Result.Attempt[]>()
  for (const attempt of Compare.standing(runs).flatMap((run) => run.attempts))
    tasks.set(attempt.task.name, [...(tasks.get(attempt.task.name) ?? []), attempt])
  const found: Check = { moved: [], sound: [], unsound: [] }
  for (const [name, standing] of [...tasks].sort(([left], [right]) => left.localeCompare(right))) {
    const passed = standing.filter((attempt) => attempt.outcome === 'passed').length
    const verdict: Verdict = {
      outcome:
        passed === standing.length
          ? 'passed'
          : standing.some((attempt) => attempt.outcome === 'failed')
            ? 'failed'
            : 'errored',
      passed,
      standing,
      task: short(name),
    }
    const checksum = standing[0]!.task.checksum
    const entry = find(list, checksum)
    if (entry) found.unsound.push({ ...verdict, entry })
    else {
      found.sound.push(verdict)
      for (const each of entries(list))
        if (each.task === verdict.task) found.moved.push({ entry: each, held: checksum })
    }
  }
  return found
}

export function failed(found: Check): boolean {
  return found.sound.some((verdict) => verdict.outcome !== 'passed')
}

function ended(verdict: Verdict): string {
  const failures = [
    ...new Set(
      verdict.standing.flatMap((attempt) =>
        attempt.failure
          ? [
              attempt.failure.kind +
                ': ' +
                attempt.failure.message.replace(/\s+/g, ' ').trim().slice(0, 160),
            ]
          : [],
      ),
    ),
  ]
  return (
    verdict.outcome +
    (verdict.standing.length === 1 ? '' : ' ' + verdict.passed + '/' + verdict.standing.length) +
    (failures.length ? ' (' + failures.join('; ') + ')' : '')
  )
}

export function report(found: Check): string {
  const broken = found.sound.filter((verdict) => verdict.outcome !== 'passed')
  return (
    [
      'oracle: the solution passes on ' +
        (found.sound.length - broken.length) +
        ' of ' +
        some(found.sound.length, 'sound task') +
        (broken.length ? ', and not on:' : ''),
      ...broken.map((verdict) => '  ' + verdict.task + ' ' + ended(verdict)),
      ...(found.unsound.length
        ? [
            'unsound, set apart: ' +
              found.unsound.length +
              ' of ' +
              some(found.sound.length + found.unsound.length) +
              ':',
            ...found.unsound.map(
              (verdict) =>
                '  ' +
                verdict.task +
                ' ' +
                ended(verdict) +
                ': ' +
                verdict.entry.reason +
                ' ' +
                verdict.entry.upstream,
            ),
          ]
        : []),
      ...found.moved.map(
        (each) =>
          'note: ' +
          each.entry.task +
          ' is listed as unsound at ' +
          each.entry.checksum.slice(0, 19) +
          ', and the run holds it at ' +
          each.held.slice(0, 19) +
          ', which counts as sound',
      ),
    ].join('\n') + '\n'
  )
}
