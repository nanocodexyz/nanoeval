import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'
import { test } from 'node:test'
import { refusal } from '../cli/nanoeval.ts'
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
  assert.equal(agent.stderr, 'nanoeval: an agent is ID=HARNESS:MODEL[:THINKING], not bad\n')
  assert.equal(agent.status, 1)
  const option = run('run', '--tag', 'x')
  assert.equal(option.stderr.trim().split('\n').length, 1)
  assert.match(option.stderr, /^nanoeval: Unknown option '--tag'/)
  assert.equal(option.status, 1)
  const missing = run('status', ...there)
  assert.equal(missing.stderr, 'nanoeval: RUN is required\n')
  assert.equal(missing.status, 1)
  assert.equal(run('status').stderr, 'nanoeval: --token is required\n')
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
