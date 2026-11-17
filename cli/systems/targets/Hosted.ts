import { execFile } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Target from '../Target.ts'

// Shared by the targets that drive a deployed nanocode-ts session over HTTP (release-worker, gateway): one
// turn is a POST that answers with the session's server-sent events, and the build a deployment serves is
// a nanocode-ts build-<sha> release. Not a target itself (cli/systems/main.ts loads lowercase names only).

export type Fetch = typeof fetch

const deltas = new Set(['assistant.delta', 'reasoning.delta', 'reasoning.summary.delta'])
const outputs = new Set(['assistant.message', 'tool.call', 'tool.input.delta'])

// The kind of cell a nanocode tool call is, by its tool's name.
export function kind(tool: string): Target.CellTiming['kind'] {
  const name = tool.toLowerCase()
  if (/python/.test(name)) return 'python'
  if (/^(shell|bash|sh|psh|exec_command|run_shell|terminal)$/.test(name)) return 'shell'
  if (/^(exec|code|code_mode|js|javascript|run_code|cell)$/.test(name)) return 'code'
  return 'tool'
}

export type Envelope = { created_at?: number; event?: Record<string, any> }

type Call = {
  createdAt?: number | undefined
  kind: Target.CellTiming['kind']
  name: string
  startMs: number
}

// What a turn's event stream says, read one SSE message at a time; sample() turns it into a TurnSample.
export class Reader {
  readonly cells: Target.CellTiming[] = []
  done = false
  error: string | undefined
  firstOutputMs: number | undefined
  firstTokenMs: number | undefined
  ok = false
  result: Record<string, any> | undefined
  texts: string[] = []
  resultMs: number | undefined
  private calls = new Map<string, Call>()

  // One parsed data payload, arriving at the client time at.
  read(payload: Envelope, at: number): void {
    const outer = payload.event
    if (!outer || typeof outer !== 'object') return
    if (outer['source'] === undefined && outer['type'] === 'result') {
      this.result = outer
      this.resultMs = at
      this.done = true
      this.ok = outer['status'] === 'completed' && outer['ok'] !== undefined
      if (!this.ok)
        this.error ??= message(outer['error'] ?? outer['err'] ?? outer['status'] ?? 'turn failed')
      return
    }
    if (outer['source'] !== 'agent' || !outer['event']) return
    const inner = outer['event'] as { payload?: Record<string, any>; type?: string }
    const created = typeof payload.created_at === 'number' ? payload.created_at : undefined
    const type = String(inner.type ?? '')
    const body = inner.payload ?? {}
    if (deltas.has(type)) this.firstTokenMs ??= at
    if (deltas.has(type) || outputs.has(type)) this.firstOutputMs ??= at
    if (type === 'assistant.message' && typeof body['text'] === 'string')
      this.texts.push(body['text'])
    if (type === 'tool.call') {
      const id = String(body['call_id'] ?? '')
      const name = String(body['tool'] ?? 'tool')
      if (id && !this.calls.has(id))
        this.calls.set(id, { createdAt: created, kind: kind(name), name, startMs: at })
    }
    if (type === 'tool.result') {
      const id = String(body['call_id'] ?? '')
      const call = this.calls.get(id)
      const name = call?.name ?? String(body['tool'] ?? 'tool')
      const ns = typeof body['duration_ns'] === 'number' ? body['duration_ns'] : undefined
      const status = String(body['status'] ?? '').toLowerCase()
      this.calls.delete(id)
      // Events can arrive batched, so a cell's length is the runtime's own measure when it gives one, else
      // the server's stamps on the call and its result, and only then the gap between their arrivals here.
      const ms =
        ns !== undefined
          ? ns / 1e6
          : created !== undefined && call?.createdAt !== undefined
            ? Math.max(0, created - call.createdAt)
            : at - (call?.startMs ?? at)
      this.cells.push({
        endMs: at,
        kind: call?.kind ?? kind(name),
        name,
        ok: !/(error|fail|timeout|timed_out|cancel|denied|refused)/.test(status),
        startMs: at - ms,
      })
    }
    if (type === 'run.failed')
      this.error ??= message(body['error'] ?? body['message'] ?? 'run failed')
  }

  // A turn-relative server time (ms since the runtime took the turn) on this clock: the result went out at
  // the turn's observed_ms and arrived at resultMs, so earlier moments are that much before its arrival.
  local(serverMs: unknown): number | undefined {
    const observed = this.result?.['timing']?.observed_ms
    if (typeof serverMs !== 'number' || typeof observed !== 'number' || this.resultMs === undefined)
      return undefined
    return this.resultMs - Math.max(0, observed - serverMs)
  }
}

function message(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const found =
      (value as Record<string, unknown>)['message'] ?? (value as Record<string, unknown>)['error']
    if (typeof found === 'string') return found
    return JSON.stringify(value).slice(0, 300)
  }
  return String(value)
}

// Splits SSE text into data payloads, returning what is left of an unfinished message.
export function messages(buffer: string, each: (data: string) => void): string {
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data) each(data)
  }
  return rest
}

export type TurnInput = {
  body: unknown
  context?: Target.Context | undefined
  fetch?: Fetch | undefined
  headers: Record<string, string>
  url: string
}

// Posts one turn and reads its event stream to the end, the deadline or a stall. firstByteMs is when the
// turn's first model request got its first response byte (the server's own timing, mapped onto this clock
// from the result's arrival, so it includes one trip back from the server);
// firstTokenMs is the first model text or reasoning delta to arrive here, else the first model output (a
// message or a tool call) when the surface sends no deltas.
export async function turn(input: TurnInput): Promise<Target.TurnSample> {
  const deadlineMs = input.context?.deadlineMs ?? 300_000
  const stallMs = input.context?.stallMs ?? 120_000
  const reader = new Reader()
  const control = new AbortController()
  let timedOut = false
  let stalled = false
  let stall: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(stall)
    stall = setTimeout(() => {
      stalled = true
      control.abort()
    }, stallMs)
  }
  const deadline = setTimeout(() => {
    timedOut = true
    control.abort()
  }, deadlineMs)
  const sendMs = Target.now()
  let failure: string | undefined
  try {
    arm()
    const response = await (input.fetch ?? fetch)(input.url, {
      body: JSON.stringify(input.body),
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...input.headers,
      },
      method: 'POST',
      signal: control.signal,
    })
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      failure = 'HTTP ' + response.status + (text ? ': ' + text.slice(0, 300) : '')
    } else {
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const at = Target.now()
        arm()
        buffer = messages(buffer + decoder.decode(chunk, { stream: true }), (data) => {
          try {
            reader.read(JSON.parse(data) as Envelope, at)
          } catch {}
        })
        if (reader.done) break
      }
      if (!reader.done) failure = 'the event stream ended before the turn finished'
      await response.body.cancel().catch(() => {})
    }
  } catch (error) {
    if (!timedOut && !stalled) failure = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(stall)
    clearTimeout(deadline)
  }
  return sample(reader, { doneMs: Target.now(), failure, sendMs, stalled, timedOut })
}

export function sample(
  reader: Reader,
  end: {
    doneMs: number
    failure?: string | undefined
    sendMs: number
    stalled: boolean
    timedOut: boolean
  },
): Target.TurnSample {
  const ok = reader.result?.['ok'] as Record<string, any> | undefined
  const timing = (reader.result?.['timing'] ?? {}) as Record<string, any>
  const requests = (
    Array.isArray(timing['model_requests']) ? timing['model_requests'] : []
  ) as Record<string, any>[]
  // The turn's first model request: the one that started first (requests are listed as they settle).
  const first = [...requests].sort(
    (a, b) => Number(a['started_ms'] ?? 0) - Number(b['started_ms'] ?? 0),
  )[0]
  const usage = (ok?.['usage'] ?? {}) as Record<string, any>
  const text = typeof ok?.['message'] === 'string' ? ok['message'] : reader.texts.join('\n')
  const tokens =
    typeof usage['output_tokens'] === 'number' ? (usage['output_tokens'] as number) : undefined
  const metrics: Record<string, number> = {}
  const put = (name: string, value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) metrics[name] = value
  }
  put('serverFirstByteMs', first?.['first_byte_ms'])
  put('serverHeadersMs', first?.['headers_ms'])
  put('serverModelStartMs', first?.['started_ms'])
  put('serverObservedMs', timing['observed_ms'])
  put('runtimeOpenMs', timing['runtime_open_ms'])
  put('admissionMs', timing['admission_ms'])
  if (typeof timing['runtime_reused'] === 'boolean')
    metrics['runtimeReused'] = timing['runtime_reused'] ? 1 : 0
  if (requests.length) metrics['modelRequests'] = requests.length
  put('costUsd', Number(usage['estimated_cost']?.usd))
  // No delta can arrive before the first byte, which bounds the estimate's trip back from the server.
  const estimate = reader.local(first?.['first_byte_ms'])
  const firstByteMs =
    estimate !== undefined && reader.firstTokenMs !== undefined
      ? Math.min(estimate, reader.firstTokenMs)
      : estimate
  const firstTokenMs = reader.firstTokenMs ?? reader.firstOutputMs
  const error = end.timedOut
    ? 'the turn passed its deadline'
    : end.stalled
      ? 'no event for longer than the stall window'
      : (end.failure ?? reader.error)
  return {
    cells: reader.cells,
    doneMs: end.doneMs,
    ...(error === undefined ? {} : { error }),
    ...(tokens === undefined && text ? { estimated: true } : {}),
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...(Object.keys(metrics).length ? { metrics } : {}),
    ok: error === undefined && reader.ok,
    outputTokens: tokens ?? Target.estimate(text),
    sendMs: end.sendMs,
    ...(end.stalled ? { stalled: true } : {}),
    text,
    ...(end.timedOut ? { timedOut: true } : {}),
  }
}

export function provider(model: string): 'claude' | 'codex' {
  return /^(tempo\/)?claude/.test(model) ? 'claude' : 'codex'
}

export function model(context?: Target.Context): string {
  return context?.model ?? process.env['NANOEVAL_SYSTEMS_MODEL'] ?? 'claude-haiku-4-5'
}

export type Release = {
  nanocodeRev?: string
  nanocodeTs: string
  tarball: string
  wasmFingerprint?: string
  wasmSha256?: string
}

const repository = 'nanocodexyz/nanocode-ts'

// The nanocode-ts build in a deployment's version string, such as pin-03b425f-ncts-6d58e23.
export function nanocodeTs(version: string): string | undefined {
  return /(?:^|[-_])ncts-([0-9a-f]{7,40})(?:$|[-_])/.exec(version)?.[1]
}

// Reads a nanocode-ts build-<sha> release: the nanocode SDK revision and WASM fingerprint its notes name,
// and the sha256 of nanocode_wasm.wasm from the tarball's dist/nanocode-wasm.json. Cached per build under
// NANOEVAL_SYSTEMS_CACHE (default ~/.cache/nanoeval/systems); what GitHub can't answer is left out.
export async function release(
  sha: string,
  options: { cache?: string; fetch?: Fetch } = {},
): Promise<Release> {
  const short = sha.slice(0, 7)
  const tarball =
    'https://github.com/' +
    repository +
    '/releases/download/build-' +
    short +
    '/nanocode-ts-' +
    short +
    '.tgz'
  const cache =
    options.cache ??
    process.env['NANOEVAL_SYSTEMS_CACHE'] ??
    Path.join(Os.homedir(), '.cache', 'nanoeval', 'systems')
  const known = Path.join(cache, 'nanocode-ts-' + short + '.json')
  const cached = await Fs.readFile(known, 'utf8').then(
    (text) => JSON.parse(text) as Release,
    () => undefined,
  )
  if (cached?.wasmSha256 && cached.nanocodeRev) return cached
  const found: Release = { nanocodeTs: sha, tarball }
  const get = options.fetch ?? fetch
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']
  try {
    const answer = await get(
      'https://api.github.com/repos/' + repository + '/releases/tags/build-' + short,
      {
        headers: {
          accept: 'application/vnd.github+json',
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (answer.ok) {
      const notes = String(((await answer.json()) as { body?: string }).body ?? '')
      const built = /Built from ([0-9a-f]{40})/.exec(notes)?.[1]
      const sdk = /against SDK ([0-9a-f]{7,40})/.exec(notes)?.[1]
      const wasm = /WASM build ([0-9a-f]{8,64})/.exec(notes)?.[1]
      if (built) found.nanocodeTs = built
      if (sdk) found.nanocodeRev = sdk
      if (wasm) found.wasmFingerprint = wasm
    }
  } catch {}
  try {
    const answer = await get(tarball, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (answer.ok) {
      await Fs.mkdir(cache, { recursive: true })
      const file = Path.join(cache, 'nanocode-ts-' + short + '.tgz')
      await Fs.writeFile(file, Buffer.from(await answer.arrayBuffer()))
      const manifest = await new Promise<string>((resolve, reject) =>
        execFile(
          'tar',
          ['-xzOf', file, 'package/dist/nanocode-wasm.json'],
          { maxBuffer: 1 << 24 },
          (error, out) => (error ? reject(error) : resolve(out)),
        ),
      ).finally(() => Fs.rm(file, { force: true }))
      const parsed = JSON.parse(manifest) as {
        files?: Record<string, string>
        fingerprint?: string
      }
      if (parsed.files?.['nanocode_wasm.wasm'])
        found.wasmSha256 = parsed.files['nanocode_wasm.wasm']
      if (parsed.fingerprint) found.wasmFingerprint ??= parsed.fingerprint
    }
  } catch {}
  if (found.wasmSha256 || found.nanocodeRev) {
    await Fs.mkdir(cache, { recursive: true }).catch(() => {})
    await Fs.writeFile(known, JSON.stringify(found, null, 2) + '\n').catch(() => {})
  }
  return found
}
