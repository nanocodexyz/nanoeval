import * as Target from '../Target.ts'

export type Endpoint = { base: string; token?: string | undefined; visitor: string }

export type Entry = { arrivalMs: number; record: unknown }

export type Frame = { data: string; event?: string | undefined }

export type Read = { comments: readonly string[]; frames: readonly Frame[]; rest: string }

export type Turn = {
  comments: readonly string[]
  doneMs: number
  entries: readonly Entry[]
  error?: string | undefined
  firstByteMs?: number | undefined
  sendMs: number
  stalled?: boolean | undefined
  timedOut?: boolean | undefined
}

type Agent = { payload: Record<string, unknown>; type: string }

type Host = { [key: string]: unknown; type: string }

export const origin = 'https://cloudflare.nanocode.xyz'

export const stock = {
  aiGateway: 'default',
  chatPublic: false,
  claudeModel: 'claude-opus-5-5',
  codexModel: 'gpt-6.1-sol',
  serviceTier: '',
} as const

export const declared = {
  aiGateway: 'nanocode-cloudflare-durable',
  chatPublic: true,
  claudeModel: 'claude-haiku-5-5',
  serviceTier: 'priority',
  source: 'nanocodexyz/durable-cloudflare package.json deploy:demo',
  workersAi: true,
} as const

export const limits = {
  promptCharacters: 2000,
  publicModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'gpt-6-luna', 'gpt-6.1-sol', 'glm-5.3'],
  publicRate: '30 requests per 60 s per client address (IPv6 /64), every public route but /health',
} as const

const deltas = new Set(['assistant.delta', 'reasoning.summary.delta', 'tool.input.delta'])

const visitorPattern = /^[0-9a-f]{64}$/

let generated: string | undefined

export function read(text: string): Read {
  const comments: string[] = []
  const frames: Frame[] = []
  const blocks = text.replace(/\r\n?/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    const data: string[] = []
    let event: string | undefined
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) comments.push(line.slice(1).trim())
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) event = line.slice(6).trim()
    }
    if (data.length > 0) frames.push({ data: data.join('\n'), ...(event ? { event } : {}) })
  }
  return { comments, frames, rest }
}

export function timing(comments: readonly string[]): Record<string, number> {
  const found: Record<string, number> = {}
  for (const comment of comments) {
    if (!comment.startsWith('server-timing ')) continue
    for (const part of comment.slice('server-timing '.length).split(',')) {
      const [name, ...fields] = part.trim().split(';')
      const duration = fields.find((field) => field.startsWith('dur='))
      if (name && duration) found[name] = Number(duration.slice(4))
    }
  }
  return found
}

function host(record: unknown): Host | undefined {
  const event = (record as { event?: unknown } | null)?.event as Host | undefined
  return event && typeof event.type === 'string' && event['source'] === undefined
    ? event
    : undefined
}

function agent(record: unknown): Agent | undefined {
  const event = (record as { event?: { event?: unknown; source?: unknown } } | null)?.event
  if (event?.source !== 'agent') return undefined
  const inner = event.event as { payload?: unknown; type?: unknown } | undefined
  if (typeof inner?.type !== 'string') return undefined
  return { payload: (inner.payload ?? {}) as Record<string, unknown>, type: inner.type }
}

function emitted(record: unknown): { ms: number; runtime: string } | undefined {
  const event = (
    record as {
      event?: { host_timing?: { runtime_id?: unknown }; sdk_timing?: { emitted_ns?: unknown } }
    } | null
  )?.event
  const ns = event?.sdk_timing?.emitted_ns
  const runtime = event?.host_timing?.runtime_id
  return typeof ns === 'number' && typeof runtime === 'string'
    ? { ms: ns / 1e6, runtime }
    : undefined
}

function created(record: unknown): number | undefined {
  const value = (record as { created_at?: unknown } | null)?.created_at
  return typeof value === 'number' ? value : undefined
}

export function kind(payload: Record<string, unknown>): Target.CellTiming['kind'] {
  const tool = String(payload['tool'] ?? '')
  if (/python/i.test(tool)) return 'python'
  if (tool === 'exec' && payload['parent_call_id'] === undefined) return 'code'
  if (tool === 'exec_command' || tool === 'shell') {
    const args = payload['arguments']
    const command = String(
      typeof args === 'object' && args !== null
        ? ((args as { cmd?: unknown }).cmd ?? '')
        : (args ?? ''),
    )
    return /^\s*(?:uv run )?python3?\b/.test(command) ? 'python' : 'shell'
  }
  return 'tool'
}

function succeeded(payload: Record<string, unknown>): boolean {
  if (payload['status'] !== 'completed') return false
  const structured = payload['structured_result'] as { exit_code?: unknown } | undefined
  return typeof structured?.exit_code !== 'number' || structured.exit_code === 0
}

function message(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function summarize(turn: Turn): Target.TurnSample {
  const offsets = turn.entries.flatMap((entry) => {
    const at = created(entry.record)
    return at === undefined ? [] : [entry.arrivalMs - at]
  })
  const offset = offsets.length > 0 ? Math.min(...offsets) : 0
  const calls = new Map<
    string,
    {
      clock: { ms: number; runtime: string } | undefined
      payload: Record<string, unknown>
      startMs: number
    }
  >()
  const cells: Target.CellTiming[] = []
  const texts: string[] = []
  const metrics: Record<string, number> = {}
  let firstTokenMs: number | undefined
  let result: Host | undefined
  let failure: string | undefined
  let usage: { output_tokens?: unknown } | undefined
  const pieces = new Map<string, string>()

  for (const entry of turn.entries) {
    const outer = host(entry.record)
    if (outer?.type === 'result') result = outer
    const inner = agent(entry.record)
    if (!inner) continue
    const at = (created(entry.record) ?? entry.arrivalMs - offset) + offset
    if (deltas.has(inner.type)) firstTokenMs ??= entry.arrivalMs
    if (inner.type === 'assistant.delta')
      pieces.set(
        String(inner.payload['item_id']) + ':' + String(inner.payload['offset']),
        String(inner.payload['text'] ?? ''),
      )
    if (inner.type === 'assistant.message') texts.push(String(inner.payload['text'] ?? ''))
    if (inner.type === 'tool.call')
      calls.set(String(inner.payload['call_id']), {
        clock: emitted(entry.record),
        payload: inner.payload,
        startMs: at,
      })
    if (inner.type === 'tool.result') {
      const call = calls.get(String(inner.payload['call_id']))
      if (call) {
        calls.delete(String(inner.payload['call_id']))
        const clock = emitted(entry.record)
        cells.push({
          endMs:
            clock && call.clock && clock.runtime === call.clock.runtime && clock.ms >= call.clock.ms
              ? call.startMs + clock.ms - call.clock.ms
              : at,
          kind: kind(call.payload),
          name: String(call.payload['tool']),
          ok: succeeded(inner.payload),
          startMs: call.startMs,
        })
      }
    }
    if (inner.type === 'run.failed') failure = message(inner.payload['error'] ?? inner.payload)
    if (inner.type === 'run.completed') {
      usage = inner.payload['usage'] as typeof usage
      for (const [name, key] of [
        ['costUsd', 'cost_usd'],
        ['modelCalls', 'model_calls'],
        ['runMs', 'duration_ms'],
        ['toolCalls', 'tool_calls'],
      ] as const) {
        const value = inner.payload[key]
        if (typeof value === 'number') metrics[name] = value
      }
    }
  }

  for (const call of calls.values())
    cells.push({
      endMs: turn.doneMs,
      kind: kind(call.payload),
      name: String(call.payload['tool']),
      ok: false,
      startMs: call.startMs,
    })
  cells.sort((left, right) => left.startMs - right.startMs || right.endMs - left.endMs)

  const server = timing(turn.comments)
  for (const [name, key] of [
    ['serverSessionMs', 'session'],
    ['serverPoolMs', 'pool_total'],
  ] as const) {
    const value = server[key]
    if (value !== undefined && Number.isFinite(value)) metrics[name] = value
  }

  const ok = result?.['ok'] as
    | { message?: unknown; usage?: { estimated_cost?: { usd?: unknown }; output_tokens?: unknown } }
    | undefined
  const admission = (result?.['timing'] as { admission_ms?: unknown } | undefined)?.admission_ms
  if (typeof admission === 'number') metrics['admissionMs'] = admission
  const usd = Number(ok?.usage?.estimated_cost?.usd)
  if (metrics['costUsd'] === undefined && Number.isFinite(usd)) metrics['costUsd'] = usd
  const streamed = [...pieces.values()].join('')
  const text =
    typeof ok?.message === 'string' ? ok.message : texts.length > 0 ? texts.join('\n') : streamed
  const tokens = ok?.usage?.output_tokens ?? usage?.output_tokens
  const error =
    turn.error ??
    failure ??
    (result === undefined
      ? 'the stream ended without a result event'
      : result['status'] === 'completed' && ok
        ? undefined
        : message(result['error'] ?? result['detail'] ?? result['status']))

  return {
    cells,
    doneMs: turn.doneMs,
    ...(error === undefined ? {} : { error }),
    ...(typeof tokens === 'number'
      ? { outputTokens: tokens }
      : { estimated: true, outputTokens: Target.estimate(text) }),
    ...(turn.firstByteMs === undefined ? {} : { firstByteMs: turn.firstByteMs }),
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    metrics,
    ok: error === undefined,
    sendMs: turn.sendMs,
    ...(turn.stalled ? { stalled: true } : {}),
    text,
    ...(turn.timedOut ? { timedOut: true } : {}),
  }
}

export function model(name: string | undefined): { model?: string; provider?: 'claude' | 'codex' } {
  if (!name) return {}
  const at = name.indexOf('/')
  if (at > 0) {
    const provider = name.slice(0, at)
    if (provider !== 'claude' && provider !== 'codex')
      throw new Target.InvalidError('a model is claude/<id>, codex/<id> or a bare id, not ' + name)
    return { model: name.slice(at + 1), provider }
  }
  return { model: name, provider: name.startsWith('claude') ? 'claude' : 'codex' }
}

export function visitor(variable: string): string {
  const configured = process.env[variable]
  if (configured !== undefined) {
    if (!visitorPattern.test(configured))
      throw new Target.InvalidError(variable + ' must be 64 lowercase hex characters')
    return configured
  }
  generated ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')
  return generated
}

export function endpoint(base: string, prefix: string): Endpoint {
  const token = process.env['NANOEVAL_SYSTEMS_' + prefix + '_TOKEN']
  return {
    base: base.replace(/\/+$/, ''),
    ...(token ? { token } : {}),
    visitor: visitor('NANOEVAL_SYSTEMS_' + prefix + '_VISITOR'),
  }
}

function headers(endpoint: Endpoint, accept: string): Record<string, string> {
  return {
    accept,
    ...(endpoint.token ? { authorization: 'Bearer ' + endpoint.token } : {}),
    'content-type': 'application/json',
    'x-nanocode-visitor': endpoint.visitor,
  }
}

export async function turn(
  endpoint: Endpoint,
  options: { context?: Target.Context | undefined; id: string; prompt: string },
): Promise<Turn> {
  const controller = new AbortController()
  const entries: Entry[] = []
  const comments: string[] = []
  const decoder = new TextDecoder()
  let reason: 'stalled' | 'timedOut' | undefined
  let stall: ReturnType<typeof setTimeout> | undefined
  const stop = (why: 'stalled' | 'timedOut') => {
    reason ??= why
    controller.abort()
  }
  const arm = () => {
    clearTimeout(stall)
    if (options.context) stall = setTimeout(() => stop('stalled'), options.context.stallMs)
  }
  const deadline = options.context
    ? setTimeout(() => stop('timedOut'), options.context.deadlineMs)
    : undefined
  const sendMs = Target.now()
  let firstByteMs: number | undefined
  let error: string | undefined
  arm()
  try {
    const response = await fetch(
      endpoint.base + '/sessions/' + encodeURIComponent(options.id) + '/turns?live=1',
      {
        body: JSON.stringify({
          prompt: options.prompt,
          request_id: crypto.randomUUID(),
          ...model(options.context?.model),
          ...(options.context?.thinking ? { thinking: options.context.thinking } : {}),
        }),
        headers: headers(endpoint, 'text/event-stream'),
        method: 'POST',
        signal: controller.signal,
      },
    )
    firstByteMs = Target.now()
    arm()
    if (!response.ok || !response.body) {
      const retry = response.headers.get('retry-after')
      error =
        'HTTP ' +
        response.status +
        (retry ? ' (retry-after ' + retry + ' s)' : '') +
        ': ' +
        (await response.text())
    } else {
      const reader = response.body.getReader()
      let rest = ''
      let finished = false
      while (!finished) {
        const chunk = await reader.read()
        if (chunk.done) break
        const arrivalMs = Target.now()
        arm()
        const parsed = read(rest + decoder.decode(chunk.value, { stream: true }))
        rest = parsed.rest
        comments.push(...parsed.comments)
        for (const frame of parsed.frames) {
          const record = JSON.parse(frame.data) as unknown
          entries.push({ arrivalMs, record })
          if (host(record)?.type === 'result') finished = true
        }
      }
      if (finished) await reader.cancel()
    }
  } catch (caught) {
    if (!reason) error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    clearTimeout(stall)
    clearTimeout(deadline)
  }
  return {
    comments,
    doneMs: Target.now(),
    entries,
    ...(reason
      ? { error: reason === 'timedOut' ? 'the turn passed its deadline' : 'the stream stalled' }
      : error
        ? { error }
        : {}),
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
    sendMs,
    ...(reason === 'stalled' ? { stalled: true } : {}),
    ...(reason === 'timedOut' ? { timedOut: true } : {}),
  }
}

export async function replay(endpoint: Endpoint, id: string): Promise<number> {
  const startMs = Target.now()
  const response = await fetch(
    endpoint.base + '/sessions/' + encodeURIComponent(id) + '/events?after=0&limit=1',
    {
      headers: headers(endpoint, 'application/json'),
    },
  )
  if (!response.ok)
    throw new Error(
      'resuming ' + id + ' returned HTTP ' + response.status + ': ' + (await response.text()),
    )
  const page = (await response.json()) as { events?: unknown }
  if (!Array.isArray(page.events) || page.events.length === 0)
    throw new Target.InvalidError(
      'session ' + id + ' has no events for this visitor; set the same visitor to resume it',
    )
  return Target.now() - startMs
}

export function session(
  endpoint: Endpoint,
  options: { context?: Target.Context | undefined; id: string; resumeMs?: number | undefined },
): Target.Session {
  let resumeMs = options.resumeMs
  return {
    async close() {},
    id: options.id,
    async turn(prompt) {
      const sample = summarize(
        await turn(endpoint, { context: options.context, id: options.id, prompt }),
      )
      if (resumeMs === undefined) return sample
      const metrics = { ...sample.metrics, resumeMs }
      resumeMs = undefined
      return { ...sample, metrics }
    },
  }
}

export async function health(
  base: string,
): Promise<{ auth?: string; model?: string; models?: Record<string, string> }> {
  const response = await fetch(base + '/health')
  if (!response.ok) throw new Error(base + '/health returned HTTP ' + response.status)
  return (await response.json()) as {
    auth?: string
    model?: string
    models?: Record<string, string>
  }
}

export async function probe(endpoint: Endpoint): Promise<boolean> {
  const response = await fetch(
    endpoint.base + '/sessions/nanoeval-describe/events?after=0&limit=1',
    {
      headers: { accept: 'application/json', 'x-nanocode-visitor': endpoint.visitor },
    },
  )
  await response.body?.cancel()
  return response.ok
}

export async function overrides(endpoint: Endpoint): Promise<Record<string, unknown>> {
  const [found, chatPublic] = await Promise.all([health(endpoint.base), probe(endpoint)])
  const observed = {
    auth: found.auth,
    chatPublic,
    claudeModel: found.models?.['claude'],
    codexModel: found.models?.['codex'],
  }
  const changed = Object.fromEntries(
    Object.entries(observed).filter(
      ([key, value]) => key in stock && value !== stock[key as keyof typeof stock],
    ),
  )
  return { changed, declared, limits, observed, stock }
}

export const manifest =
  'https://raw.githubusercontent.com/nanocodexyz/durable-cloudflare/master/package.json'

export async function pinned(): Promise<string | undefined> {
  const response = await fetch(manifest)
  if (!response.ok) return undefined
  const found = (await response.json()) as { dependencies?: Record<string, string> }
  return spec(found.dependencies?.['nanocode-ts'])
}

export function spec(value: string | undefined): string | undefined {
  if (!value) return undefined
  return /\/download\/build-([0-9a-f]+)\//.exec(value)?.[1] ?? /#(.+)$/.exec(value)?.[1] ?? value
}

export function base(build: Target.Build): string {
  return (build.url ?? origin).replace(/\/+$/, '')
}

export function id(): string {
  return 'nanoeval-' + crypto.randomUUID()
}

const target: Target.Target = {
  async describe(build) {
    const url = base(build)
    const [found, pin] = await Promise.all([
      overrides(endpoint(url, 'CF_DEMO')),
      pinned().catch(() => undefined),
    ])
    return {
      ...(build.version ? { nanocodeTs: build.version } : {}),
      overrides: {
        ...found,
        repositoryPin: {
          nanocodeTs: pin ?? 'unknown',
          note: 'durable-cloudflare master; the deployed version may differ',
        },
        build:
          'not exposed: /health reports models and auth only, and version preview URLs are off',
      },
      url,
    }
  },
  name: 'cf-demo',
  async open(build, context) {
    return session(endpoint(base(build), 'CF_DEMO'), { context, id: id() })
  },
  async resume(build, name, context) {
    const at = endpoint(base(build), 'CF_DEMO')
    return session(at, { context, id: name, resumeMs: await replay(at, name) })
  },
}

export default target
