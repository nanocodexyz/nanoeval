import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, test } from 'node:test'
import { parseAgent } from '../cli/nanoeval.ts'
import type * as Atif from '../src/Atif.ts'
import * as Config from '../src/Config.ts'
import * as Gateway from '../src/Gateway.ts'
import * as Harbor from '../src/Harbor.ts'
import * as Installed from '../src/Installed.ts'
import * as Proxy from '../src/Proxy.ts'
import type * as Result from '../src/Result.ts'
import * as Slot from '../src/Slot.ts'

const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-installed-'))
after(() => Fs.rmSync(root, { force: true, recursive: true }))

const attemptToken = 'attempt-token-0123'

test('an agent names a session harness or an installed command', () => {
  assert.deepEqual(parseAgent('cli=codex-cli:gpt-6.1-sol:high'), {
    id: 'cli',
    model: 'gpt-6.1-sol',
    provider: 'codex-cli',
    thinking: 'high',
  })
  assert.deepEqual(parseAgent('code=claude-code:claude-opus-5-5'), {
    id: 'code',
    model: 'claude-opus-5-5',
    provider: 'claude-code',
  })
  assert.deepEqual(parseAgent('nano=claude:claude-haiku-4-5'), {
    id: 'nano',
    model: 'claude-haiku-4-5',
    provider: 'claude',
  })
  assert.deepEqual(parseAgent('nanoxd=codex-direct:gpt-6-luna:high'), {
    id: 'nanoxd',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    provider: 'codex',
    thinking: 'high',
  })
  assert.throws(() => parseAgent('other=cursor:some-model'), /ID=HARNESS:MODEL/)
  assert.throws(() => parseAgent('codex-cli:gpt-6.1-sol'), /ID=HARNESS:MODEL/)

  assert.equal(Config.harness({ provider: 'codex-cli' }), 'installed')
  assert.equal(Config.harness({ provider: 'claude-code' }), 'installed')
  assert.equal(Config.harness({ provider: 'claude' }), 'session')
  assert.equal(Config.harness({ provider: 'oracle' }), 'oracle')
  const config = {
    agents: [parseAgent('cli=codex-cli:gpt-6.1-sol:high'), parseAgent('nano=codex:gpt-6.1-sol')],
    attempts: 1,
    budget: { sandboxUsd: 0 },
    eval: { name: 'example' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'arms',
    sandbox: {
      backend: 'krun',
      max: 1,
      network: 'private',
      pollMs: 250,
      provider: 'local',
      slots: 2,
      timeoutSec: 3600,
    },
  }
  assert.deepEqual(
    Config.parse(config).agents.map((agent) => agent.provider),
    ['codex-cli', 'codex'],
  )
  assert.throws(
    () => Config.parse({ ...config, agents: [{ id: 'x', model: 'm', provider: 'cursor' }] }),
    /provider must be one of claude, codex, oracle, claude-code, codex-cli/,
  )
  assert.throws(
    () => Config.parse({ ...config, judge: { model: 'gpt-6.1-sol', provider: 'codex-cli' } }),
    /judge.provider must be one of claude, codex/,
  )
  const arms = Config.parse({
    ...config,
    agents: [parseAgent('nanox=codex:gpt-6-luna:high'), parseAgent('nanoxd=codex-direct:gpt-6-luna:high')],
  }).agents
  assert.deepEqual(
    arms.map((agent) => [agent.id, agent.provider, agent.orchestration]),
    [
      ['nanox', 'codex', undefined],
      ['nanoxd', 'codex', 'direct'],
    ],
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', orchestration: 'direct', provider: 'claude' }],
      }),
    /x has an orchestration, which only codex takes/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', orchestration: 'cells', provider: 'codex' }],
      }),
    /orchestration must be one of direct/,
  )
})

test('every pinned release names a checksum for each build it fetches', () => {
  for (const kind of Installed.kinds) {
    const release = Installed.releases[kind]
    assert.match(release.version, /^\d+\.\d+\.\d+$/)
    for (const binary of release.binaries) {
      assert.match(binary.sha256, /^[0-9a-f]{64}$/)
      assert.ok(binary.url.startsWith('https://') && binary.url.includes(release.version))
    }
    for (const arch of ['aarch64', 'x86_64'])
      assert.ok(
        release.binaries.some((binary) => binary.arch === arch),
        kind + ' on ' + arch,
      )
  }
})

function install(kind: Installed.Kind, libc: string): string {
  const rt = Path.join(root, 'rt-' + kind + '-' + libc)
  const entry = Path.join(rt, 'agents', kind, libc, Installed.releases[kind].entry)
  Fs.mkdirSync(Path.dirname(entry), { recursive: true })
  Fs.writeFileSync(
    entry,
    [
      '#!/bin/sh',
      'printf "argument:%s\\n" "$@"',
      'printf "input:%s\\n" "$(cat)"',
      'env | grep -E "^(ANTHROPIC|CLAUDE|CODEX|DISABLE|IS_SANDBOX|NANOEVAL_AGENT)" | sort',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return rt
}

function run(agent: Installed.Agent, rt: string): string {
  const home = Path.join(root, 'home-' + agent.kind)
  return execFileSync(
    'sh',
    ['-c', Installed.script(agent, { url: 'http://127.0.0.1:8787/v1/runs/r/model/a00001' }), 'sh'],
    {
      encoding: 'utf8',
      env: {
        NANOEVAL_AGENT_HOME: home,
        NANOEVAL_AGENT_RT: rt,
        NANOEVAL_AGENT_TOKEN: attemptToken,
        PATH: process.env['PATH'],
      },
      input: "Write it's done.\n",
    },
  )
}

test('the command of Codex CLI names the endpoint of the attempt and no credential', () => {
  const out = run(
    { kind: 'codex-cli', model: "gpt-6.1-sol'x", thinking: 'high' },
    install('codex-cli', 'any'),
  )
  const args = out
    .split('\n')
    .filter((line) => line.startsWith('argument:'))
    .map((line) => line.slice('argument:'.length))
  assert.deepEqual(args, [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-m',
    "gpt-6.1-sol'x",
    '-c',
    'model_reasoning_effort="high"',
    '-c',
    'model_provider="nanoeval"',
    '-c',
    'model_providers.nanoeval={name="nanoeval", base_url="http://127.0.0.1:8787/v1/runs/r/model/a00001", env_key="NANOEVAL_AGENT_TOKEN", wire_api="responses"}',
    '-',
  ])
  assert.match(out, /^input:Write it's done\.$/m)
  assert.match(out, /^CODEX_HOME=.*home-codex-cli$/m)
  assert.ok(Fs.statSync(Path.join(root, 'home-codex-cli')).isDirectory())
  assert.equal(
    out.split(attemptToken).length,
    2,
    'the token reaches the command in one variable and in no argument',
  )
})

test('the command of Claude Code is the build of the image and reads the endpoint from its variables', () => {
  const out = run(
    { kind: 'claude-code', model: 'claude-opus-5-5', thinking: 'high' },
    install('claude-code', 'any'),
  )
  assert.deepEqual(
    out
      .split('\n')
      .filter((line) => line.startsWith('argument:'))
      .map((line) => line.slice('argument:'.length)),
    [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
    ],
  )
  assert.match(out, /^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787\/v1\/runs\/r\/model\/a00001$/m)
  assert.match(out, new RegExp('^ANTHROPIC_AUTH_TOKEN=' + attemptToken + '$', 'm'))
  assert.match(out, /^CLAUDE_CONFIG_DIR=.*home-claude-code$/m)
  assert.doesNotMatch(out, /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/)

  const glibc =
    Fs.existsSync('/lib64/ld-linux-x86-64.so.2') || Fs.existsSync('/lib/ld-linux-aarch64.so.1')
  const libc = glibc ? 'gnu' : 'musl'
  assert.match(
    run({ kind: 'claude-code', model: 'claude-opus-5-5' }, install('claude-code', libc)),
    /^argument:-p$/m,
    'without a build for every image, the one of the libc of the image runs',
  )
  assert.throws(
    () => Installed.script({ kind: 'codex-cli', model: 'm' }, { url: 'http://host/a"b' }),
    /not a plain http or https address/,
  )
})

const codexStream = [
  '{"type":"thread.started","thread_id":"thread-1"}',
  'a line that is not JSON',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"plan"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I will write the file."}}',
  '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"echo hi > a.txt","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"echo hi > a.txt","aggregated_output":"ok\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"/app/b.txt","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Done."}}',
  '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":20}}',
  '',
].join('\n')

const claudeStream = [
  '{"type":"system","subtype":"init","session_id":"session-1","model":"claude-opus-5-5","tools":["Bash","Read"]}',
  '{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"thinking","thinking":"plan"}],"usage":{"input_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5,"output_tokens":9}}}',
  '{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"text","text":"I will write the file."}],"usage":{"input_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5,"output_tokens":9}}}',
  '{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo hi > a.txt"}}],"usage":{"input_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5,"output_tokens":9}}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"ok"}],"is_error":false}]}}',
  '{"type":"assistant","message":{"id":"msg_2","model":"claude-opus-5-5","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":4,"cache_read_input_tokens":65,"cache_creation_input_tokens":0,"output_tokens":3}}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.0421,"num_turns":2}',
  '',
].join('\n')

const usage: Atif.Usage = {
  cacheWriteTokens: 0,
  cachedTokens: 100,
  costUsd: undefined,
  inputTokens: 300,
  modelCalls: 2,
  outputTokens: 20,
  toolCalls: 2,
}

test('the event stream of Codex CLI gives the final message, the tool calls and an ATIF trajectory', () => {
  assert.deepEqual(Installed.summarize('codex-cli', codexStream), {
    costUsd: undefined,
    error: undefined,
    message: 'Done.',
    toolCalls: 2,
  })
  assert.equal(
    Installed.summarize(
      'codex-cli',
      '{"type":"turn.failed","error":{"message":"unexpected status 401"}}\n',
    ).error,
    'unexpected status 401',
  )
  const trajectory = Installed.trajectory(
    'codex-cli',
    { instruction: 'Write the file.', stream: codexStream, usage },
    { model: 'gpt-6.1-sol', name: 'codex-cli', session: 'fallback', version: '0.166.0' },
  )
  assert.equal(trajectory.session_id, 'thread-1')
  assert.deepEqual(trajectory.agent, {
    extra: {},
    model_name: 'gpt-6.1-sol',
    name: 'codex-cli',
    version: '0.166.0',
  })
  assert.deepEqual(
    trajectory.steps.map((step) => [step.step_id, step.source, step.message]),
    [
      [1, 'user', 'Write the file.'],
      [2, 'agent', ''],
      [3, 'agent', 'I will write the file.'],
      [4, 'agent', ''],
      [5, 'agent', ''],
      [6, 'agent', 'Done.'],
    ],
  )
  assert.equal(trajectory.steps[1]!.reasoning_content, 'plan')
  assert.deepEqual(trajectory.steps[3]!.tool_calls, [
    {
      arguments: { command: 'echo hi > a.txt' },
      function_name: 'command_execution',
      tool_call_id: 'item_2',
    },
  ])
  assert.deepEqual(trajectory.steps[3]!.observation, {
    results: [
      {
        content: 'ok\n',
        extra: { duration_ns: null, exit_code: 0, status: 'completed' },
        source_call_id: 'item_2',
      },
    ],
  })
  assert.deepEqual(trajectory.steps[4]!.tool_calls![0]!.arguments, {
    changes: [{ kind: 'add', path: '/app/b.txt' }],
  })
  assert.deepEqual(trajectory.final_metrics, {
    extra: { cache_write_input_tokens: 0, model_calls: 2, tool_calls: 2 },
    total_cached_tokens: 100,
    total_completion_tokens: 20,
    total_prompt_tokens: 300,
    total_steps: 6,
  })
})

test('the event stream of Claude Code gives the final message, its cost and an ATIF trajectory', () => {
  assert.deepEqual(Installed.summarize('claude-code', claudeStream), {
    costUsd: 0.0421,
    error: undefined,
    message: 'Done.',
    toolCalls: 1,
  })
  assert.equal(
    Installed.summarize(
      'claude-code',
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 401"}\n',
    ).error,
    'API Error: 401',
  )
  const trajectory = Installed.trajectory(
    'claude-code',
    { stream: claudeStream, usage: { ...usage, costUsd: 0.0421 } },
    { model: 'opus', name: 'claude-code', session: 'fallback', version: '2.1.318' },
  )
  assert.equal(trajectory.session_id, 'session-1')
  assert.equal(trajectory.agent.model_name, 'claude-opus-5-5')
  assert.deepEqual(trajectory.agent.extra, { tools: ['Bash', 'Read'] })
  assert.equal(trajectory.steps.length, 2, 'the blocks of one message are one step')
  const [first, second] = trajectory.steps
  assert.equal(first!.message, 'I will write the file.')
  assert.equal(first!.reasoning_content, 'plan')
  assert.deepEqual(first!.metrics, {
    cached_tokens: 50,
    completion_tokens: 9,
    extra: { cache_write_input_tokens: 5 },
    prompt_tokens: 65,
  })
  assert.deepEqual(first!.tool_calls, [
    { arguments: { command: 'echo hi > a.txt' }, function_name: 'Bash', tool_call_id: 'toolu_1' },
  ])
  assert.deepEqual(first!.observation, {
    results: [
      {
        content: 'ok',
        extra: { duration_ns: null, status: 'completed' },
        source_call_id: 'toolu_1',
      },
    ],
  })
  assert.equal(second!.message, 'Done.')
  assert.equal(trajectory.final_metrics.total_cost_usd, 0.0421)
})

const presented = () =>
  new Headers({
    'accept-encoding': 'gzip',
    'anthropic-beta': 'claude-code-20250219',
    'anthropic-version': '2023-06-01',
    authorization: 'Bearer ' + attemptToken,
    'cf-connecting-ip': '10.0.0.1',
    'chatgpt-account-id': 'chosen-by-the-guest',
    'content-type': 'application/json',
    host: '127.0.0.1:8787',
    originator: 'codex_exec',
    'x-api-key': attemptToken,
    'x-forwarded-for': '10.0.0.1',
    [Proxy.relaySecretHeader]: 'chosen-by-the-guest',
  })

function sent(headers: Headers): Record<string, string> {
  const all: Record<string, string> = {}
  headers.forEach((value, name) => (all[name] = value))
  return all
}

test('the token of an attempt is read from either header an agent sends it in', () => {
  assert.equal(Proxy.token(new Headers({ authorization: 'Bearer abc' })), 'abc')
  assert.equal(Proxy.token(new Headers({ 'x-api-key': 'abc' })), 'abc')
  assert.equal(Proxy.token(new Headers({ authorization: 'Basic abc' })), undefined)
  assert.equal(Proxy.token(new Headers()), undefined)
})

test('the model endpoint forwards only the generation routes of its provider', () => {
  assert.equal(Proxy.route('codex', 'responses'), 'responses')
  assert.equal(Proxy.route('codex', '/responses/compact/'), 'responses/compact')
  assert.equal(Proxy.route('codex', 'models'), undefined)
  assert.equal(Proxy.route('codex', 'v1/messages'), undefined)
  assert.equal(Proxy.route('claude', 'v1/messages'), 'v1/messages')
  assert.equal(Proxy.route('claude', 'v1/messages/count_tokens'), 'v1/messages/count_tokens')
  assert.equal(Proxy.route('claude', 'v1/files'), undefined)
  assert.equal(Proxy.route('claude', 'responses'), undefined)
  assert.equal(Proxy.generates('claude', 'v1/messages/count_tokens'), false)
  assert.equal(Proxy.generates('claude', 'v1/messages'), true)
})

test('forwarding swaps the token of the attempt for the credential of the deployment', () => {
  const cases: [Proxy.forward.Input, string, Record<string, string>][] = [
    [
      {
        credential: { key: 'sk-openai', kind: 'key', scheme: 'bearer' },
        headers: presented(),
        path: 'responses',
        provider: 'codex',
        search: '',
      },
      'https://api.openai.com/v1/responses',
      { authorization: 'Bearer sk-openai' },
    ],
    [
      {
        credential: {
          base: 'http://127.0.0.1:9000/',
          key: 'sk-ant',
          kind: 'key',
          scheme: 'x-api-key',
        },
        headers: presented(),
        path: 'v1/messages',
        provider: 'claude',
        search: '?beta=true',
      },
      'http://127.0.0.1:9000/v1/messages?beta=true',
      { 'anthropic-beta': 'claude-code-20250219', 'x-api-key': 'sk-ant' },
    ],
    [
      {
        credential: {
          base: 'https://gateway.example',
          key: 'sk-gateway',
          kind: 'key',
          scheme: 'bearer',
        },
        headers: presented(),
        path: 'v1/messages',
        provider: 'claude',
        search: '?beta=true',
      },
      'https://gateway.example/v1/messages?beta=true',
      { 'anthropic-beta': 'claude-code-20250219', authorization: 'Bearer sk-gateway' },
    ],
    [
      {
        credential: {
          headers: { authorization: 'Bearer plan-token', 'chatgpt-account-id': 'account-1' },
          kind: 'plan',
          relay: { secret: 'relay-secret', url: 'http://127.0.0.1:7000' },
        },
        headers: presented(),
        path: 'responses',
        provider: 'codex',
        search: '',
      },
      'http://127.0.0.1:7000/backend-api/codex/responses',
      {
        authorization: 'Bearer plan-token',
        'chatgpt-account-id': 'account-1',
        [Proxy.relaySecretHeader]: 'relay-secret',
      },
    ],
    [
      {
        credential: {
          headers: { authorization: 'Bearer plan-token', 'chatgpt-account-id': 'account-1' },
          kind: 'plan',
        },
        headers: presented(),
        path: 'responses/compact',
        provider: 'codex',
        search: '',
      },
      'https://chatgpt.com/backend-api/codex/responses/compact',
      { authorization: 'Bearer plan-token', 'chatgpt-account-id': 'account-1' },
    ],
    [
      {
        credential: { headers: { authorization: 'Bearer oauth-token' }, kind: 'plan' },
        headers: presented(),
        path: 'v1/messages',
        provider: 'claude',
        search: '?beta=true',
      },
      'https://api.anthropic.com/v1/messages?beta=true',
      {
        'anthropic-beta': 'claude-code-20250219,' + Proxy.oauthBeta,
        authorization: 'Bearer oauth-token',
      },
    ],
  ]
  for (const [input, url, credential] of cases) {
    const target = Proxy.forward(input)
    const headers = sent(target.headers)
    assert.equal(target.url, url)
    for (const [name, value] of Object.entries(credential)) assert.equal(headers[name], value, name)
    assert.ok(
      !Object.values(headers).some((value) => value.includes(attemptToken)),
      'the token of the attempt goes no further than the run',
    )
    assert.ok(
      !Object.values(headers).some((value) => value.includes('chosen-by-the-guest')),
      'an agent chooses neither the account nor the relay',
    )
    for (const name of ['accept-encoding', 'cf-connecting-ip', 'host', 'x-forwarded-for'])
      assert.equal(headers[name], undefined, name)
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['originator'], 'codex_exec')
    assert.equal(headers['anthropic-version'], '2023-06-01')
    if (input.credential.kind === 'plan' || input.credential.scheme === 'bearer')
      assert.equal(headers['x-api-key'], undefined)
    else assert.equal(headers['authorization'], undefined)
  }
  const again = Proxy.forward({
    credential: { headers: { authorization: 'Bearer oauth-token' }, kind: 'plan' },
    headers: new Headers({ 'anthropic-beta': Proxy.oauthBeta + ', other' }),
    path: 'v1/messages',
    provider: 'claude',
    search: '',
  })
  assert.equal(again.headers.get('anthropic-beta'), Proxy.oauthBeta + ',other')
})

test('a deployment holds a key of its own for a provider, or one Tempo Key for both', () => {
  assert.equal(Proxy.key({}, 'claude'), undefined)
  assert.equal(Proxy.key({ ANTHROPIC_BASE_URL: 'https://models.example' }, 'claude'), undefined)
  assert.deepEqual(Proxy.key({ ANTHROPIC_API_KEY: 'sk-ant' }, 'claude'), {
    key: 'sk-ant',
    kind: 'key',
    scheme: 'x-api-key',
  })
  assert.equal(Proxy.key({ ANTHROPIC_API_KEY: 'sk-ant' }, 'codex'), undefined)
  assert.deepEqual(
    Proxy.key(
      {
        ANTHROPIC_API_KEY: 'sk-ant',
        ANTHROPIC_AUTH_TOKEN: 'token',
        ANTHROPIC_BASE_URL: 'https://models.example',
        TEMPO_KEY: 'sk-tempo',
      },
      'claude',
    ),
    { base: 'https://models.example', key: 'token', kind: 'key', scheme: 'bearer' },
  )
  assert.deepEqual(
    Proxy.key({ OPENAI_API_KEY: 'sk-openai', OPENAI_BASE_URL: 'https://models.example' }, 'codex'),
    { base: 'https://models.example', key: 'sk-openai', kind: 'key', scheme: 'bearer' },
  )
  for (const provider of ['claude', 'codex'] as const) {
    assert.deepEqual(Proxy.key({ TEMPO_KEY: 'sk-tempo' }, provider), {
      base: Gateway.origin,
      key: 'sk-tempo',
      kind: 'key',
      scheme: 'bearer',
    })
    assert.deepEqual(
      Proxy.key(
        {
          ANTHROPIC_BASE_URL: 'https://ignored.example',
          OPENAI_BASE_URL: 'https://ignored.example',
          TEMPO_GATEWAY_URL: 'http://127.0.0.1:9000',
          TEMPO_KEY: 'sk-tempo',
        },
        provider,
      ),
      { base: 'http://127.0.0.1:9000', key: 'sk-tempo', kind: 'key', scheme: 'bearer' },
    )
  }

  const headers = new Headers({ authorization: 'Bearer of-the-client', 'x-api-key': 'placeholder' })
  Proxy.authorize(headers, { key: 'sk-tempo', kind: 'key', scheme: 'bearer' })
  assert.deepEqual(sent(headers), { authorization: 'Bearer sk-tempo' })
  Proxy.authorize(headers, { key: 'sk-ant', kind: 'key', scheme: 'x-api-key' })
  assert.deepEqual(sent(headers), { 'x-api-key': 'sk-ant' })
})

test('the meter keeps the cost a gateway reports with the usage', () => {
  const responses = Proxy.meter('codex')
  responses.push(
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-luna","usage":{"input_tokens":1200,"input_tokens_details":{"cached_tokens":1000},"output_tokens":40,"cost":0.00005}}}\n\n',
  )
  assert.deepEqual(responses.usage(), {
    cacheWriteTokens: 0,
    cachedTokens: 1000,
    costUsd: 0.00005,
    inputTokens: 1200,
    model: 'gpt-6-luna',
    outputTokens: 40,
  })

  const messages = Proxy.meter('claude')
  messages.push(
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30,"cost":0.000016}}\n\n',
  )
  assert.deepEqual(messages.usage(), {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    costUsd: 0.000016,
    inputTokens: 10,
    model: 'claude-haiku-5-5',
    outputTokens: 30,
  })

  const whole = Proxy.meter('claude')
  whole.push(
    '{"type":"message","model":"claude-haiku-5-5","usage":{"input_tokens":3,"output_tokens":2,"cost":0.0000013}}',
  )
  assert.equal(whole.usage()?.costUsd, 0.0000013)
})

test('the meter counts the searches and fetches a provider ran for a response', () => {
  const messages = Proxy.meter('claude')
  messages.push(
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30,"cost":0.020016,"server_tool_use":{"web_search_requests":2,"web_fetch_requests":1}}}\n\n',
  )
  assert.deepEqual(messages.usage(), {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    costUsd: 0.020016,
    inputTokens: 10,
    model: 'claude-haiku-5-5',
    outputTokens: 30,
    webFetches: 1,
    webSearches: 2,
  })

  const responses = Proxy.meter('codex')
  responses.push(
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-luna","output":[{"type":"web_search_call"},{"type":"message"},{"type":"web_search_call"}],"usage":{"input_tokens":12,"output_tokens":4}}}\n\n',
  )
  assert.equal(responses.usage()?.webSearches, 2)
})

test('a refused payment is told apart: one that passes, and one that says the key is spent', () => {
  assert.equal(
    Proxy.refusal(
      '{"type":"https://paymentauth.org/problems/session/delta-too-small","title":"Delta Too Small","status":402,"detail":"Delta too small: voucher does not add new funds for this request.","challengeId":"c"}',
    ),
    'passing',
  )
  assert.equal(
    Proxy.refusal(
      '{"type":"https://paymentauth.org/problems/session/insufficient-balance","title":"Insufficient Balance","status":402,"detail":"Insufficient balance."}',
    ),
    'passing',
  )
  assert.equal(
    Proxy.refusal(
      '{"type":"/reference#description/payment-failed","title":"Payment failed","status":402,"code":"payment_failed","detail":"The wallet holds 0 of the 3 its channel needs now."}',
    ),
    'spent',
  )
  assert.equal(Proxy.refusal('{"type":"about:blank","status":402}'), undefined)
  assert.equal(Proxy.refusal('Payment Required'), undefined)
  assert.equal(Proxy.refusal('null'), undefined)
})

test('the name of a session says which attempt and claim of which run its requests belong to', () => {
  const run = '0f8fad5b-d9cb-469f-a165-70867728950e'
  assert.deepEqual(Proxy.session(run + '-a00012-2'), { attempt: 'a00012', claim: 2, run })
  assert.deepEqual(Proxy.session(run + '-a00012-2-judge-1'), {
    attempt: 'a00012',
    claim: 2,
    judge: 1,
    run,
  })
  assert.equal(Proxy.session('some-other-session'), undefined)
  assert.equal(Proxy.session(''), undefined)
})

test('the meter reads the usage of a response from its events, however they are cut', () => {
  const completed =
    'event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-6.1-sol"}}\n\n' +
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"model":"gpt-6.1-sol","usage":{"input_tokens":300,"input_tokens_details":{"cached_tokens":100,"cache_write_tokens":7},"output_tokens":20,"output_tokens_details":{"reasoning_tokens":5}}}}\r\n\r\n'
  for (const size of [1, 7, completed.length]) {
    const meter = Proxy.meter('codex')
    for (let index = 0; index < completed.length; index += size)
      meter.push(completed.slice(index, index + size))
    assert.deepEqual(meter.usage(), {
      cacheWriteTokens: 7,
      cachedTokens: 100,
      inputTokens: 300,
      model: 'gpt-6.1-sol',
      outputTokens: 20,
    })
  }

  const messages = Proxy.meter('claude')
  messages.push(
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\n',
  )
  messages.push('event: ping\ndata: {"type":"ping"}\n\n')
  messages.push(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
  )
  assert.deepEqual(messages.usage(), {
    cacheWriteTokens: 5,
    cachedTokens: 50,
    inputTokens: 65,
    model: 'claude-opus-5-5',
    outputTokens: 42,
  })

  const whole = Proxy.meter('claude')
  whole.push('{"type":"message","model":"claude-haiku-4-5","usage":{"input_tok')
  whole.push('ens":3,"output_tokens":2}}')
  assert.deepEqual(whole.usage(), {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    inputTokens: 3,
    model: 'claude-haiku-4-5',
    outputTokens: 2,
  })

  const refused = Proxy.meter('codex')
  refused.push('{"error":{"message":"no"}}')
  assert.equal(refused.usage(), undefined)
  const cut = Proxy.meter('codex')
  cut.push('event: response.created\ndata: {"type":"response.created","respo')
  assert.equal(cut.usage(), undefined)
})

function attempt(
  agent: Result.Attempt['agent'],
  input: { n: number; outcome: Result.Attempt['outcome']; task: string; usage: Atif.Usage | null },
): Result.Attempt {
  return {
    agent,
    ...(input.outcome === 'errored'
      ? { failure: { at: 0, kind: 'agent' as const, message: 'it exited with 1' } }
      : {}),
    finishedAt: 100_000,
    id: 'a0000' + input.n,
    index: 1,
    outcome: input.outcome,
    reward: input.outcome === 'errored' ? null : input.outcome === 'passed' ? 1 : 0,
    sandbox: null,
    session: 's',
    startedAt: 10_000,
    task: { checksum: 'c', name: 'bench/' + input.task },
    timing: { agentExecution: { finishedAt: 80_000, startedAt: 20_000 } },
    usage: input.usage,
  }
}

test('a Harbor trial of an installed agent names the command and its release', () => {
  const cli = { id: 'cli', model: 'claude-opus-5-5', provider: 'claude-code' as const }
  const trial = Harbor.trial(attempt(cli, { n: 1, outcome: 'passed', task: 'one', usage }), {
    job: { finishedAt: 1, id: '00000000-0000-4000-8000-000000000000', name: 'job', startedAt: 0 },
    source: 'bench@v',
    uri: 'file:///job/one__cli__1',
    version: '0.2.0',
  })
  assert.deepEqual(trial['agent_info'], {
    model_info: { name: 'claude-opus-5-5', provider: 'anthropic' },
    name: 'claude-code',
    version: Installed.releases['claude-code'].version,
  })
  assert.equal((trial['config'] as { agent: { name: string } }).agent.name, 'claude-code')
})

test('a slot installs a release of an agent only when its checksum matches', () => {
  const home = Path.join(root, 'sandbox')
  const cache = Path.join(root, 'cache')
  Fs.mkdirSync(home, { recursive: true })
  Fs.copyFileSync(Path.resolve('sandbox/slot.sh'), Path.join(home, 'slot.sh'))
  const release = Path.join(root, 'release')
  Fs.writeFileSync(release, '#!/bin/sh\necho released\n')
  const sha256 = Crypto.createHash('sha256').update(Fs.readFileSync(release)).digest('hex')
  const arch = Os.arch() === 'arm64' ? 'aarch64' : 'x86_64'
  const slots = Slot.create({ home })
  const install = (sum: string, version: string) =>
    spawnSync(
      'bash',
      [
        '-c',
        slots.agents('claude-code', {
          binaries: [
            { arch, libc: 'gnu', sha256: sum, url: 'file://' + release },
            {
              arch: arch === 'x86_64' ? 'aarch64' : 'x86_64',
              libc: 'gnu',
              sha256: sum,
              url: 'file:///nothing',
            },
          ],
          entry: 'claude',
          format: 'file',
          provider: 'claude',
          version,
        }),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, NANOEVAL_AGENT_CLAUDE_CODE: '', NANOEVAL_CACHE: cache },
      },
    )
  const refused = install('0'.repeat(64), '1.0.0')
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /checksum mismatch/)
  assert.equal(Fs.existsSync(Path.join(home, 'rt/agents/claude-code')), false)

  const installed = install(sha256, '1.0.0')
  assert.equal(installed.status, 0, installed.stderr)
  const entry = Path.join(home, 'rt/agents/claude-code/gnu/claude')
  assert.equal(execFileSync(entry, { encoding: 'utf8' }), 'released\n')
  assert.equal(
    Fs.readFileSync(Path.join(home, 'rt/agents/claude-code/version'), 'utf8'),
    '1.0.0 release\n',
  )

  Fs.rmSync(release)
  assert.equal(
    install(sha256, '1.0.0').status,
    0,
    'a release that is installed is not fetched again',
  )
  Fs.rmSync(Path.join(home, 'rt'), { recursive: true })
  assert.equal(
    install(sha256, '1.0.0').status,
    0,
    'another sandbox of the machine takes it from the cache',
  )
  assert.equal(execFileSync(entry, { encoding: 'utf8' }), 'released\n')
})
