import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'
import { test } from 'node:test'
import { begins, commands, help, named, refusal } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'

test('a refusal is its message, and what the Worker said without the JSON around it', () => {
  assert.equal(refusal(new Error('--eval is required')), '--eval is required')
  assert.equal(
    refusal(new Error('/v1/runs answered 400: {"error":"the eval has no task typo"}')),
    'the eval has no task typo (/v1/runs answered 400)',
  )
  assert.equal(
    refusal(new Error('/v1/runs/abc answered 502: bad gateway')),
    'bad gateway (/v1/runs/abc answered 502)',
  )
  assert.equal(refusal(new Config.InvalidError('name is required')), 'name is required')
  assert.equal(refusal('text'), 'text')
})

test('an error that is no refusal keeps its stack', () => {
  const error = new TypeError('undefined is not a function')
  assert.equal(refusal(error), error.stack)
})

test('the command prints a refusal as one line and exits 1', () => {
  const cli = Path.resolve(import.meta.dirname, '../cli/nanoeval.ts')
  const run = (...words: string[]) =>
    spawnSync(process.execPath, [cli, ...words], {
      encoding: 'utf8',
      env: { HOME: process.env['HOME'], PATH: process.env['PATH'] },
    })
  const there = ['--url', 'http://127.0.0.1:9', '--token', 't']
  const agent = run('run', ...there, '--eval', 'samples', '--agent', 'bad')
  assert.equal(
    agent.stderr,
    'nanoeval: an agent is ID=HARNESS:MODEL[:THINKING][:branches=N][:refusal_fallback=return_once|session][:cell_yield_ms=N][:brief_finish=on][:fold_finish=on][:low_effort_rounds=on][:brief_final=on][:lean_cells=on], not bad\n',
  )
  assert.equal(agent.status, 1)
  const option = run('run', '--tag', 'x')
  assert.equal(option.stderr.trim().split('\n').length, 1)
  assert.match(option.stderr, /^nanoeval: Unknown option '--tag'/)
  assert.equal(option.status, 1)
  const missing = run('status', ...there)
  assert.equal(missing.stderr, 'nanoeval: RUN is required\n')
  assert.equal(missing.status, 1)
  assert.equal(
    run('status').stderr,
    'nanoeval: --url is required, or NANOEVAL_URL: the address of the Worker, which nanoeval worker prints, http://127.0.0.1:8787 unless its --port names another\n',
  )
  assert.equal(
    run('status', '--url', 'http://127.0.0.1:9').stderr,
    'nanoeval: --token is required, or NANOEVAL_TOKEN: the token the Worker was started with\n',
  )
})

test('the command says that no Worker answers, and how to have one', async () => {
  const cli = Path.resolve(import.meta.dirname, '../cli/nanoeval.ts')
  const taken = Http.createServer()
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
  const at = '127.0.0.1:' + (taken.address() as AddressInfo).port
  await new Promise((resolve) => taken.close(resolve))
  const down = spawnSync(process.execPath, [cli, 'runs', '--token', 't'], {
    encoding: 'utf8',
    env: { HOME: process.env['HOME'], NANOEVAL_URL: 'http://' + at, PATH: process.env['PATH'] },
  })
  assert.equal(
    down.stderr,
    'nanoeval: no Worker answers at http://' +
      at +
      ' (connect ECONNREFUSED ' +
      at +
      '): start one with nanoeval worker, or name another with --url or NANOEVAL_URL\n',
  )
  assert.equal(down.status, 1)
})

test('a request that got no answer names the Worker only when it is the one that did not', () => {
  const failed = (cause: string) =>
    Object.assign(new TypeError('fetch failed'), { cause: new Error(cause) })
  assert.equal(
    refusal(failed('connect ECONNREFUSED 127.0.0.1:8787'), 'http://127.0.0.1:8787/'),
    'no Worker answers at http://127.0.0.1:8787/ (connect ECONNREFUSED 127.0.0.1:8787): start one with nanoeval worker, or name another with --url or NANOEVAL_URL',
  )
  assert.equal(
    refusal(failed('getaddrinfo ENOTFOUND registry.example'), 'http://127.0.0.1:8787'),
    'a request got no answer: getaddrinfo ENOTFOUND registry.example',
  )
  assert.equal(
    refusal(failed('connect ECONNREFUSED 127.0.0.1:8787')),
    'a request got no answer: connect ECONNREFUSED 127.0.0.1:8787',
  )
  const both = Object.assign(new TypeError('fetch failed'), {
    cause: new AggregateError([
      new Error('connect ECONNREFUSED ::1:8787'),
      new Error('connect ECONNREFUSED 127.0.0.1:8787'),
    ]),
  })
  assert.equal(
    refusal(both, 'http://localhost:8787'),
    'no Worker answers at http://localhost:8787 (connect ECONNREFUSED ::1:8787, connect ECONNREFUSED 127.0.0.1:8787): start one with nanoeval worker, or name another with --url or NANOEVAL_URL',
  )
  assert.equal(
    refusal(both, 'http://127.0.0.1:9999'),
    'a request got no answer: connect ECONNREFUSED ::1:8787, connect ECONNREFUSED 127.0.0.1:8787',
  )
})

test('the command prints the usage of one command, and names a command it does not know', () => {
  const cli = Path.resolve(import.meta.dirname, '../cli/nanoeval.ts')
  const run = (...words: string[]) =>
    spawnSync(process.execPath, [cli, ...words], {
      encoding: 'utf8',
      env: { HOME: process.env['HOME'], PATH: process.env['PATH'] },
    })
  const all = run()
  assert.equal(all.status, 0)
  const usage = all.stdout.slice(0, -1)
  const known = commands(usage)
  assert.ok(known.includes('run') && known.includes('watch') && known.includes('help'))
  for (const name of known) {
    const one = help(usage, name)
    assert.ok(one?.startsWith('nanoeval ' + name + '\n\n  ' + name + ' '), name)
    assert.ok(
      one?.split('\n').some((line) => line.startsWith('            ')),
      name + ' has no description',
    )
  }
  assert.equal(help(usage, 'nope'), undefined)
  assert.equal(help(usage, undefined), usage)
  const status = run('help', 'status')
  assert.equal(status.stdout, help(usage, 'status') + '\n')
  assert.equal(run('status', '--help').stdout, status.stdout)
  assert.ok(!status.stdout.includes('\n  run '))
  assert.equal(run('help').stdout, all.stdout)
  assert.equal(run('--help').stdout, all.stdout)
  const unknown = run('frobnicate')
  assert.equal(unknown.status, 2)
  assert.equal(unknown.stdout, '')
  assert.equal(
    unknown.stderr,
    'nanoeval: no command is named frobnicate: the commands are ' +
      known.join(', ') +
      '. nanoeval help COMMAND prints one\n',
  )
  assert.equal(run('help', 'frobnicate').status, 2)
})

test('a run is named by its id, by the start of its id or by its name', () => {
  const first = '774e5979-8251-41c8-a55e-611bf330cc56'
  const second = '7f0e0d0c-0b0a-4908-8706-050403020100'
  const listed = [
    { id: first, name: 'good' },
    { id: second, name: null },
  ]
  assert.equal(named(first, []), first)
  assert.equal(named('774e5979', listed), first)
  assert.equal(named('7f', listed), second)
  assert.equal(named('good', listed), first)
  assert.throws(
    () => named('7', listed),
    new Error('7 names 2 runs, ' + first + ' and ' + second + ': name one by more of its id'),
  )
  assert.equal(begins('774e5979', listed), first)
  assert.equal(begins('774e5979-8251', listed), first)
  assert.equal(begins('774e597', listed), undefined)
  assert.equal(begins('master', listed), undefined)
  assert.equal(begins('0a9ed13f2337', listed), undefined)
  assert.throws(
    () => named('bad', listed),
    new Error(
      'no run of this Worker has an id that begins with bad, or that name: nanoeval runs lists them',
    ),
  )
})

test('the command prints what a Worker answered 404 as one line and exits 1', async () => {
  const cli = Path.resolve(import.meta.dirname, '../cli/nanoeval.ts')
  const worker = Http.createServer((request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        error: request.url!.includes('/attempts/')
          ? 'the attempt is in the claimed phase and has no agent/events.jsonl yet'
          : 'run not found',
      }),
    )
  })
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + (worker.address() as AddressInfo).port
  const run = (...words: string[]) =>
    new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [cli, ...words, '--url', url, '--token', 't'], {
        env: { HOME: process.env['HOME'], PATH: process.env['PATH'] },
      })
      const said = { stderr: '', stdout: '' }
      child.stderr.on('data', (chunk: Buffer) => (said.stderr += chunk.toString()))
      child.stdout.on('data', (chunk: Buffer) => (said.stdout += chunk.toString()))
      child.once('close', (status) => resolve({ status, ...said }))
    })
  const id = '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12)
  try {
    assert.deepEqual(await run('status', id), {
      status: 1,
      stderr: 'nanoeval: run not found (/v1/runs/' + id + ' answered 404)\n',
      stdout: '',
    })
    assert.deepEqual(await run('attempt', id, 'a00001', 'agent/events.jsonl'), {
      status: 1,
      stderr:
        'nanoeval: the attempt is in the claimed phase and has no agent/events.jsonl yet (/v1/runs/' +
        id +
        '/attempts/a00001/artifacts/agent%2Fevents.jsonl answered 404)\n',
      stdout: '',
    })
  } finally {
    worker.close()
  }
})
