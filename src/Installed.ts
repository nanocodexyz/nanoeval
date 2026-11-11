import type * as Atif from './Atif.ts'

export type Kind = 'claude-code' | 'codex-cli'

export type Agent = { kind: Kind; model: string; thinking?: string }

export type Binary = {
  arch: 'aarch64' | 'x86_64'
  libc: 'any' | 'gnu' | 'musl'
  sha256: string
  url: string
}

export type Release = {
  binaries: readonly Binary[]
  entry: string
  format: 'file' | 'tar.gz'
  provider: 'claude' | 'codex'
  version: string
}

export const kinds: readonly Kind[] = ['claude-code', 'codex-cli']

export const events = 'agent/events.jsonl'
export const instruction = 'agent/instruction.md'
export const tokenVariable = 'NANOEVAL_AGENT_TOKEN'

const claude =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.318'
const codex = 'https://github.com/openai/codex/releases/download/rust-v0.166.0'

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
    version: '0.166.0',
  },
}

export function is(provider: string): provider is Kind {
  return (kinds as readonly string[]).includes(provider)
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

const preamble = ['set -eu', 'mkdir -p "$NANOEVAL_AGENT_HOME"']

export function script(agent: Agent, options: { url: string }): string {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]_/-]+$/.test(options.url))
    throw new Error('the model endpoint is not a plain http or https address: ' + options.url)
  const root = '"$NANOEVAL_AGENT_RT"/agents/' + agent.kind
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
          'exec ' + root + '/any/' + releases[agent.kind].entry,
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
  for (const line of lines(stream)) {
    if (kind === 'codex-cli') {
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

  for (const line of lines(input.stream)) {
    if (kind === 'codex-cli') {
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
