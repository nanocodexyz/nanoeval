import type * as Atif from './Atif.ts'
import * as Blocklist from './Blocklist.ts'
import * as CodexFallback from './CodexFallback.ts'
import * as Slot from './Slot.ts'

export type Api = 'chat' | 'messages' | 'responses'

export type Kind =
  | 'claude-code'
  | 'codex-cli'
  | 'fx'
  | 'goose'
  | 'nanocode-claude'
  | 'nanocode-codex'
  | 'opencode'
  | 'pi'
  | 'stock-claude'
  | 'stock-codex'

export type Agent = {
  api?: Api
  hedgeCapPercent?: number
  kind: Kind
  model: string
  thinking?: string
}

export type Binary = {
  arch: 'aarch64' | 'x86_64'
  libc: 'any' | 'gnu' | 'musl'
  sha256: string
  url: string
}

export type Release =
  | {
      binaries: readonly Binary[]
      entry: string
      format: 'file' | 'tar.gz'
      provider: 'api' | 'claude' | 'codex'
      source: 'release'
      version: string
    }
  | { provider: 'claude' | 'codex'; source: 'runtime'; version: string }

export const apis: Record<Api, 'claude' | 'codex'> = {
  chat: 'codex',
  messages: 'claude',
  responses: 'codex',
}

export const kinds: readonly Kind[] = [
  'claude-code',
  'codex-cli',
  'fx',
  'goose',
  'nanocode-claude',
  'nanocode-codex',
  'opencode',
  'pi',
  'stock-claude',
  'stock-codex',
]

export const events = 'agent/events.jsonl'
export const instruction = 'agent/instruction.md'
export const tokenVariable = 'NANOEVAL_AGENT_TOKEN'

const claude =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.318'
const codex = 'https://github.com/openai/codex/releases/download/rust-v0.166.0'
const fx = 'https://github.com/vercel-labs/fx/releases/download/v0.0.17'
const goose = 'https://github.com/block/goose/releases/download/v1.59.2'
const opencode = 'https://github.com/sst/opencode/releases/download/v1.19.5'
const pi = 'https://github.com/badlogic/pi-mono/releases/download/v1.5.2'
const leaderboardClaude =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.300'
const leaderboardCodex = 'https://github.com/openai/codex/releases/download/rust-v0.162.1'

export const leaderboard = { contextWindow: 1_048_576, replyLimit: 65_536 } as const

// The window Workers AI serves each model with, which every agent of the model is told alike: a
// harness told the leaderboard default for a 262K model never compacts before the endpoint refuses
// the request, and the nanocode session would otherwise assume 272K for a model it does not know.
// Each value is the max_model_len the endpoint reports when asked for more output than it holds.
export const contextWindows: Readonly<Record<string, number>> = {
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017': 1_048_576,
  '@cf/google/gemma-4-26b-a4b-it': 256_000,
  '@cf/moonshotai/kimi-k2.6': 262_144,
  '@cf/moonshotai/kimi-k2.7-code': 262_144,
  '@cf/qwen/qwen3.8-27b': 262_144,
  '@cf/zai-org/glm-5.3-flash': 1_048_576,
}

export function contextWindow(model: string): number | undefined {
  return contextWindows[model]
}

export const releases: Record<Kind, Release> = {
  'claude-code': {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'gnu',
        sha256: '53a0d7e219d7b0804ecba5dbc002745e89f786cc946d2de85a6470d5b2d1fb06',
        url: claude + '/linux-arm64/claude',
      },
      {
        arch: 'aarch64',
        libc: 'musl',
        sha256: 'a5ec862f882101dbe3e959ec166ab144e902a8e8e76215a2345b3860fe92ad28',
        url: claude + '/linux-arm64-musl/claude',
      },
      {
        arch: 'x86_64',
        libc: 'gnu',
        sha256: '708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd',
        url: claude + '/linux-x64/claude',
      },
      {
        arch: 'x86_64',
        libc: 'musl',
        sha256: 'e6ff03823153a699d708c88c2fa87d18a1f6b45f13b14a985a221f8af442dd54',
        url: claude + '/linux-x64-musl/claude',
      },
    ],
    entry: 'claude',
    format: 'file',
    provider: 'claude',
    source: 'release',
    version: '2.1.318',
  },
  'codex-cli': {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'any',
        sha256: '7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6',
        url: codex + '/codex-package-aarch64-unknown-linux-musl.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'any',
        sha256: '1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254',
        url: codex + '/codex-package-x86_64-unknown-linux-musl.tar.gz',
      },
    ],
    entry: 'bin/codex',
    format: 'tar.gz',
    provider: 'codex',
    source: 'release',
    version: '0.166.0',
  },
  fx: {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'any',
        sha256: 'b4633b8987ec43f1b9454e4629f3b5a4f1e086aae36b84ae4fefeacd6a53761f',
        url: fx + '/fx-linux-aarch64.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'any',
        sha256: '78c155d59fa59e42fd56d93037fd75041868c9c67865e8c7f0ca6dcdfac23e75',
        url: fx + '/fx-linux-x86_64.tar.gz',
      },
    ],
    entry: 'fx',
    format: 'tar.gz',
    provider: 'api',
    source: 'release',
    version: '0.0.17',
  },
  goose: {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'gnu',
        sha256: 'ec2e0aded1e2aba8d310727a5138f2e3cce0769f2611fbe196ed014c31ce370a',
        url: goose + '/goose-aarch64-unknown-linux-gnu.tar.gz',
      },
      {
        arch: 'aarch64',
        libc: 'musl',
        sha256: 'd5d2b4b999c6664a15684d0972e84afd6a1b7cb8ca9e72b49bf335d0e8e08b93',
        url: goose + '/goose-aarch64-unknown-linux-musl.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'gnu',
        sha256: 'c63cf82953e968d84b7542eb38a621dfdb5050b967728ed363517be5cdc666ea',
        url: goose + '/goose-x86_64-unknown-linux-gnu.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'musl',
        sha256: '73c40735b207e583cc827b087df07680fbd97d56d42a2940ffe692f9e077f6c8',
        url: goose + '/goose-x86_64-unknown-linux-musl.tar.gz',
      },
    ],
    entry: 'goose',
    format: 'tar.gz',
    provider: 'api',
    source: 'release',
    version: '1.59.2',
  },
  'nanocode-claude': {
    provider: 'claude',
    source: 'runtime',
    version: 'runtime-' + Slot.runtime.sha256.slice(0, 12),
  },
  'nanocode-codex': {
    provider: 'codex',
    source: 'runtime',
    version: 'runtime-' + Slot.runtime.sha256.slice(0, 12),
  },
  opencode: {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'gnu',
        sha256: 'fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b',
        url: opencode + '/opencode-linux-arm64.tar.gz',
      },
      {
        arch: 'aarch64',
        libc: 'musl',
        sha256: '3522eccafd30d84a2d770b72a56d4877c576b9072b36a5a9ea0fa30ed82b896e',
        url: opencode + '/opencode-linux-arm64-musl.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'gnu',
        sha256: '588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a',
        url: opencode + '/opencode-linux-x64.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'musl',
        sha256: 'e8d5be23bf8f3f69bc3206f3311215c049329cd6afa7c06d733987cc2d33b568',
        url: opencode + '/opencode-linux-x64-musl.tar.gz',
      },
    ],
    entry: 'opencode',
    format: 'tar.gz',
    provider: 'api',
    source: 'release',
    version: '1.19.5',
  },
  pi: {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'gnu',
        sha256: '42805cd5615952fcbbfc9c56b04f8feb84395134952e169a6cdc8d7676975666',
        url: pi + '/pi-linux-arm64.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'gnu',
        sha256: '811c6f2c9e7aaee252b5404252e556fb713aa209c1f7f924226aa77d4ef70cb5',
        url: pi + '/pi-linux-x64.tar.gz',
      },
    ],
    entry: 'pi/pi',
    format: 'tar.gz',
    provider: 'api',
    source: 'release',
    version: '1.5.2',
  },
  'stock-claude': {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'gnu',
        sha256: 'ae2295ae2da156936bf5831ab01971ce924d0c9a0af174e28d96fffa8d5fa0a6',
        url: leaderboardClaude + '/linux-arm64/claude',
      },
      {
        arch: 'aarch64',
        libc: 'musl',
        sha256: '267fecafb9df3dc1ef93f01ea936742455151d38b9bceebc4c12b531df827a2c',
        url: leaderboardClaude + '/linux-arm64-musl/claude',
      },
      {
        arch: 'x86_64',
        libc: 'gnu',
        sha256: '674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453',
        url: leaderboardClaude + '/linux-x64/claude',
      },
      {
        arch: 'x86_64',
        libc: 'musl',
        sha256: '426e7b0a3726d656babc943a92392eb3653377587658a240ab442d19e4eef3c9',
        url: leaderboardClaude + '/linux-x64-musl/claude',
      },
    ],
    entry: 'claude',
    format: 'file',
    provider: 'claude',
    source: 'release',
    version: '2.1.300',
  },
  'stock-codex': {
    binaries: [
      {
        arch: 'aarch64',
        libc: 'any',
        sha256: '53a9ce0b94beb27a63fdeb2f7704d95199e17b3898aa33b60461a1a93ac0d88b',
        url: leaderboardCodex + '/codex-package-aarch64-unknown-linux-musl.tar.gz',
      },
      {
        arch: 'x86_64',
        libc: 'any',
        sha256: 'a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3',
        url: leaderboardCodex + '/codex-package-x86_64-unknown-linux-musl.tar.gz',
      },
    ],
    entry: 'bin/codex',
    format: 'tar.gz',
    provider: 'codex',
    source: 'release',
    version: '0.162.1',
  },
}

function codexEvents(kind: Kind): boolean {
  return kind === 'codex-cli' || kind === 'stock-codex'
}

export const anthropicMessagesUrl = 'NANOCODE_ANTHROPIC_MESSAGES_URL'
export const anthropicApiKey = 'NANOCODE_ANTHROPIC_API_KEY'

export function is(provider: string): provider is Kind {
  return (kinds as readonly string[]).includes(provider)
}

export function provider(kind: Kind, api?: Api): 'claude' | 'codex' {
  const fixed = releases[kind].provider
  if (fixed !== 'api') return fixed
  if (!api) throw new Error(kind + ' names no API for its model')
  return apis[api]
}

export const harnesses: readonly string[] = kinds.flatMap((kind) =>
  releases[kind].provider === 'api' ? Object.keys(apis).map((api) => kind + '-' + api) : [kind],
)

export function harness(name: string): { api?: Api; kind: Kind } | undefined {
  if (is(name)) return releases[name].provider === 'api' ? undefined : { kind: name }
  const cut = name.lastIndexOf('-')
  const kind = name.slice(0, cut)
  const api = name.slice(cut + 1)
  return is(kind) && releases[kind].provider === 'api' && Object.hasOwn(apis, api)
    ? { api: api as Api, kind }
    : undefined
}

export function name(agent: { api?: Api; provider: string }): string {
  return agent.provider + (agent.api ? '-' + agent.api : '')
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

const preamble = ['set -eu', 'mkdir -p "$NANOEVAL_AGENT_HOME"']

const prompt = ['prompt=$(cat; printf x)', 'prompt=${prompt%x}']

const claudeWebTools = ['WebFetch', 'WebSearch']

function claudeClosed(options: Options): string[] {
  return [
    ...(options.closed ? ['--disallowedTools ' + claudeWebTools.join(' ')] : []),
    ...(options.blocklist ? ['--settings "$NANOEVAL_AGENT_HOME/web-blocklist.json"'] : []),
  ]
}

const hookEnd = 'NANOEVAL_WEB_BLOCKLIST'

function claudeBlocklist(options: Options): string[] {
  if (!options.blocklist) return []
  const hook = Blocklist.hook(options.blocklist)
  if (hook.split('\n').includes(hookEnd))
    throw new Error('the web blocklist hook ends its own here-document')
  return [
    'cat > "$NANOEVAL_AGENT_HOME/web-blocklist.sh" <<\'' + hookEnd + "'",
    ...hook.trimEnd().split('\n'),
    hookEnd,
    'cat > "$NANOEVAL_AGENT_HOME/web-blocklist.json" <<' + hookEnd,
    '{"hooks":{"PreToolUse":[{"matcher":"WebFetch","hooks":[{"type":"command","command":"sh $NANOEVAL_AGENT_HOME/web-blocklist.sh"}]}]}}',
    hookEnd,
  ]
}

export type Options = { blocklist?: Blocklist.List; closed?: boolean; url: string }

const fxApis: Record<Api, { base: string; effort: (level: string) => unknown; protocol: string }> =
  {
    chat: {
      base: '',
      effort: (level) => ({ reasoning_effort: level }),
      protocol: 'openai-chat-completions',
    },
    messages: {
      base: '/v1',
      effort: (level) => ({ output_config: { effort: level }, thinking: { type: 'adaptive' } }),
      protocol: 'anthropic-messages',
    },
    responses: {
      base: '',
      effort: (level) => ({ reasoning: { effort: level } }),
      protocol: 'openai-responses',
    },
  }

function fxAsk(agent: Agent, url: string): string {
  if (!agent.api) throw new Error('fx names no API for its model')
  const api = fxApis[agent.api]
  const settings = {
    models: { nanoeval: agent.model },
    provider: 'nanoeval',
    providers: {
      nanoeval: {
        auth: { env: tokenVariable, type: 'bearer' },
        base_url: url + api.base,
        model_metadata: {
          [agent.model]: {
            max_output_tokens: leaderboard.replyLimit,
            ...(agent.thinking
              ? { reasoning_efforts: { [agent.thinking]: api.effort(agent.thinking) } }
              : {}),
          },
        },
        protocol: api.protocol,
      },
    },
  }
  return (
    [
      ...preamble,
      'export FX_HOME="$NANOEVAL_AGENT_HOME/fx" FX_AUTO_UPGRADE=0',
      'mkdir -p "$FX_HOME"',
      'cat >"$FX_HOME/settings.json" <<\'NANOEVAL_FX_SETTINGS\'',
      JSON.stringify(settings, null, 2),
      'NANOEVAL_FX_SETTINGS',
      [
        'exec "$NANOEVAL_AGENT_RT"/agents/fx/any/fx ask',
        '--json',
        '--full-access',
        '--model ' + quote(agent.model),
        ...(agent.thinking ? ['--effort ' + quote(agent.thinking)] : []),
      ].join(' '),
    ].join('\n') + '\n'
  )
}

const glibcLoaders = ['/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-aarch64.so.1']

function glibc(options: { musl: boolean }): string {
  return glibcLoaders
    .map((loader) =>
      options.musl
        ? '{ [ -e ' + loader + ' ] && ! grep -q musl ' + loader + '; }'
        : '[ -e ' + loader + ' ]',
    )
    .join(' || ')
}

function build(kind: Kind, name: string): string[] {
  const release = releases[kind]
  if (release.source !== 'release') throw new Error(kind + ' has no release to choose a build of')
  const root = '"$NANOEVAL_AGENT_RT"/agents/' + kind
  const libcs = release.binaries.map((binary) => binary.libc)
  return [
    'if [ -x ' + root + '/any/' + release.entry + ' ]; then cli=' + root + '/any/' + release.entry,
    ...(libcs.includes('gnu')
      ? [
          'elif ' +
            glibc({ musl: libcs.includes('musl') }) +
            '; then cli=' +
            root +
            '/gnu/' +
            release.entry,
        ]
      : []),
    ...(libcs.includes('musl')
      ? ['elif [ -e "/lib/ld-musl-$(uname -m).so.1" ]; then cli=' + root + '/musl/' + release.entry]
      : []),
    'else',
    "  echo 'nanoeval: this image has no loader that a build of " + name + " runs with' >&2",
    '  exit 127',
    'fi',
  ]
}

function gooseRun(agent: Agent, url: string): string {
  if (!agent.api) throw new Error('goose names no API for its model')
  const endpoint = new URL(url)
  const path = endpoint.pathname.replace(/^\/+|\/+$/g, '')
  const base = (path ? path + '/' : '') + (agent.api === 'chat' ? 'chat/completions' : 'responses')
  return (
    [
      ...preamble,
      ...build('goose', 'goose'),
      'export XDG_CACHE_HOME="$NANOEVAL_AGENT_HOME/cache" XDG_CONFIG_HOME="$NANOEVAL_AGENT_HOME/config"',
      'export XDG_DATA_HOME="$NANOEVAL_AGENT_HOME/data" XDG_STATE_HOME="$NANOEVAL_AGENT_HOME/state"',
      'export GOOSE_DISABLE_KEYRING=1 GOOSE_MODE=auto GOOSE_TELEMETRY_ENABLED=false',
      'export GOOSE_MODEL=' + quote(agent.model),
      ...(agent.thinking ? ['export GOOSE_THINKING_EFFORT=' + quote(agent.thinking)] : []),
      ...(agent.api === 'messages'
        ? [
            'export GOOSE_PROVIDER=anthropic ANTHROPIC_HOST=' + quote(url),
            'export ANTHROPIC_API_KEY="$' + tokenVariable + '"',
          ]
        : [
            'export GOOSE_PROVIDER=openai OPENAI_HOST=' + quote(endpoint.origin),
            'export OPENAI_BASE_PATH=' + quote(base),
            'export OPENAI_API_KEY="$' + tokenVariable + '"',
          ]),
      'exec "$cli" run --no-session --no-profile --with-builtin developer --output-format stream-json -i -',
    ].join('\n') + '\n'
  )
}

const opencodeApis: Record<Api, { base: string; npm: string }> = {
  chat: { base: '', npm: '@ai-sdk/openai-compatible' },
  messages: { base: '/v1', npm: '@ai-sdk/anthropic' },
  responses: { base: '', npm: '@ai-sdk/openai' },
}

function opencodeLimit(model: string): { limit?: { context: number; output: number } } {
  const context = contextWindow(model)
  return context ? { limit: { context, output: leaderboard.replyLimit } } : {}
}

function opencodeRun(agent: Agent, url: string): string {
  if (!agent.api) throw new Error('opencode names no API for its model')
  const api = opencodeApis[agent.api]
  const config = {
    autoupdate: false,
    permission: 'allow',
    provider: {
      nanoeval: {
        models: {
          // opencode has no variants for a model it does not know, so --variant alone sends no effort.
          [agent.model]: {
            ...(agent.thinking
              ? {
                  reasoning: true,
                  ...(agent.api === 'chat'
                    ? { variants: { [agent.thinking]: { reasoningEffort: agent.thinking } } }
                    : {}),
                }
              : {}),
            ...opencodeLimit(agent.model),
          },
        },
        npm: api.npm,
        options: { apiKey: '{env:' + tokenVariable + '}', baseURL: url + api.base },
      },
    },
    share: 'disabled',
  }
  return (
    [
      ...preamble,
      ...build('opencode', 'opencode'),
      'export XDG_CACHE_HOME="$NANOEVAL_AGENT_HOME/cache" XDG_CONFIG_HOME="$NANOEVAL_AGENT_HOME/config"',
      'export XDG_DATA_HOME="$NANOEVAL_AGENT_HOME/data" XDG_STATE_HOME="$NANOEVAL_AGENT_HOME/state"',
      'export OPENCODE_DISABLE_LSP_DOWNLOAD=true OPENCODE_DISABLE_MODELS_FETCH=true',
      'export OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=' + leaderboard.replyLimit,
      'export OPENCODE_CONFIG_CONTENT=' + quote(JSON.stringify(config)),
      [
        'exec "$cli" run',
        '--format json',
        '-m ' + quote('nanoeval/' + agent.model),
        ...(agent.thinking ? ['--variant ' + quote(agent.thinking)] : []),
      ].join(' '),
    ].join('\n') + '\n'
  )
}

const piApis: Record<Api, { api: string; thinking: Record<string, unknown> }> = {
  chat: { api: 'openai-completions', thinking: {} },
  messages: { api: 'anthropic-messages', thinking: { compat: { forceAdaptiveThinking: true } } },
  responses: { api: 'openai-responses', thinking: {} },
}

function piPrint(agent: Agent, url: string): string {
  if (!agent.api) throw new Error('pi names no API for its model')
  const api = piApis[agent.api]
  const models = {
    providers: {
      nanoeval: {
        api: api.api,
        apiKey: '$' + tokenVariable,
        authHeader: true,
        baseUrl: url,
        models: [
          {
            id: agent.model,
            ...(contextWindow(agent.model) ? { contextWindow: contextWindow(agent.model) } : {}),
            maxTokens: leaderboard.replyLimit,
            ...(agent.thinking ? { ...api.thinking, reasoning: true } : {}),
          },
        ],
      },
    },
  }
  return (
    [
      ...preamble,
      ...build('pi', 'pi'),
      'export PI_CODING_AGENT_DIR="$NANOEVAL_AGENT_HOME/pi" PI_OFFLINE=1',
      'mkdir -p "$PI_CODING_AGENT_DIR"',
      'cat >"$PI_CODING_AGENT_DIR/models.json" <<\'NANOEVAL_PI_MODELS\'',
      JSON.stringify(models, null, 2),
      'NANOEVAL_PI_MODELS',
      [
        'exec "$cli"',
        '-p',
        '--mode json',
        '--no-session',
        '--model ' + quote('nanoeval/' + agent.model),
        ...(agent.thinking ? ['--thinking ' + quote(agent.thinking)] : []),
      ].join(' '),
    ].join('\n') + '\n'
  )
}

function stockCodex(agent: Agent, url: string): string {
  const root = '"$NANOEVAL_AGENT_RT"/agents/stock-codex/any'
  const catalog = '/tmp/hlb-codex-model-catalog.json'
  const entry = {
    ...CodexFallback.model,
    input_modalities: ['text', 'image'],
    slug: agent.model,
    display_name: agent.model,
    context_window: contextWindow(agent.model) ?? leaderboard.contextWindow,
    max_context_window: contextWindow(agent.model) ?? leaderboard.contextWindow,
    model_messages: { instructions_template: CodexFallback.instructions },
  }
  const config = [
    'model_provider = "hill-proxy"',
    'model_context_window = ' + (contextWindow(agent.model) ?? leaderboard.contextWindow),
    'model_catalog_json = "' + catalog + '"',
    '',
    '[model_providers.hill-proxy]',
    'name = "hill proxy"',
    'base_url = ' + JSON.stringify(url),
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
    '[features]',
    'multi_agent = false',
    '',
    '[model_providers.hill-proxy.capabilities]',
    'remote_compaction = "unsupported"',
  ]
  return (
    [
      ...preamble,
      'ln -sf ' + root + '/bin/codex /usr/local/bin/codex 2>/dev/null || true',
      'ln -sf ' + root + '/codex-path/rg /usr/local/bin/rg 2>/dev/null || true',
      'export CODEX_HOME=/tmp/codex-home',
      'export OPENAI_API_KEY="$' + tokenVariable + '"',
      'mkdir -p "$CODEX_HOME" /tmp/codex-secrets',
      'cat >/tmp/codex-secrets/auth.json <<EOF',
      '{',
      '  "OPENAI_API_KEY": "${OPENAI_API_KEY}"',
      '}',
      'EOF',
      'ln -sf /tmp/codex-secrets/auth.json "$CODEX_HOME/auth.json"',
      'cat >"$CODEX_HOME/config.toml" <<\'NANOEVAL_CODEX_CONFIG\'',
      ...config,
      'NANOEVAL_CODEX_CONFIG',
      'cat >' + catalog + " <<'NANOEVAL_CODEX_CATALOG'",
      JSON.stringify({ models: [entry] }, null, 2),
      'NANOEVAL_CODEX_CATALOG',
      ...prompt,
      'if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi',
      [
        'exec ' + root + '/bin/codex exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--model ' + quote(agent.model),
        '--json',
        '--enable unified_exec',
        ...(agent.thinking ? ['-c model_reasoning_effort=' + quote(agent.thinking)] : []),
        '-c web_search=disabled',
        '-- "$prompt" 2>&1 </dev/null',
      ].join(' '),
    ].join('\n') + '\n'
  )
}

function stockClaude(agent: Agent, options: Options): string {
  const root = '"$NANOEVAL_AGENT_RT"/agents/stock-claude'
  const model = quote(agent.model)
  return (
    [
      ...preamble,
      'if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then cli=' +
        root +
        '/musl/claude; else cli=' +
        root +
        '/gnu/claude; fi',
      'ln -sf "$cli" /usr/local/bin/claude 2>/dev/null || true',
      'export ANTHROPIC_AUTH_TOKEN="$' + tokenVariable + '"',
      'export ANTHROPIC_BASE_URL=' + quote(options.url),
      'export ANTHROPIC_MODEL=' + model,
      'export ANTHROPIC_DEFAULT_SONNET_MODEL=' + model,
      'export ANTHROPIC_DEFAULT_OPUS_MODEL=' + model,
      'export ANTHROPIC_DEFAULT_HAIKU_MODEL=' + model,
      'export CLAUDE_CODE_SUBAGENT_MODEL=' + model,
      'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 IS_SANDBOX=1',
      'export CLAUDE_CODE_MAX_CONTEXT_TOKENS=' +
        (contextWindow(agent.model) ?? leaderboard.contextWindow),
      'export CLAUDE_CODE_MAX_OUTPUT_TOKENS=' + leaderboard.replyLimit,
      'export CLAUDE_CONFIG_DIR=/logs/agent/sessions',
      'mkdir -p $CLAUDE_CONFIG_DIR/debug $CLAUDE_CONFIG_DIR/projects/-app $CLAUDE_CONFIG_DIR/shell-snapshots $CLAUDE_CONFIG_DIR/statsig $CLAUDE_CONFIG_DIR/todos $CLAUDE_CONFIG_DIR/skills',
      'export PATH="${HOME:-/root}/.local/bin:$PATH"',
      ...claudeBlocklist(options),
      ...prompt,
      [
        'printf "%s" "$prompt" | "$cli"',
        '--verbose',
        '--output-format=stream-json',
        ...claudeClosed(options),
        ...(agent.thinking ? ['--effort ' + quote(agent.thinking)] : []),
        '--permission-mode=bypassPermissions',
        '--print 2>&1',
      ].join(' '),
    ].join('\n') + '\n'
  )
}

export function script(agent: Agent, options: Options): string {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]_/-]+$/.test(options.url))
    throw new Error('the model endpoint is not a plain http or https address: ' + options.url)
  const root = '"$NANOEVAL_AGENT_RT"/agents/' + agent.kind
  const release = releases[agent.kind]
  if (release.source === 'runtime') {
    const harness = release.provider
    return (
      [
        ...preamble,
        'if [ -x "$NANOEVAL_AGENT_RT/ld.so" ]; then',
        '  set -- "$NANOEVAL_AGENT_RT/ld.so" --library-path "$NANOEVAL_AGENT_RT/lib" "$NANOEVAL_AGENT_RT/nanocode"',
        'else',
        '  set -- "$NANOEVAL_AGENT_RT/nanocode"',
        'fi',
        'export NANOCODE_HOME="$NANOEVAL_AGENT_HOME"',
        'export NANOCODE_OPENAI_BASE_URL=' + quote(options.url),
        'export NANOCODE_OPENAI_API_KEY="$' + tokenVariable + '"',
        'export NO_COLOR=1',
        ...(harness === 'claude'
          ? [
              'export ' + anthropicMessagesUrl + '=' + quote(options.url + '/v1/messages'),
              'export NANOCODE_ANTHROPIC_BASE_URL=' + quote(options.url + '/v1'),
              'export ' + anthropicApiKey + '="$' + tokenVariable + '"',
              'export NANOCODE_MODELS_URL=' + quote(options.url + '/models'),
            ]
          : []),
        ...prompt,
        [
          'exec "$@" exec',
          '--model ' + quote(agent.model),
          '--harness ' + harness,
          ...(agent.thinking ? ['--thinking ' + quote(agent.thinking)] : []),
          '--ephemeral',
          '--no-tempo-tools',
          ...(agent.hedgeCapPercent === undefined
            ? []
            : ['--hedge-cap-percent ' + agent.hedgeCapPercent]),
          ...(harness === 'claude'
            ? ['--context-window ' + (contextWindow(agent.model) ?? leaderboard.contextWindow)]
            : contextWindow(agent.model)
              ? ['--context-window ' + contextWindow(agent.model)]
              : []),
          '--max-output-tokens ' + leaderboard.replyLimit,
          '"$prompt" </dev/null',
        ].join(' '),
      ].join('\n') + '\n'
    )
  }
  if (agent.kind === 'fx') return fxAsk(agent, options.url)
  if (agent.kind === 'goose') return gooseRun(agent, options.url)
  if (agent.kind === 'opencode') return opencodeRun(agent, options.url)
  if (agent.kind === 'pi') return piPrint(agent, options.url)
  if (agent.kind === 'stock-codex') return stockCodex(agent, options.url)
  if (agent.kind === 'stock-claude') return stockClaude(agent, options)
  if (agent.kind === 'codex-cli') {
    const provider =
      'model_providers.nanoeval={name="nanoeval", base_url="' +
      options.url +
      '", env_key="' +
      tokenVariable +
      '", wire_api="responses"}'
    return (
      [
        ...preamble,
        'export CODEX_HOME="$NANOEVAL_AGENT_HOME"',
        [
          'exec ' + root + '/any/' + release.entry,
          'exec',
          '--json',
          '--dangerously-bypass-approvals-and-sandbox',
          '--skip-git-repo-check',
          '-m ' + quote(agent.model),
          ...(agent.thinking
            ? ['-c ' + quote('model_reasoning_effort="' + agent.thinking + '"')]
            : []),
          '-c ' + quote('model_provider="nanoeval"'),
          '-c ' + quote(provider),
          ...(options.closed ? ['-c web_search=disabled'] : []),
          '-',
        ].join(' '),
      ].join('\n') + '\n'
    )
  }
  return (
    [
      ...preamble,
      'if [ -x ' + root + '/any/claude ]; then cli=' + root + '/any/claude',
      'elif ' + glibc({ musl: true }) + '; then cli=' + root + '/gnu/claude',
      'elif [ -e "/lib/ld-musl-$(uname -m).so.1" ]; then cli=' + root + '/musl/claude',
      'else',
      "  echo 'nanoeval: this image has neither the glibc nor the musl loader that Claude Code needs' >&2",
      '  exit 127',
      'fi',
      'export CLAUDE_CONFIG_DIR="$NANOEVAL_AGENT_HOME"',
      'export ANTHROPIC_BASE_URL=' + quote(options.url),
      'export ANTHROPIC_AUTH_TOKEN="$' + tokenVariable + '"',
      'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 IS_SANDBOX=1',
      ...claudeBlocklist(options),
      [
        'exec "$cli"',
        '-p',
        '--output-format stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        ...claudeClosed(options),
        '--model ' + quote(agent.model),
        ...(agent.thinking ? ['--effort ' + quote(agent.thinking)] : []),
      ].join(' '),
    ].join('\n') + '\n'
  )
}

type Line = Record<string, any>

function lines(stream: string): Line[] {
  const parsed: Line[] = []
  for (const line of stream.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value === 'object' && value !== null) parsed.push(value as Line)
    } catch {}
  }
  return parsed
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part?.text === 'string' ? part.text : part === undefined ? '' : JSON.stringify(part),
      )
      .join('')
  return value === undefined || value === null ? '' : JSON.stringify(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function gooseBlocks(line: Line, role: string): Line[] {
  const message = line['message'] as Line | undefined
  return line['type'] === 'message' &&
    message?.['role'] === role &&
    Array.isArray(message['content'])
    ? message['content']
    : []
}

function piBlocks(message: Line): Line[] {
  return Array.isArray(message['content']) ? message['content'] : []
}

function piText(message: Line, type: 'text' | 'thinking'): string {
  return piBlocks(message)
    .filter((block) => block['type'] === type)
    .map((block) => text(block[type]))
    .join('')
}

export type Summary = {
  costUsd: number | undefined
  error: string | undefined
  message: string
  toolCalls: number
}

const fxStops = [
  'Repeated shell validation failures stopped the tool loop.',
  'Repeated identical shell failures stopped the tool loop.',
  'Repeated malformed tool arguments stopped the agent loop.',
]

export function stopped(kind: Kind, said: string): boolean {
  return kind === 'fx' && fxStops.some((stop) => said.includes(stop))
}

export function summarize(kind: Kind, stream: string): Summary {
  const summary: Summary = { costUsd: undefined, error: undefined, message: '', toolCalls: 0 }
  if (releases[kind].source === 'runtime') {
    summary.message = stream.trim()
    return summary
  }
  for (const line of lines(stream)) {
    if (kind === 'fx') {
      summary.message = text(line['final_output'] || line['output'])
      summary.toolCalls = Array.isArray(line['tool_calls']) ? line['tool_calls'].length : 0
      summary.error = line['error'] === undefined ? undefined : text(line['error'])
      continue
    }
    if (kind === 'goose') {
      const said = gooseBlocks(line, 'assistant')
        .filter((block) => block['type'] === 'text')
        .map((block) => text(block['text']))
        .join('')
      if (said) summary.message = said
      summary.toolCalls += gooseBlocks(line, 'assistant').filter(
        (block) => block['type'] === 'toolRequest',
      ).length
      if (line['type'] === 'error') summary.error = text(line['error'])
      continue
    }
    if (kind === 'opencode') {
      if (line['type'] === 'text') summary.message = text(line['part']?.text)
      if (line['type'] === 'tool_use') summary.toolCalls++
      if (line['type'] === 'error')
        summary.error = text(line['error']?.data?.message ?? line['error']?.name)
      continue
    }
    if (kind === 'pi') {
      const message = line['message'] as Line | undefined
      if (line['type'] === 'message_end' && message?.['role'] === 'assistant') {
        const said = piText(message, 'text')
        if (said) summary.message = said
        summary.error =
          message['stopReason'] === 'error' ? text(message['errorMessage']) : undefined
      }
      if (line['type'] === 'tool_execution_end') summary.toolCalls++
      continue
    }
    if (codexEvents(kind)) {
      const item = line['item']
      if (line['type'] === 'item.completed' && item?.type === 'agent_message')
        summary.message = text(item.text)
      else if (line['type'] === 'item.completed' && item?.type === 'error')
        summary.error = text(item.message)
      else if (line['type'] === 'item.completed' && item?.type !== 'reasoning') summary.toolCalls++
      if (line['type'] === 'turn.failed') summary.error = text(line['error']?.message)
      if (line['type'] === 'error') summary.error = text(line['message'])
      if (line['type'] === 'turn.completed') summary.error = undefined
      continue
    }
    if (line['type'] === 'assistant')
      for (const block of line['message']?.content ?? [])
        if (block?.type === 'tool_use') summary.toolCalls++
    if (line['type'] === 'result') {
      summary.message = text(line['result'])
      if (typeof line['total_cost_usd'] === 'number') summary.costUsd = line['total_cost_usd']
      summary.error = line['is_error'] ? text(line['result']) || String(line['subtype']) : undefined
    }
  }
  return summary
}

export function trajectory(
  kind: Kind,
  input: { instruction?: string; stream: string; usage: Atif.Usage },
  options: Atif.fromEvents.Options,
): Atif.Trajectory {
  const steps: Atif.Step[] = []
  const calls = new Map<string, Atif.Step>()
  const messages = new Map<string, Atif.Step>()
  let session = options.session
  let model = options.model
  let extra: Record<string, unknown> = {}
  const step = (source: Atif.Step['source'], message: string): Atif.Step => {
    const next: Atif.Step = { step_id: steps.length + 1, source, message }
    steps.push(next)
    return next
  }
  const call = (target: Atif.Step, tool: Atif.ToolCall, result?: Atif.Observation) => {
    ;(target.tool_calls ??= []).push(tool)
    calls.set(tool.tool_call_id, target)
    if (result) (target.observation ??= { results: [] }).results.push(result)
  }
  if (input.instruction !== undefined) step('user', input.instruction)
  const runtime = releases[kind].source === 'runtime'
  if (runtime && input.stream.trim()) step('agent', input.stream.trim()).model_name = model

  for (const line of runtime ? [] : lines(input.stream)) {
    if (kind === 'fx') {
      session = text(line['session_id']) || session
      const made = (Array.isArray(line['tool_calls']) ? line['tool_calls'] : []) as Line[]
      const target = made.length ? step('agent', '') : undefined
      made.forEach((tool, index) => {
        const { name, status, ...rest } = tool
        const result = (rest['command_result'] ?? {}) as Line
        call(
          target!,
          {
            tool_call_id: String(index + 1),
            function_name: text(name),
            arguments: typeof result['command'] === 'string' ? { command: result['command'] } : {},
          },
          {
            source_call_id: String(index + 1),
            content: text(rest),
            extra: {
              duration_ns: null,
              ...(typeof result['exit_code'] === 'number'
                ? { exit_code: result['exit_code'] }
                : {}),
              status: text(status),
            },
          },
        )
      })
      if (target) target.model_name = model
      if (line['error'] !== undefined) step('system', 'error: ' + text(line['error']))
      else step('agent', text(line['final_output'] || line['output'])).model_name = model
      continue
    }
    if (kind === 'goose') {
      if (line['type'] === 'error') step('system', 'error: ' + text(line['error']))
      const made = gooseBlocks(line, 'assistant')
      if (made.length) {
        const target = step(
          'agent',
          made
            .filter((block) => block['type'] === 'text')
            .map((block) => text(block['text']))
            .join(''),
        )
        target.model_name = model
        const thought = made
          .filter((block) => block['type'] === 'thinking')
          .map((block) => text(block['thinking']))
          .join('')
        if (thought) target.reasoning_content = thought
        for (const block of made)
          if (block['type'] === 'toolRequest') {
            const value = (block['toolCall']?.value ?? {}) as Line
            call(target, {
              tool_call_id: text(block['id']),
              function_name: text(value['name']),
              arguments: (value['arguments'] ?? {}) as Record<string, unknown>,
            })
          }
      }
      for (const block of gooseBlocks(line, 'user'))
        if (block['type'] === 'toolResponse') {
          const id = text(block['id'])
          const value = (block['toolResult']?.value ?? {}) as Line
          const exit = value['structuredContent']?.exit_code
          const target = calls.get(id) ?? step('agent', '')
          ;(target.observation ??= { results: [] }).results.push({
            source_call_id: id,
            content: text(value['content'] ?? block['toolResult']?.error ?? ''),
            extra: {
              duration_ns: null,
              ...(typeof exit === 'number' ? { exit_code: exit } : {}),
              status:
                value['isError'] || block['toolResult']?.status !== 'success'
                  ? 'failed'
                  : 'completed',
            },
          })
        }
      continue
    }
    if (kind === 'opencode') {
      const part = (line['part'] ?? {}) as Line
      session = text(line['sessionID']) || session
      if (line['type'] === 'text') step('agent', text(part['text'])).model_name = model
      if (line['type'] === 'reasoning') {
        const next = step('agent', '')
        next.model_name = model
        next.reasoning_content = text(part['text'])
      }
      if (line['type'] === 'tool_use') {
        const state = (part['state'] ?? {}) as Line
        const id = text(part['callID'])
        const exit = state['metadata']?.exit
        call(
          step('agent', ''),
          {
            tool_call_id: id,
            function_name: text(part['tool']),
            arguments: (state['input'] ?? {}) as Record<string, unknown>,
          },
          {
            source_call_id: id,
            content: text(state['output'] ?? state['error'] ?? ''),
            extra: {
              duration_ns: null,
              ...(typeof exit === 'number' ? { exit_code: exit } : {}),
              status: text(state['status']),
            },
          },
        )
      }
      if (line['type'] === 'error')
        step('system', 'error: ' + text(line['error']?.data?.message ?? line['error']?.name))
      continue
    }
    if (kind === 'pi') {
      const message = line['message'] as Line | undefined
      if (line['type'] === 'session') session = text(line['id']) || session
      if (line['type'] === 'message_end' && message?.['role'] === 'assistant') {
        if (message['stopReason'] === 'error') {
          step('system', 'error: ' + text(message['errorMessage']))
          continue
        }
        const target = step('agent', piText(message, 'text'))
        const used = (message['usage'] ?? {}) as Line
        const thought = piText(message, 'thinking')
        target.model_name = text(message['model']) || model
        if (thought) target.reasoning_content = thought
        target.metrics = {
          prompt_tokens:
            count(used['input']) + count(used['cacheRead']) + count(used['cacheWrite']),
          completion_tokens: count(used['output']),
          cached_tokens: count(used['cacheRead']),
          extra: { cache_write_input_tokens: count(used['cacheWrite']) },
        }
        for (const block of piBlocks(message))
          if (block['type'] === 'toolCall')
            call(target, {
              tool_call_id: text(block['id']),
              function_name: text(block['name']),
              arguments: (block['arguments'] ?? {}) as Record<string, unknown>,
            })
      }
      if (line['type'] === 'tool_execution_end') {
        const id = text(line['toolCallId'])
        const target = calls.get(id) ?? step('agent', '')
        ;(target.observation ??= { results: [] }).results.push({
          source_call_id: id,
          content: text(line['result']?.content),
          extra: { duration_ns: null, status: line['isError'] ? 'failed' : 'completed' },
        })
      }
      continue
    }
    if (codexEvents(kind)) {
      const item = line['item'] as Line | undefined
      if (line['type'] === 'thread.started') session = text(line['thread_id']) || session
      if (line['type'] === 'turn.failed')
        step('system', 'turn failed: ' + text(line['error']?.message))
      if (line['type'] === 'error') step('system', 'error: ' + text(line['message']))
      if (line['type'] !== 'item.completed' || !item) continue
      const id = text(item['id'])
      const status = text(item['status']) || 'completed'
      switch (item['type']) {
        case 'agent_message':
          step('agent', text(item['text'])).model_name = model
          break
        case 'reasoning': {
          const next = step('agent', '')
          next.model_name = model
          next.reasoning_content = text(item['text'])
          break
        }
        case 'error':
          step('system', 'error: ' + text(item['message']))
          break
        case 'command_execution':
          call(
            step('agent', ''),
            {
              tool_call_id: id,
              function_name: 'command_execution',
              arguments: { command: item['command'] },
            },
            {
              source_call_id: id,
              content: text(item['aggregated_output']),
              extra: {
                duration_ns: null,
                ...(typeof item['exit_code'] === 'number' ? { exit_code: item['exit_code'] } : {}),
                status,
              },
            },
          )
          break
        default: {
          const { id: _, status: __, type, ...rest } = item
          call(
            step('agent', ''),
            { tool_call_id: id, function_name: text(type), arguments: rest },
            {
              source_call_id: id,
              content: text(rest['result'] ?? rest['error'] ?? ''),
              extra: { duration_ns: null, status },
            },
          )
        }
      }
      continue
    }

    if (line['type'] === 'system' && line['subtype'] === 'init') {
      session = text(line['session_id']) || session
      model = text(line['model']) || model
      extra = { tools: line['tools'] }
    }
    if (line['type'] === 'assistant') {
      const message = (line['message'] ?? {}) as Line
      const id = text(message['id'])
      let target = messages.get(id)
      if (!target) {
        target = step('agent', '')
        target.model_name = text(message['model']) || model
        const used = (message['usage'] ?? {}) as Line
        target.metrics = {
          prompt_tokens:
            count(used['input_tokens']) +
            count(used['cache_read_input_tokens']) +
            count(used['cache_creation_input_tokens']),
          completion_tokens: count(used['output_tokens']),
          cached_tokens: count(used['cache_read_input_tokens']),
          extra: { cache_write_input_tokens: count(used['cache_creation_input_tokens']) },
        }
        if (id) messages.set(id, target)
      }
      for (const block of (message['content'] ?? []) as Line[]) {
        if (block['type'] === 'text')
          target.message = target.message
            ? target.message + '\n' + text(block['text'])
            : text(block['text'])
        if (block['type'] === 'thinking')
          target.reasoning_content = (target.reasoning_content ?? '') + text(block['thinking'])
        if (block['type'] === 'tool_use')
          call(target, {
            tool_call_id: text(block['id']),
            function_name: text(block['name']),
            arguments: (block['input'] ?? {}) as Record<string, unknown>,
          })
      }
    }
    if (line['type'] === 'user')
      for (const block of (Array.isArray(line['message']?.content)
        ? line['message'].content
        : []) as Line[])
        if (block['type'] === 'tool_result') {
          const id = text(block['tool_use_id'])
          const target = calls.get(id) ?? step('agent', '')
          ;(target.observation ??= { results: [] }).results.push({
            source_call_id: id,
            content: text(block['content']),
            extra: { duration_ns: null, status: block['is_error'] ? 'failed' : 'completed' },
          })
        }
  }

  const totals = input.usage
  return {
    schema_version: 'ATIF-v1.7',
    session_id: session,
    agent: { name: options.name, version: options.version, model_name: model, extra },
    steps,
    final_metrics: {
      total_prompt_tokens: totals.inputTokens,
      total_completion_tokens: totals.outputTokens,
      total_cached_tokens: totals.cachedTokens,
      ...(totals.costUsd === undefined ? {} : { total_cost_usd: totals.costUsd }),
      total_steps: steps.length,
      extra: {
        cache_write_input_tokens: totals.cacheWriteTokens,
        model_calls: totals.modelCalls,
        tool_calls: totals.toolCalls,
      },
    },
  }
}
