import type * as Atif from './Atif.ts'
import * as CodexFallback from './CodexFallback.ts'
import * as Slot from './Slot.ts'

export type Kind =
  | 'claude-code'
  | 'codex-cli'
  | 'nanocode-claude'
  | 'nanocode-codex'
  | 'stock-claude'
  | 'stock-codex'

export type Agent = { kind: Kind; model: string; thinking?: string }

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
      provider: 'claude' | 'codex'
      source: 'release'
      version: string
    }
  | { provider: 'claude' | 'codex'; source: 'runtime'; version: string }

export const kinds: readonly Kind[] = [
  'claude-code',
  'codex-cli',
  'nanocode-claude',
  'nanocode-codex',
  'stock-claude',
  'stock-codex',
]

export const events = 'agent/events.jsonl'
export const instruction = 'agent/instruction.md'
export const tokenVariable = 'NANOEVAL_AGENT_TOKEN'

const claude =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.318'
const codex = 'https://github.com/openai/codex/releases/download/rust-v0.166.0'
const leaderboardClaude =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.300'
const leaderboardCodex = 'https://github.com/openai/codex/releases/download/rust-v0.162.1'

export const leaderboard = { contextWindow: 1_048_576, replyLimit: 65_536 } as const

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

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

const preamble = ['set -eu', 'mkdir -p "$NANOEVAL_AGENT_HOME"']

const prompt = ['prompt=$(cat; printf x)', 'prompt=${prompt%x}']

function stockCodex(agent: Agent, url: string): string {
  const root = '"$NANOEVAL_AGENT_RT"/agents/stock-codex/any'
  const catalog = '/tmp/hlb-codex-model-catalog.json'
  const entry = {
    ...CodexFallback.model,
    input_modalities: ['text', 'image'],
    slug: agent.model,
    display_name: agent.model,
    context_window: leaderboard.contextWindow,
    max_context_window: leaderboard.contextWindow,
    model_messages: { instructions_template: CodexFallback.instructions },
  }
  const config = [
    'model_provider = "hill-proxy"',
    'model_context_window = ' + leaderboard.contextWindow,
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

function stockClaude(agent: Agent, url: string): string {
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
      'export ANTHROPIC_BASE_URL=' + quote(url),
      'export ANTHROPIC_MODEL=' + model,
      'export ANTHROPIC_DEFAULT_SONNET_MODEL=' + model,
      'export ANTHROPIC_DEFAULT_OPUS_MODEL=' + model,
      'export ANTHROPIC_DEFAULT_HAIKU_MODEL=' + model,
      'export CLAUDE_CODE_SUBAGENT_MODEL=' + model,
      'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 IS_SANDBOX=1',
      'export CLAUDE_CODE_MAX_CONTEXT_TOKENS=' + leaderboard.contextWindow,
      'export CLAUDE_CODE_MAX_OUTPUT_TOKENS=' + leaderboard.replyLimit,
      'export CLAUDE_CONFIG_DIR=/logs/agent/sessions',
      'mkdir -p $CLAUDE_CONFIG_DIR/debug $CLAUDE_CONFIG_DIR/projects/-app $CLAUDE_CONFIG_DIR/shell-snapshots $CLAUDE_CONFIG_DIR/statsig $CLAUDE_CONFIG_DIR/todos $CLAUDE_CONFIG_DIR/skills',
      'export PATH="${HOME:-/root}/.local/bin:$PATH"',
      ...prompt,
      [
        'printf "%s" "$prompt" | "$cli"',
        '--verbose',
        '--output-format=stream-json',
        ...(agent.thinking ? ['--effort ' + quote(agent.thinking)] : []),
        '--permission-mode=bypassPermissions',
        '--print 2>&1',
      ].join(' '),
    ].join('\n') + '\n'
  )
}

export function script(agent: Agent, options: { url: string }): string {
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
          '--context-window ' + leaderboard.contextWindow,
          ...(harness === 'claude' ? ['--max-output-tokens ' + leaderboard.replyLimit] : []),
          '"$prompt" </dev/null',
        ].join(' '),
      ].join('\n') + '\n'
    )
  }
  if (agent.kind === 'stock-codex') return stockCodex(agent, options.url)
  if (agent.kind === 'stock-claude') return stockClaude(agent, options.url)
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
          '-',
        ].join(' '),
      ].join('\n') + '\n'
    )
  }
  return (
    [
      ...preamble,
      'if [ -x ' + root + '/any/claude ]; then cli=' + root + '/any/claude',
      'elif [ -e /lib64/ld-linux-x86-64.so.2 ] || [ -e /lib/ld-linux-aarch64.so.1 ]; then cli=' +
        root +
        '/gnu/claude',
      'elif [ -e "/lib/ld-musl-$(uname -m).so.1" ]; then cli=' + root + '/musl/claude',
      'else',
      "  echo 'nanoeval: this image has neither the glibc nor the musl loader that Claude Code needs' >&2",
      '  exit 127',
      'fi',
      'export CLAUDE_CONFIG_DIR="$NANOEVAL_AGENT_HOME"',
      'export ANTHROPIC_BASE_URL=' + quote(options.url),
      'export ANTHROPIC_AUTH_TOKEN="$' + tokenVariable + '"',
      'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 IS_SANDBOX=1',
      [
        'exec "$cli"',
        '-p',
        '--output-format stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
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

export type Summary = {
  costUsd: number | undefined
  error: string | undefined
  message: string
  toolCalls: number
}

export function summarize(kind: Kind, stream: string): Summary {
  const summary: Summary = { costUsd: undefined, error: undefined, message: '', toolCalls: 0 }
  if (releases[kind].source === 'runtime') {
    summary.message = stream.trim()
    return summary
  }
  for (const line of lines(stream)) {
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
