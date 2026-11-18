import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { Readable } from 'node:stream'
import * as Zlib from 'node:zlib'
import * as Target from '../Target.ts'

export const production = 'https://nanocode-vercel-durable.vercel.app'
const repository = 'nanocodexyz/durable-vercel'

type Env = Record<string, string | undefined>

function setting(name: string, env: Env = process.env): string | undefined {
  const value = env['NANOEVAL_SYSTEMS_VERCEL_DEMO_' + name]
  return value?.trim() ? value.trim() : undefined
}

export function base(build: Target.Build, env: Env = process.env): string {
  const chosen = build.url ?? setting('URL', env) ?? production
  if (!/^https?:\/\//.test(chosen))
    throw new Target.InvalidError('vercel-demo needs a URL, not ' + chosen)
  return chosen.replace(/\/+$/, '').replace(/\/api\/chat$/, '')
}

export function headers(
  extra: Record<string, string> = {},
  env: Env = process.env,
): Record<string, string> {
  const token = setting('TOKEN', env)
  const bypass = setting('BYPASS', env)
  return {
    ...extra,
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
  }
}

export function selection(
  model: string | undefined,
  env: Env = process.env,
  thinking?: string,
): { effort?: string; harness?: string; model?: string } {
  const effort = thinking ?? setting('EFFORT', env)
  const spec = model ?? setting('MODEL', env)
  if (!spec) return effort ? { effort } : {}
  const at = spec.lastIndexOf('@')
  const named = at > 0 ? spec.slice(0, at) : spec
  const chosenEffort = at > 0 ? spec.slice(at + 1) : effort
  const colon = named.indexOf(':')
  const harness =
    colon > 0
      ? named.slice(0, colon)
      : /^(gpt-|codex)/.test(named) || /^(luna|sol)$/.test(named)
        ? 'codex'
        : 'claude'
  return {
    harness,
    model: colon > 0 ? named.slice(colon + 1) : named,
    ...(chosenEffort ? { effort: chosenEffort } : {}),
  }
}

export type Frame = { data?: string; event?: string; id?: string }

export class Sse {
  #buffer = ''
  #frame: Frame = {}
  #lines: string[] = []

  push(chunk: string): Frame[] {
    this.#buffer += chunk
    const out: Frame[] = []
    let index: number
    while ((index = this.#buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.#buffer.slice(0, index)
      if (this.#buffer[index] === '\r' && index === this.#buffer.length - 1) break
      const width = this.#buffer.startsWith('\r\n', index) ? 2 : 1
      this.#buffer = this.#buffer.slice(index + width)
      if (line === '') {
        if (this.#lines.length) this.#frame.data = this.#lines.join('\n')
        if (this.#frame.id !== undefined || this.#frame.data !== undefined || this.#frame.event)
          out.push(this.#frame)
        this.#frame = {}
        this.#lines = []
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') this.#lines.push(value)
      else if (field === 'id') this.#frame.id = value
      else if (field === 'event') this.#frame.event = value
    }
    return out
  }
}

type Open = { at?: number; kind: Target.CellTiming['kind']; name: string; receivedMs: number }

export function kind(event: {
  args?: unknown
  name?: unknown
  parent?: unknown
}): Target.CellTiming['kind'] {
  const name = typeof event.name === 'string' ? event.name : ''
  if (name === 'exec' && !event.parent) return 'code'
  if (/^python/i.test(name)) return 'python'
  if (name === 'Bash' || name === 'bash') {
    const args = event.args as { command?: unknown } | undefined
    const command = typeof args?.command === 'string' ? args.command : ''
    return /(^|[\s;&|(])(python3?|uv run python3?)(\s|$)/.test(command) ? 'python' : 'shell'
  }
  return 'tool'
}

export class Turn {
  readonly cells: Target.CellTiming[] = []
  cursor: string | undefined
  ended = false
  error: string | undefined
  firstByteMs: number | undefined
  firstTokenMs: number | undefined
  readonly metrics: Record<string, number> = {}
  status: string | undefined
  #message: string | undefined
  #open = new Map<string, Open>()
  #text: string[] = []
  #usage = 0
  readonly sendMs: number

  constructor(sendMs: number) {
    this.sendMs = sendMs
  }

  byte(at: number): void {
    this.firstByteMs ??= at
  }

  count(name: string, by = 1): void {
    this.metrics[name] = (this.metrics[name] ?? 0) + by
  }

  frame(frame: Frame, at: number): void {
    if (frame.id !== undefined) {
      this.cursor = frame.id
      if (frame.id.endsWith(';end')) this.ended = true
    }
    if (frame.event === 'end') {
      this.ended = true
      return
    }
    if (frame.data === undefined) return
    let event: unknown
    try {
      event = JSON.parse(frame.data)
    } catch {
      return
    }
    if (event && typeof event === 'object') this.event(event as Record<string, unknown>, at)
  }

  event(event: Record<string, unknown>, at: number): void {
    const type = event['type']
    const delta = event['delta']
    switch (type) {
      case 'text':
        if (typeof delta === 'string' && delta) {
          this.firstTokenMs ??= at
          this.#text.push(delta)
        }
        return
      case 'reasoning':
      case 'tool_input':
        if (typeof delta === 'string' && delta) this.firstTokenMs ??= at
        return
      case 'usage': {
        if (event['replayed'] === true) {
          this.count('replayedModelCalls')
          return
        }
        this.#usage++
        this.count('modelCalls')
        this.count('outputTokens', number(event['output_tokens']))
        this.count('inputTokens', number(event['input_tokens']))
        this.count('cachedTokens', number(event['cached_tokens']))
        if (
          this.metrics['serverFirstOutputMs'] === undefined &&
          typeof event['first_output_ms'] === 'number'
        )
          this.metrics['serverFirstOutputMs'] = event['first_output_ms']
        return
      }
      case 'tool_start': {
        const id = typeof event['call_id'] === 'string' ? event['call_id'] : String(this.#open.size)
        this.#open.set(id, {
          ...(typeof event['at'] === 'number' ? { at: event['at'] } : {}),
          kind: kind(event),
          name: typeof event['name'] === 'string' ? event['name'] : 'tool',
          receivedMs: at,
        })
        return
      }
      case 'tool_end': {
        const id = typeof event['call_id'] === 'string' ? event['call_id'] : ''
        const started = this.#open.get(id)
        this.#open.delete(id)
        const serverMs =
          typeof event['duration_ns'] === 'number'
            ? event['duration_ns'] / 1e6
            : started?.at !== undefined && typeof event['at'] === 'number'
              ? event['at'] - started.at
              : started
                ? at - started.receivedMs
                : 0
        const structured = event['structured'] as { exit_code?: unknown } | null | undefined
        const exited =
          structured && typeof structured.exit_code === 'number' ? structured.exit_code === 0 : true
        this.cells.push({
          endMs: at,
          kind: started?.kind ?? kind(event),
          name: started?.name ?? (typeof event['name'] === 'string' ? event['name'] : 'tool'),
          ok: event['status'] === 'completed' && exited,
          startMs: at - Math.max(0, serverMs),
        })
        return
      }
      case 'turn':
        this.status = typeof event['status'] === 'string' ? event['status'] : 'unknown'
        if (typeof event['message'] === 'string') this.#message = event['message']
        if (this.status !== 'completed')
          this.error ??= 'turn ' + this.status + (this.#message ? ': ' + this.#message : '')
        return
      case 'chaos':
        this.count('chaos')
        return
      case 'error':
      case 'failed': {
        const message = event['message'] ?? event['error']
        this.error ??= typeof message === 'string' ? message : String(type)
        return
      }
    }
  }

  sample(doneMs: number, flags: { stalled?: boolean; timedOut?: boolean } = {}): Target.TurnSample {
    const text = this.#text.length ? this.#text.join('') : (this.#message ?? '')
    const estimated = this.#usage === 0
    const error = flags.timedOut
      ? (this.error ?? 'turn exceeded its deadline')
      : (this.error ??
        (this.ended
          ? this.status
            ? undefined
            : 'stream ended without a turn result'
          : 'stream ended early'))
    if (this.cells.length) this.metrics['cells'] = this.cells.length
    return {
      cells: this.cells,
      doneMs,
      ...(error ? { error } : {}),
      ...(estimated ? { estimated: true } : {}),
      ...(this.firstByteMs !== undefined ? { firstByteMs: this.firstByteMs } : {}),
      ...(this.firstTokenMs !== undefined ? { firstTokenMs: this.firstTokenMs } : {}),
      metrics: { ...this.metrics },
      ok: !error && this.status === 'completed',
      outputTokens: estimated ? Target.estimate(text) : (this.metrics['outputTokens'] ?? 0),
      sendMs: this.sendMs,
      ...(flags.stalled ? { stalled: true } : {}),
      text,
      ...(flags.timedOut ? { timedOut: true } : {}),
    }
  }
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const defaults: Target.Context = { deadlineMs: 300_000, stallMs: 60_000 }

async function excerpt(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  return response.status + (body ? ' ' + body.trim() : '')
}

async function follow(
  response: Response,
  turn: Turn,
  options: { deadline: AbortSignal; stallMs: number },
): Promise<{ ended: boolean; stalled: boolean }> {
  if (!response.body) return { ended: false, stalled: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const sse = new Sse()
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => void reader.cancel().catch(() => undefined)
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      stop()
    }, options.stallMs)
  }
  options.deadline.addEventListener('abort', stop, { once: true })
  arm()
  try {
    while (!turn.ended) {
      const read = await reader.read().catch(() => undefined)
      if (!read || read.done || !read.value) break
      const at = Target.now()
      turn.byte(at)
      for (const frame of sse.push(decoder.decode(read.value, { stream: true }))) {
        if (frame.data !== undefined || frame.event) arm()
        turn.frame(frame, at)
      }
    }
  } finally {
    clearTimeout(timer)
    options.deadline.removeEventListener('abort', stop)
    if (turn.ended) stop()
  }
  return { ended: turn.ended, stalled }
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

class VercelSession implements Target.Session {
  #busy = false
  #opened: number | undefined
  #fallback: boolean
  id: string
  readonly endpoint: string
  readonly context: Target.Context
  readonly choice: Record<string, string>

  constructor(
    endpoint: string,
    id: string,
    context: Target.Context,
    choice: Record<string, string>,
    opened?: number,
    fallback = false,
  ) {
    this.#fallback = fallback
    this.endpoint = endpoint
    this.id = id
    this.context = context
    this.choice = choice
    this.#opened = opened
  }

  async close(): Promise<void> {}

  async turn(prompt: string): Promise<Target.TurnSample> {
    if (this.#busy) throw new Error('vercel-demo sessions take one turn at a time')
    this.#busy = true
    try {
      return await this.#turn(prompt)
    } finally {
      this.#busy = false
    }
  }

  async #turn(prompt: string): Promise<Target.TurnSample> {
    const sendMs = Target.now()
    const turn = new Turn(sendMs)
    if (this.#opened !== undefined) {
      turn.metrics['openMs'] = this.#opened
      this.#opened = undefined
    }
    if (this.#fallback) {
      turn.metrics['modelFallback'] = 1
      this.#fallback = false
    }
    const deadline = AbortSignal.timeout(this.context.deadlineMs)
    let stalled = false
    const finish = () =>
      turn.sample(Target.now(), { stalled, timedOut: deadline.aborted && !turn.ended })
    const body = this.id ? { sessionId: this.id, text: prompt } : { ...this.choice, text: prompt }
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        body: JSON.stringify(body),
        headers: headers({ accept: 'text/event-stream', 'content-type': 'application/json' }),
        method: 'POST',
        signal: deadline,
      })
    } catch (error) {
      turn.error = 'POST failed: ' + (error instanceof Error ? error.message : String(error))
      return finish()
    }
    if (!response.ok) {
      turn.error = 'POST ' + (await excerpt(response))
      return finish()
    }
    this.id ||= response.headers.get('x-session-id') ?? ''
    let result = await follow(response, turn, { deadline, stallMs: this.context.stallMs })
    stalled ||= result.stalled
    let delay = 500
    while (!result.ended && !deadline.aborted && this.id) {
      turn.count('reconnects')
      const cursor = turn.cursor ?? '0.0'
      const again = await fetch(
        this.endpoint +
          '?sessionId=' +
          encodeURIComponent(this.id) +
          '&cursor=' +
          encodeURIComponent(cursor),
        { headers: headers({ accept: 'text/event-stream' }), signal: deadline },
      ).catch(() => undefined)
      if (!again || !again.ok) {
        if (again && again.status < 500 && again.status !== 408 && again.status !== 429) {
          turn.error ??= 'resume ' + (await excerpt(again))
          break
        }
        void again?.body?.cancel().catch(() => undefined)
        await pause(delay, deadline)
        delay = Math.min(delay * 2, 8_000)
        continue
      }
      delay = 500
      result = await follow(again, turn, { deadline, stallMs: this.context.stallMs })
      stalled ||= result.stalled
    }
    return finish()
  }
}

type Manifest = { fingerprint?: string; files?: Record<string, string> }

async function sha256(url: string): Promise<string | undefined> {
  const response = await fetch(url, { headers: headers() }).catch(() => undefined)
  if (!response?.ok || !response.body) return undefined
  const hash = Crypto.createHash('sha256')
  for await (const chunk of Readable.fromWeb(response.body as never)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function github(path: string): Promise<Response> {
  const token = process.env['GH_TOKEN'] || process.env['GITHUB_TOKEN']
  return fetch('https://api.github.com/' + path, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
  })
}

async function candidates(limit = 30): Promise<string[]> {
  const listed = await github('repos/' + repository + '/commits?per_page=' + limit).catch(
    () => undefined,
  )
  if (!listed?.ok) return []
  const commits = ((await listed.json()) as { sha: string }[]).map((commit) => commit.sha)
  const specs = await Promise.all(
    commits.map(async (sha) => {
      const response = await fetch(
        'https://raw.githubusercontent.com/' + repository + '/' + sha + '/package.json',
      ).catch(() => undefined)
      if (!response?.ok) return undefined
      const pkg = (await response.json().catch(() => ({}))) as {
        dependencies?: Record<string, string>
      }
      return pkg.dependencies?.['nanocode-ts']
    }),
  )
  return [...new Set(specs.filter((spec): spec is string => !!spec))]
}

export async function manifest(url: string): Promise<Manifest | undefined> {
  const cache = Path.join(Os.homedir(), '.cache', 'nanoeval', 'nanocode-ts')
  const file = Path.join(
    cache,
    Crypto.createHash('sha256').update(url).digest('hex').slice(0, 24) + '.json',
  )
  const cached = await Fs.readFile(file, 'utf8').catch(() => undefined)
  if (cached) return JSON.parse(cached) as Manifest
  const response = await fetch(url).catch(() => undefined)
  if (!response?.ok || !response.body) return undefined
  const found = await untar(
    Readable.fromWeb(response.body as never).pipe(Zlib.createGunzip()),
    /(^|\/)dist\/nanocode-wasm\.json$/,
  )
  if (!found) return undefined
  await Fs.mkdir(cache, { recursive: true })
  await Fs.writeFile(file, found)
  return JSON.parse(found) as Manifest
}

export async function untar(
  stream: AsyncIterable<Buffer>,
  wanted: RegExp,
): Promise<string | undefined> {
  let buffer: Buffer = Buffer.alloc(0)
  let entry: { name: string; padded: number; size: number } | undefined
  let skip = 0
  const field = (from: number, width: number) => {
    const slice = buffer.subarray(from, from + width)
    const zero = slice.indexOf(0)
    return slice.subarray(0, zero < 0 ? width : zero).toString('utf8')
  }
  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      if (skip) {
        const taken = Math.min(skip, buffer.length)
        buffer = buffer.subarray(taken)
        skip -= taken
        if (skip) break
      }
      if (entry) {
        if (buffer.length < entry.size) break
        return buffer.subarray(0, entry.size).toString('utf8')
      }
      if (buffer.length < 512) break
      if (buffer.subarray(0, 512).every((byte) => byte === 0)) return undefined
      const name = field(0, 100)
      const prefix = field(345, 155)
      const size = Number.parseInt(field(124, 12).trim() || '0', 8)
      buffer = buffer.subarray(512)
      const full = prefix ? prefix + '/' + name : name
      if (wanted.test(full)) entry = { name: full, padded: Math.ceil(size / 512) * 512, size }
      else skip = Math.ceil(size / 512) * 512
    }
  }
  return undefined
}

export const overrides = {
  defaultSelection: {
    harness: 'claude',
    model: 'claude-haiku-5-5',
    stock: 'claude-opus-5-5 (claude family default); gpt-6.2-sol for codex',
  },
  effort: { value: 'low', stock: 'the model catalog default (medium for claude-haiku-5-5)' },
  gateway: 'Vercel AI Gateway (only models it serves)',
  models: [
    'claude:claude-haiku-5-5',
    'claude:claude-sonnet-5-5',
    'claude:zai/glm-5.3',
    'claude:moonshotai/kimi-k3',
    'codex:gpt-6-luna',
    'codex:gpt-6.1-sol',
    'codex:glm-5.3',
    'codex:kimi-k3',
  ],
  publicLimits: { maxPromptCharacters: 2000, maxPrompts: 20 },
  directDriveMs: 280_000,
  warmDriveMs: 280_000,
  durability: 'on (NANOCODE_DURABILITY=strict switches to strict)',
  subagents: true,
  streamToolInput: true,
  hands: 'visitor machines over WebSocket (nc hand)',
  tools: ['charge (host tool)', 'Tempo wallet MCP'],
  promptImages: 'claude-* and gpt-* models only',
} as const

export async function describe(build: Target.Build): Promise<Target.Description> {
  const url = base(build)
  const [wasmSha256, page, specs] = await Promise.all([
    sha256(url + '/nanocode_wasm.wasm'),
    fetch(url + '/', { headers: headers() })
      .then((response) => (response.ok ? response.text() : ''))
      .catch(() => ''),
    candidates(),
  ])
  const tarballs = (build.version ? [build.version, ...specs] : specs).filter((spec) =>
    spec.startsWith('https:'),
  )
  const matches: string[] = []
  for (const candidate of tarballs.slice(0, 4)) {
    const found = await manifest(candidate).catch(() => undefined)
    if (wasmSha256 && found?.files?.['nanocode_wasm.wasm'] === wasmSha256)
      matches.push(candidate.match(/\/download\/(build-[0-9a-f]+)\//)?.[1] ?? candidate)
  }
  const tag = matches[0]
  let nanocodeRev: string | undefined
  if (tag?.startsWith('build-')) {
    const release = await github('repos/nanocodexyz/nanocode-ts/releases/tags/' + tag).catch(
      () => undefined,
    )
    const body = release?.ok ? ((await release.json()) as { body?: string }).body : undefined
    nanocodeRev = body?.match(/against SDK ([0-9a-f]{40})/)?.[1]
  }
  const flag = (name: string) => {
    const match = page.match(new RegExp('\\\\?"' + name + '\\\\?":(true|false)'))
    return match ? match[1] === 'true' : undefined
  }
  const requested = selection(undefined)
  return {
    ...(nanocodeRev ? { nanocodeRev } : {}),
    ...(tag ? { nanocodeTs: tag } : {}),
    overrides: {
      ...overrides,
      ...(flag('chaos') !== undefined ? { chaosEndpoint: flag('chaos') } : {}),
      ...(flag('needsToken') !== undefined ? { needsToken: flag('needsToken') } : {}),
      ...(matches.length > 1 ? { nanocodeTsMatches: matches } : {}),
      ...(specs[0] && !specs[0].includes(tag ?? '\0') ? { sourceNanocodeTs: specs[0] } : {}),
      ...(requested.model || requested.effort ? { requested } : {}),
    },
    url,
    ...(wasmSha256 ? { wasmSha256 } : {}),
  }
}

export function choose(
  context: Pick<Target.Context, 'model' | 'thinking'>,
  env: Env = process.env,
): { choice: Record<string, string>; fallback: boolean } {
  const pinned = setting('MODEL', env)
  const asked = pinned ? undefined : context.model
  const wanted = selection(pinned ?? asked, env, context.thinking)
  const served = (overrides.models as readonly string[]).includes(
    wanted.harness + ':' + wanted.model,
  )
  const fallback = !!asked && !served
  const chosen =
    wanted.model && (served || pinned)
      ? wanted
      : wanted.effort
        ? {
            ...selection(
              overrides.defaultSelection.harness + ':' + overrides.defaultSelection.model,
              {},
            ),
            effort: wanted.effort,
          }
        : {}
  const choice = Object.fromEntries(
    Object.entries(chosen).filter((entry): entry is [string, string] => !!entry[1]),
  )
  return { choice, fallback }
}

async function open(
  build: Target.Build,
  context: Target.Context = defaults,
): Promise<Target.Session> {
  const endpoint = base(build) + '/api/chat'
  const { choice, fallback } = choose(context)
  if (context.cold || setting('WARM') === '0')
    return new VercelSession(endpoint, '', context, choice, undefined, fallback)
  const started = Target.now()
  const response = await fetch(endpoint, {
    body: JSON.stringify({ ...choice, warm: true }),
    headers: headers({ 'content-type': 'application/json' }),
    method: 'POST',
    signal: AbortSignal.timeout(context.deadlineMs),
  })
  if (!response.ok)
    throw new Error('vercel-demo could not start a session: ' + (await excerpt(response)))
  const id = ((await response.json()) as { sessionId?: string }).sessionId
  if (!id) throw new Error('vercel-demo started no session')
  return new VercelSession(endpoint, id, context, choice, Target.now() - started, fallback)
}

async function resume(
  build: Target.Build,
  id: string,
  context: Target.Context = defaults,
): Promise<Target.Session> {
  return new VercelSession(base(build) + '/api/chat', id, context, {})
}

const target: Target.Target = { describe, name: 'vercel-demo', open, resume }
export default target
