import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
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
  assert.deepEqual(parseAgent('nanox=codex:gpt-6-luna:high'), {
    id: 'nanox',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    provider: 'codex',
    thinking: 'high',
  })
  assert.deepEqual(parseAgent('nanoxc=codex-code-mode:gpt-6-luna:high'), {
    id: 'nanoxc',
    model: 'gpt-6-luna',
    provider: 'codex',
    thinking: 'high',
  })
  assert.equal(
    agentText(parseAgent('nanoxd=codex-direct:gpt-6-luna:high')),
    'nanoxd=codex:gpt-6-luna:high',
  )
  assert.equal(
    agentText(parseAgent('nanoxc=codex-code-mode:gpt-6-luna:high')),
    'nanoxc=codex-code-mode:gpt-6-luna:high',
  )
  assert.deepEqual(parseAgent('nanoxj=codex-jobs:gpt-6-luna:high'), {
    id: 'nanoxj',
    model: 'gpt-6-luna',
    orchestration: 'jobs',
    provider: 'codex',
    thinking: 'high',
  })
  assert.equal(
    agentText(parseAgent('nanoxj=codex-jobs:gpt-6-luna:high')),
    'nanoxj=codex-jobs:gpt-6-luna:high',
  )
  assert.throws(() => parseAgent('other=cursor:some-model'), /ID=HARNESS:MODEL/)
  assert.deepEqual(parseAgent('open=fx-chat:@cf/vendor/open-model:high'), {
    api: 'chat',
    id: 'open',
    model: '@cf/vendor/open-model',
    provider: 'fx',
    thinking: 'high',
  })
  assert.deepEqual(parseAgent('fx=fx-messages:claude-haiku-5-5'), {
    api: 'messages',
    id: 'fx',
    model: 'claude-haiku-5-5',
    provider: 'fx',
  })
  assert.equal(parseAgent('fx=fx-responses:gpt-6-luna').api, 'responses')
  assert.equal(
    agentText(parseAgent('fx=fx-responses:gpt-6-luna:low')),
    'fx=fx-responses:gpt-6-luna:low',
  )
  assert.throws(() => parseAgent('fx=fx:gpt-6-luna'), /ID=HARNESS:MODEL/)
  assert.throws(() => parseAgent('fx=fx-embeddings:gpt-6-luna'), /ID=HARNESS:MODEL/)
  assert.throws(() => parseAgent('cli=codex-cli-chat:gpt-6-luna'), /ID=HARNESS:MODEL/)
  assert.equal(Installed.provider('fx', 'chat'), 'codex')
  assert.equal(Installed.provider('fx', 'responses'), 'codex')
  assert.equal(Installed.provider('fx', 'messages'), 'claude')
  assert.equal(Installed.provider('codex-cli'), 'codex')
  assert.throws(() => Installed.provider('fx'), /fx names no API for its model/)
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
    /provider must be one of claude, codex, oracle, claude-code, codex-cli, fx, nanocode-claude, nanocode-codex, opencode, pi/,
  )
  assert.throws(
    () => Config.parse({ ...config, judge: { model: 'gpt-6.1-sol', provider: 'codex-cli' } }),
    /judge.provider must be one of claude, codex/,
  )
  assert.deepEqual(
    Config.parse({ ...config, agents: [parseAgent('fx=fx-chat:open-model')] }).agents,
    [{ api: 'chat', id: 'fx', model: 'open-model', provider: 'fx' }],
  )
  assert.throws(
    () => Config.parse({ ...config, agents: [{ id: 'x', model: 'm', provider: 'fx' }] }),
    /x: the api of fx must be one of chat, messages, responses/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ api: 'chat', id: 'x', model: 'm', provider: 'codex-cli' }],
      }),
    /x has an api, which codex-cli does not take/,
  )
  const arms = Config.parse({
    ...config,
    agents: [
      parseAgent('nanox=codex:gpt-6-luna:high'),
      parseAgent('nanoxc=codex-code-mode:gpt-6-luna:high'),
      { id: 'plain', model: 'gpt-6-luna', provider: 'codex' },
    ],
  }).agents
  assert.deepEqual(
    arms.map((agent) => [agent.id, agent.provider, agent.orchestration]),
    [
      ['nanox', 'codex', 'direct'],
      ['nanoxc', 'codex', undefined],
      ['plain', 'codex', undefined],
    ],
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', orchestration: 'jobs', provider: 'claude' }],
      }),
    /x has the orchestration jobs, and claude takes only direct/,
  )
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [{ id: 'x', model: 'm', orchestration: 'direct', provider: 'claude' }],
    }).agents.map((agent) => [agent.provider, agent.orchestration]),
    [['claude', 'direct']],
  )
  assert.deepEqual(parseAgent('nanod=claude-direct:claude-opus-5-5:high'), {
    id: 'nanod',
    model: 'claude-opus-5-5',
    orchestration: 'direct',
    provider: 'claude',
    thinking: 'high',
  })
  assert.equal(
    agentText(parseAgent('nanod=claude-direct:claude-opus-5-5:high')),
    'nanod=claude-direct:claude-opus-5-5:high',
  )
  assert.equal(
    agentText(parseAgent('nano=claude:claude-opus-5-5:high')),
    'nano=claude:claude-opus-5-5:high',
  )
  const once = parseAgent('nano-ro=claude:claude-opus-5-5:high:refusal_fallback=return_once')
  assert.deepEqual(once, {
    id: 'nano-ro',
    model: 'claude-opus-5-5',
    provider: 'claude',
    refusalFallback: 'return_once',
    thinking: 'high',
  })
  assert.equal(agentText(once), 'nano-ro=claude:claude-opus-5-5:high:refusal_fallback=return_once')
  assert.equal(
    agentText(
      parseAgent('b=claude-direct:claude-opus-5-5:branches=2:refusal_fallback=return_once'),
    ),
    'b=claude-direct:claude-opus-5-5:branches=2:refusal_fallback=return_once',
  )
  const kept = parseAgent('nano-s=claude:claude-opus-5-5:high:refusal_fallback=session')
  assert.deepEqual(kept, {
    id: 'nano-s',
    model: 'claude-opus-5-5',
    provider: 'claude',
    refusalFallback: 'session',
    thinking: 'high',
  })
  assert.equal(agentText(kept), 'nano-s=claude:claude-opus-5-5:high:refusal_fallback=session')
  assert.throws(
    () => parseAgent('x=claude:claude-opus-5-5:high:refusal_fallback=never'),
    /an agent is ID=HARNESS:MODEL/,
  )
  assert.deepEqual(
    Config.parse({
      ...config,
      agents: [parseAgent('nano=claude:claude-opus-5-5:high'), once, kept],
    }).agents.map((agent) => [agent.id, agent.refusalFallback]),
    [
      ['nano', undefined],
      ['nano-ro', 'return_once'],
      ['nano-s', 'session'],
    ],
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', provider: 'claude', refusalFallback: 'never' }],
      }),
    /refusalFallback must be one of return_once, session/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', provider: 'codex', refusalFallback: 'return_once' }],
      }),
    /x has a refusalFallback, which only a claude session takes/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', orchestration: 'cells', provider: 'codex' }],
      }),
    /orchestration must be one of direct, jobs/,
  )
})

test('every pinned release names a checksum for each build it fetches', () => {
  for (const kind of Installed.kinds) {
    const release = Installed.releases[kind]
    if (release.source === 'runtime') {
      assert.equal(release.version, 'runtime-' + Slot.runtime.sha256.slice(0, 12))
      continue
    }
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

function install(
  kind: 'claude-code' | 'codex-cli' | 'fx' | 'opencode' | 'pi',
  libc: string,
): string {
  const rt = Path.join(root, 'rt-' + kind + '-' + libc)
  const release = Installed.releases[kind]
  assert.equal(release.source, 'release')
  const entry = Path.join(rt, 'agents', kind, libc, release.entry)
  Fs.mkdirSync(Path.dirname(entry), { recursive: true })
  Fs.writeFileSync(
    entry,
    [
      '#!/bin/sh',
      'printf "argument:%s\\n" "$@"',
      'printf "input:%s\\n" "$(cat)"',
      'env | grep -E "^(ANTHROPIC|CLAUDE|CODEX|DISABLE|FX|IS_SANDBOX|NANOEVAL_AGENT|OPENCODE|PI_|XDG)" | sort',
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

test('an image where musl answers at the path of the glibc loader takes the musl build', () => {
  const rt = Path.join(root, 'rt-loaders')
  for (const libc of ['gnu', 'musl']) {
    const entry = Path.join(rt, 'agents', 'claude-code', libc, 'claude')
    Fs.mkdirSync(Path.dirname(entry), { recursive: true })
    Fs.writeFileSync(entry, '#!/bin/sh\necho build:' + libc + '\n', { mode: 0o755 })
  }
  const image = Path.join(root, 'image-loaders')
  const gnu = Path.join(image, 'ld-linux-x86-64.so.2')
  const musl = Path.join(image, 'ld-musl.so.1')
  const chosen = () => {
    const script = Installed.script(
      { kind: 'claude-code', model: 'm' },
      { url: 'http://127.0.0.1:8787/v1/runs/r/model/a00001' },
    )
      .replaceAll('/lib64/ld-linux-x86-64.so.2', gnu)
      .replaceAll('/lib/ld-linux-aarch64.so.1', Path.join(image, 'absent'))
      .replaceAll('"/lib/ld-musl-$(uname -m).so.1"', musl)
    const result = spawnSync('sh', ['-c', script, 'sh'], {
      encoding: 'utf8',
      env: {
        NANOEVAL_AGENT_HOME: Path.join(root, 'home-loaders'),
        NANOEVAL_AGENT_RT: rt,
        NANOEVAL_AGENT_TOKEN: attemptToken,
        PATH: process.env['PATH'],
      },
      input: 'x\n',
    })
    return result.status === 0 ? result.stdout.trim() : result.status
  }
  const reset = () => {
    Fs.rmSync(image, { force: true, recursive: true })
    Fs.mkdirSync(image, { recursive: true })
  }

  reset()
  Fs.writeFileSync(gnu, 'the loader of the GNU C Library')
  assert.equal(chosen(), 'build:gnu')
  Fs.writeFileSync(musl, 'musl libc')
  assert.equal(chosen(), 'build:gnu', 'a glibc image that also has musl keeps the glibc build')

  reset()
  Fs.writeFileSync(musl, 'musl libc')
  assert.equal(chosen(), 'build:musl')
  Fs.symlinkSync(musl, gnu)
  assert.equal(chosen(), 'build:musl', 'the glibc path is a link to musl')

  reset()
  Fs.writeFileSync(musl, 'musl libc')
  Fs.writeFileSync(gnu, 'a stub that starts /lib/ld-musl-x86_64.so.1 with a compatibility library')
  assert.equal(chosen(), 'build:musl', 'the glibc path is a stub that starts musl')

  reset()
  assert.equal(chosen(), 127)

  assert.match(
    Installed.script({ api: 'chat', kind: 'opencode', model: 'm' }, { url: 'http://host/a' }),
    /! grep -q musl \/lib64\/ld-linux-x86-64\.so\.2/,
  )
  assert.doesNotMatch(
    Installed.script({ api: 'chat', kind: 'pi', model: 'm' }, { url: 'http://host/a' }),
    /grep -q musl/,
    'pi ships no musl build, so any glibc loader path takes its glibc build',
  )
})

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

test('the command of fx names the endpoint of the attempt in its settings and no credential', () => {
  const url = 'http://127.0.0.1:8787/v1/runs/r/model/a00001'
  const expected: [Installed.Api, string, string, unknown][] = [
    ['chat', url, 'openai-chat-completions', { reasoning_effort: 'high' }],
    ['responses', url, 'openai-responses', { reasoning: { effort: 'high' } }],
    [
      'messages',
      url + '/v1',
      'anthropic-messages',
      { output_config: { effort: 'high' }, thinking: { type: 'adaptive' } },
    ],
  ]
  for (const [api, base, protocol, effort] of expected) {
    const out = run(
      { api, kind: 'fx', model: "open/model'x", thinking: 'high' },
      install('fx', 'any'),
    )
    assert.deepEqual(
      out
        .split('\n')
        .filter((line) => line.startsWith('argument:'))
        .map((line) => line.slice('argument:'.length)),
      ['ask', '--json', '--full-access', '--model', "open/model'x", '--effort', 'high'],
    )
    assert.match(out, /^input:Write it's done\.$/m)
    assert.match(out, /^FX_HOME=.*home-fx\/fx$/m)
    assert.match(out, /^FX_AUTO_UPGRADE=0$/m)
    assert.deepEqual(
      JSON.parse(Fs.readFileSync(Path.join(root, 'home-fx', 'fx', 'settings.json'), 'utf8')),
      {
        models: { nanoeval: "open/model'x" },
        provider: 'nanoeval',
        providers: {
          nanoeval: {
            auth: { env: 'NANOEVAL_AGENT_TOKEN', type: 'bearer' },
            base_url: base,
            model_metadata: { "open/model'x": { reasoning_efforts: { high: effort } } },
            protocol,
          },
        },
      },
    )
    assert.equal(
      out.split(attemptToken).length,
      2,
      'the token reaches the command in one variable, in no argument and in no file',
    )
  }
  const plain = run({ api: 'chat', kind: 'fx', model: 'open-model' }, install('fx', 'any'))
  assert.doesNotMatch(plain, /^argument:--effort$/m)
  assert.equal(
    JSON.parse(Fs.readFileSync(Path.join(root, 'home-fx', 'fx', 'settings.json'), 'utf8')).providers
      .nanoeval.model_metadata,
    undefined,
  )
  assert.throws(
    () => Installed.script({ kind: 'fx', model: 'm' }, { url }),
    /fx names no API for its model/,
  )
})

test('the command of opencode is the build of the image and names the endpoint in its configuration', () => {
  const url = 'http://127.0.0.1:8787/v1/runs/r/model/a00001'
  const expected: [Installed.Api, string, string][] = [
    ['chat', url, '@ai-sdk/openai-compatible'],
    ['responses', url, '@ai-sdk/openai'],
    ['messages', url + '/v1', '@ai-sdk/anthropic'],
  ]
  for (const [api, base, npm] of expected) {
    const out = run(
      { api, kind: 'opencode', model: "open/model'x", thinking: 'high' },
      install('opencode', 'any'),
    )
    assert.deepEqual(
      out
        .split('\n')
        .filter((line) => line.startsWith('argument:'))
        .map((line) => line.slice('argument:'.length)),
      ['run', '--format', 'json', '-m', "nanoeval/open/model'x", '--variant', 'high'],
    )
    assert.match(out, /^input:Write it's done\.$/m)
    for (const name of ['CACHE', 'CONFIG', 'DATA', 'STATE'])
      assert.match(
        out,
        new RegExp('^XDG_' + name + '_HOME=.*home-opencode/' + name.toLowerCase() + '$', 'm'),
      )
    assert.match(out, /^OPENCODE_DISABLE_MODELS_FETCH=true$/m)
    assert.deepEqual(JSON.parse(/^OPENCODE_CONFIG_CONTENT=(.*)$/m.exec(out)![1]!), {
      autoupdate: false,
      permission: 'allow',
      provider: {
        nanoeval: {
          models: { "open/model'x": { reasoning: true } },
          npm,
          options: { apiKey: '{env:NANOEVAL_AGENT_TOKEN}', baseURL: base },
        },
      },
      share: 'disabled',
    })
    assert.equal(
      out.split(attemptToken).length,
      2,
      'the token reaches the command in one variable and in no argument',
    )
  }
  const glibc =
    Fs.existsSync('/lib64/ld-linux-x86-64.so.2') || Fs.existsSync('/lib/ld-linux-aarch64.so.1')
  const plain = run(
    { api: 'chat', kind: 'opencode', model: 'open-model' },
    install('opencode', glibc ? 'gnu' : 'musl'),
  )
  assert.doesNotMatch(plain, /^argument:--variant$/m)
  assert.deepEqual(
    JSON.parse(/^OPENCODE_CONFIG_CONTENT=(.*)$/m.exec(plain)![1]!).provider.nanoeval.models,
    { 'open-model': {} },
  )
  assert.throws(
    () => Installed.script({ kind: 'opencode', model: 'm' }, { url }),
    /opencode names no API for its model/,
  )
})

const opencodeStream = [
  '{"type":"step_start","sessionID":"session-oc","part":{"type":"step-start"}}',
  '{"type":"reasoning","sessionID":"session-oc","part":{"type":"reasoning","text":"plan"}}',
  '{"type":"tool_use","sessionID":"session-oc","part":{"type":"tool","tool":"bash","callID":"call_1","state":{"status":"completed","input":{"command":"echo hi > a.txt"},"output":"ok","metadata":{"exit":0}}}}',
  '{"type":"step_finish","sessionID":"session-oc","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":200,"output":12},"cost":0}}',
  '{"type":"tool_use","sessionID":"session-oc","part":{"type":"tool","tool":"read","callID":"call_2","state":{"status":"error","input":{"filePath":"/app/b.txt"},"error":"File not found"}}}',
  '{"type":"text","sessionID":"session-oc","part":{"type":"text","text":"Done."}}',
  '{"type":"step_finish","sessionID":"session-oc","part":{"type":"step-finish","reason":"stop","tokens":{"input":100,"output":8},"cost":0}}',
  '',
].join('\n')

test('the event stream of opencode gives the final message, the tool calls and an ATIF trajectory', () => {
  assert.deepEqual(Installed.summarize('opencode', opencodeStream), {
    costUsd: undefined,
    error: undefined,
    message: 'Done.',
    toolCalls: 2,
  })
  assert.deepEqual(
    Installed.summarize(
      'opencode',
      '{"type":"error","sessionID":"session-oc","error":{"name":"APIError","data":{"message":"Cannot connect to API","isRetryable":true}}}\n',
    ),
    { costUsd: undefined, error: 'Cannot connect to API', message: '', toolCalls: 0 },
  )
  const trajectory = Installed.trajectory(
    'opencode',
    { instruction: 'Write the file.', stream: opencodeStream, usage },
    { model: 'open-model', name: 'opencode', session: 'fallback', version: '1.19.5' },
  )
  assert.equal(trajectory.session_id, 'session-oc')
  assert.deepEqual(
    trajectory.steps.map((step) => [step.step_id, step.source, step.message]),
    [
      [1, 'user', 'Write the file.'],
      [2, 'agent', ''],
      [3, 'agent', ''],
      [4, 'agent', ''],
      [5, 'agent', 'Done.'],
    ],
  )
  assert.equal(trajectory.steps[1]!.reasoning_content, 'plan')
  assert.deepEqual(trajectory.steps[2]!.tool_calls, [
    { tool_call_id: 'call_1', function_name: 'bash', arguments: { command: 'echo hi > a.txt' } },
  ])
  assert.deepEqual(trajectory.steps[2]!.observation, {
    results: [
      {
        source_call_id: 'call_1',
        content: 'ok',
        extra: { duration_ns: null, exit_code: 0, status: 'completed' },
      },
    ],
  })
  assert.deepEqual(trajectory.steps[3]!.observation!.results[0], {
    source_call_id: 'call_2',
    content: 'File not found',
    extra: { duration_ns: null, status: 'error' },
  })
})

test('the command of pi is its glibc build and names the endpoint in its models file', () => {
  const url = 'http://127.0.0.1:8787/v1/runs/r/model/a00001'
  const expected: [Installed.Api, string, Record<string, unknown>][] = [
    ['chat', 'openai-completions', {}],
    ['responses', 'openai-responses', {}],
    ['messages', 'anthropic-messages', { compat: { forceAdaptiveThinking: true } }],
  ]
  for (const [api, named, thinking] of expected) {
    const out = run(
      { api, kind: 'pi', model: "open/model'x", thinking: 'high' },
      install('pi', 'any'),
    )
    assert.deepEqual(
      out
        .split('\n')
        .filter((line) => line.startsWith('argument:'))
        .map((line) => line.slice('argument:'.length)),
      [
        '-p',
        '--mode',
        'json',
        '--no-session',
        '--model',
        "nanoeval/open/model'x",
        '--thinking',
        'high',
      ],
    )
    assert.match(out, /^input:Write it's done\.$/m)
    assert.match(out, /^PI_CODING_AGENT_DIR=.*home-pi\/pi$/m)
    assert.match(out, /^PI_OFFLINE=1$/m)
    assert.deepEqual(
      JSON.parse(Fs.readFileSync(Path.join(root, 'home-pi', 'pi', 'models.json'), 'utf8')),
      {
        providers: {
          nanoeval: {
            api: named,
            apiKey: '$NANOEVAL_AGENT_TOKEN',
            authHeader: true,
            baseUrl: url,
            models: [{ id: "open/model'x", ...thinking, reasoning: true }],
          },
        },
      },
    )
    assert.equal(
      out.split(attemptToken).length,
      2,
      'the token reaches the command in one variable, in no argument and in no file',
    )
  }
  const plain = run({ api: 'chat', kind: 'pi', model: 'open-model' }, install('pi', 'any'))
  assert.doesNotMatch(plain, /^argument:--thinking$/m)
  assert.deepEqual(
    JSON.parse(Fs.readFileSync(Path.join(root, 'home-pi', 'pi', 'models.json'), 'utf8')).providers
      .nanoeval.models,
    [{ id: 'open-model' }],
  )
  assert.doesNotMatch(
    Installed.script({ api: 'chat', kind: 'pi', model: 'm' }, { url }),
    /ld-musl/,
    'pi ships no musl build, so its command looks for none',
  )
  assert.throws(
    () => Installed.script({ kind: 'pi', model: 'm' }, { url }),
    /pi names no API for its model/,
  )
})

const piStream = [
  '{"type":"session","version":3,"id":"session-pi","cwd":"/app"}',
  '{"type":"agent_start"}',
  '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Write the file."}]}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"I will write the file."},{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"echo hi > a.txt"}}],"model":"open-model","usage":{"input":160,"output":12,"cacheRead":40,"cacheWrite":5},"stopReason":"toolUse"}}',
  '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}',
  '{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_1","content":[{"type":"text","text":"ok"}]}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"model":"open-model","usage":{"input":40,"output":8,"cacheRead":160,"cacheWrite":0},"stopReason":"stop"}}',
  '{"type":"agent_settled","aborted":false}',
  '',
].join('\n')

const piUnreached = [
  '{"type":"session","version":3,"id":"session-pi","cwd":"/app"}',
  '{"type":"message_end","message":{"role":"assistant","content":[],"model":"open-model","stopReason":"error","errorMessage":"Connection error."}}',
  '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"Connection error."}',
  '{"type":"agent_settled","aborted":false}',
  '',
].join('\n')

test('the event stream of pi gives the final message, the tool calls, an error it exits 0 with and an ATIF trajectory', () => {
  assert.deepEqual(Installed.summarize('pi', piStream), {
    costUsd: undefined,
    error: undefined,
    message: 'Done.',
    toolCalls: 1,
  })
  assert.deepEqual(Installed.summarize('pi', piUnreached), {
    costUsd: undefined,
    error: 'Connection error.',
    message: '',
    toolCalls: 0,
  })
  assert.equal(
    Installed.summarize('pi', piUnreached + piStream).error,
    undefined,
    'an error that a later answer followed is not the end of the stream',
  )
  const trajectory = Installed.trajectory(
    'pi',
    { instruction: 'Write the file.', stream: piStream, usage },
    { model: 'open-model', name: 'pi', session: 'fallback', version: '1.5.2' },
  )
  assert.equal(trajectory.session_id, 'session-pi')
  assert.deepEqual(
    trajectory.steps.map((step) => [step.step_id, step.source, step.message]),
    [
      [1, 'user', 'Write the file.'],
      [2, 'agent', 'I will write the file.'],
      [3, 'agent', 'Done.'],
    ],
  )
  assert.equal(trajectory.steps[1]!.reasoning_content, 'plan')
  assert.deepEqual(trajectory.steps[1]!.metrics, {
    prompt_tokens: 205,
    completion_tokens: 12,
    cached_tokens: 40,
    extra: { cache_write_input_tokens: 5 },
  })
  assert.deepEqual(trajectory.steps[1]!.tool_calls, [
    { tool_call_id: 'call_1', function_name: 'bash', arguments: { command: 'echo hi > a.txt' } },
  ])
  assert.deepEqual(trajectory.steps[1]!.observation, {
    results: [
      {
        source_call_id: 'call_1',
        content: 'ok',
        extra: { duration_ns: null, status: 'completed' },
      },
    ],
  })
  assert.deepEqual(
    Installed.trajectory(
      'pi',
      { stream: piUnreached, usage },
      { model: 'open-model', name: 'pi', session: 'fallback', version: '1.5.2' },
    ).steps.map((step) => [step.source, step.message]),
    [['system', 'error: Connection error.']],
  )
})

const fxOutput =
  '{"output":"I ran it.\\n\\nDone.","final_output":"Done.","exit_code":0,"model":"open-model","resolved_provider":null,"session_id":"session-fx","steps":2,"tool_calls":[{"name":"shell","status":"success","command_result":{"kind":"command","command":"echo hi > a.txt","exit_code":0}},{"name":"read_file","status":"error","error":{"category":"rejected","code":"rejected"}}],"usage":{"input_tokens":300,"output_tokens":20,"cache_read_tokens":100}}\n'

test('the output of fx gives the final message, the tool calls and an ATIF trajectory', () => {
  assert.deepEqual(Installed.summarize('fx', 'Running echo hi\n' + fxOutput), {
    costUsd: undefined,
    error: undefined,
    message: 'Done.',
    toolCalls: 2,
  })
  assert.deepEqual(
    Installed.summarize(
      'fx',
      '{"output":"","final_output":"","exit_code":1,"session_id":"","steps":0,"tool_calls":[],"usage":{"input_tokens":null,"output_tokens":null},"error":"InsecureBaseUrl"}\n',
    ),
    { costUsd: undefined, error: 'InsecureBaseUrl', message: '', toolCalls: 0 },
  )
  const trajectory = Installed.trajectory(
    'fx',
    { instruction: 'Write the file.', stream: fxOutput, usage },
    { model: 'open-model', name: 'fx', session: 'fallback', version: '0.0.17' },
  )
  assert.equal(trajectory.session_id, 'session-fx')
  assert.deepEqual(
    trajectory.steps.map((step) => [step.step_id, step.source, step.message]),
    [
      [1, 'user', 'Write the file.'],
      [2, 'agent', ''],
      [3, 'agent', 'Done.'],
    ],
  )
  assert.deepEqual(trajectory.steps[1]!.tool_calls, [
    { tool_call_id: '1', function_name: 'shell', arguments: { command: 'echo hi > a.txt' } },
    { tool_call_id: '2', function_name: 'read_file', arguments: {} },
  ])
  assert.deepEqual(
    trajectory.steps[1]!.observation!.results.map((result) => result.extra),
    [
      { duration_ns: null, exit_code: 0, status: 'success' },
      { duration_ns: null, status: 'error' },
    ],
  )
  assert.equal(trajectory.final_metrics!.total_prompt_tokens, 300)
})

function runtime(withLoader: boolean): string {
  const rt = Path.join(root, 'rt-nanocode-' + (withLoader ? 'loader' : 'plain'))
  Fs.mkdirSync(Path.join(rt, 'lib'), { recursive: true })
  const nanocode = [
    '#!/bin/sh',
    'printf "argument:%s\\n" "$@"',
    'env | grep -E "^(NANOCODE|NANOEVAL_AGENT)" | sort',
    '',
  ].join('\n')
  Fs.writeFileSync(Path.join(rt, 'nanocode'), nanocode, { mode: 0o755 })
  if (withLoader)
    Fs.writeFileSync(
      Path.join(rt, 'ld.so'),
      ['#!/bin/sh', 'printf "loader:%s %s\\n" "$1" "$2"', 'shift 2', 'exec "$@"', ''].join('\n'),
      { mode: 0o755 },
    )
  return rt
}

test('the command of nanocode is the runtime of the slot and reads the endpoint from its variables', () => {
  const args = (out: string) =>
    out
      .split('\n')
      .filter((line) => line.startsWith('argument:'))
      .map((line) => line.slice('argument:'.length))
  const codex = run(
    { kind: 'nanocode-codex', model: 'boundless/z-ai/glm-5.3-flash', thinking: 'high' },
    runtime(true),
  )
  assert.match(codex, /^loader:--library-path .*rt-nanocode-loader\/lib$/m)
  assert.deepEqual(args(codex), [
    'exec',
    '--model',
    'boundless/z-ai/glm-5.3-flash',
    '--harness',
    'codex',
    '--thinking',
    'high',
    '--ephemeral',
    '--no-tempo-tools',
    '--hedge-cap-percent',
    '0',
    "Write it's done.",
  ])
  assert.match(
    codex,
    /^NANOCODE_OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8787\/v1\/runs\/r\/model\/a00001$/m,
  )
  assert.match(codex, new RegExp('^NANOCODE_OPENAI_API_KEY=' + attemptToken + '$', 'm'))
  assert.match(codex, /^NANOCODE_HOME=.*home-nanocode-codex$/m)
  assert.equal(codex.split(attemptToken).length, 3, 'the token is in two variables and no argument')

  const claude = run(
    { kind: 'nanocode-claude', model: 'boundless/z-ai/glm-5.3-flash' },
    runtime(false),
  )
  assert.doesNotMatch(claude, /^loader:/m)
  assert.deepEqual(args(claude), [
    'exec',
    '--model',
    'boundless/z-ai/glm-5.3-flash',
    '--harness',
    'claude',
    '--ephemeral',
    '--no-tempo-tools',
    '--hedge-cap-percent',
    '0',
    '--context-window',
    String(Installed.leaderboard.contextWindow),
    '--max-output-tokens',
    String(Installed.leaderboard.replyLimit),
    "Write it's done.",
  ])
  assert.match(
    claude,
    /^NANOCODE_ANTHROPIC_MESSAGES_URL=http:\/\/127\.0\.0\.1:8787\/v1\/runs\/r\/model\/a00001\/v1\/messages$/m,
  )
  assert.match(claude, new RegExp('^NANOCODE_ANTHROPIC_API_KEY=' + attemptToken + '$', 'm'))
  assert.match(
    claude,
    /^NANOCODE_MODELS_URL=http:\/\/127\.0\.0\.1:8787\/v1\/runs\/r\/model\/a00001\/models$/m,
  )
  assert.equal(Config.harness({ provider: 'nanocode-codex' }), 'installed')
  assert.deepEqual(parseAgent('nc=nanocode-codex:boundless/z-ai/glm-5.3-flash:high'), {
    id: 'nc',
    model: 'boundless/z-ai/glm-5.3-flash',
    provider: 'nanocode-codex',
    thinking: 'high',
  })
})

test('a nanocode codex agent keeps the catalog window of its model and sends no hedged request', () => {
  const out = run({ kind: 'nanocode-codex', model: 'gpt-6-luna', thinking: 'high' }, runtime(false))
  const args = out
    .split('\n')
    .filter((line) => line.startsWith('argument:'))
    .map((line) => line.slice('argument:'.length))

  assert.ok(!args.includes('--context-window'), args.join(' '))
  assert.ok(!out.includes('NANOCODE_CONTEXT_WINDOW'), out)
  assert.equal(args[args.indexOf('--hedge-cap-percent') + 1], '0')
})

test('the output of nanocode is its final message and an ATIF trajectory', () => {
  assert.deepEqual(Installed.summarize('nanocode-codex', 'Done.\n\n'), {
    costUsd: undefined,
    error: undefined,
    message: 'Done.',
    toolCalls: 0,
  })
  const trajectory = Installed.trajectory(
    'nanocode-claude',
    { instruction: 'Write the file.', stream: 'Done.\n', usage },
    {
      model: 'm',
      name: 'nanocode-claude',
      session: 's',
      version: Installed.releases['nanocode-claude'].version,
    },
  )
  assert.deepEqual(
    trajectory.steps.map((step) => [step.source, step.message]),
    [
      ['user', 'Write the file.'],
      ['agent', 'Done.'],
    ],
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
  assert.equal(Proxy.route('codex', 'chat/completions'), 'chat/completions')
  assert.equal(Proxy.route('codex', 'completions'), undefined)
  assert.equal(Proxy.route('codex', 'models'), undefined)
  assert.equal(Proxy.route('codex', 'v1/messages'), undefined)
  assert.equal(Proxy.route('claude', 'v1/messages'), 'v1/messages')
  assert.equal(Proxy.route('claude', 'v1/messages/count_tokens'), 'v1/messages/count_tokens')
  assert.equal(Proxy.route('claude', 'v1/files'), undefined)
  assert.equal(Proxy.route('claude', 'responses'), undefined)
  assert.equal(Proxy.generates('claude', 'v1/messages/count_tokens'), false)
  assert.equal(Proxy.generates('claude', 'v1/messages'), true)
  assert.equal(Proxy.generates('codex', 'chat/completions'), true)
  assert.equal(Proxy.route('claude', 'chat/completions'), undefined)
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

test('the meter keeps what a gateway paid for the web calls of a response, and counts other tools', () => {
  const messages = Proxy.meter('claude')
  messages.push(
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30,"cost":0.026016,"server_tool_use":{"web_search_requests":2,"web_fetch_requests":1,"code_execution_requests":3},"web":{"calls":3,"paid":0.026,"wallet":0.026}}}\n\n',
  )
  const gateway = messages.usage()!
  assert.equal(gateway.webUsd, 0.026)
  assert.deepEqual(gateway.otherTools, { code_execution: 3 })
  assert.deepEqual(Proxy.tools('claude', gateway, { listed: true }), {
    calls: 6,
    unpriced: 3,
    usd: 0.026,
  })

  const responses = Proxy.meter('codex')
  responses.push(
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-luna","output":[{"type":"web_search_call"},{"type":"function_call"},{"type":"file_search_call"},{"type":"code_interpreter_call"},{"type":"web_search_call"}],"usage":{"input_tokens":12,"output_tokens":4,"cost":0.0241,"web":{"calls":2,"paid":0.024,"wallet":0}}}}\n\n',
  )
  const paid = responses.usage()!
  assert.equal(paid.webSearches, 2)
  assert.equal(paid.webUsd, 0.024)
  assert.deepEqual(paid.otherTools, { code_interpreter: 1, file_search: 1 })
})

test('a tool the provider ran has the price its response names, else its list price, else none', () => {
  const usage = {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    inputTokens: 10,
    outputTokens: 4,
    webFetches: 2,
    webSearches: 3,
  }
  const listed = { listed: true }
  assert.deepEqual(Proxy.tools('claude', usage, listed), { calls: 5, unpriced: 0, usd: 0.03 })
  assert.deepEqual(
    Proxy.tools('codex', { ...usage, webFetches: 0 }, listed),
    { calls: 3, unpriced: 0, usd: 0.03 },
    'a search of the Responses API at its list price',
  )
  assert.deepEqual(
    Proxy.tools('codex', { ...usage, otherTools: { code_interpreter: 1, file_search: 4 } }, listed),
    { calls: 10, unpriced: 3, usd: 0.04 },
    'a fetch of the Responses API and a container have no price a call',
  )
  assert.deepEqual(
    Proxy.tools('claude', { ...usage, costUsd: 0.5 }, listed),
    { calls: 5, unpriced: 5 },
    'a cost that names no web calls may hold them or not',
  )
  assert.deepEqual(
    Proxy.tools('claude', { ...usage, costUsd: 0.5, webUsd: 0.036 }, listed),
    { calls: 5, unpriced: 0, usd: 0.036 },
    'what the endpoint paid is the price, and it is in the cost',
  )
  assert.deepEqual(Proxy.tools('claude', usage, { listed: false }), { calls: 5, unpriced: 5 })
  assert.deepEqual(Proxy.tools('claude', { ...usage, webFetches: 0, webSearches: 0 }, listed), {
    calls: 0,
    unpriced: 0,
  })
  assert.deepEqual(
    Proxy.tools('claude', { ...usage, webFetches: 2, webSearches: 0 }, listed),
    { calls: 2, unpriced: 0, usd: 0 },
    'a fetch costs its tokens and nothing a call, which is a price',
  )
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
      reasoningTokens: 5,
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

  const hour = Proxy.meter('claude')
  hour.push(
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_read_input_tokens":50,"cache_creation_input_tokens":8,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":5},"output_tokens":1}}}\n\n',
  )
  hour.push(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
  )
  assert.deepEqual(hour.usage(), {
    cacheWriteHourTokens: 5,
    cacheWriteTokens: 8,
    cachedTokens: 50,
    inputTokens: 60,
    model: 'claude-opus-5-5',
    outputTokens: 9,
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

  const chat = Proxy.meter('codex')
  chat.push(
    'data: {"object":"chat.completion.chunk","model":"open-model","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}],"usage":null}\n\n',
  )
  chat.push(
    'data: {"object":"chat.completion.chunk","model":"open-model","choices":[],"usage":{"prompt_tokens":300,"completion_tokens":20,"total_tokens":320,"prompt_tokens_details":{"cached_tokens":100},"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
  )
  chat.push('data: [DONE]\n\n')
  assert.deepEqual(chat.usage(), {
    cacheWriteTokens: 0,
    cachedTokens: 100,
    inputTokens: 300,
    model: 'open-model',
    outputTokens: 20,
    reasoningTokens: 5,
  })
  const completion = Proxy.meter('codex')
  completion.push(
    '{"object":"chat.completion","model":"open-model","usage":{"prompt_tokens":12,"completion_tokens":3,"cost":0.0004}}',
  )
  assert.deepEqual(completion.usage(), {
    cacheWriteTokens: 0,
    cachedTokens: 0,
    costUsd: 0.0004,
    inputTokens: 12,
    model: 'open-model',
    outputTokens: 3,
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
          source: 'release',
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

function released(input: { cache: string; home: string; path?: string }) {
  Fs.mkdirSync(input.home, { recursive: true })
  Fs.copyFileSync(Path.resolve('sandbox/slot.sh'), Path.join(input.home, 'slot.sh'))
  const release = Path.join(input.home, 'release')
  Fs.writeFileSync(release, '#!/bin/sh\necho released\n')
  const result = spawnSync(
    'bash',
    [
      '-c',
      Slot.create({ home: input.home }).agents('claude-code', {
        binaries: [
          {
            arch: Os.arch() === 'arm64' ? 'aarch64' : 'x86_64',
            libc: 'gnu',
            sha256: Crypto.createHash('sha256').update(Fs.readFileSync(release)).digest('hex'),
            url: 'file://' + release,
          },
        ],
        entry: 'claude',
        format: 'file',
        provider: 'claude',
        source: 'release',
        version: '1.0.0',
      }),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(input.path ? { PATH: input.path + ':' + process.env['PATH'] } : {}),
        NANOEVAL_AGENT_CLAUDE_CODE: '',
        NANOEVAL_CACHE: input.cache,
      },
    },
  )
  return { entry: Path.join(input.home, 'rt/agents/claude-code/gnu/claude'), result }
}

test('a slot installs a release whose hard links into its home fail half way', () => {
  const bin = Path.join(root, 'half', 'bin')
  Fs.mkdirSync(bin, { recursive: true })
  const cp = execFileSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim()
  Fs.writeFileSync(
    Path.join(bin, 'cp'),
    '#!/bin/sh\nif [ "$1" = -al ]; then mkdir -p "$3"; exit 1; fi\nexec ' + cp + ' "$@"\n',
    { mode: 0o755 },
  )
  const { entry, result } = released({
    cache: Path.join(root, 'half', 'cache'),
    home: Path.join(root, 'half', 'sandbox'),
    path: bin,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(execFileSync(entry, { encoding: 'utf8' }), 'released\n')
})

const memory = ['/dev/shm'].find((directory) => {
  try {
    Fs.accessSync(directory, Fs.constants.W_OK)
    return Fs.statSync(directory).dev !== Fs.statSync(root).dev
  } catch {
    return false
  }
})

test(
  'a slot installs a release from a cache on another filesystem than its home',
  { skip: memory ? false : 'this machine has no second filesystem to write to' },
  () => {
    const cache = Fs.mkdtempSync(Path.join(memory!, 'nanoeval-installed-'))
    try {
      const { entry, result } = released({ cache, home: Path.join(root, 'apart', 'sandbox') })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(execFileSync(entry, { encoding: 'utf8' }), 'released\n')
      assert.equal(Fs.statSync(entry).nlink, 1)
    } finally {
      Fs.rmSync(cache, { force: true, recursive: true })
    }
  },
)

test('an installed agent of a closed task is started without the web tools that its provider runs, and of an open task as it was', () => {
  const url = 'http://127.0.0.1:8787/v1/runs/r/model/a00001'
  const last = (script: string) => script.trimEnd().split('\n').at(-1)
  const web = '--disallowedTools WebFetch WebSearch'
  const claude: Installed.Agent = {
    kind: 'claude-code',
    model: 'claude-opus-5-5',
    thinking: 'high',
  }
  const open = Installed.script(claude, { url })
  assert.equal(
    last(open),
    "exec \"$cli\" -p --output-format stream-json --verbose --dangerously-skip-permissions --model 'claude-opus-5-5' --effort 'high'",
  )
  assert.equal(Installed.script(claude, { closed: false, url }), open)
  assert.equal(
    Installed.script(claude, { closed: true, url }),
    open.replace(' --model ', ' ' + web + ' --model '),
  )
  const stock = Installed.script({ ...claude, kind: 'stock-claude' }, { url })
  assert.equal(
    last(stock),
    'printf "%s" "$prompt" | "$cli" --verbose --output-format=stream-json --effort \'high\' --permission-mode=bypassPermissions --print 2>&1',
  )
  assert.equal(
    Installed.script({ ...claude, kind: 'stock-claude' }, { closed: true, url }),
    stock.replace(' --effort ', ' ' + web + ' --effort '),
  )
  const codex: Installed.Agent = { kind: 'codex-cli', model: 'gpt-6-luna', thinking: 'high' }
  const exec = Installed.script(codex, { url })
  assert.equal(
    last(exec),
    'exec "$NANOEVAL_AGENT_RT"/agents/codex-cli/any/bin/codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m \'gpt-6-luna\' -c \'model_reasoning_effort="high"\' -c \'model_provider="nanoeval"\' -c \'model_providers.nanoeval={name="nanoeval", base_url="' +
      url +
      '", env_key="NANOEVAL_AGENT_TOKEN", wire_api="responses"}\' -',
  )
  assert.equal(Installed.script(codex, { closed: false, url }), exec)
  assert.equal(
    Installed.script(codex, { closed: true, url }),
    exec.slice(0, -' -\n'.length) + ' -c web_search=disabled -\n',
  )
  const others: Installed.Agent[] = [
    { api: 'messages', kind: 'fx', model: 'm' },
    { kind: 'nanocode-claude', model: 'm' },
    { kind: 'nanocode-codex', model: 'm' },
    { api: 'messages', kind: 'opencode', model: 'm' },
    { api: 'messages', kind: 'pi', model: 'm' },
    { kind: 'stock-codex', model: 'm' },
  ]
  for (const agent of others)
    assert.equal(Installed.script(agent, { closed: true, url }), Installed.script(agent, { url }))
  assert.equal(
    Installed.script({ kind: 'stock-codex', model: 'm' }, { url }).includes(
      ' -c web_search=disabled ',
    ),
    true,
  )
})
