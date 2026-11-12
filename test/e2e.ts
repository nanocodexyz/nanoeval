import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Import from '../cli/Import.ts'
import { blobStore, client, exportJob, oracle, summary } from '../cli/nanoeval.ts'
import * as Plan from '../cli/Plan.ts'
import * as Runtime from '../cli/Runtime.ts'
import type * as Dataset from '../datasets/Dataset.ts'
import * as Converter from '../sandbox/Converter.ts'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import * as Store from '../sandbox/Store.ts'
import * as Config from '../src/Config.ts'
import type * as Eval from '../src/Eval.ts'
import type * as Slot from '../src/Slot.ts'
import * as Guest from './Guest.ts'
import * as Krun from './Krun.ts'
import * as MockGateway from './MockGateway.ts'
import * as Network from './Network.ts'

const model = process.env['NANOEVAL_E2E_MODEL'] ?? 'scripted'
const backend = (process.env['NANOEVAL_E2E_BACKEND'] ?? 'krun') as Slot.Backend
const taskNames = (process.env['NANOEVAL_E2E_TASKS'] ?? 'extract-todos,uppercase-message').split(
  ',',
)
const attempts = Number(process.env['NANOEVAL_E2E_ATTEMPTS'] ?? '2')
const slots = Number(process.env['NANOEVAL_E2E_SLOTS'] ?? '4')
const realModel = process.env['NANOEVAL_E2E_ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5'
const codexModel = process.env['NANOEVAL_E2E_CODEX_MODEL'] ?? 'gpt-6-luna'
const thinking = process.env['NANOEVAL_E2E_THINKING']
const login = process.env['NANOEVAL_E2E_LOGIN']
const scenario = process.env['NANOEVAL_E2E_SCENARIO'] ?? 'tasks'
const restartAfterMs = Number(process.env['NANOEVAL_E2E_RESTART_AFTER_MS'] ?? '0')
const caBundle = process.env['NANOEVAL_E2E_CA_BUNDLE']
const slotForward = process.env['NANOEVAL_E2E_SLOT_FORWARD']
const network = (process.env['NANOEVAL_E2E_NETWORK'] ??
  Config.network({ backend })) as Config.Config['sandbox']['network']
const tickMs = process.env['NANOEVAL_E2E_TICK_MS'] ?? '500'
const pollMs = Number(process.env['NANOEVAL_E2E_POLL_MS'] ?? '250')
const storeKind = process.env['NANOEVAL_E2E_STORE'] ?? 'directory'
const gateway = process.env['NANOEVAL_E2E_GATEWAY'] === '1'
const leaseSec = Number(process.env['NANOEVAL_E2E_LEASE_SEC'] ?? (gateway ? '3' : '60'))
const label =
  process.env['NANOEVAL_E2E_LABEL'] ??
  model +
    '-' +
    backend +
    (scenario === 'tasks' ? '' : '-' + scenario) +
    (storeKind === 'directory' ? '' : '-' + storeKind) +
    (process.env['NANOEVAL_E2E_RUNTIME'] === '1' ? '-runtime' : '') +
    (gateway ? '-gateway' : '')
const out = Path.resolve('output/e2e', label)
const largeTestBytes = 3 * 1024 * 1024
const attached = ['lost', 'resume', 'runners'].includes(scenario)
const fleet = scenario === 'fleet'
const lapse = scenario === 'lapse'
const sandboxLeaseSec = Number(process.env['NANOEVAL_E2E_SANDBOX_LEASE_SEC'] ?? leaseSec)
const seededDisk = 'e'.repeat(64)
const installed = model === 'installed'
const fakeCli = Path.resolve('test/fixtures/fake-cli.sh')
const fakeUsage = {
  'claude-code': {
    cacheWriteTokens: 5,
    cachedTokens: 40,
    costUsd: 0.0125,
    inputTokens: 65,
    modelCalls: 1,
    outputTokens: 7,
    toolCalls: 1,
  },
  'codex-cli': {
    cacheWriteTokens: 0,
    cachedTokens: 40,
    inputTokens: 100,
    modelCalls: 1,
    outputTokens: 7,
    toolCalls: 1,
  },
}
const disk = backend !== 'dir'
const hosted = backend === 'ns' && process.getuid?.() !== 0
const guestCpus = Number(process.env['NANOEVAL_E2E_GUEST_CPUS'] ?? '8')
const guestMemoryMb = Number(process.env['NANOEVAL_E2E_GUEST_MEMORY_MB'] ?? '8192')
const bundled = process.env['NANOEVAL_E2E_RUNTIME'] === '1'
const guestNode = process.env['NANOEVAL_E2E_NODE']

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
  [
    'background.pid',
    "setsid sh -c 'echo $$ > background.pid; exec sleep 300.5' >/dev/null 2>&1 & while [ ! -s background.pid ]; do sleep 0.1; done",
    'true',
  ],
  ['hog.txt', "x=$(head -c 400000000 /dev/zero | tr '\\0' x); echo ${#x} > hog.txt", 'true'],
  ['large.bin', 'true', 'true'],
  ['slow.txt', 'sleep 30; echo late > slow.txt', 'true'],
  ['greeting.txt', "printf 'hello from nanoeval\\n' > greeting.txt", 'echo hi > greeting.txt'],
  ['port.token', 'sh start.sh', 'true'],
  ['network.checks', 'sh check.sh', 'true'],
  ['cached.txt', 'echo ready > cached.txt', 'true'],
]

function sse(events: [string, unknown][]): string {
  return events
    .map(([name, data]) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n')
    .join('')
}

let scriptedCalls = 0

function fake(
  path: string,
  body: { model?: string; prompt_base64?: string },
  cost?: number,
): string {
  const codex = path === '/v1/responses'
  const charged = cost === undefined ? {} : { cost }
  const prompt = Buffer.from(body.prompt_base64 ?? '', 'base64').toString()
  const solution = solutions.find(([marker]) => prompt.includes(marker))
  if (!solution) throw new Error('the scripted model has no solution for this prompt')
  const command = Buffer.from(body.model?.includes('sonnet') ? solution[2] : solution[1]).toString(
    'base64',
  )
  return (
    ': command ' +
    command +
    '\n\n' +
    sse(
      codex
        ? [
            [
              'response.completed',
              {
                response: {
                  model: body.model,
                  usage: {
                    ...charged,
                    input_tokens: 100,
                    input_tokens_details: { cached_tokens: 40 },
                    output_tokens: 7,
                  },
                },
                type: 'response.completed',
              },
            ],
          ]
        : [
            [
              'message_start',
              {
                message: {
                  model: body.model,
                  usage: {
                    cache_creation_input_tokens: 5,
                    cache_read_input_tokens: 40,
                    input_tokens: 20,
                    output_tokens: 0,
                  },
                },
                type: 'message_start',
              },
            ],
            ['message_delta', { type: 'message_delta', usage: { ...charged, output_tokens: 7 } }],
          ],
    )
  )
}

function responses(body: { input?: unknown; model?: string }, cost: number): string {
  const text = JSON.stringify(body.input ?? [])
  const id = ++scriptedCalls
  const solution = solutions.find(([marker]) => text.includes(marker))
  if (!solution) throw new Error('the scripted model has no solution for this prompt')
  const code =
    'await tools.exec_command({ cmd: ' + JSON.stringify(solution[1]) + ' }); text("done")'
  const item = text.includes('"custom_tool_call_output"')
    ? {
        content: [{ annotations: [], text: 'The task is complete.', type: 'output_text' }],
        id: 'msg_' + id,
        role: 'assistant',
        status: 'completed',
        type: 'message',
      }
    : {
        call_id: 'call_' + id,
        id: 'ctc_' + id,
        input: code,
        name: 'exec',
        status: 'completed',
        type: 'custom_tool_call',
      }
  const response = {
    created_at: 0,
    id: 'resp_' + id,
    model: body.model,
    object: 'response',
    output: [item],
    status: 'completed',
    usage: {
      cost,
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 107,
    },
  }
  return sse([
    [
      'response.created',
      {
        response: { ...response, output: [], status: 'in_progress', usage: null },
        type: 'response.created',
      },
    ],
    ['response.output_item.done', { item, output_index: 0, type: 'response.output_item.done' }],
    ['response.completed', { response, type: 'response.completed' }],
  ])
}

function scripted(body: { messages?: unknown; model?: string }, cost?: number): string {
  const text = JSON.stringify(body.messages ?? [])
  const id = ++scriptedCalls
  const reply = text.includes('JUDGE-FIXTURE')
    ? text.includes('answer: nanoeval')
      ? 'PASS'
      : 'FAIL'
    : text.includes('FINAL-ANSWER-FIXTURE')
      ? body.model?.includes('sonnet')
        ? 'wrong'
        : 'nanoeval'
      : undefined
  const answered = reply !== undefined || text.includes('"tool_result"')
  const solution = solutions.find(([marker]) => text.includes(marker))
  if (!solution && reply === undefined)
    throw new Error('the scripted model has no solution for this prompt')

  const command = body.model?.includes('sonnet') ? solution?.[2] : solution?.[1]
  const code = 'await tools.exec_command({ cmd: ' + JSON.stringify(command) + ' }); text("done")'
  const block = answered
    ? [
        { text: '', type: 'text' },
        { text: reply ?? 'The task is complete.', type: 'text_delta' },
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
        usage: { ...(cost === undefined ? {} : { cost }), output_tokens: 4 },
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
  if (model === 'scripted' || installed || scenario === 'judge')
    return listen(async (request, response) => {
      try {
        const body = JSON.parse((await read(request)).toString())
        const codex = request.url === '/v1/responses'
        const credential = !body.fake_cli
          ? true
          : codex
            ? request.headers['authorization'] === 'Bearer scripted-openai' &&
              request.headers['x-api-key'] === undefined
            : request.headers['x-api-key'] === 'scripted' &&
              request.headers['authorization'] === undefined
        if (!credential || (body.fake_cli && !codex && request.url !== '/v1/messages'))
          throw new Error(
            'the request of the installed agent did not carry the credential of the run',
          )
        const reply = body.fake_cli ? fake(request.url!, body) : scripted(body)
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

  if (model === 'oracle' || model === 'claude-plan' || model === 'codex-plan')
    return { close() {}, url: undefined }
  if (model !== 'anthropic')
    throw new Error(
      'NANOEVAL_E2E_MODEL is scripted, installed, oracle, anthropic, claude-plan or codex-plan',
    )
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
  const missing =
    backend === 'krun'
      ? Krun.missing(network === 'private' ? 'private' : 'host')
      : hosted
        ? Guest.missing()
        : undefined
  if (missing) {
    console.log('e2e skipped: ' + label + ' needs ' + missing)
    return
  }
  if (hosted && (attached || ['disk', 'disks'].includes(scenario)))
    throw new Error('the ' + scenario + ' scenario of ns slots runs on a machine with root')
  Fs.rmSync(out, { force: true, recursive: true })
  Fs.mkdirSync(out, { recursive: true })
  const token = Crypto.randomBytes(16).toString('hex')
  const sandboxToken = Crypto.randomBytes(16).toString('hex')
  const cache = Path.join(out, 'cache')
  const storeRoot = Path.join(out, 'store')

  const port = await freePort()
  const beacon = await listen((_, response) => void response.end('the host\n'))
  Fs.writeFileSync(
    Path.join(out, 'slot.env'),
    'NANOEVAL_E2E_LABEL=' +
      label +
      '\nNANOEVAL_E2E_HOST_PORT=' +
      new URL(beacon.url).port +
      '\nNANOEVAL_E2E_SESSION_PORT=' +
      port +
      '\n',
  )
  const forward = slotForward ?? (scenario === 'closed' ? new URL(beacon.url).host : undefined)
  if (installed)
    Object.assign(process.env, {
      NANOEVAL_AGENT_CLAUDE_CODE: fakeCli,
      NANOEVAL_AGENT_CODEX_CLI: fakeCli,
    })
  const guest = hosted
    ? await Guest.start({
        cpus: guestCpus,
        forwards: ['127.0.0.1:' + port, '127.0.0.1:' + new URL(beacon.url).port],
        home: Path.join(out, 'guest'),
        memoryMb: guestMemoryMb,
        ...(bundled && guestNode ? { node: guestNode } : {}),
      })
    : undefined
  const seen = (file: string) => (guest ? Guest.inside(file) : file)
  if (caBundle && guest) Fs.copyFileSync(caBundle, Path.join(out, 'ca.pem'))
  const hostPolicy = {
    ...(installed
      ? { NANOEVAL_AGENT_CLAUDE_CODE: seen(fakeCli), NANOEVAL_AGENT_CODEX_CLI: seen(fakeCli) }
      : {}),
    NANOEVAL_SLOT_ENV: seen(Path.join(out, 'slot.env')),
    ...(caBundle
      ? { NANOEVAL_CA_BUNDLE: guest ? seen(Path.join(out, 'ca.pem')) : Path.resolve(caBundle) }
      : {}),
    ...(forward ? { NANOEVAL_SLOT_FORWARD: forward } : {}),
  }
  const sandboxes = guest ? Guest.root + '/sandboxes' : Path.join(out, 'sandboxes')
  const there = async (command: string): Promise<string> =>
    guest
      ? (await guest.machine.exec(command, { cwd: '/', env: {}, timeoutMs: 60_000 })).stdout
      : spawnSync('bash', ['-c', command]).stdout.toString()
  const sandboxd = await Sandboxd.start({
    env: {
      ...hostPolicy,
      ...guest?.variables,
      NANOEVAL_CACHE: guest ? Guest.root + '/cache' : cache,
      NANOEVAL_STORE: seen(storeRoot),
    },
    execTimeoutMs: 600_000,
    host: '127.0.0.1',
    ...(guest ? { machine: guest.machine } : {}),
    port: 0,
    root: sandboxes,
    token: sandboxToken,
  })
  const mock = gateway
    ? await MockGateway.start({
        key: 'sk-tempo-' + Crypto.randomBytes(16).toString('hex'),
        model: (path, body, cost) =>
          body['fake_cli']
            ? fake(path, body, cost)
            : path === '/v1/responses'
              ? responses(body, cost)
              : scripted(body, cost),
        ...(lapse ? { renewals: false } : {}),
        sandboxd: { token: sandboxToken, url: sandboxd.url },
      })
    : undefined
  const upstream = mock ?? (await modelEndpoint())
  const plan =
    model === 'codex-plan'
      ? await Plan.codex(login ?? Path.join(Os.homedir(), '.codex', 'auth.json'))
      : model === 'claude-plan'
        ? await Plan.claude(login ?? Path.join(Os.homedir(), '.claude', '.credentials.json'))
        : undefined
  if (plan?.expiresAt !== undefined && plan.expiresAt <= Date.now())
    throw new Error('the plan login expired at ' + new Date(plan.expiresAt).toISOString())
  const relay = model === 'codex-plan' ? await Plan.relay() : undefined
  const url = 'http://127.0.0.1:' + port
  const vars: Record<string, string> = {
    ACCESS_TOKEN: token,
    LOCAL_SANDBOX_TOKEN: sandboxToken,
    LOCAL_SANDBOX_URL: sandboxd.url,
    TICK_MS: tickMs,
    ...(mock ? { TEMPO_GATEWAY_URL: mock.url, TEMPO_KEY: mock.key } : {}),
    ...(upstream.url && !mock ? { ANTHROPIC_BASE_URL: upstream.url } : {}),
    ...((model === 'scripted' || installed || scenario === 'judge') && !mock
      ? { ANTHROPIC_API_KEY: 'scripted' }
      : {}),
    ...(installed && upstream.url && !mock
      ? { OPENAI_API_KEY: 'scripted-openai', OPENAI_BASE_URL: upstream.url }
      : {}),
    ...(model === 'anthropic' ? { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY']! } : {}),
    ...plan?.vars,
    ...relay?.vars,
  }
  const secrets = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-e2e-'))
  Fs.writeFileSync(Path.join(secrets, 'vars.env'), Plan.envFile(vars), { mode: 0o600 })
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
        '--env-file',
        Path.join(secrets, 'vars.env'),
      ],
      {
        detached: true,
        env: { HOME: process.env['HOME'], PATH: process.env['PATH'] },
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

  const runners: { child: ChildProcess; home: string; name: string }[] = []
  const attach = (run: string, name: string) => {
    const home = Path.join(out, 'runner-' + name)
    Fs.mkdirSync(home, { recursive: true })
    const output = Fs.openSync(Path.join(out, 'runner-' + name + '.log'), 'a')
    const child = spawn(
      process.execPath,
      [
        Path.resolve('cli/nanoeval.ts'),
        'runner',
        '--url',
        url,
        '--run',
        run,
        '--home',
        home,
        '--cache',
        Path.join(out, 'cache-' + name),
        '--store',
        storeRoot,
        '--slots',
        String(slots),
        '--slot-env',
        Path.join(out, 'slot.env'),
        ...(caBundle ? ['--ca-bundle', Path.resolve(caBundle)] : []),
        ...(forward ? ['--slot-forward', forward] : []),
      ],
      { env: { ...process.env, NANOEVAL_TOKEN: token }, stdio: ['ignore', output, output] },
    )
    Fs.closeSync(output)
    const entry = { child, home, name }
    runners.push(entry)
    return entry
  }
  const runnerId = (home: string | undefined): number | undefined => {
    try {
      return (
        JSON.parse(Fs.readFileSync(Path.join(home ?? '', 'runner.json'), 'utf8')) as Config.Runner
      ).runner
    } catch {
      return undefined
    }
  }
  const destroy = (home: string) =>
    spawnSync('bash', [Path.resolve('sandbox/slot.sh'), 'destroy'], {
      env: { ...process.env, NANOEVAL_HOME: home },
    })

  try {
    const unauthorized = await fetch(url + '/v1/runs', { body: '{}', method: 'POST' })
    assert.equal(unauthorized.status, 401)

    const failures = scenario === 'failures'
    const cached = scenario === 'cache'
    const closed = scenario === 'closed'
    const isolated = scenario === 'network'
    const judged = scenario === 'judge'
    if (
      scenario !== 'tasks' &&
      model !== 'scripted' &&
      !(judged && model === 'oracle') &&
      !(installed && ['closed', 'failures', 'lost', 'resume', 'runners'].includes(scenario))
    )
      throw new Error('the ' + scenario + ' scenario runs on the scripted model')
    if (isolated) {
      if (backend === 'dir') throw new Error('the network scenario runs on krun or ns slots')
      await Network.isolation({
        backend,
        hostPort: Number(new URL(beacon.url).port),
        network,
        sandboxd: { token: sandboxToken, url: sandboxd.url },
        ...(guest ? { stage: { directory: out, seen } } : {}),
      })
    }
    const packing = scenario === 'packing'
    const lost = 'tasks/write-greeting'
    const directories = judged
      ? ['final-answer', 'judged-answer'].map((name) => Path.join('test/fixtures', name))
      : packing
        ? ['extract-todos', 'uppercase-message', 'write-greeting'].map((name) =>
            Path.join('tasks', name),
          )
        : failures
          ? [
              ...[
                'large-tests',
                'no-reward',
                'slow-agent',
                'unreported-tests',
                ...(backend === 'dir' ? [] : ['background-process', 'memory-limit', 'plain-user']),
              ].map((name) => Path.join('test/fixtures', name)),
              lost,
            ]
          : isolated
            ? [Network.fixture]
            : closed
              ? ['closed-agent', 'closed-network', 'closed-verifier'].map((name) =>
                  Path.join('test/fixtures', name),
                )
              : cached
                ? [Path.join('test/fixtures', 'cached-verifier')]
                : taskNames.map((name) => Path.join('tasks', name))
    const agents: Config.Agent[] =
      model === 'oracle'
        ? [oracle]
        : installed
          ? [
              { id: 'right', model: 'gpt-right', provider: 'codex-cli' as const },
              ...(closed || failures
                ? []
                : [
                    {
                      id: 'wrong',
                      model: 'claude-sonnet-wrong',
                      provider: 'claude-code' as const,
                      thinking: 'high',
                    },
                  ]),
            ]
          : model === 'codex-plan'
            ? [
                {
                  id: 'nanocode',
                  model: codexModel,
                  provider: 'codex',
                  ...(thinking ? { thinking } : {}),
                },
              ]
            : cached || closed || failures || isolated || packing || model !== 'scripted'
              ? [
                  {
                    id: cached || closed || failures || isolated || packing ? 'right' : 'nanocode',
                    model: realModel,
                    provider: 'claude',
                  },
                ]
              : [
                  gateway
                    ? { id: 'right', model: 'gpt-right', provider: 'codex' }
                    : { id: 'right', model: 'claude-haiku-4-5', provider: 'claude' },
                  { id: 'wrong', model: 'claude-sonnet-4-6', provider: 'claude' },
                ]

    const api = client({ token, url })
    const store = blobStore(storeKind === 'r2' ? 'r2' : storeRoot, { token, url })
    const options: Import.Options = {
      cache,
      converter: Converter.create({
        home: Path.join(cache, 'converter'),
        layers: Converter.defaultLayers(cache),
      }),
      format: disk ? 'disk' : 'dir',
      store,
    }
    async function* cases(): AsyncIterable<Dataset.Case> {
      for (const directory of directories) {
        const item = await Import.readDirectory(directory)
        if (directory.endsWith('large-tests'))
          item.files['tests/large.bin'] = Buffer.alloc(largeTestBytes)
        yield item
      }
    }
    const importStarted = Date.now()
    const imported = await Import.cases(cases(), options)
    const importMs = Date.now() - importStarted
    if (packing) for (const task of imported.tasks.slice(0, 2)) task.resources.memoryMb = 512
    const evalName = 'e2e-' + label.replace(/[^a-z0-9.-]/g, '-')
    const { version } = await api.putVersion(evalName, {
      ...Import.local,
      tasks: imported.tasks,
    })
    assert.equal(version.tasks, directories.length)
    assert.equal((await api.evals()).evals[0]!.digest, version.digest)
    assert.deepEqual(
      (await api.eval(evalName + '@' + version.digest.slice(0, 12))).entries.map(
        (entry) => entry.id,
      ),
      directories.map((directory) => Path.basename(directory)).sort(),
    )
    if (disk && scenario === 'tasks') {
      await assert.rejects(
        Import.cases(
          Import.directories([Path.join('test/fixtures', 'broken-environment')]),
          options,
        ),
        /converter failed at build/,
        'an environment that does not build is refused when it is imported',
      )
      const again = await Import.cases(cases(), options)
      assert.ok(
        again.timings.every((timing) => timing.reused),
        'importing again converts nothing',
      )
    }

    const blobOf = (task: Eval.Task) =>
      task.environment.kind === 'disk' ? task.environment.disk : task.environment.files
    const blobFile = (blob: Eval.Blob) =>
      Path.join(storeRoot, 'sha256', blob.digest.slice(0, 2), blob.digest)
    if (failures) {
      const task = imported.tasks.find((candidate) => candidate.id === Path.basename(lost))!
      Fs.rmSync(blobFile(blobOf(task)))
    }
    let kept: string | undefined
    if (scenario === 'disks') {
      const task = imported.tasks[1]!
      assert.equal(task.environment.kind, 'disk')
      kept = Path.join(cache, 'disks', blobOf(task).digest + '.ext4')
      Fs.mkdirSync(Path.join(cache, 'blobs'), { recursive: true })
      Fs.mkdirSync(Path.join(cache, 'disks'), { recursive: true })
      await options.converter.unpack(
        await Store.ensure([store], { blob: blobOf(task), cache }),
        kept,
      )
      Fs.rmSync(Path.join(cache, 'blobs', blobOf(task).digest))
    }

    const config: Config.Config = {
      agents,
      attempts: cached || closed || failures || packing ? 1 : isolated ? slots : attempts,
      budget: { modelUsd: 1, sandboxUsd: gateway ? 1 : 0 },
      eval: { name: evalName, version: version.digest },
      ...(judged ? { judge: { model: 'claude-haiku-4-5', provider: 'claude' as const } } : {}),
      limits: {
        attachSec: 60,
        claims: 3,
        leaseSec,
        setupSec: scenario === 'disk' ? 5 : 600,
        stepRetries: failures ? 1 : 3,
      },
      name: 'e2e-' + label,
      sandbox: {
        backend,
        disks: scenario === 'disks' || scenario === 'disk' ? 'remove' : 'keep',
        ...(scenario === 'disk' ? { freeDiskMb: 2 ** 40 } : {}),
        ...(gateway ? { leaseSec: sandboxLeaseSec } : {}),
        max: attached ? 0 : fleet ? 2 : 1,
        ...(packing ? { memoryMb: 768 } : {}),
        network,
        pollMs,
        provider: gateway ? 'gateway' : 'local',
        ...(bundled
          ? {
              runtime: await Runtime.publish(blobStore('r2', { token, url }), {
                cache,
                out: Path.join(out, 'runtime.tgz'),
              }),
            }
          : {}),
        slots,
        timeoutSec: 3600,
        ...(cached ? { verifierCache: true as const } : {}),
      },
    }
    if (closed && !(backend === 'krun' && network === 'private')) {
      await assert.rejects(
        api.create(config),
        /closes the network of its agent, which only krun slots on a private network enforce/,
      )
      console.log('e2e passed: ' + label)
      return
    }
    const started = Date.now()
    const created = await api.create(config)
    const total = directories.length * agents.length * config.attempts
    assert.equal(created.attempts, total)
    const disks = (guest ? Guest.root + '/cache' : cache) + '/disks'
    if (scenario === 'disk')
      await there(
        'mkdir -p ' +
          disks +
          ' && cd ' +
          disks +
          ' && touch ' +
          seededDisk +
          '.ext4 ' +
          seededDisk +
          '.run-' +
          created.id +
          ' other.ext4 other.run-other',
      )
    if ((fleet || lapse) && !mock)
      throw new Error('the ' + scenario + ' scenario runs through the scripted gateway')
    assert.deepEqual(created.eval, { name: evalName, version: version.digest })
    if (attached) {
      attach(created.id, 'a')
      if (scenario !== 'resume') attach(created.id, 'b')
    }

    const machines = () => [
      ...Krun.machines(sandboxes),
      ...runners.flatMap((runner) => Krun.machines(Path.dirname(runner.home))),
    ]
    const sizes = new Set<string>()
    const sized = new Set(
      imported.tasks.map((task) => Math.ceil(task.resources.cpus) + ' ' + task.resources.memoryMb),
    )
    let status: Record<string, any>
    let restarted = false
    let forgotten = 0
    let activeAt: number | undefined
    for (;;) {
      status = await api.status(created.id)
      if (status['state'] === 'finished') break
      if (status['counts'].active > 0) activeAt ??= Date.now()
      if (backend === 'krun')
        for (const size of [
          ...Krun.sizes(sandboxes),
          ...runners.flatMap((runner) => Krun.sizes(Path.dirname(runner.home))),
        ])
          sizes.add(size)
      const holding =
        scenario === 'restart' ||
        (status['attempts'] as { phase: string; runner: number | null }[]).some(
          (attempt) =>
            attempt.runner !== null &&
            attempt.runner === runnerId(runners[0]?.home) &&
            !['claimed', 'done', 'unclaimed'].includes(attempt.phase),
        )
      if (
        ['lost', 'restart', 'resume'].includes(scenario) &&
        !restarted &&
        holding &&
        Date.now() - (activeAt ?? Infinity) >= restartAfterMs
      ) {
        restarted = true
        if (scenario === 'restart') {
          await stop(worker, 'SIGKILL')
          worker = await start()
        } else {
          const runner = runners[0]!
          const exited = new Promise((resolve) => runner.child.once('exit', resolve))
          runner.child.kill('SIGKILL')
          await exited
          if (scenario === 'resume') {
            const held = (
              (await api.status(created.id))['attempts'] as { id: string; phase: string }[]
            ).filter((attempt) => !['done', 'unclaimed'].includes(attempt.phase))
            const slot = Fs.readdirSync(Path.join(runner.home, 'slots')).find((name) =>
              held.some((attempt) => name.includes('-' + attempt.id + '-')),
            )
            if (slot) {
              Fs.rmSync(Path.join(runner.home, 'slots', slot, 'row.json'), { force: true })
              forgotten = 1
            }
            runners.shift()
            const output = Fs.openSync(Path.join(out, 'runner-' + runner.name + '.log'), 'a')
            const resumed = spawn(process.execPath, runner.child.spawnargs.slice(1), {
              env: { ...process.env, NANOEVAL_TOKEN: token },
              stdio: ['ignore', output, output],
            })
            Fs.closeSync(output)
            runners.push({ ...runner, child: resumed })
          }
        }
      }
      if (fleet && !restarted) {
        const first = (status['sandboxes'] as { runner: number; state: string }[]).find(
          (sandbox) => sandbox.state === 'ready',
        )
        const busy = (status['attempts'] as { phase: string; runner: number | null }[]).some(
          (attempt) =>
            first !== undefined &&
            attempt.runner === first.runner &&
            !['claimed', 'done', 'unclaimed'].includes(attempt.phase),
        )
        if (busy) {
          restarted = true
          await mock!.die([...mock!.sandboxes.keys()][0]!)
        }
      }
      if (Date.now() - started > 20 * 60_000)
        throw new Error('the run did not finish:\n' + summary(status))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (['fleet', 'lost', 'restart', 'resume'].includes(scenario))
      assert.ok(restarted, 'the ' + scenario + ' happened during the run')
    const wallMs = Date.now() - started
    console.log(summary(status))
    Fs.writeFileSync(Path.join(out, 'status.json'), JSON.stringify(status, null, 2) + '\n')
    const { files } = await exportJob(api, { out: Path.join(out, 'harbor'), run: created.id })
    const details: Record<string, any>[] = []
    for (const attempt of status['attempts'] as { id: string }[])
      details.push(await api.attempt(created.id, attempt.id))
    const edges = details
      .filter((detail) => detail['result'].sandbox !== null)
      .flatMap((detail) => [
        [detail['result'].startedAt as number, 1],
        [detail['result'].finishedAt as number, -1],
      ])
      .sort((left, right) => left[0]! - right[0]! || left[1]! - right[1]!)
    let peak = 0
    for (let index = 0, running = 0; index < edges.length; index++) {
      running += edges[index]![1]!
      peak = Math.max(peak, running)
    }

    assert.deepEqual(status['eval'], { name: evalName, version: version.digest })
    if (attached) {
      for (const runner of runners) {
        if (runner.child.exitCode === null && runner.child.signalCode === null)
          await new Promise((resolve) => runner.child.once('exit', resolve))
      }
      if (scenario === 'lost') destroy(runners[0]!.home)
      assert.equal(status['sandboxes'].length, 0, 'attached runners need no sandbox')
      const finishedBy = new Set(
        (status['attempts'] as { runner: number }[]).map((attempt) => attempt.runner),
      )
      if (scenario === 'runners')
        assert.equal(finishedBy.size, 2, 'both runners finished rows of the run')
      if (scenario === 'lost') {
        assert.ok(status['lostClaims'] >= 1, 'the lease of the killed runner expired')
        assert.ok(
          (status['attempts'] as { claims: number }[]).some((attempt) => attempt.claims === 2),
          'a row of the killed runner was claimed again',
        )
        const survivor = { id: runnerId(runners[1]!.home) }
        assert.equal(
          (await api.status(created.id))['runners'].find(
            (runner: { id: number }) => runner.id === survivor.id,
          ).state,
          'left',
          'the other runner finished the run and left',
        )
        for (const attempt of status['attempts'] as {
          claims: number
          id: string
          runner: number
        }[])
          if (attempt.claims === 2) {
            assert.equal(attempt.runner, survivor.id)
            const detail = await api.attempt(created.id, attempt.id)
            assert.deepEqual(
              detail['claims'].map((claim: { ending: string }) => claim.ending),
              ['expired', 'finished'],
            )
          }
      }
      if (scenario === 'resume') {
        assert.equal(
          status['lostClaims'],
          forgotten,
          'a runner that comes back keeps the rows it saved and gives back the one it did not',
        )
        assert.ok(wallMs < leaseSec * 1000, 'no row waited for its lease to end')
        for (const attempt of status['attempts'] as { claims: number; id: string }[])
          if (attempt.claims === 2)
            assert.deepEqual(
              (await api.attempt(created.id, attempt.id))['claims'].map(
                (claim: { ending: string }) => claim.ending,
              ),
              ['released', 'finished'],
            )
      }
    } else if (lapse) {
      const rows = (status['sandboxes'] as { error: string | null; state: string }[]).slice(1)
      assert.ok(rows.length >= 2, 'a sandbox whose lease ended was replaced by another')
      for (const row of rows) assert.equal(row.state, 'closed')
      for (const row of rows.slice(0, -1))
        assert.match(
          row.error!,
          /the gateway answered 502 to an unpaid renew instead of its price: /,
          'a sandbox that is sold no renewal says so, and is used until its lease ends',
        )
    } else if (fleet) {
      const rows = status['sandboxes'] as { error: string | null; state: string }[]
      assert.match(rows[0]!.error!, /the gateway refused create with 503: /)
      assert.equal(rows[1]!.state, 'failed', 'the sandbox that died is failed, not waited for')
      assert.match(rows[1]!.error!, /the runner stopped answering|refused renew with 404: /)
      assert.ok(rows.length >= 3, 'another sandbox worked the run')
      for (const row of rows.slice(2)) assert.equal(row.state, 'closed')
      assert.ok(status['lostClaims'] >= 1, 'the rows of the sandbox that died lost their claims')
      const again = (status['attempts'] as { claims: number; runner: number }[]).filter(
        (attempt) => attempt.claims === 2,
      )
      assert.ok(again.length >= 1, 'a row of the sandbox that died was claimed again')
      const dead = (status['sandboxes'] as { runner: number }[])[1]!.runner
      for (const attempt of again)
        assert.notEqual(attempt.runner, dead, 'a row that was claimed again ends on another runner')
    } else {
      const opened = (status['sandboxes'] as { state: string }[]).filter(
        (sandbox) => sandbox.state !== 'failed',
      )
      assert.equal(opened.length, 1, 'every attempt shares one sandbox')
      assert.equal(status['sandboxes'].length, gateway ? 2 : 1)
      const sandbox = status['sandboxes'].at(-1)
      assert.equal(sandbox.state, 'closed')
      assert.equal(sandbox.capabilities.ca_bundle, caBundle !== undefined)
      assert.equal(sandbox.capabilities.slot_env, true)
      assert.equal(sandbox.capabilities.slot_forward, forward !== undefined)
      assert.equal(sandbox.capabilities.network, network)
    }
    if (backend === 'krun') {
      assert.deepEqual(Network.relays(sandboxes), [], 'no relay outlives the run')
      for (const runner of runners)
        assert.deepEqual(
          Network.relays(Path.dirname(runner.home)),
          [],
          'no relay outlives a runner',
        )
      assert.deepEqual(machines(), [], 'no microVM outlives the run')
      if (scenario !== 'restart' && scenario !== 'disk') {
        assert.ok(sizes.size > 0, 'microVMs were seen while the run was active')
        for (const size of sizes)
          assert.ok(sized.has(size), 'a microVM ran with ' + size + ' vCPUs and MiB')
      }
    }
    if (backend === 'ns')
      assert.equal(
        (
          await there(
            "ps -eo args= | grep -F '" +
              sandboxes +
              "/' | grep -E '^(unshare|[^ ]*nanoeval-net host) ' || true",
          )
        ).trim(),
        '',
        'no slot and no relay outlives the run',
      )
    assert.deepEqual(
      (await there('ls -A ' + sandboxes)).split('\n').filter(Boolean),
      [],
      'no sandbox directory outlives the run',
    )

    if (failures) {
      const byTask = Object.fromEntries(
        (status['attempts'] as Record<string, any>[]).map((attempt) => [attempt['task'], attempt]),
      )
      assert.equal(byTask['fixtures/large-tests'].outcome, 'passed')
      assert.equal(byTask['fixtures/no-reward'].outcome, 'errored')
      assert.equal(byTask['fixtures/no-reward'].failure.kind, 'verifier')
      assert.equal(byTask['fixtures/slow-agent'].outcome, 'failed')
      assert.equal(byTask['fixtures/slow-agent'].reward, 0)
      assert.equal(byTask['fixtures/slow-agent'].failure.kind, 'agent_timeout')
      assert.equal(byTask['fixtures/unreported-tests'].outcome, 'errored')
      assert.equal(byTask['fixtures/unreported-tests'].failure.kind, 'verifier')
      assert.match(byTask['fixtures/unreported-tests'].failure.message, /its tests did not run/)
      assert.equal(byTask['nanoeval/write-greeting'].outcome, 'errored')
      assert.equal(byTask['nanoeval/write-greeting'].failure.kind, 'environment')
      assert.match(byTask['nanoeval/write-greeting'].failure.message, /no store holds the blob/)
      if (backend !== 'dir') {
        assert.equal(byTask['fixtures/background-process'].outcome, 'passed')
        assert.equal(byTask['fixtures/memory-limit'].outcome, 'failed')
        assert.ok(
          byTask['fixtures/memory-limit'].oomKills >= 1,
          'the memory limit of the task ended a process of the attempt',
        )
        assert.equal(byTask['fixtures/background-process'].oomKills, undefined)
        const plain = byTask['fixtures/plain-user']
        assert.equal(plain.outcome, 'passed', JSON.stringify(plain.failure))
        assert.deepEqual(
          (await api.attempt(created.id, plain.id))['artifacts'].filter((name: string) =>
            name.startsWith('verifier/'),
          ),
          [
            'verifier/ctrf.json',
            'verifier/extra/data.bin',
            'verifier/reward.txt',
            'verifier/test-stdout.txt',
          ],
        )
        assert.deepEqual(
          [
            ...Fs.readFileSync(
              Path.join(out, 'harbor', 'plain-user__right__1', 'verifier', 'extra', 'data.bin'),
            ),
          ],
          [0xff, 0x00, 0xfe],
        )
      }
      assert.equal(status['counts'].errored, 3)
      assert.equal(
        JSON.parse(files['result.json']!).stats.n_errored_trials,
        4,
        'Harbor counts every trial with an exception, the agent timeout included',
      )

      const rerun = await api.create({
        ...config,
        name: config.name + '-rerun',
        rerun: { run: created.id, select: 'errored' },
      })
      assert.equal(rerun.attempts, 3)
      let again: Record<string, any>
      for (;;) {
        again = await api.status(rerun.id)
        if (again['state'] === 'finished') break
        if (Date.now() - started > 20 * 60_000)
          throw new Error('the rerun did not finish:\n' + summary(again))
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      console.log(summary(again))
      assert.deepEqual(again['rerunOf'], { run: created.id, select: 'errored' })
      assert.deepEqual((await api.status(created.id))['reruns'], [rerun.id])
      const erroredBefore = (status['attempts'] as Record<string, any>[]).filter(
        (attempt) => attempt['outcome'] === 'errored',
      )
      assert.deepEqual(
        (again['attempts'] as Record<string, any>[]).map((attempt) => [
          attempt['task'],
          attempt['outcome'],
          attempt['retryOf'],
        ]),
        erroredBefore.map((attempt) => [
          attempt['task'],
          'errored',
          { attempt: attempt['id'], run: created.id },
        ]),
      )
      const retried = await api.attempt(rerun.id, again['attempts'][0].id)
      assert.deepEqual(retried['result'].retryOf, {
        attempt: erroredBefore[0]!['id'],
        run: created.id,
      })
      const refused = await fetch(url + '/v1/runs', {
        body: JSON.stringify({
          ...config,
          name: 'nothing',
          rerun: { run: rerun.id, select: 'failed' },
        }),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        method: 'POST',
      })
      assert.equal(refused.status, 400)
      assert.match(await refused.text(), /no failed attempt to rerun/)
      console.log('e2e passed: ' + label)
      return
    }

    if (packing) {
      const started: Record<string, number> = {}
      for (const detail of details) {
        assert.equal(detail['attempt'].outcome, 'passed')
        started[detail['attempt'].task] = detail['result'].startedAt
      }
      assert.equal(peak, 2, 'two attempts fit the memory of the sandbox at once')
      assert.ok(
        started['nanoeval/write-greeting']! < started['nanoeval/uppercase-message']!,
        'a small attempt starts while a larger one ahead of it waits for memory',
      )
      console.log('e2e passed: ' + label)
      return
    }

    if (scenario === 'disk') {
      for (const attempt of status['attempts'] as Record<string, any>[]) {
        assert.equal(attempt['outcome'], 'errored')
        assert.equal(attempt['failure'].kind, 'environment')
        assert.match(attempt['failure'].message, /MB of free disk with no attempt running/)
      }
      assert.deepEqual(
        (await there('ls ' + disks)).split('\n').filter(Boolean).sort(),
        ['other.ext4', 'other.run-other'],
        'a runner short of disk removes a disk of its run that no row of it uses, and no other',
      )
      await there('rm -f ' + disks + '/other.ext4 ' + disks + '/other.run-other')
      console.log('e2e passed: ' + label)
      return
    }

    if (scenario === 'disks') {
      assert.deepEqual(
        Fs.readdirSync(Path.join(cache, 'disks')).filter((name) => name.endsWith('.ext4')),
        [Path.basename(kept!)],
        'a disk that the run unpacked is removed with its last attempt, and one the machine had is kept',
      )
      assert.deepEqual(
        Fs.readdirSync(Path.join(cache, 'blobs')).filter((name) =>
          imported.tasks.some((task) => blobOf(task).digest === name),
        ),
        [],
        'no packed disk stays in the cache',
      )
    }

    assert.equal(status['counts'].errored, 0, 'no attempt may end in an infrastructure error')
    assert.equal(status['counts'].passed + status['counts'].failed, total)
    if (!attached && !fleet && !lapse)
      assert.equal(peak, Math.min(slots, total), 'the sandbox fills every slot')
    if (cached) {
      if (!disk) throw new Error('the cache scenario runs on krun or ns slots')
      const kept = async () =>
        (await there('ls -A ' + (guest ? Guest.root + '/cache' : cache) + '/verifier 2>/dev/null'))
          .split('\n')
          .filter(Boolean).length
      const verified = async (run: string) => {
        let finished: Record<string, any>
        for (;;) {
          finished = await api.status(run)
          if (finished['state'] === 'finished') break
          if (Date.now() - started > 20 * 60_000)
            throw new Error('the run did not finish:\n' + summary(finished))
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const attempt = finished['attempts'][0] as { id: string; outcome: string }
        assert.equal(attempt.outcome, 'passed', summary(finished))
        const read = (name: string) => api.artifact(run, attempt.id, 'verifier/' + name)
        return [(await read('cache.txt')).trim(), (await read('variable.txt')).trim()]
      }
      const directory = '/var/cache/nanoeval-verifier/uv'
      assert.deepEqual(await verified(created.id), ['miss', 'unset'])
      assert.equal(await kept(), 0, 'the attempt of a model keeps nothing for later verifiers')
      const solved = { ...config, agents: [oracle], name: config.name + '-oracle' }
      assert.deepEqual(await verified((await api.create(solved)).id), ['miss', directory])
      assert.equal(await kept(), 1, 'the attempt of the oracle kept its downloads')
      assert.deepEqual(await verified((await api.create(config)).id), ['hit', directory])
      assert.deepEqual(await verified((await api.create(solved)).id), ['hit', directory])
      const plain = { ...config, sandbox: { ...config.sandbox, verifierCache: undefined } }
      assert.deepEqual(await verified((await api.create(plain)).id), ['miss', 'unset'])
      assert.equal(await kept(), 1)
    } else if (closed || isolated) {
      for (const attempt of status['attempts'] as { id: string; outcome: string }[])
        assert.equal(
          attempt.outcome,
          'passed',
          await api.artifact(created.id, attempt.id, 'verifier/test-stdout.txt'),
        )
    } else if (model === 'scripted' || installed) {
      assert.equal(status['agents'].right.passed, total / 2)
      assert.equal(status['agents'].wrong.failed, total / 2)
      assert.equal(status['agents'].right.passAtK['1'], 1)
      assert.equal(status['agents'].wrong.passAtK['1'], 0)
    } else if (model === 'oracle') {
      assert.equal(status['counts'].passed, total, 'every solution passes its verifier')
    } else {
      assert.ok(status['counts'].passed > 0, 'the model solves at least one task')
    }

    const phases: Record<string, number[]> = {}
    for (const detail of details) {
      const attempt = detail['attempt'] as { id: string }
      assert.ok(detail['artifacts'].includes('verifier/test-stdout.txt'))
      if (judged) {
        const graded = detail['attempt'].task === 'fixtures/judged-answer'
        assert.equal(detail['result'].judge?.requests, graded ? 1 : undefined)
        assert.equal(detail['result'].timing.judge !== undefined, graded)
        for (const name of ['verifier/judge-request.json', 'verifier/judge-response.json'])
          assert.equal(detail['artifacts'].includes(name), graded)
      } else if (model === 'oracle') {
        assert.deepEqual(
          detail['artifacts'].filter((name: string) => !name.startsWith('verifier/')),
          ['agent/oracle.txt'],
        )
        assert.ok(detail['artifacts'].includes('verifier/reward.txt'))
        assert.match(
          await api.artifact(created.id, attempt.id, 'agent/oracle.txt'),
          /solve\.sh exited with 0\n$/,
        )
      } else {
        const trajectory = JSON.parse(
          await api.artifact(created.id, attempt.id, 'agent/trajectory.json'),
        )
        assert.equal(trajectory.schema_version, 'ATIF-v1.7')
        assert.ok(trajectory.steps.length >= 2)
        assert.ok(trajectory.final_metrics.extra.tool_calls >= 1)
        if (installed) {
          const kind = detail['result'].agent.provider as keyof typeof fakeUsage
          assert.deepEqual(
            detail['result'].usage,
            gateway
              ? {
                  ...fakeUsage[kind],
                  costUsd:
                    MockGateway.modelUsd[kind === 'codex-cli' ? '/v1/responses' : '/v1/messages'],
                }
              : fakeUsage[kind],
          )
          assert.equal(trajectory.agent.name, kind)
          assert.equal(trajectory.steps[0].source, 'user')
          for (const name of ['agent/events.jsonl', 'agent/model-requests.jsonl'])
            assert.ok(detail['artifacts'].includes(name), name)
          const requests = (
            await api.artifact(created.id, attempt.id, 'agent/model-requests.jsonl')
          )
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          assert.deepEqual(
            requests
              .filter((entry) => entry.claim === detail['attempt'].claims)
              .map((entry) => [entry.path, entry.status]),
            [[kind === 'codex-cli' ? 'responses' : 'v1/messages', 200]],
          )
          assert.equal(detail['result'].session.startsWith(created.id), true)
        }
      }
      for (const [phase, span] of Object.entries(
        detail['result'].timing as Record<string, { finishedAt: number; startedAt: number }>,
      ))
        (phases[phase] ??= []).push(span.finishedAt - span.startedAt)
    }

    if (installed) {
      const first = (status['attempts'] as { id: string }[])[0]!
      const presented: Record<string, string>[] = [
        {},
        { authorization: 'Bearer wrong' },
        { 'x-api-key': token },
      ]
      for (const headers of presented) {
        const refused = await fetch(
          url + '/v1/runs/' + created.id + '/model/' + first.id + '/responses',
          { body: '{}', headers, method: 'POST' },
        )
        assert.equal(refused.status, 401, 'the model endpoint of an attempt ends with its agent')
      }
      if (!gateway)
        assert.ok(
          Math.abs(
            status['spend'].modelUsd - fakeUsage['claude-code'].costUsd * (closed ? 0 : total / 2),
          ) < 1e-9,
          'the cost an installed agent reports counts against the model budget',
        )
    }

    if (mock) {
      const sum = (values: readonly number[]) => values.reduce((all, value) => all + value, 0)
      assert.deepEqual(mock.refused, [], 'every model request carried the one key as a bearer')
      if (model !== 'oracle') {
        assert.ok(mock.modelCosts.length >= total)
        assert.ok(
          Math.abs(status['spend'].modelUsd - sum(mock.modelCosts)) < 1e-9,
          'the model spend of the run is what the gateway reported as charged',
        )
        for (const detail of details)
          assert.ok(detail['result'].usage.costUsd > 0, 'every attempt has the cost it was charged')
      }
      const payments = (status['payments'] as { detail: string; usd: number }[]).map((payment) => ({
        operation: (JSON.parse(payment.detail) as { description: string }).description,
        usd: payment.usd,
      }))
      const micro = (charge: MockGateway.Charge) => Math.round(charge.usd * 1e6)
      assert.deepEqual(
        payments.map((payment) => [payment.operation, Math.round(payment.usd * 1e6)]),
        mock.log.flatMap((entry) => [
          ['compute.' + entry.operation, micro(entry)],
          ...(entry.refused === undefined
            ? []
            : [['compute.' + entry.operation + ' refused with ' + entry.refused, -micro(entry)]]),
        ]),
        'the payments of the run are what the gateway charged in order, and what it refused written back',
      )
      assert.deepEqual(
        mock.unavailable.map((charge) => charge.operation),
        lapse ? ['create'] : ['create', 'renew'],
        'the first sandbox and the first renewal were refused',
      )
      assert.ok(
        Math.abs(status['spend'].sandboxUsd - sum(mock.charges.map((charge) => charge.usd))) < 1e-9,
        'the sandbox spend of the run is what the gateway charged, without what it refused',
      )
      assert.ok(Math.abs(status['spend'].sandboxUsd - sum(payments.map((p) => p.usd))) < 1e-9)
      const operations = payments.map((payment) => payment.operation)
      assert.equal(operations[0], 'compute.create')
      assert.equal(operations.at(-1), 'compute.terminate')
      assert.equal(
        operations.includes('compute.renew'),
        !lapse,
        'the lease was renewed while rows ran, unless no renewal is sold',
      )
      const leased = [...mock.sandboxes.values()]
      if (lapse) {
        assert.ok(leased.length >= 2)
        assert.ok(
          leased.every((sandbox) => sandbox.ended !== undefined && sandbox.renewals === 0),
          'every sandbox ended, by its lease or by the run, and none was renewed',
        )
      } else {
        assert.deepEqual(
          leased.map((sandbox) => sandbox.ended),
          fleet ? ['died', ...leased.slice(1).map(() => 'terminated')] : ['terminated'],
          'every sandbox was terminated, not left to lapse, the one whose renewal was refused in passing too',
        )
      }
      assert.equal(status['sandboxes'][0].state, 'failed')
      assert.match(status['sandboxes'][0].error, /the gateway refused create with 503: /)
      assert.equal(status['sandboxes'].at(-1).state, 'closed')
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
      import: { ms: importMs, timings: imported.timings },
      label,
      medianPhaseMs: Object.fromEntries(
        Object.entries(phases).map(([phase, values]) => [phase, median(values)]),
      ),
      model:
        model === 'anthropic' || model === 'claude-plan'
          ? realModel
          : model === 'codex-plan'
            ? codexModel
            : model,
      network,
      peakConcurrentAttempts: peak,
      pollMs,
      slots,
      spend: status['spend'],
      store: storeKind,
      tickMs: Number(tickMs),
      tasks: taskNames,
      wallMs,
    }
    Fs.writeFileSync(Path.join(out, 'summary.json'), JSON.stringify(measured, null, 2) + '\n')
    console.log(JSON.stringify({ ...measured, import: { ms: importMs } }))
    console.log('e2e passed: ' + label)
  } finally {
    for (const runner of runners) {
      runner.child.kill('SIGKILL')
      destroy(runner.home)
    }
    await stop(worker, 'SIGTERM')
    beacon.close()
    upstream.close()
    await relay?.close()
    Fs.rmSync(secrets, { force: true, recursive: true })
    await sandboxd.close()
    guest?.close()
  }
}

await main()
process.exit(0)
