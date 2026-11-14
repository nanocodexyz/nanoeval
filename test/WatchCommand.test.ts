import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { after, test } from 'node:test'
import { clean, ended, short, until, value, world } from './WatchWorld.ts'

after(clean)

test('commits that arrive while the watcher runs are each evaluated once, and it stops clean', async () => {
  const w = world()
  const child = w.start()
  let out = ''
  child.stdout!.on('data', (chunk) => (out += chunk))
  const done = ended(child)
  await until(() => w.lines().length === 1, 'the baseline')
  const one = w.commit('nanocode', 'feat: one')
  await until(() => w.lines().length === 2, 'the first commit')
  const brain = w.commit('nanocode-ts', 'feat: brain')
  await until(() => w.lines().length === 3, 'the second commit')
  await until(() => out.includes('up to date at nanocode ' + short(one)), 'the idle line')
  child.kill('SIGTERM')
  assert.equal(await done, 143)

  const lines = w.lines()
  assert.deepEqual(
    lines.map((line) => [line.verdict, line.pair.nanocode, line.pair.nanocodeTs]),
    [
      ['baseline', w.origin['nanocode'], w.origin['nanocode-ts']],
      ['ok', one, w.origin['nanocode-ts']],
      ['ok', one, brain],
    ],
  )
  assert.deepEqual(lines[1]!.covers, { nanocode: 1, nanocodeTs: 0 })
  assert.deepEqual(lines[2]!.covers, { nanocode: 0, nanocodeTs: 1 })
  assert.equal(w.runs().length, 3)
  assert.deepEqual(w.intents(), [])
  const said = out.split('\n').filter(Boolean)
  assert.equal(said.filter((line) => line.includes(': baseline;')).length, 1)
  assert.equal(said.filter((line) => line.includes(': ok;')).length, 2)
  assert.equal(
    said.filter(
      (line) => line === 'up to date at nanocode ' + short(one) + ' nanocode-ts ' + short(brain),
    ).length,
    1,
  )
  assert.match(
    w.board(),
    new RegExp(
      '\\| ' +
        short(one) +
        ' \\| ' +
        short(brain) +
        ' \\| watch \\| ok, covers 0 \\+ 1 commits \\| sonnet \\| 100.0% \\| 100.0% @2 \\|',
    ),
  )
  assert.equal(spawnSync('flock', ['--nonblock', Path.join(w.state, 'lock'), 'true']).status, 0)
})

test('of several commits the newest is run first, the first losing one is found on the lost task alone, and the hook hears it', () => {
  const w = world({ hook: true })
  assert.match(
    w.watch('--dry-run').stdout,
    /^would evaluate nanocode \w{12} nanocode-ts \w{12} as baseline: 4 attempts of alpha, beta, gamma for sonnet, luna\n$/,
  )
  assert.equal(w.lines().length, 0)
  assert.match(
    w.watch('--once').stdout,
    /: baseline; sonnet pass@1 100.0% pass@2 100.0%; luna pass@1 100.0% pass@2 100.0%; 1 run, \$0.2400\nup to date at /,
  )
  const n1 = w.commit('nanocode', 'feat: one')
  const n2 = w.commit('nanocode', 'feat: two')
  const t1 = w.commit('nanocode-ts', 'feat: brain one')
  const n3 = w.commit('nanocode', 'feat: three')
  const n4 = w.commit('nanocode', 'feat: four')
  const t2 = w.commit('nanocode-ts', 'feat: brain two')
  const n5 = w.commit('nanocode', 'feat: five')
  w.play({ outcomes: Object.fromEntries([n3, n4, n5].map((sha) => [sha, { 'luna/gamma': 'f' }])) })
  const before = w.calls().length

  const said = w.watch('--once').stdout.split('\n').filter(Boolean)
  const culprit = 'first losing commit nanocode ' + short(n3) + ' "feat: three"'
  assert.deepEqual(
    said.map((line) => line.replace(/; (sonnet|luna) pass.*$/, '')),
    [
      'nanocode ' +
        short(n5) +
        ' nanocode-ts ' +
        short(t2) +
        ': REGRESSION, lost luna/gamma 4/4 -> 0/4 (p 0.014)',
      'nanocode ' + short(n2) + ' nanocode-ts ' + short(t1) + ': bisect, loses nothing',
      'nanocode ' +
        short(n4) +
        ' nanocode-ts ' +
        short(t1) +
        ': bisect, loses, lost luna/gamma 4/4 -> 0/4 (p 0.014)',
      'nanocode ' +
        short(n3) +
        ' nanocode-ts ' +
        short(t1) +
        ': bisect, loses, lost luna/gamma 4/4 -> 0/4 (p 0.014); ' +
        culprit,
      'nanocode ' +
        short(n5) +
        ' nanocode-ts ' +
        short(t2) +
        ' lost luna/gamma against nanocode ' +
        short(w.origin['nanocode']!) +
        ' nanocode-ts ' +
        short(w.origin['nanocode-ts']!) +
        ': ' +
        culprit,
    ],
  )
  const runs = w
    .calls()
    .slice(before)
    .filter((call) => !call.includes('--build-only'))
  assert.deepEqual(
    runs.map((call) => [
      short(value(call, '--nanocode')[0]!),
      short(value(call, '--nanocode-ts')[0]!),
      value(call, '--only').join(','),
      value(call, '--agent')
        .map((agent) => agent.split('=')[0])
        .join(','),
      value(call, '--attempts')[0],
    ]),
    [
      [short(n5), short(t2), 'alpha,beta,gamma', 'sonnet,luna', '2'],
      [short(n5), short(t2), 'gamma', 'luna', '2'],
      [short(n2), short(t1), 'gamma', 'luna', '2'],
      [short(n4), short(t1), 'gamma', 'luna', '2'],
      [short(n4), short(t1), 'gamma', 'luna', '2'],
      [short(n3), short(t1), 'gamma', 'luna', '2'],
      [short(n3), short(t1), 'gamma', 'luna', '2'],
    ],
  )
  assert.ok(runs.every((call) => value(call, '--model-budget-usd')[0] === '1'))
  assert.ok(!w.calls().some((call) => value(call, '--nanocode')[0] === n1))
  const lines = w.lines()
  assert.deepEqual(
    lines.map((line) => [line.trigger, line.verdict]),
    [
      ['watch', 'baseline'],
      ['watch', 'regression'],
      ['bisect', 'good'],
      ['bisect', 'bad'],
      ['bisect', 'bad'],
    ],
  )
  assert.deepEqual(lines[1]!.covers, { nanocode: 5, nanocodeTs: 2 })
  assert.equal(lines[1]!.baseline, lines[0]!.id)
  assert.deepEqual(lines[4]!.culprit, {
    commits: [{ repository: 'nanocode', sha: n3, subject: 'feat: three' }],
    good: { nanocode: n2, nanocodeTs: t1 },
  })
  const heard = w.hooked()
  assert.deepEqual(
    heard.map((line) => [line.id, line.verdict, Boolean(line.culprit)]),
    [
      [lines[1]!.id, 'regression', false],
      [lines[4]!.id, 'bad', true],
    ],
  )
  assert.equal(heard[0]!.scoreboard, Path.join(w.state, 'scoreboard.md'))
  assert.equal(heard[0]!.changes[0]!.kind, 'lost')
  assert.match(
    w.board(),
    /## Standing regression\n\nnanocode \w{12} nanocode-ts \w{12} \(evaluation \S+\) lost luna\/gamma 4\/4 -> 0\/4 \(p 0.014\)\. The first losing commit nanocode \w{12} "feat: three"\./,
  )
  assert.match(w.board(), new RegExp('## Baseline\\n\\nnanocode ' + short(w.origin['nanocode']!)))

  const again = w.calls().length
  assert.equal(w.watch('--once').stdout.split('\n').filter(Boolean).length, 1)
  assert.equal(w.calls().length, again)
  assert.equal(w.lines().length, 5)

  const n6 = w.commit('nanocode', 'fix: gamma')
  assert.match(
    w.watch('--once').stdout,
    new RegExp('^nanocode ' + short(n6) + ' nanocode-ts ' + short(t2) + ': ok; '),
  )
  assert.equal(w.lines().at(-1)!.verdict, 'ok')
  assert.deepEqual(w.lines().at(-1)!.covers, { nanocode: 6, nanocodeTs: 2 })
  assert.doesNotMatch(w.board(), /Standing regression/)
  assert.match(w.board(), new RegExp('## Baseline\\n\\nnanocode ' + short(n6)))
  assert.equal(w.hooked().length, 2)
})

test('a hook that does not end is killed after its limit, and the evaluation stands', () => {
  const w = world({ bisect: 'off', hook: ['sleep', '30'], hookSec: 0.3 })
  w.watch('--once')
  const dropped = w.commit('nanocode', 'feat: drop beta')
  w.play({ outcomes: { [dropped]: { beta: 'f' } } })
  const started = Date.now()
  const said = w.watch('--once').stdout
  assert.match(said, /REGRESSION, lost sonnet\/beta 4\/4 -> 0\/4/)
  assert.match(
    said,
    /\nthe hook for \S+ had not ended after 0\.3 s and was killed, log \S+-hook\.log\n/,
  )
  assert.ok(Date.now() - started < 20_000)
  assert.equal(w.lines().at(-1)!.verdict, 'regression')
  assert.equal(w.intents().length, 0)
})

test('a revision that lost a task can be accepted as the baseline, and bisect can be off', () => {
  const w = world({ bisect: 'off' })
  w.watch('--once')
  const n1 = w.commit('nanocode', 'feat: one')
  const n2 = w.commit('nanocode', 'feat: drop beta')
  w.play({ outcomes: { [n2]: { beta: 'f' } } })
  const said = w.watch('--once').stdout
  assert.match(
    said,
    /REGRESSION, lost sonnet\/beta 4\/4 -> 0\/4 \(p 0.014\), luna\/beta 4\/4 -> 0\/4 \(p 0.014\)/,
  )
  assert.match(
    said,
    /lost sonnet\/beta, luna\/beta against nanocode \w{12} nanocode-ts \w{12}, and bisect is off\n$/,
  )
  assert.equal(w.lines().length, 2)
  const asked = w.watch('--once', '--bisect').stdout
  assert.match(
    asked,
    new RegExp(
      'nanocode ' +
        short(n1) +
        ' nanocode-ts \\w{12}: bisect, loses nothing; first losing commit nanocode ' +
        short(n2) +
        ' "feat: drop beta"',
    ),
  )
  const regression = w.lines()[1]!
  assert.equal(w.watch('--accept', 'nothing').status, 1)
  assert.match(
    w.watch('--accept', regression.id).stdout,
    /is accepted as the baseline with what it lost/,
  )
  assert.match(w.watch('--once').stdout, new RegExp('^up to date at nanocode ' + short(n2)))
  assert.doesNotMatch(w.board(), /Standing regression/)
  assert.match(w.board(), /\| beta \| 0\/4 \| 0\/4 \|/)
  assert.match(w.board(), /\| alpha \| 6\/6 \| 6\/6 \|/)
  const n3 = w.commit('nanocode', 'feat: three')
  assert.match(
    w.watch('--once').stdout,
    new RegExp(
      '^nanocode ' +
        short(n3) +
        ' nanocode-ts \\w{12}: ok, gained sonnet/beta 0/4 -> 4/4 \\(p 0.014\\), luna/beta 0/4 -> 4/4 \\(p 0.014\\); ',
    ),
  )
  assert.match(w.board(), /\| beta \| 4\/4 \| 4\/4 \|/)
})

test('runs stop at the daily cap in runs and in dollars, and go on when there is room', () => {
  const w = world({ dailyRuns: 1 })
  w.watch('--once')
  const n1 = w.commit('nanocode', 'feat: one')
  const capped = w.watch('--once').stdout
  assert.equal(
    capped,
    'the daily cap is reached, 1 of the 1 runs of the day are used: nanocode ' +
      short(n1) +
      ' nanocode-ts ' +
      short(w.origin['nanocode-ts']!) +
      ' goes on the next day (UTC)\n',
  )
  assert.equal(w.watch('--once').stdout, capped)
  assert.equal(w.lines().length, 1)
  assert.equal(w.runs(n1).length, 0)
  assert.equal(w.intents().length, 1)
  w.configure({ dailyRuns: 5 })
  assert.match(
    w.watch('--once').stdout,
    new RegExp('^nanocode ' + short(n1) + ' nanocode-ts \\w{12}: ok; '),
  )
  assert.equal(
    w.calls().filter((call) => call.includes('--build-only') && value(call, '--nanocode')[0] === n1)
      .length,
    1,
  )

  const u = world({ dailyUsd: 1.5 })
  u.play({ unpriced: true })
  assert.match(u.watch('--once').stdout, /: baseline; .*; 1 run, \$1.0000 with what is reserved\n/)
  assert.equal(u.lines()[0]!.summary['sonnet']!.costUsd, null)
  u.commit('nanocode', 'feat: one')
  assert.match(
    u.watch('--once').stdout,
    /^the daily cap is reached, \$1.0000 of the \$1.5 of the day is spent or reserved, and a run may spend \$1: /,
  )
  assert.equal(u.lines().length, 1)
})

test('a checkout with uncommitted changes is evaluated on demand beside the baseline, which does not move', () => {
  const w = world()
  w.watch('--once')
  const directory = Path.join(w.root, 'nanocode')
  Fs.writeFileSync(Path.join(directory, 'README'), 'changed\n')
  Fs.writeFileSync(Path.join(directory, 'new.txt'), 'new\n')
  const status = w.git('nanocode', ['status', '--porcelain'])
  w.play({ outcomes: { [directory]: { beta: 'f' } } })
  const result = w.watch('--nanocode', directory)
  assert.equal(result.status, 1)
  const label = short(w.origin['nanocode']!) + '\\+[0-9a-f]{12}'
  assert.match(
    result.stdout,
    new RegExp(
      '^on demand nanocode ' +
        label +
        ' nanocode-ts ' +
        short(w.origin['nanocode-ts']!) +
        ': REGRESSION, lost sonnet/beta 4/4 -> 0/4 \\(p 0.014\\), luna/beta 4/4 -> 0/4 \\(p 0.014\\); sonnet pass@1 66.7% pass@2 66.7%; luna pass@1 66.7% pass@2 66.7%; 2 runs, \\$0.1600\\n\\nagainst the baseline ',
    ),
  )
  assert.match(
    result.stdout,
    /\nagainst the baseline nanocode \w{12} nanocode-ts \w{12}, whose tasks have the attempts of the last accepted revision\n/,
  )
  assert.match(
    result.stdout,
    /\| sonnet \| claude:claude-sonnet-5-5 \| 100.0% -> 66.7% \| 100.0% -> 66.7% \| 4 \| 4 \| 0 \| 8,000 \(3,200\) \| 400 \| \$0.0800 \|/,
  )
  assert.match(
    result.stdout,
    /\| beta \| 4\/4 \| 0\/4 ffff \| lost \(p 0.014\) \| 4\/4 \| 0\/4 ffff \| lost \(p 0.014\) \|/,
  )
  assert.match(result.stdout, /\| alpha \| 4\/4 \| 2\/2 pp \|  \| 4\/4 \| 2\/2 pp \|  \|/)
  assert.equal(w.git('nanocode', ['status', '--porcelain']), status)
  const runs = w.runs(directory)
  assert.deepEqual(
    runs.map((call) => [
      value(call, '--nanocode-ts')[0],
      value(call, '--only').join(','),
      value(call, '--agent').length,
    ]),
    [
      [w.origin['nanocode-ts'], 'alpha,beta,gamma', 2],
      [w.origin['nanocode-ts'], 'beta', 2],
    ],
  )
  const lines = w.lines()
  assert.deepEqual(
    lines.map((line) => [line.trigger, line.verdict]),
    [
      ['watch', 'baseline'],
      ['manual', 'regression'],
    ],
  )
  assert.match(lines[1]!.label!.nanocode, new RegExp('^' + label + '$'))
  assert.match(w.board(), /\| on demand \| regression \| sonnet \|/)
  assert.doesNotMatch(w.board(), /Standing regression/)
  assert.match(
    w.watch('--once').stdout,
    new RegExp('^up to date at nanocode ' + short(w.origin['nanocode']!)),
  )

  const one = w.watch('--nanocode', directory, '--only', 'alpha', '--attempts', '1')
  assert.equal(one.status, 0)
  assert.match(
    one.stdout,
    /^on demand nanocode \S+ nanocode-ts \w{12}: ok; sonnet pass@1 100.0%; luna pass@1 100.0%; 1 run, \$0.0200\n/,
  )
  const last = w.runs(directory).at(-1)!
  assert.deepEqual([value(last, '--only'), value(last, '--attempts')], [['alpha'], ['1']])

  const named = w.watch('--nanocode', w.origin['nanocode']!, '--nanocode-ts', 'pinned')
  assert.equal(named.status, 0)
  assert.match(
    named.stdout,
    new RegExp('^on demand nanocode ' + short(w.origin['nanocode']!) + ' nanocode-ts pinned: ok; '),
  )
  assert.equal(w.lines().filter((line) => line.trigger === 'manual').length, 3)
  assert.equal(w.watch('--board').stdout.split('\n')[0], '# nanoeval watch')
})

test('a command that writes its job under the lab instead is read there, and a ledger line that was cut off is dropped', () => {
  const w = world()
  w.play({ ignoreOut: true })
  assert.match(w.watch('--once').stdout, /: baseline; /)
  const job = w.lines()[0]!.steps[1]!.job!
  assert.ok(job.startsWith(Path.join(w.lab, 'runs', 'watch-')), job)
  Fs.appendFileSync(Path.join(w.state, 'watch.jsonl'), '{"type":"evaluation","id":"cut')
  const n1 = w.commit('nanocode', 'feat: one')
  const result = w.watch('--once')
  assert.match(
    result.stderr,
    /watch.jsonl ended in a line that was cut off while it was written, which is removed: \{"type":"evaluation","id":"cut/,
  )
  assert.match(result.stdout, new RegExp('^nanocode ' + short(n1) + ' nanocode-ts \\w{12}: ok; '))
  assert.deepEqual(
    w.lines().map((line) => line.verdict),
    ['baseline', 'ok'],
  )
})
