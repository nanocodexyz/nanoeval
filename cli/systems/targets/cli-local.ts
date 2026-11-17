import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Target from '../Target.ts'

// Drives the nanocode CLI headless (nanocode exec, one process per turn, later turns --resume the session)
// through a local route proxy, as the local systems harness does (sys METRICS.md): startup is the first model
// request reaching the proxy after spawn, TTFT the first line of model output the CLI writes (charged for any
// buffering), first byte the proxy's first upstream response byte, tok/s output tokens over the time each
// request streamed, cells the time from a response that asked for tools to the next request, RSS the process
// tree sampled every 100 ms. Keys come from the environment and never reach the CLI.

export type Provider = 'claude' | 'codex'

export type Call = {
  path: string
  status?: number
  tDone?: number
  tFirstByte?: number
  tFirstDelta?: number
  tReq: number
  tools: string[]
  usage?: { input?: number; output?: number }
}

const local = 'sk-nanoeval-systems-local'
const drop = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'x-api-key',
])
const codexDeltas = new Set([
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.function_call_arguments.delta',
  'response.custom_tool_call_input.delta',
  'response.refusal.delta',
])
const quiet = /^(nanocode: |session [0-9a-f-]{8,}$)/

export function provider(model: string): Provider {
  const forced = process.env['NANOEVAL_SYSTEMS_HARNESS']
  if (forced === 'claude' || forced === 'codex') return forced
  return /^(tempo\/)?claude/.test(model) ? 'claude' : 'codex'
}

export function model(context?: Target.Context): string {
  return context?.model ?? process.env['NANOEVAL_SYSTEMS_MODEL'] ?? 'claude-haiku-4-5'
}

function key(of: Provider): string | undefined {
  return of === 'claude'
    ? (process.env['NANOEVAL_SYSTEMS_ANTHROPIC_KEY'] ?? process.env['ANTHROPIC_API_KEY'])
    : (process.env['NANOEVAL_SYSTEMS_OPENAI_KEY'] ?? process.env['OPENAI_API_KEY'])
}

// Reads one server-sent event payload (or a whole JSON response) into the call record.
export function observe(call: Call, payload: unknown, at: number): void {
  if (!payload || typeof payload !== 'object') return
  const event = payload as Record<string, any>
  const type = String(event['type'] ?? '')
  if (type === 'message_start')
    call.usage = { ...call.usage, input: event['message']?.usage?.input_tokens }
  if (type === 'content_block_start' && event['content_block']?.type === 'tool_use')
    call.tools.push(String(event['content_block'].name))
  if ((type === 'content_block_delta' || codexDeltas.has(type)) && call.tFirstDelta === undefined)
    call.tFirstDelta = at
  if (
    type === 'content_block_start' &&
    event['content_block']?.type === 'tool_use' &&
    call.tFirstDelta === undefined
  )
    call.tFirstDelta = at
  if (type === 'message_delta' && event['usage']?.output_tokens !== undefined)
    call.usage = { ...call.usage, output: event['usage'].output_tokens }
  if (
    type === 'response.output_item.added' &&
    ['custom_tool_call', 'function_call', 'local_shell_call'].includes(event['item']?.type)
  ) {
    call.tools.push(String(event['item'].name ?? event['item'].type))
    call.tFirstDelta ??= at
  }
  if (type === 'response.completed' || type === 'response.done')
    call.usage = {
      input: event['response']?.usage?.input_tokens,
      output: event['response']?.usage?.output_tokens,
    }
  if (type === 'message' && Array.isArray(event['content'])) {
    call.usage = { input: event['usage']?.input_tokens, output: event['usage']?.output_tokens }
    for (const block of event['content'])
      if (block?.type === 'tool_use') call.tools.push(String(block.name))
  }
}

export function sse(buffer: string, each: (payload: unknown) => void): string {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      each(JSON.parse(data))
    } catch {}
  }
  return rest
}

export function model_call(path: string): boolean {
  return /(^|\/)(messages|responses)(\?|$)/.test(path)
}

export type Proxy = { calls: Call[]; close(): Promise<void>; onActivity?: () => void; url: string }

export async function proxy(of: Provider, upstream?: string): Promise<Proxy> {
  const secret = key(of)
  const base = (
    upstream ?? (of === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  ).replace(/\/+$/, '')
  const calls: Call[] = []
  const state: Proxy = { calls, close: async () => {}, url: '' }
  const server = Http.createServer(async (request, response) => {
    const tReq = Target.now()
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    let path = (request.url ?? '/').replace(/^\/+/, '/')
    if (of === 'codex') path = path.replace(/^\/v1\//, '/')
    const call: Call = { path, tReq, tools: [] }
    const metered = model_call(path)
    if (metered) calls.push(call)
    state.onActivity?.()
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers))
      if (!drop.has(name) && value !== undefined)
        headers[name] = Array.isArray(value) ? value.join(', ') : value
    if (secret) {
      if (of === 'claude') headers['x-api-key'] = secret
      else headers['authorization'] = 'Bearer ' + secret
    }
    try {
      const answer = await fetch(base + path, {
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        headers,
        method: request.method ?? 'GET',
      })
      call.status = answer.status
      const out: Record<string, string> = {}
      answer.headers.forEach((value, name) => {
        if (
          !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)
        )
          out[name] = value
      })
      response.writeHead(answer.status, out)
      const decoder = new TextDecoder()
      let buffer = ''
      const json = (answer.headers.get('content-type') ?? '').includes('json')
      if (answer.body)
        for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
          const at = Target.now()
          call.tFirstByte ??= at
          state.onActivity?.()
          response.write(chunk)
          if (!metered) continue
          buffer += decoder.decode(chunk, { stream: true })
          if (!json) buffer = sse(buffer, (payload) => observe(call, payload, at))
        }
      if (metered && json)
        try {
          observe(call, JSON.parse(buffer), Target.now())
        } catch {}
      call.tDone = Target.now()
      response.end()
    } catch (error) {
      call.tDone = Target.now()
      call.status = 502
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            message:
              'nanoeval systems proxy: ' + (error instanceof Error ? error.message : String(error)),
            type: 'proxy_error',
          },
        }),
      )
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  state.url = 'http://127.0.0.1:' + address.port
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return state
}

// One ps for every live process tree, every 100 ms.
type Watch = { root: number; samples: { kb: number; t: number }[] }
const watched = new Set<Watch>()
let ticking: ReturnType<typeof setInterval> | undefined
let busy = false
function tick() {
  if (busy || !watched.size) return
  busy = true
  const t = Target.now()
  execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { maxBuffer: 1 << 24 }, (error, stdout) => {
    busy = false
    if (error) return
    const kids = new Map<number, number[]>()
    const rss = new Map<number, number>()
    for (const line of stdout.split('\n')) {
      const found = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line)
      if (!found) continue
      rss.set(+found[1]!, +found[3]!)
      kids.set(+found[2]!, [...(kids.get(+found[2]!) ?? []), +found[1]!])
    }
    for (const watch of watched) {
      if (!rss.has(watch.root)) continue
      let kb = 0
      const stack = [watch.root]
      while (stack.length) {
        const pid = stack.pop()!
        kb += rss.get(pid) ?? 0
        stack.push(...(kids.get(pid) ?? []))
      }
      watch.samples.push({ kb, t })
    }
  })
}
function watch(root: number): Watch {
  const entry: Watch = { root, samples: [] }
  watched.add(entry)
  ticking ??= setInterval(tick, 100)
  ticking.unref()
  return entry
}
function unwatch(entry: Watch) {
  watched.delete(entry)
  if (!watched.size && ticking) {
    clearInterval(ticking)
    ticking = undefined
  }
}

export function triple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'darwin') return arch + '-apple-darwin'
  if (process.platform === 'linux') return arch + '-unknown-linux-gnu'
  throw new Target.InvalidError('cli-local runs on Linux or macOS, not ' + process.platform)
}

export function release(version: string): string {
  return (
    'https://github.com/nanocodexyz/nanocode/releases/download/nanocode-cli/nanocode-' +
    triple() +
    (version === 'latest' ? '' : '.' + version) +
    '.xz'
  )
}

function cache(): string {
  return (
    process.env['NANOEVAL_SYSTEMS_CACHE'] ??
    Path.join(Os.homedir(), '.cache', 'nanoeval', 'systems')
  )
}

async function unpack(url: string, file: string): Promise<void> {
  const answer = await fetch(url)
  if (!answer.ok) throw new Target.InvalidError('downloading ' + url + ' answered ' + answer.status)
  const bytes = Buffer.from(await answer.arrayBuffer())
  const tool = url.endsWith('.xz') ? 'xz' : url.endsWith('.gz') ? 'gzip' : undefined
  await Fs.mkdir(Path.dirname(file), { recursive: true })
  if (!tool) await Fs.writeFile(file + '.part', bytes)
  else {
    await Fs.writeFile(file + '.download', bytes)
    const sink = await Fs.open(file + '.part', 'w')
    try {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(tool, ['-dc', file + '.download'], {
          stdio: ['ignore', sink.fd, 'inherit'],
        })
        child.on('error', () => resolve(-1))
        child.on('close', resolve)
      })
      if (code !== 0) throw new Target.InvalidError(tool + ' could not unpack ' + url)
    } finally {
      await sink.close()
      await Fs.rm(file + '.download', { force: true })
    }
  }
  await Fs.chmod(file + '.part', 0o755)
  await Fs.rename(file + '.part', file)
}

const resolved = new Map<string, Promise<string>>()
export function binary(build: Target.Build): Promise<string> {
  const spec = build.binary ?? build.url ?? build.version ?? 'latest'
  let found = resolved.get(spec)
  if (!found) {
    found = (async () => {
      if (build.binary) {
        const path = Path.resolve(build.binary.replace(/^~(?=\/)/, Os.homedir()))
        await Fs.access(path)
        return path
      }
      const url = build.url ?? release(build.version ?? 'latest')
      const file = Path.join(
        cache(),
        createHash('sha256').update(url).digest('hex').slice(0, 16),
        'nanocode',
      )
      if (build.version === 'latest' || !(await Fs.stat(file).catch(() => undefined)))
        await unpack(url, file)
      return file
    })()
    resolved.set(spec, found)
  }
  return found
}

async function digest(file: string): Promise<string> {
  return createHash('sha256')
    .update(await Fs.readFile(file))
    .digest('hex')
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: 30_000 }, (_, stdout, stderr) =>
      resolve((stdout || stderr).trim()),
    ),
  )
}

const homes = new Map<string, string>()
async function home(label: string, root: string): Promise<string> {
  let found = homes.get(label)
  if (!found) {
    found = Path.join(root, 'home-' + label.replace(/[^\w.-]/g, '_'))
    await Fs.mkdir(found, { recursive: true })
    homes.set(label, found)
  }
  return found
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

export function cells(calls: readonly Call[], doneMs: number): Target.CellTiming[] {
  const found: Target.CellTiming[] = []
  calls.forEach((call, at) => {
    if (!call.tools.length || call.tDone === undefined) return
    const name = call.tools.join(',')
    found.push({
      endMs: calls[at + 1]?.tReq ?? doneMs,
      kind: /python/i.test(name)
        ? 'python'
        : /^(exec|wait)(,|$)/.test(name)
          ? 'code'
          : /bash|shell/i.test(name)
            ? 'shell'
            : 'tool',
      name,
      ok: true,
      startMs: call.tDone,
    })
  })
  return found
}

let root: Promise<string> | undefined
function scratch(): Promise<string> {
  root ??= Fs.mkdtemp(Path.join(Os.tmpdir(), 'nanoeval-systems-'))
  return root
}

export const cliLocal: Target.Target = {
  async describe(build) {
    const file = await binary(build)
    const sha = await digest(file)
    return {
      ...(build.version && /^[0-9a-f]{7,40}$/.test(build.version)
        ? { nanocodeRev: build.version }
        : {}),
      overrides: {
        binary: file,
        model: model(),
        route: key(provider(model())) ? 'proxy' : 'direct',
        sha256: sha,
        version: await run(file, ['--version']),
      },
      ...(build.url ? { url: build.url } : {}),
    }
  },
  name: 'cli-local',
  async open(build, context) {
    const base = await scratch()
    const named = model(context)
    const of = provider(named)
    const dir = await Fs.mkdtemp(Path.join(base, 'session-'))
    const work = Path.join(dir, 'work')
    await Fs.mkdir(work, { recursive: true })
    let file = await binary(build)
    let nanohome = await home(build.label, base)
    if (context?.cold) {
      const fresh = Path.join(dir, 'bin', Path.basename(file))
      await Fs.mkdir(Path.dirname(fresh), { recursive: true })
      await Fs.copyFile(file, fresh)
      await Fs.chmod(fresh, 0o755)
      file = fresh
      nanohome = Path.join(dir, 'home')
      await Fs.mkdir(nanohome, { recursive: true })
    }
    const route =
      key(of) && !named.startsWith('tempo/')
        ? await proxy(of, process.env['NANOEVAL_SYSTEMS_UPSTREAM'])
        : undefined
    const env: Record<string, string> = {
      HOME: process.env['HOME'] ?? Os.homedir(),
      LANG: 'en_US.UTF-8',
      NANOCODE_HOME: nanohome,
      NO_COLOR: '1',
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TERM: 'dumb',
      TMPDIR: dir,
    }
    if (route && of === 'claude')
      Object.assign(env, {
        NANOCODE_ANTHROPIC_API_KEY: local,
        NANOCODE_ANTHROPIC_BASE_URL: route.url + '/v1',
        NANOCODE_ANTHROPIC_MESSAGES_URL: route.url + '/v1/messages',
      })
    if (route && of === 'codex')
      Object.assign(env, { NANOCODE_OPENAI_API_KEY: local, NANOCODE_OPENAI_BASE_URL: route.url })
    if (!route)
      for (const name of [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'TEMPO_API_KEY',
        'NANOCODE_TEMPO_KEY',
      ])
        if (process.env[name]) env[name] = process.env[name]!
    let session: string | undefined
    const deadlineMs = context?.deadlineMs ?? 120_000
    const stallMs = context?.stallMs ?? 30_000
    return {
      async close() {
        await route?.close()
        await Fs.rm(dir, { force: true, recursive: true }).catch(() => {})
      },
      get id() {
        return session ?? Path.basename(dir)
      },
      async turn(prompt) {
        const from = route?.calls.length ?? 0
        const args = ['exec', '--model', named, '--harness', of]
        if (context?.thinking) args.push('--thinking', context.thinking)
        if (session) args.push('--resume=' + session)
        args.push(prompt)
        let last = Target.now()
        let gap = 0
        const active = () => {
          const at = Target.now()
          gap = Math.max(gap, at - last)
          last = at
        }
        if (route) route.onActivity = active
        const sendMs = Target.now()
        last = sendMs
        const child = spawn(file, args, {
          cwd: work,
          detached: true,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const memory = child.pid ? watch(child.pid) : undefined
        let firstTokenMs: number | undefined
        let stdout = ''
        let stderr = ''
        const lines = (text: string, at: number) => {
          for (const line of text.split('\n'))
            if (line.trim() && !quiet.test(line.trim()) && firstTokenMs === undefined)
              firstTokenMs = at
        }
        let pendingOut = ''
        let pendingErr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          const at = Target.now()
          active()
          stdout += chunk
          pendingOut += chunk
          const cut = pendingOut.lastIndexOf('\n')
          if (cut >= 0 || firstTokenMs === undefined) {
            lines(cut >= 0 ? pendingOut.slice(0, cut) : pendingOut, at)
            if (cut >= 0) pendingOut = pendingOut.slice(cut + 1)
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          const at = Target.now()
          active()
          stderr += chunk
          pendingErr += chunk
          const cut = pendingErr.lastIndexOf('\n')
          if (cut >= 0) {
            lines(pendingErr.slice(0, cut), at)
            pendingErr = pendingErr.slice(cut + 1)
          }
        })
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {}
        }, deadlineMs)
        const code = await new Promise<number | null>((resolve) => {
          child.on('error', () => resolve(-1))
          child.on('close', (exit) => resolve(exit))
        })
        clearTimeout(timer)
        const doneMs = Target.now()
        gap = Math.max(gap, doneMs - last)
        if (memory) unwatch(memory)
        if (route) route.onActivity = undefined
        session = /^session ([0-9a-f-]{8,})$/m.exec(stderr)?.[1] ?? session
        const calls = route?.calls.slice(from) ?? []
        const first = calls[0]
        const metrics: Record<string, number> = {}
        if (first) metrics['startupMs'] = first.tReq - sendMs
        const kb = memory?.samples ?? []
        if (kb.length) {
          metrics['rssPeakKb'] = Math.max(...kb.map((sample) => sample.kb))
          const steady = median(
            kb.filter((sample) => !first || sample.t >= first.tReq).map((sample) => sample.kb),
          )
          if (steady !== undefined) metrics['rssSteadyKb'] = steady
        }
        const streamed = calls.filter(
          (call) =>
            call.tFirstDelta !== undefined && call.tDone !== undefined && call.usage?.output,
        )
        const streamMs = streamed.reduce((sum, call) => sum + (call.tDone! - call.tFirstDelta!), 0)
        const outputTokens = calls.reduce((sum, call) => sum + (call.usage?.output ?? 0), 0)
        if (streamMs > 0)
          metrics['tokS'] =
            streamed.reduce((sum, call) => sum + call.usage!.output!, 0) / (streamMs / 1000)
        const wire = calls.find((call) => call.tFirstDelta !== undefined)
        if (wire) metrics['ttftWireMs'] = wire.tFirstDelta! - sendMs
        metrics['modelCalls'] = calls.length
        const ok = code === 0 && !timedOut
        const text = stdout.trim()
        return {
          cells: cells(calls, doneMs),
          doneMs,
          ...(ok
            ? {}
            : {
                error: timedOut
                  ? 'deadline of ' + deadlineMs + ' ms'
                  : 'exit ' +
                    code +
                    ': ' +
                    stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400),
              }),
          ...(first?.tFirstByte !== undefined ? { firstByteMs: first.tFirstByte } : {}),
          ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
          metrics,
          ok,
          ...(route ? { outputTokens } : { estimated: true, outputTokens: Target.estimate(text) }),
          sendMs,
          stalled: gap > stallMs,
          text,
          timedOut,
        }
      },
    }
  },
}

export default cliLocal
