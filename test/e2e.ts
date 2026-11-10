import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'
import { client, exportJob, loadTask, summary } from '../cli/nanoeval.ts'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import type * as Config from '../src/Config.ts'

const model = process.env['NANOEVAL_E2E_MODEL'] ?? 'scripted'
const backend = (process.env['NANOEVAL_E2E_BACKEND'] ??
  'docker') as Config.Config['sandbox']['backend']
const taskNames = (process.env['NANOEVAL_E2E_TASKS'] ?? 'extract-todos,uppercase-message').split(
  ',',
)
const attempts = Number(process.env['NANOEVAL_E2E_ATTEMPTS'] ?? '2')
const slots = Number(process.env['NANOEVAL_E2E_SLOTS'] ?? '4')
const limits = (process.env['NANOEVAL_E2E_LIMITS'] ?? 'enforce') as 'enforce' | 'none'
const realModel = process.env['NANOEVAL_E2E_ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5'
const scenario = process.env['NANOEVAL_E2E_SCENARIO'] ?? 'tasks'
const label =
  process.env['NANOEVAL_E2E_LABEL'] ??
  model + '-' + backend + (scenario === 'tasks' ? '' : '-' + scenario)
const out = Path.resolve('output/e2e', label)

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
  ['slow.txt', 'sleep 30; echo late > slow.txt', 'true'],
  ['greeting.txt', "printf 'hello from nanoeval\\n' > greeting.txt", 'echo hi > greeting.txt'],
]

function sse(events: [string, unknown][]): string {
  return events
    .map(([name, data]) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n')
    .join('')
}

let scriptedCalls = 0

function scripted(body: { messages?: unknown; model?: string }): string {
  const text = JSON.stringify(body.messages ?? [])
  const id = ++scriptedCalls
  const answered = text.includes('"tool_result"')
  const solution = solutions.find(([marker]) => text.includes(marker))
  if (!solution) throw new Error('the scripted model has no solution for this prompt')

  const command = body.model?.includes('sonnet') ? solution[2] : solution[1]
  const code = 'await tools.exec_command({ cmd: ' + JSON.stringify(command) + ' }); text("done")'
  const block = answered
    ? [
        { text: '', type: 'text' },
        { text: 'The task is complete.', type: 'text_delta' },
      ]
    : [
        { id: 'toolu_' + id, input: {}, name: 'exec', type: 'tool_use' },
        { partial_json: JSON.stringify({ code }), type: 'input_json_delta' },
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
        delta: { stop_reason: answered ? 'end_turn' : 'tool_use', stop_sequence: null },
        type: 'message_delta',
        usage: { output_tokens: 4 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

async function listen(handler: Http.RequestListener): Promise<{ close(): void; url: string }> {
  const server = Http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    close: () => void server.close(),
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
  }
}

async function read(request: Http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function modelEndpoint(): Promise<{ close(): void; url: string | undefined }> {
  if (model === 'scripted')
    return listen(async (request, response) => {
      try {
        const reply = scripted(JSON.parse((await read(request)).toString()))
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply)
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { message: String(error), type: 'invalid_request_error' },
            type: 'error',
          }),
        )
      }
    })

  if (!process.env['ANTHROPIC_API_KEY'])
    throw new Error('NANOEVAL_E2E_MODEL=anthropic needs ANTHROPIC_API_KEY')
  if (!process.env['HTTPS_PROXY'] && !process.env['https_proxy'])
    return { close() {}, url: undefined }

  return listen(async (request, response) => {
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers))
      if (!['accept-encoding', 'connection', 'content-length', 'host'].includes(name))
        headers.set(name, String(value))
    const upstream = await fetch('https://api.anthropic.com' + request.url, {
      body: (await read(request)) as Uint8Array<ArrayBuffer>,
      headers,
      method: request.method!,
    })
    const forwarded: Record<string, string> = {}
    for (const [name, value] of upstream.headers)
      if (!['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name))
        forwarded[name] = value
    response.writeHead(upstream.status, forwarded)
    if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
    response.end()
  })
}

async function freePort(): Promise<number> {
  const probe = await listen(() => {})
  probe.close()
  return Number(new URL(probe.url).port)
}

async function main(): Promise<void> {
  Fs.rmSync(out, { force: true, recursive: true })
  Fs.mkdirSync(out, { recursive: true })
  const token = Crypto.randomBytes(16).toString('hex')
  const sandboxToken = Crypto.randomBytes(16).toString('hex')

  const sandboxd = await Sandboxd.start({
    execTimeoutMs: 600_000,
    host: '127.0.0.1',
    port: 0,
    root: Path.join(out, 'sandboxes'),
    token: sandboxToken,
  })
  const upstream = await modelEndpoint()
  const port = await freePort()
  const url = 'http://127.0.0.1:' + port
  const vars = {
    ACCESS_TOKEN: token,
    LOCAL_SANDBOX_TOKEN: sandboxToken,
    LOCAL_SANDBOX_URL: sandboxd.url,
    TICK_MS: '500',
    ...(upstream.url ? { ANTHROPIC_BASE_URL: upstream.url } : {}),
    ...(model === 'scripted' ? { ANTHROPIC_API_KEY: 'scripted' } : {}),
  }
  const log = Fs.createWriteStream(Path.join(out, 'wrangler.log'))
  const start = async () => {
    const child = spawn(
      Path.resolve('node_modules/.bin/wrangler'),
      [
        'dev',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--persist-to',
        Path.join(out, 'state'),
        ...Object.entries(vars).flatMap(([name, value]) => ['--var', name + ':' + value]),
      ],
      {
        detached: true,
        env: {
          HOME: process.env['HOME'],
          PATH: process.env['PATH'],
          ...(model === 'scripted'
            ? {}
            : {
                ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
                CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
              }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    for (let tries = 0; ; tries++) {
      const healthy = await fetch(url + '/health').then(
        (response) => response.ok,
        () => false,
      )
      if (healthy) return child
      if (tries > 240 || child.exitCode !== null)
        throw new Error('wrangler dev did not start; see ' + Path.join(out, 'wrangler.log'))
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const stop = async (child: Awaited<ReturnType<typeof start>>, signal: NodeJS.Signals) => {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      process.kill(-child.pid!, signal)
    } catch {}
    await exited
  }
  let worker = await start()

  try {
    const unauthorized = await fetch(url + '/v1/runs', { body: '{}', method: 'POST' })
    assert.equal(unauthorized.status, 401)

    const failures = scenario === 'failures'
    if (failures && model !== 'scripted')
      throw new Error('the failures scenario runs on the scripted model')
    const directories = failures
      ? ['no-reward', 'slow-agent', ...(backend === 'docker' ? ['broken-environment'] : [])].map(
          (name) => Path.join('test/fixtures', name),
        )
      : taskNames.map((name) => Path.join('tasks', name))
    const agents: Config.Agent[] =
      failures || model !== 'scripted'
        ? [{ id: failures ? 'right' : 'nanocode', model: realModel, provider: 'claude' }]
        : [
            { id: 'right', model: 'claude-haiku-4-5', provider: 'claude' },
            { id: 'wrong', model: 'claude-sonnet-4-6', provider: 'claude' },
          ]
    const config: Config.Config = {
      agents,
      attempts: failures ? 1 : attempts,
      budget: { modelUsd: 1, sandboxUsd: 0 },
      limits: { attachSec: 60, setupSec: 600, stepRetries: 3 },
      name: 'e2e-' + label,
      sandbox: {
        backend,
        docker: 'keep',
        limits,
        max: 1,
        network: 'host',
        provider: 'local',
        slots,
        timeoutSec: 3600,
      },
      tasks: await Promise.all(directories.map((directory) => loadTask(directory))),
    }
    const api = client({ token, url })
    const started = Date.now()
    const created = await api.create(config)
    const total = directories.length * agents.length * config.attempts
    assert.equal(created.attempts, total)

    let status: Record<string, any>
    let peak = 0
    let restarted = false
    for (;;) {
      status = await api.status(created.id)
      peak = Math.max(peak, status['counts'].active)
      if (status['state'] === 'finished') break
      if (scenario === 'restart' && !restarted && status['counts'].active > 0) {
        restarted = true
        await stop(worker, 'SIGKILL')
        worker = await start()
      }
      if (Date.now() - started > 20 * 60_000)
        throw new Error('the run did not finish:\n' + summary(status))
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const wallMs = Date.now() - started
    console.log(summary(status))
    Fs.writeFileSync(Path.join(out, 'status.json'), JSON.stringify(status, null, 2) + '\n')
    const files = await api.harbor(created.id)
    await exportJob(files, Path.join(out, 'harbor'))

    assert.equal(status['sandboxes'].length, 1, 'every attempt shares one sandbox')
    assert.equal(status['sandboxes'][0].state, 'closed')
    if (backend === 'docker') {
      const left = execFileSync('docker', ['ps', '-aq', '--filter', 'label=nanoeval'])
        .toString()
        .trim()
      assert.equal(left, '', 'no slot container outlives the run')
    }
    assert.deepEqual(
      Fs.readdirSync(Path.join(out, 'sandboxes')),
      [],
      'no sandbox directory outlives the run',
    )

    if (failures) {
      const byTask = Object.fromEntries(
        (status['attempts'] as Record<string, any>[]).map((attempt) => [attempt['task'], attempt]),
      )
      assert.equal(byTask['fixtures/no-reward'].outcome, 'errored')
      assert.equal(byTask['fixtures/no-reward'].failure.kind, 'verifier')
      assert.equal(byTask['fixtures/slow-agent'].outcome, 'failed')
      assert.equal(byTask['fixtures/slow-agent'].reward, 0)
      assert.equal(byTask['fixtures/slow-agent'].failure.kind, 'agent_timeout')
      if (backend === 'docker') {
        assert.equal(byTask['fixtures/broken-environment'].outcome, 'errored')
        assert.equal(byTask['fixtures/broken-environment'].failure.kind, 'environment')
      }
      assert.equal(
        JSON.parse(files['result.json']!).stats.n_errored_trials,
        backend === 'docker' ? 2 : 1,
      )
      console.log('e2e passed: ' + label)
      return
    }

    assert.equal(status['counts'].errored, 0, 'no attempt may end in an infrastructure error')
    assert.equal(status['counts'].passed + status['counts'].failed, total)
    assert.equal(peak, Math.min(slots, total), 'the sandbox fills every slot')
    if (model === 'scripted') {
      assert.equal(status['agents'].right.passed, total / 2)
      assert.equal(status['agents'].wrong.failed, total / 2)
      assert.equal(status['agents'].right.passAtK['1'], 1)
      assert.equal(status['agents'].wrong.passAtK['1'], 0)
    } else {
      assert.ok(status['counts'].passed > 0, 'the model solves at least one task')
    }

    const phases: Record<string, number[]> = {}
    for (const attempt of status['attempts'] as { id: string }[]) {
      const detail = await api.attempt(created.id, attempt.id)
      assert.ok(detail['artifacts'].includes('agent/trajectory.json'))
      assert.ok(detail['artifacts'].includes('verifier/test-stdout.txt'))
      const trajectory = JSON.parse(
        await api.artifact(created.id, attempt.id, 'agent/trajectory.json'),
      )
      assert.equal(trajectory.schema_version, 'ATIF-v1.7')
      assert.ok(trajectory.steps.length >= 2)
      assert.ok(trajectory.final_metrics.extra.tool_calls >= 1)
      for (const [phase, span] of Object.entries(
        detail['result'].timing as Record<string, { finishedAt: number; startedAt: number }>,
      ))
        (phases[phase] ??= []).push(span.finishedAt - span.startedAt)
    }

    const job = JSON.parse(files['result.json']!)
    assert.equal(job.n_total_trials, total)
    assert.equal(job.stats.n_completed_trials, total)
    assert.equal(Object.keys(files).filter((path) => path.endsWith('/result.json')).length, total)

    const median = (values: number[]) =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
    const measured = {
      attempts: total,
      backend,
      label,
      medianPhaseMs: Object.fromEntries(
        Object.entries(phases).map(([phase, values]) => [phase, median(values)]),
      ),
      model: model === 'scripted' ? 'scripted' : realModel,
      peakConcurrentAttempts: peak,
      slots,
      spend: status['spend'],
      tasks: taskNames,
      wallMs,
    }
    Fs.writeFileSync(Path.join(out, 'summary.json'), JSON.stringify(measured, null, 2) + '\n')
    console.log(JSON.stringify(measured))
    console.log('e2e passed: ' + label)
  } finally {
    await stop(worker, 'SIGTERM')
    upstream.close()
    await sandboxd.close()
  }
}

await main()
process.exit(0)
