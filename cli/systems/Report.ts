import type * as Runner from './Runner.ts'
import * as Stats from './Stats.ts'
import type * as Suite from './Suite.ts'

const shown = ['ttftMs', 'turnMs', 'tokS', 'startupMs', 'rssPeakKb'] as const

export function number(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US')
  return Number(value.toPrecision(digits)).toString()
}

export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    '| ' + head.join(' | ') + ' |',
    '|' + head.map(() => '---').join('|') + '|',
    ...rows.map((row) => '| ' + row.join(' | ') + ' |'),
  ].join('\n')
}

function pair(summary: Stats.Summary | undefined): string {
  return summary?.n ? number(summary.p50) + ' / ' + number(summary.p95) : '-'
}

export function summary(run: Runner.Run, suite?: Suite.Suite): string {
  const lines = [
    '# Systems run ' + run.id,
    '',
    'Suite ' +
      run.suite.name +
      '@' +
      run.suite.version +
      ' (sha256 ' +
      run.suite.digest +
      '), targets ' +
      run.targets.join(', ') +
      ', ' +
      run.started +
      ' to ' +
      run.finished +
      '.',
    run.command ? '\n`' + run.command + '`' : '',
    '',
    '## Builds',
    '',
    table(
      ['build', 'spec', 'described'],
      run.builds.map(({ build, description }) => [
        build.label,
        build.binary ?? build.version ?? build.url ?? '-',
        'error' in description
          ? 'error: ' + description.error
          : JSON.stringify(description).slice(0, 200),
      ]),
    ),
    '',
    '## Scenarios',
    '',
    table(
      ['scenario', 'target', 'build', 'SLOs'],
      run.verdicts.map((verdict) => [
        verdict.scenario,
        verdict.target,
        verdict.build,
        (verdict.passed ? '**PASS**' : '**FAIL**') +
          ' ' +
          verdict.checks.filter((check) => check.passed).length +
          '/' +
          verdict.checks.length,
      ]),
    ),
    '',
    '## Metrics (p50 / p95)',
    '',
    'Times in ms, tok/s per turn, RSS in KB. pass is the share of turns that met their expectations.',
    '',
    table(
      ['scenario', 'c', 'phase', 'target/build', 'n', 'pass', ...shown, 'agg tok/s'],
      run.groups
        .filter((group) => group.phase !== 'batch')
        .map((group) => {
          const batch = run.groups.find(
            (other) =>
              other.phase === 'batch' &&
              other.scenario === group.scenario &&
              other.concurrency === group.concurrency &&
              other.target === group.target &&
              other.build === group.build,
          )
          const aggregate = group.metrics['aggTokS'] ?? batch?.metrics['aggTokS']
          return [
            group.scenario,
            String(group.concurrency),
            group.phase,
            group.target + '/' + group.build,
            String(group.metrics['pass']?.n ?? 0),
            number(group.metrics['pass']?.mean ?? null),
            ...shown.map((name) => pair(group.metrics[name])),
            aggregate?.n ? number(aggregate.p50) : '-',
          ]
        }),
    ),
    '',
  ]
  const failed = run.verdicts.flatMap((verdict) => verdict.checks.filter((check) => !check.passed))
  if (failed.length) {
    lines.push('## Missed SLOs', '')
    for (const check of failed)
      lines.push(
        '- ' +
          check.scenario +
          ' c' +
          check.concurrency +
          ' ' +
          check.target +
          '/' +
          check.build +
          ': ' +
          check.metric +
          ' ' +
          check.slo.stat +
          ' = ' +
          number(check.actual) +
          (check.slo.max !== undefined ? ', max ' + check.slo.max : '') +
          (check.slo.min !== undefined ? ', min ' + check.slo.min : '') +
          (check.slo.note ? ' (' + check.slo.note + ')' : ''),
      )
    lines.push('')
  }
  const failures = run.samples.filter((sample) => !sample.pass)
  if (failures.length) {
    lines.push('## Failed turns', '')
    for (const sample of failures.slice(0, 40))
      lines.push(
        '- ' +
          [
            sample.scenario,
            'c' + sample.concurrency,
            sample.target + '/' + sample.build,
            'r' + sample.rep,
            's' + sample.session,
            't' + sample.turn,
          ].join(' ') +
          ': ' +
          sample.failures.join('; '),
      )
    if (failures.length > 40) lines.push('- and ' + (failures.length - 40) + ' more in run.json')
    lines.push('')
  }
  if (suite)
    lines.push(
      'Scenario descriptions: ' +
        suite.scenarios.map((scenario) => scenario.id + ': ' + scenario.description).join(' · '),
      '',
    )
  return lines.filter((line, at) => line !== '' || lines[at - 1] !== '').join('\n')
}
