import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { client } from '../cli/nanoeval.ts'
import * as Revision from '../cli/Revision.ts'
import * as Loop from '../src/Loop.ts'

const lane = process.argv[2] ?? 'revision'
const out = Path.resolve('output/revision', lane)
const lab = Path.join(out, 'lab')
const cli = Path.resolve('cli/nanoeval.ts')
const agent = 'a=claude:claude-haiku-5-5'
const dir = ['--backend', 'dir']
const limitMs = Number(process.env['NANOEVAL_LANE_LIMIT_SEC'] ?? '1500') * 1000
const children = new Set<ChildProcess>()
const times: [step: string, ms: number][] = []

const solutions: [marker: string, right: string, wrong: string][] = [
  [
    'todos.txt',
    "grep '^- TODO: ' notes.md | sed 's/^- TODO: //' | sort > todos.txt",
    'echo nothing > todos.txt',
  ],
  [
    'message.upper.txt',
    "tr '[:lower:]' '[:upper:]' < message.txt > message.upper.txt",
    'cp message.txt message.upper.txt',
  ],
  ['greeting.txt', "printf 'hello from nanoeval\\n' > greeting.txt", 'echo hi > greeting.txt'],
]

const model = { asked: 0, gate: undefined as Promise<void> | undefined, wrong: false }

function sse(events: [string, unknown][]): string {
  return events
    .map(([name, data]) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n')
    .join('')
}

function reply(body: { messages?: unknown; model?: string }, id: number): string {
  const text = JSON.stringify(body.messages ?? [])
  const solution = solutions.find(([marker]) => text.includes(marker))
  if (!solution) throw new Error('the scripted model has no solution for this prompt')
  const call = text.includes('"tool_result"')
    ? undefined
    : 'await tools.exec_command({ cmd: ' +
      JSON.stringify(model.wrong ? solution[2] : solution[1]) +
      ' }); text("done")'
  const block = call
    ? [
        { id: 'toolu_' + id, input: {}, name: 'exec', type: 'tool_use' },
        { partial_json: JSON.stringify({ code: call }), type: 'input_json_delta' },
      ]
    : [
        { text: '', type: 'text' },
        { text: 'The task is complete.', type: 'text_delta' },
      ]
  return sse([
    [
      'message_start',
      {
        message: {
          content: [],
          id: 'msg_' + id,
          model: body.model,
          role: 'assistant',
          stop_reason: null,
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 8, output_tokens: 0 },
        },
        type: 'message_start',
      },
    ],
    ['content_block_start', { content_block: block[0], index: 0, type: 'content_block_start' }],
    ['content_block_delta', { delta: block[1], index: 0, type: 'content_block_delta' }],
    ['content_block_stop', { index: 0, type: 'content_block_stop' }],
    [
      'message_delta',
      {
        delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
        type: 'message_delta',
        usage: { output_tokens: 4 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

async function endpoint(): Promise<{ close(): void; url: string }> {
  const server = Http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const id = ++model.asked
      await model.gate
      try {
        const text = reply(JSON.parse(Buffer.concat(chunks).toString()), id)
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(text)
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { message: String(error), type: 'invalid_request_error' },
            type: 'error',
          }),
        )
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    close: () => void server.close(),
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
  }
}

type Ended = { code: number | null; ms: number; stderr: string; stdout: string }

function start(
  args: readonly string[],
  env: Record<string, string>,
): { child: ChildProcess; done: Promise<Ended>; output(): { stderr: string; stdout: string } } {
  const started = Date.now()
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let stderr = ''
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  return {
    child,
    done: new Promise<Ended>((resolve) =>
      child.once('close', (code) => {
        children.delete(child)
        resolve({ code, ms: Date.now() - started, stderr, stdout })
      }),
    ),
    output: () => ({ stderr, stdout }),
  }
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + limitMs
  for (;;) {
    const found = await probe()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error('the lane waited too long for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function passed(step: string, ended: Ended, code = 0): Ended {
  assert.equal(
    ended.code,
    code,
    step + ' ended with ' + ended.code + ':\n' + ended.stdout + '\n' + ended.stderr,
  )
  times.push([step, ended.ms])
  console.log(step + ': ' + (ended.ms / 1000).toFixed(1) + ' s')
  return ended
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-C', directory, '-c', 'user.name=lane', '-c', 'user.email=lane@example.com', ...args],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr)
  return result.stdout.trim()
}

function repository(name: string, files: Record<string, string>): string {
  const directory = Path.join(out, name)
  Fs.mkdirSync(directory, { recursive: true })
  git(directory, 'init', '--quiet', '--initial-branch', 'master')
  commit(directory, 'first', files)
  return directory
}

function commit(directory: string, subject: string, files: Record<string, string>): string {
  for (const [path, contents] of Object.entries(files)) {
    Fs.mkdirSync(Path.dirname(Path.join(directory, path)), { recursive: true })
    Fs.writeFileSync(Path.join(directory, path), contents)
  }
  git(directory, 'add', '.')
  git(directory, 'commit', '--quiet', '-m', subject)
  return git(directory, 'rev-parse', 'HEAD')
}

const hand = (check: string) =>
  [
    'use std::os::unix::process::CommandExt;',
    '',
    'fn main() {',
    '    let real = std::env::var("NANOEVAL_LANE_HAND").expect("NANOEVAL_LANE_HAND names a hand");',
    '    let arguments: Vec<String> = std::env::args().skip(1).collect();',
    check,
    '    let error = std::process::Command::new(real).args(arguments).exec();',
    '    eprintln!("{error}");',
    '    std::process::exit(1);',
    '}',
    '',
  ].join('\n')

function nanocode(): { breaking: string; current: string; directory: string; old: string } {
  const directory = repository('nanocode', {
    '.gitignore': 'target/\n',
    'Cargo.lock':
      '# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n[[package]]\nname = "nanocode-cli"\nversion = "0.0.0"\n',
    'Cargo.toml':
      '[package]\nname = "nanocode-cli"\nversion = "0.0.0"\nedition = "2021"\n\n[[bin]]\nname = "nanocode"\npath = "src/main.rs"\n',
    'src/main.rs': hand(''),
  })
  const old = git(directory, 'rev-parse', 'HEAD')
  const current = commit(directory, 'second', {
    'src/main.rs': hand(
      '    if arguments.first().map(String::as_str) == Some("hand") {\n        assert!(arguments.iter().any(|argument| argument == "--own-processes"));\n    }',
    ),
  })
  const breaking = commit(directory, 'third', { 'breaks-the-package': 'yes\n' })
  git(directory, 'checkout', '--quiet', '--detach', current)
  return { breaking, current, directory, old }
}

function nanocodeTs(sdk: string): string {
  return repository('nanocode-ts', {
    'Cargo.toml': '[package]\nname = "nanocode-ts-crates"\nversion = "0.0.0"\nedition = "2021"\n',
    'package-lock.json':
      JSON.stringify(
        {
          lockfileVersion: 3,
          name: 'nanocode-ts',
          packages: { '': { name: 'nanocode-ts', version: '0.0.0' } },
          requires: true,
          version: '0.0.0',
        },
        null,
        2,
      ) + '\n',
    'package.json':
      JSON.stringify(
        {
          exports: { '.': './dist/index.js' },
          name: 'nanocode-ts',
          scripts: { 'build:ts': 'node scripts/ts.mjs' },
          type: 'module',
          version: '0.0.0',
        },
        null,
        2,
      ) + '\n',
    'scripts/build.mjs': [
      "import * as Fs from 'node:fs'",
      "if (Fs.existsSync('../nanocodex/breaks-the-package')) {",
      "  console.error('error[E0308]: mismatched types')",
      '  process.exit(1)',
      '}',
      "Fs.mkdirSync('dist', { recursive: true })",
      "Fs.writeFileSync('dist/nanocode-wasm.json', JSON.stringify({ fingerprint: 'lane' }))",
      '',
    ].join('\n'),
    'scripts/ts.mjs':
      "import * as Fs from 'node:fs'\nFs.writeFileSync('dist/index.js', 'export {}\\n')\n",
    'sdk-revision.json': JSON.stringify({ revision: sdk }) + '\n',
    'src/lib.rs': '',
  })
}

function task(name: string, from: string, change: (directory: string) => void): string {
  const directory = Path.join(out, 'tasks', name)
  Fs.cpSync(Path.resolve('tasks', from), directory, { recursive: true })
  change(directory)
  return directory
}

const stamped = (text: string) => new RegExp('^\\[\\d+:\\d\\d\\] ' + text, 'm')

async function revision(env: Record<string, string>): Promise<void> {
  const run = (args: readonly string[], more: Record<string, string> = {}) =>
    start(['revision', '--lab', lab, ...args], { ...env, ...more })
  const subsets = Path.join(out, 'subsets.json')
  Fs.writeFileSync(
    subsets,
    JSON.stringify({
      samples: { quick: ['extract-todos', 'uppercase-message', 'write-greeting'] },
    }),
  )
  const recorded = async (name: string) => {
    const found = (await Revision.recorded(lab)) as (Revision.Recorded & {
      baseline?: string
      counts: { errored: number; failed: number; passed: number; total: number }
      name: string
    })[]
    const run = found.find((each) => each.name === name)
    assert.ok(run, 'the lab recorded no run ' + name)
    return run
  }
  const tickets = () =>
    Fs.existsSync(Path.join(lab, 'queue'))
      ? Fs.readdirSync(Path.join(lab, 'queue')).filter((name) => /^\d+\.json$/.test(name)).length
      : 0

  const server = run(['--serve'])
  const served = await until(
    'the served lab to say where it is',
    () => /NANOEVAL_URL=(http:\/\/127\.0\.0\.1:\d+) /.exec(server.output().stdout)?.[1],
  )
  const token = Fs.readFileSync(Path.join(lab, 'token'), 'utf8').trim()
  const api = client({ token, url: served })
  const read = <T>(what: string, ask: () => Promise<T>) =>
    until(what, () =>
      ask().catch((error: Error) => {
        if (/ answered 503: /.test(error.message)) return undefined
        throw error
      }),
    )
  const startedAt = Date.now()
  assert.deepEqual((await read('the Worker of the served lab', () => api.runs())).runs, [])
  console.log('served lab, its own Worker: ' + ((Date.now() - startedAt) / 1000).toFixed(1) + ' s')

  let release = () => {}
  model.gate = new Promise<void>((resolve) => (release = resolve))
  const first = run([
    '--task',
    'tasks/write-greeting',
    '--task',
    'tasks/extract-todos',
    '--task',
    'tasks/uppercase-message',
    '--eval',
    'samples',
    '--agent',
    agent,
    '--slots',
    '3',
    '--name',
    'lane-first',
    ...dir,
  ])
  await until('a model request of the first run', () => model.asked > 0)
  const pinned = Path.join(out, 'hand')
  Fs.copyFileSync(Path.join(lab, 'runner', 'rt', 'nanocode'), pinned)
  Fs.chmodSync(pinned, 0o755)
  const running = await read('the run through the served lab', async () => {
    const { runs } = await api.runs()
    return runs.length ? runs[0] : undefined
  })
  assert.equal(running.state, 'running')
  const seen = await read('the status of the run', () => api.status(running.id))
  assert.equal(seen['state'], 'running')
  assert.ok(seen['counts'].active > 0)
  const refused = await fetch(served + '/v1/runs/' + running.id + '/cancel', {
    headers: { authorization: 'Bearer ' + token },
    method: 'POST',
  })
  assert.equal(refused.status, 405)
  assert.match(await refused.text(), /the lab is served to be read: POST is refused/)
  release()
  model.gate = undefined
  const one = passed('the first run, three tasks imported, beside the served lab', await first.done)
  for (const line of [
    'worker: starting under local workerd on the state in ',
    'worker: http://127\\.0\\.0\\.1:\\d+, log in ',
    'import: 3 task directories$',
    'runner: started on the rows of the run, log in ',
    'rows: 0 of 3 ended, ',
    'rows: 3 of 3 ended \\(3 passed, 0 failed, 0 errored\\), 0 running, 0 waiting$',
  ])
    assert.match(one.stderr, stamped(line))
  assert.match(one.stdout, /^run [0-9a-f-]{36}: 3 attempts of samples@/m)
  assert.match(one.stdout, /^job written to /m)
  assert.match(server.output().stderr, stamped('an evaluation took the lab'))
  assert.equal(
    (await read('the run that ended', () => api.status(running.id)))['state'],
    'finished',
  )

  const a = run([
    '--quick',
    '--eval',
    'samples',
    '--subsets',
    subsets,
    '--agent',
    agent,
    '--slots',
    '3',
    '--model-budget-usd',
    '1',
    '--name',
    'lane-a',
    ...dir,
  ])
  await until('the first of the queue', () => tickets() === 1)
  const b = run([
    '--eval',
    'samples',
    '--agent',
    agent,
    '--baseline',
    'previous',
    '--name',
    'lane-b',
    ...dir,
  ])
  await until('the second of the queue', () => tickets() === 2)
  const c = run([
    '--eval',
    'samples',
    '--only',
    'write-greeting',
    '--agent',
    agent,
    '--baseline',
    'previous',
    '--quiet',
    '--name',
    'lane-c',
    ...dir,
  ])
  const pins = passed('the pinned builds, quick: three tasks, three attempts', await a.done)
  const second = passed('queued behind it, against the run before', await b.done)
  const third = passed('queued third, quiet, against the run before', await c.done)
  assert.match(
    pins.stderr,
    stamped('quick: samples, the subset quick, 3 attempts a task, a=claude:claude-haiku-5-5$'),
  )
  assert.match(
    second.stderr,
    stamped(
      'lab: waiting in .* for 1 evaluation that came first: nanocode pinned, lane-a \\(process \\d+\\)$',
    ),
  )
  assert.doesNotMatch(third.stderr, /^\[/m)
  const [ranA, ranB, ranC] = [
    await recorded('lane-a'),
    await recorded('lane-b'),
    await recorded('lane-c'),
  ]
  assert.deepEqual(
    (await Revision.recorded(lab)).map((each) => each.id),
    [running.id, ranA.id, ranB.id, ranC.id],
  )
  assert.equal(ranA.counts.passed, 9)
  assert.equal(ranB.baseline, ranA.id)
  assert.equal(ranC.baseline, ranB.id)
  assert.match(
    second.stderr,
    new RegExp('^baseline: ' + ranA.id + ', the run before this one, ', 'm'),
  )
  assert.match(
    third.stderr,
    new RegExp('^baseline: ' + ranB.id + ', the run before this one, ', 'm'),
  )
  assert.deepEqual(ranA.settings, {
    agents: [{ id: 'a', model: 'claude-haiku-5-5', provider: 'claude' }],
    attempts: 3,
    modelUsd: 1,
    slots: 3,
  })

  const fake = nanocode()
  const repositories = ['--nanocode-repository', fake.directory]
  const old = passed(
    'a nanocode whose hand a slot cannot start, refused',
    await run([
      '--nanocode',
      fake.old,
      '--nanocode-ts',
      'pinned',
      ...repositories,
      '--eval',
      'samples',
      '--agent',
      agent,
      ...dir,
    ]).done,
    1,
  )
  assert.match(
    old.stderr,
    /^nanoeval: nanocode [0-9a-f]{12} cannot be the hand of a slot: a slot starts its hand with --own-processes, .* from 5f8b457de on$/m,
  )
  assert.ok(!Fs.existsSync(Path.join(lab, 'hands')) && !Fs.existsSync(Path.join(lab, 'target')))

  const ts = nanocodeTs(fake.current)
  const pair = [
    '--nanocode',
    fake.breaking,
    '--nanocode-ts',
    'master',
    ...repositories,
    '--nanocode-ts-repository',
    ts,
    '--build-only',
  ]
  const unbuilt = passed('a package that does not build on its nanocode', await run(pair).done, 1)
  assert.match(unbuilt.stderr, /error\[E0308\]: mismatched types/)
  assert.match(unbuilt.stderr, stamped('hand: built in \\d+ s$'))
  const short = (revision: string) => revision.slice(0, 12)
  const fell =
    'harness: nanocode-ts [0-9a-f]{12} does not build on nanocode ' +
    short(fake.breaking) +
    ' \\(.*\\), so it is built on nanocode ' +
    short(fake.current) +
    ', the one it names itself: the rows run the brain of that nanocode with the hand of ' +
    short(fake.breaking) +
    '$'
  const fallen = passed(
    'the same with --sdk-fallback pinned',
    await run([...pair, '--sdk-fallback', 'pinned']).done,
  )
  assert.match(fallen.stderr, stamped(fell))
  for (const line of [
    'harness: npm ci$',
    'harness: cargo fetch, the lock of its crates for nanocode ',
    'harness: scripts/build.mjs, the WebAssembly modules$',
    'harness: npm run build:ts$',
    'harness: npm ci --omit=dev, the dependencies of the package$',
    'harness: built in \\d+ s$',
  ])
    assert.match(fallen.stderr, stamped(line))
  assert.match(
    fallen.stdout,
    new RegExp(
      "^export NANOEVAL_NANOCODE_TS_REVISION='nanocode-ts [0-9a-f]{12} on nanocode " +
        short(fake.current) +
        "'$",
      'm',
    ),
  )
  assert.match(
    fallen.stdout,
    new RegExp("^export NANOEVAL_NANOCODE_REVISION='nanocode " + short(fake.breaking) + "'$", 'm'),
  )
  const again = passed(
    'the same again, nothing built',
    await run([...pair, '--sdk-fallback', 'pinned']).done,
  )
  assert.match(again.stderr, stamped(fell))
  assert.doesNotMatch(again.stderr, /building/)
  assert.equal(again.stdout, fallen.stdout)

  Fs.appendFileSync(Path.join(fake.directory, 'src', 'main.rs'), '\n')
  Fs.writeFileSync(Path.join(fake.directory, 'notes.txt'), 'a change that is not committed\n')
  const quick = [
    '--nanocode',
    fake.directory,
    '--nanocode-ts',
    'pinned',
    '--quick',
    '--eval',
    'samples',
    '--subsets',
    subsets,
    ...dir,
  ]
  const ok = passed(
    'quick, a checkout with changes against the pinned builds',
    await run([...quick, '--name', 'lane-quick'], { NANOEVAL_LANE_HAND: pinned }).done,
  )
  const ranQuick = await recorded('lane-quick')
  const label = ranQuick.nanocode!.hands[0]!
  assert.match(label, new RegExp('^nanocode ' + short(fake.current) + '\\+[0-9a-f]{12}$'))
  assert.match(
    ok.stderr,
    stamped(
      'quick: samples, the subset quick, 3 attempts a task, a=claude:claude-haiku-5-5, against ' +
        ranA.id +
        ', the latest quick run on the pinned builds, exit 3 on regression$',
    ),
  )
  for (const line of [
    'hand: reading nanocode ',
    'hand: building ' + label.replace('+', '\\+') + ' with the release profile, log in ',
    'hand: built in \\d+ s$',
    'rows: 9 of 9 ended \\(9 passed, 0 failed, 0 errored\\), 0 running, 0 waiting$',
  ])
    assert.match(ok.stderr, stamped(line))
  assert.match(ok.stdout, /^verdict: no change beyond noise: of the 3 tasks scored on both sides /m)
  assert.equal(ranQuick.baseline, ranA.id)
  assert.deepEqual(ranQuick.settings, ranA.settings)
  assert.equal(ranQuick.counts.passed, 9)

  model.wrong = true
  const lost = passed(
    'quick again with a model that fails, against the run of that checkout: exit 3',
    await run([...quick, '--baseline', fake.directory, '--name', 'lane-lost'], {
      NANOEVAL_LANE_HAND: pinned,
    }).done,
    3,
  )
  model.wrong = false
  assert.match(lost.stderr, stamped('hand: ' + label.replace('+', '\\+') + ', built before in '))
  assert.match(
    lost.stderr,
    new RegExp(
      '^baseline: ' +
        ranQuick.id +
        ', the latest finished run of samples on .*, hand ' +
        label.replace('+', '\\+') +
        ' that holds these tasks with a, on the same model route$',
      'm',
    ),
  )
  assert.match(
    lost.stdout,
    /^verdict: regression: of the 3 tasks scored on both sides 3 moved down /m,
  )
  assert.equal((await recorded('lane-lost')).counts.failed, 9)

  const changed = task('write-greeting', 'write-greeting', (directory) =>
    Fs.appendFileSync(Path.join(directory, 'instruction.md'), 'Write nothing else.\n'),
  )
  const added = task('shout-message', 'uppercase-message', (directory) => {
    const file = Path.join(directory, 'task.toml')
    Fs.writeFileSync(
      file,
      Fs.readFileSync(file, 'utf8').replace('nanoeval/uppercase-message', 'nanoeval/shout-message'),
    )
  })
  const imported = passed(
    'a task changed and a task added, against a run of the version before',
    await run([
      '--task',
      changed,
      '--task',
      added,
      '--eval',
      'samples',
      '--agent',
      agent,
      '--baseline',
      ranA.id,
      '--name',
      'lane-imported',
      ...dir,
    ]).done,
  )
  assert.match(
    imported.stdout,
    /^left out, the task is another in the eval version of the baseline: write-greeting$/m,
  )
  assert.match(imported.stdout, /^not in the baseline: shout-message$/m)
  assert.match(imported.stdout, /^only in the baseline: extract-todos, uppercase-message$/m)
  const across = passed(
    'the tasks that did not change, against the latest run on the pinned builds',
    await run([
      '--eval',
      'samples',
      '--only',
      'extract-todos',
      '--only',
      'uppercase-message',
      '--agent',
      agent,
      '--baseline',
      'latest',
      '--name',
      'lane-across',
      ...dir,
    ]).done,
  )
  const ranAcross = await recorded('lane-across')
  assert.notEqual(ranAcross.eval!.version, ranB.eval!.version)
  assert.equal(ranAcross.baseline, ranB.id)
  assert.match(
    across.stdout,
    /^verdict: no change beyond noise: of the 2 tasks scored on both sides /m,
  )

  const listed = await read('the runs of the lab', () => api.runs())
  assert.equal(listed.runs.length, 8)
  assert.ok(listed.runs.every((each) => each.state === 'finished'))
  const compared = passed(
    'compare through the served lab',
    await start(
      ['compare', '--url', served, '--token', token, '--baseline', ranA.id, ranQuick.id],
      env,
    ).done,
  )
  assert.match(compared.stdout, /^verdict: no change beyond noise/m)
  assert.match(
    server.output().stderr,
    stamped('no evaluation runs in the lab: a Worker of its own answers, '),
  )
  server.child.kill('SIGTERM')
  assert.equal((await server.done).code, 1)
  assert.deepEqual(
    Fs.readdirSync(lab).filter((name) => name === 'worker.json' || name === 'worker.wanted'),
    [],
  )
}

async function watch(env: Record<string, string>): Promise<void> {
  const config = Path.join(out, 'watch.toml')
  Fs.writeFileSync(
    config,
    [
      'state = "state"',
      '',
      '[nanocode]',
      'revision = "pinned"',
      '',
      '[nanocode_ts]',
      'revision = "pinned"',
      '',
      '[eval]',
      'name = "samples"',
      'tasks = "all"',
      'attempts = 3',
      'agents = ["' + agent + '"]',
      'slots = 3',
      'options = ["--task", "' + Path.resolve('tasks/write-greeting') + '", "--backend", "dir"]',
      '',
      '[budget]',
      'run_usd = 1',
      'daily_usd = 20',
      'daily_runs = 40',
      '',
      '[revision]',
      'lab = "lab"',
      'options = ["--sdk-fallback", "pinned"]',
      '',
    ].join('\n'),
  )
  const run = (...args: string[]) => start(['watch', '--config', config, ...args], env).done
  const baseline = passed('watch, the baseline on the pinned builds', await run('--once'))
  assert.match(
    baseline.stdout,
    /^nanocode pinned nanocode-ts pinned: baseline; a pass@1 100\.0% pass@3 100\.0%; 1 run, /m,
  )
  model.wrong = true
  const lost = passed(
    'watch, the same pair on demand with a model that fails',
    await run('--nanocode', 'pinned', '--nanocode-ts', 'pinned'),
    1,
  )
  assert.match(
    lost.stdout,
    /^on demand nanocode pinned nanocode-ts pinned: REGRESSION, lost a\/write-greeting 3\/3 -> 0\/6 \(p 0\.012\); /m,
  )
  const lines = Fs.readFileSync(Path.join(out, 'state', 'watch.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { builds?: string[]; verdict: string })
  assert.equal(lines[0]!.verdict, 'baseline')
  assert.equal(lines[0]!.builds?.length, 1)
  assert.match(lines[0]!.builds![0]!, /^nanocode-ts \S+, hand nanocode-cli-\S+$/)
  const log = Fs.readdirSync(Path.join(out, 'state', 'logs')).find((name) =>
    name.endsWith('-main.log'),
  )!
  assert.match(
    Fs.readFileSync(Path.join(out, 'state', 'logs', log), 'utf8'),
    stamped('rows: 3 of 3 ended \\(3 passed, 0 failed, 0 errored\\), 0 running, 0 waiting$'),
  )
}

async function loop(env: Record<string, string>): Promise<void> {
  const run = (args: readonly string[]) => start(['loop', '--lab', lab, ...args, ...dir], env).done
  const names = ['extract-todos', 'uppercase-message', 'write-greeting']
  const subsets = Path.join(out, 'subsets.json')
  Fs.writeFileSync(subsets, JSON.stringify({ samples: { [Loop.defaults.subset]: names } }))
  const arms = ['--agent', 'a=claude:claude-haiku-5-5', '--agent', 'b=claude:claude-haiku-5-5']
  const samples = ['--eval', 'samples', '--subsets', subsets, '--attempts', '2', ...arms]
  const threads = Os.availableParallelism()
  const card = (ended: Ended) => {
    const file = /^scorecard written to (.+)$/m.exec(ended.stdout)?.[1]
    assert.ok(file, 'the loop named no scorecard:\n' + ended.stdout)
    return JSON.parse(Fs.readFileSync(file, 'utf8')) as Loop.Scorecard
  }
  const said = (selection: string, against: string) =>
    stamped(
      'loop: ' +
        selection +
        ', 2 attempts a task, 2 arms \\(a, b\\), ' +
        threads +
        ' dir slots, one for each thread of this machine, against ' +
        against +
        ', exit 3 on regression$',
    )
  const line = (arm: string, counts: string, against: string) =>
    new RegExp(
      '^\\| ' +
        arm +
        ' \\| [^|]+ \\| claude-haiku-5-5 \\| ' +
        counts +
        ' \\| .* \\| ' +
        against +
        ' \\|$',
      'm',
    )
  const whole = (rows: number) =>
    new RegExp(
      '^loop: ' +
        rows +
        ' rows of 2 arms in [0-9a-z ]+ from the start of the command, the run [0-9a-z ]+ from its first start to its last end on ' +
        threads +
        ' slots, infrastructure errors 0 or 0\\.0% of the rows, agent or model errors 0$',
      'm',
    )

  const first = passed(
    'a loop of two arms on three task directories, the first run of the lab',
    await run([
      ...names.flatMap((name) => ['--task', Path.join('tasks', name)]),
      '--eval',
      'samples',
      '--attempts',
      '2',
      ...arms,
      '--name',
      'first',
    ]),
  )
  assert.match(
    first.stderr,
    said('3 task directories', 'the run before this one where the lab has one'),
  )
  assert.match(
    first.stderr,
    /^baseline: none, so this run gets no verdict: no finished run of samples /m,
  )
  assert.match(
    first.stdout,
    line('a', '6/6 \\| 100\\.0% of 6 \\| 100\\.0% over 3 \\| 100\\.0%', 'no baseline'),
  )
  assert.match(
    first.stdout,
    line('b', '6/6 \\| 100\\.0% of 6 \\| 100\\.0% over 3 \\| 100\\.0%', 'no baseline'),
  )
  assert.match(first.stdout, whole(12))
  assert.match(first.stdout, /^verdict: none, the run has no baseline$/m)
  const one = card(first)
  assert.deepEqual(
    [
      one.name,
      one.baseline,
      one.verdict,
      one.loop.rows,
      one.loop.infrastructureRate,
      one.loop.slots,
    ],
    ['first', null, null, 12, 0, threads],
  )
  assert.deepEqual(
    one.arms.map((arm) => [arm.agent, arm.passed, arm.rows, arm.passAtK, arm.against]),
    [
      ['a', 6, 6, { '1': 1, '2': 1 }, null],
      ['b', 6, 6, { '1': 1, '2': 1 }, null],
    ],
  )

  model.wrong = true
  const lost = passed(
    'the same arms with a model that fails, against the run before: exit 3',
    await run(samples),
    3,
  )
  assert.match(
    lost.stderr,
    said('samples, the subset hourly', 'the run before this one where the lab has one'),
  )
  assert.match(
    lost.stderr,
    new RegExp('^baseline: ' + one.run + ', the run before this one, ', 'm'),
  )
  for (const arm of ['a', 'b'])
    assert.match(
      lost.stdout,
      line(
        arm,
        '0/6 \\| 0\\.0% of 6 \\| 0\\.0% over 3 \\| 0\\.0%',
        'regression, 3 down and 0 up of 3',
      ),
    )
  assert.match(lost.stdout, whole(12))
  assert.match(
    lost.stdout,
    new RegExp(
      '^verdict: regression against first \\(' + one.run.slice(0, 8) + '\\); regression: a, b$',
      'm',
    ),
  )
  const two = card(lost)
  assert.deepEqual(
    [two.verdict, two.baseline],
    ['regression', { names: ['first'], runs: [one.run] }],
  )

  model.wrong = false
  const again = passed(
    'the arms again with the model that solves, against the first run by its name',
    await run([...samples, '--baseline', 'first', '--name', 'again']),
  )
  assert.match(again.stderr, said('samples, the subset hourly', 'first'))
  assert.match(
    again.stdout,
    new RegExp(
      '^verdict: no change beyond noise against first \\(' +
        one.run.slice(0, 8) +
        '\\); no change beyond noise: a, b$',
      'm',
    ),
  )
  const three = card(again)
  assert.deepEqual(
    [three.name, three.verdict, three.baseline],
    ['again', 'none', { names: ['first'], runs: [one.run] }],
  )
  assert.deepEqual(
    three.arms.map((arm) => [arm.passed, arm.against?.verdict, arm.against?.tasks]),
    [
      [6, 'none', 3],
      [6, 'none', 3],
    ],
  )
}

async function main(): Promise<void> {
  if (lane !== 'loop' && lane !== 'revision' && lane !== 'watch')
    throw new Error('the lane is loop, revision or watch, not ' + lane)
  Fs.rmSync(out, { force: true, recursive: true })
  Fs.mkdirSync(out, { recursive: true })
  const scripted = await endpoint()
  const env = {
    ANTHROPIC_API_KEY: 'scripted',
    ANTHROPIC_BASE_URL: scripted.url,
    NANOEVAL_CACHE: Path.join(out, 'cache'),
    NANOEVAL_STORE: Path.join(out, 'store'),
  }
  const limit = setTimeout(() => {
    console.error('the lane did not end within ' + limitMs / 1000 + ' s')
    for (const child of children) child.kill('SIGTERM')
    process.exitCode = 1
  }, limitMs)
  try {
    await (lane === 'loop' ? loop(env) : lane === 'revision' ? revision(env) : watch(env))
    console.log(
      'e2e passed: ' +
        lane +
        ', ' +
        (times.reduce((total, [, ms]) => total + ms, 0) / 1000).toFixed(1) +
        ' s in ' +
        times.length +
        ' commands',
    )
  } finally {
    clearTimeout(limit)
    for (const child of children) child.kill('SIGTERM')
    scripted.close()
  }
}

await main()
