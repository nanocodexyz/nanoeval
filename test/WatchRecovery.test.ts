import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { after, test } from 'node:test'
import { alive, clean, ended, short, until, value, world } from './WatchWorld.ts'

after(clean)

test('a watcher and its run killed in the middle leave an interrupted line, and the revision is run again', async () => {
  const w = world()
  w.watch('--once')
  const n1 = w.commit('nanocode', 'feat: one')
  w.play({ hold: { [n1]: 60_000 } })
  const child = w.start('--once')
  const done = ended(child)
  const pending = await until(() => {
    const phase = w.intents()[0]?.phase
    return (
      phase?.kind === 'step' &&
      phase.pending.purpose === 'main' &&
      phase.pending.pid !== undefined &&
      phase.pending
    )
  }, 'the run of the new commit')
  await until(() => w.runs(n1).length === 1, 'the stub to hold')
  child.kill('SIGKILL')
  process.kill(-pending.pid!, 'SIGKILL')
  await done
  await until(() => !alive(pending.pid!), 'the run to die')
  assert.equal(w.lines().length, 1)
  assert.equal(w.intents().length, 1)

  w.play({ hold: {} })
  const said = w.watch('--once').stdout.split('\n').filter(Boolean)
  assert.match(
    said[0]!,
    new RegExp(
      '^nanocode ' +
        short(n1) +
        ' nanocode-ts \\w{12}: interrupted; the watcher stopped during the main run and the run left no finished job, so what it spent is counted as its whole budget; 1 run, \\$1.0000 with what is reserved; log ',
    ),
  )
  assert.match(said[1]!, new RegExp('^nanocode ' + short(n1) + ' nanocode-ts \\w{12}: ok; '))
  assert.match(said[2]!, /^up to date at /)
  const lines = w.lines()
  assert.deepEqual(
    lines.map((line) => [line.verdict, line.pair.nanocode]),
    [
      ['baseline', w.origin['nanocode']],
      ['interrupted', n1],
      ['ok', n1],
    ],
  )
  assert.deepEqual(
    lines[1]!.steps.map((step) => [step.purpose, step.exit, step.usd, step.charged]),
    [
      ['build', 0, 0, undefined],
      ['main', null, 1, 'reserved'],
    ],
  )
  assert.equal(w.runs(n1).length, 2)
  assert.deepEqual(w.intents(), [])
  assert.match(w.watch('--once').stdout, /^up to date at /)
  assert.equal(w.lines().length, 3)
})

test('a watcher killed alone lets its run end, waits for it, and takes its job without running again', async () => {
  const w = world()
  w.watch('--once')
  const n1 = w.commit('nanocode', 'feat: one')
  w.play({ hold: { [n1]: 2500 } })
  const child = w.start('--once')
  const done = ended(child)
  const pending = await until(() => {
    const phase = w.intents()[0]?.phase
    return (
      phase?.kind === 'step' &&
      phase.pending.purpose === 'main' &&
      phase.pending.pid !== undefined &&
      phase.pending
    )
  }, 'the run of the new commit')
  child.kill('SIGKILL')
  await done
  assert.ok(alive(pending.pid!))
  assert.match(
    w.watch('--once').stdout,
    new RegExp(
      '^the main step that an earlier nanoeval watch started for nanocode ' +
        short(n1) +
        ' nanocode-ts \\w{12} still runs as process ' +
        pending.pid +
        '\\n$',
    ),
  )
  assert.equal(w.lines().length, 1)
  await until(() => !alive(pending.pid!), 'the run to end')
  const said = w.watch('--once').stdout
  assert.match(said, new RegExp('^nanocode ' + short(n1) + ' nanocode-ts \\w{12}: ok; '))
  const lines = w.lines()
  assert.deepEqual(
    lines.map((line) => line.verdict),
    ['baseline', 'ok'],
  )
  assert.deepEqual(
    lines[1]!.steps.map((step) => [step.purpose, step.exit, step.charged]),
    [
      ['build', 0, undefined],
      ['main', null, 'recorded'],
    ],
  )
  assert.equal(w.runs(n1).length, 1)
  assert.deepEqual(w.intents(), [])
})

test('a build that fails is recorded with its log, tried once more and then left until a new commit or --retry', () => {
  const w = world()
  w.watch('--once')
  const n1 = w.commit('nanocode', 'feat: does not build')
  w.play({ builds: { [n1]: 'fail' } })
  const first = w.watch('--once').stdout
  assert.match(
    first,
    new RegExp(
      '^nanocode ' +
        short(n1) +
        ' nanocode-ts \\w{12}: build failed; the build ended with status 101: .*error: could not compile nanocode-cli at ' +
        n1 +
        '; log (\\S+)\\n$',
    ),
  )
  const log = /; log (\S+)\n$/.exec(first)![1]!
  assert.match(
    Fs.readFileSync(log, 'utf8'),
    /^\$ .* revision --nanocode .* --build-only\n[^]*could not compile/,
  )
  assert.match(w.watch('--once').stdout, /: build failed; /)
  const third = w.watch('--once').stdout
  assert.match(
    third,
    new RegExp(
      '^nanocode ' +
        short(n1) +
        ' nanocode-ts \\w{12} is not tried again: its build failed 2 times, log \\S+-1-build.log\\n$',
    ),
  )
  assert.equal(w.watch('--once').stdout, third)
  const lines = w.lines()
  assert.deepEqual(
    lines.map((line) => line.verdict),
    ['baseline', 'build_failed', 'build_failed'],
  )
  assert.equal(w.runs(n1).length, 0)
  assert.match(w.board(), /\| watch \| build failed, covers 1 \+ 0 commits, log \S+-1-build.log \|/)

  assert.match(w.watch('--retry').stdout, /are forgotten/)
  assert.match(
    w.watch('--dry-run').stdout,
    new RegExp(
      '^would evaluate nanocode ' + short(n1) + ' nanocode-ts \\w{12} as head: 2 attempts',
    ),
  )
  assert.match(w.watch('--once').stdout, /: build failed; /)
  assert.match(w.watch('--once').stdout, /: build failed; /)
  assert.match(w.watch('--once').stdout, /is not tried again: its build failed 2 times/)

  const n2 = w.commit('nanocode', 'fix: builds again')
  assert.match(
    w.watch('--once').stdout,
    new RegExp('^nanocode ' + short(n2) + ' nanocode-ts \\w{12}: ok; '),
  )
  assert.deepEqual(w.lines().at(-1)!.covers, { nanocode: 2, nanocodeTs: 0 })
})

test('errored rows are run again once, a dead credential ends the tick, and neither is a score', () => {
  const w = world()
  w.watch('--once')
  const n1 = w.commit('nanocode', 'feat: one')
  w.play({ outcomes: { [n1]: { 'sonnet/alpha': 'ep' } } })
  assert.match(
    w.watch('--once').stdout,
    new RegExp(
      '^nanocode ' +
        short(n1) +
        ' nanocode-ts \\w{12}: ok; sonnet pass@1 100.0% pass@2 100.0%, 1 errored; luna pass@1 100.0% pass@2 100.0%; 2 runs, \\$0.1300\\n',
    ),
  )
  const repaired = w.lines()[1]!
  assert.deepEqual(
    repaired.steps.map((step) => step.purpose),
    ['build', 'main', 'errored'],
  )
  assert.equal(repaired.marks['sonnet']!['alpha'], 'epp')
  const topUp = w.runs(n1)[1]!
  assert.deepEqual(
    [value(topUp, '--only'), value(topUp, '--agent'), value(topUp, '--attempts')],
    [['alpha'], ['sonnet=claude:claude-sonnet-5-5'], ['1']],
  )

  const n2 = w.commit('nanocode', 'feat: two')
  w.play({ credential: 'expired' })
  const dead = w.watch('--once').stdout
  assert.match(
    dead,
    new RegExp(
      '^nanocode ' +
        short(n2) +
        ' nanocode-ts \\w{12}: incomplete; 6 tasks have too few scored attempts: sonnet/alpha, .*, 12 x AgentError: 401 Unauthorized: the access token expired; sonnet pass@1 not scored pass@2 not scored, 6 errored; luna pass@1 not scored pass@2 not scored, 6 errored; 1 run, \\$0.0000\\n$',
    ),
  )
  assert.equal(w.runs(n2).length, 1)
  assert.match(w.watch('--once').stdout, /: incomplete; /)
  assert.match(
    w.watch('--once').stdout,
    new RegExp(
      '^nanocode ' +
        short(n2) +
        ' nanocode-ts \\w{12} is not tried again: 2 evaluations of it did not complete, the last one incomplete \\(6 tasks have too few scored attempts',
    ),
  )
  assert.equal(w.runs(n2).length, 2)
  assert.equal(w.lines().filter((line) => line.verdict === 'ok').length, 1)

  const n3 = w.commit('nanocode', 'feat: three')
  w.play({ credential: 'missing' })
  const missing = w.watch('--once').stdout
  assert.match(
    missing,
    new RegExp(
      '^nanocode ' +
        short(n3) +
        ' nanocode-ts \\w{12}: run failed; the run ended with status 1 and left no finished job \\(no job at \\S+\\): .*no model credential serves the agent sonnet: set ANTHROPIC_API_KEY .*; 1 run, \\$1.0000 with what is reserved; log \\S+-2-main.log\\n$',
    ),
  )
  const failed = w.lines().at(-1)!
  assert.equal(failed.verdict, 'run_failed')
  assert.deepEqual(
    failed.steps.map((step) => [step.purpose, step.usd, step.charged]),
    [
      ['build', 0, undefined],
      ['main', 1, 'reserved'],
    ],
  )
  w.play({ credential: undefined })
  assert.match(
    w.watch('--once').stdout,
    new RegExp('^nanocode ' + short(n3) + ' nanocode-ts \\w{12}: ok; '),
  )
  assert.deepEqual(w.lines().at(-1)!.covers, { nanocode: 2, nanocodeTs: 0 })
})

test('while another evaluation holds the lab the watcher records nothing, and runs when it is free', async () => {
  const w = world()
  w.watch('--once')
  const n1 = w.commit('nanocode', 'feat: one')
  const lock = Path.join(w.lab, 'lock')
  const holder = spawn('flock', [lock, 'sleep', '60'], { stdio: 'ignore' })
  const gone = ended(holder)
  await until(() => spawnSync('flock', ['--nonblock', lock, 'true']).status === 1, 'the lock')
  const calls = w.calls().length
  const said = w.watch('--once').stdout
  assert.equal(
    said,
    'another evaluation holds ' +
      lock +
      ': nanocode ' +
      short(n1) +
      ' nanocode-ts ' +
      short(w.origin['nanocode-ts']!) +
      ' waits for the next time\n',
  )
  assert.equal(w.watch('--once').stdout, said)
  assert.equal(w.lines().length, 1)
  assert.equal(w.calls().length, calls)
  holder.kill('SIGKILL')
  await gone
  spawnSync('pkill', ['-f', 'sleep 60'])
  await until(
    () => spawnSync('flock', ['--nonblock', lock, 'true']).status === 0,
    'the lock to be free',
  )
  assert.match(
    w.watch('--once').stdout,
    new RegExp('^nanocode ' + short(n1) + ' nanocode-ts \\w{12}: ok; '),
  )
  assert.equal(w.lines().length, 2)
  assert.equal(w.runs(n1).length, 1)
  assert.deepEqual(w.intents(), [])
})
