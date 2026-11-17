import assert from 'node:assert/strict'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Gateway from '../cli/systems/targets/gateway.ts'
import * as Hosted from '../cli/systems/targets/Hosted.ts'
import * as Release from '../cli/systems/targets/release-worker.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function agent(type: string, payload: Record<string, unknown>, created: number): string {
  return JSON.stringify({
    created_at: created,
    event: { event: { payload, type }, source: 'agent' },
  })
}

const result = JSON.stringify({
  event: {
    ok: { message: 'pong', usage: { estimated_cost: { usd: '0.02' }, output_tokens: 4 } },
    status: 'completed',
    timing: {
      model_requests: [{ first_byte_ms: 40, headers_ms: 38, started_ms: 10 }],
      observed_ms: 90,
      runtime_open_ms: 10,
      runtime_reused: false,
    },
    type: 'result',
  },
})

type Seen = { body: string; headers: Http.IncomingHttpHeaders; method: string; url: string }

// A fake deployment: answers each request with a handler's status, headers and SSE messages, written apart.
async function server(
  handle: (seen: Seen) => { body?: string; messages?: string[]; status: number } | undefined,
): Promise<{ close(): void; seen: Seen[]; url: string }> {
  const seen: Seen[] = []
  const http = Http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      const one = { body, headers: request.headers, method: request.method!, url: request.url! }
      seen.push(one)
      const answer = handle(one) ?? { status: 404 }
      if (!answer.messages) return void response.writeHead(answer.status).end(answer.body ?? '')
      response.writeHead(answer.status, { 'content-type': 'text/event-stream' })
      for (const data of answer.messages) {
        response.write('data: ' + data + '\n\n')
        await sleep(5)
      }
      response.end()
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    close: () => void http.close(),
    seen,
    url: 'http://127.0.0.1:' + (http.address() as AddressInfo).port,
  }
}

const turnMessages = [
  JSON.stringify({ event: { type: 'queued' } }),
  agent('run.started', {}, 10),
  agent('assistant.delta', { text: 'po' }, 45),
  agent('tool.call', { call_id: 'c1', tool: 'shell' }, 50),
  agent('tool.result', { call_id: 'c1', duration_ns: 3_000_000, status: 'completed' }, 55),
  agent('tool.call', { call_id: 'c2', tool: 'python' }, 56),
  agent('tool.result', { call_id: 'c2', status: 'error' }, 60),
  agent('assistant.message', { text: 'pong' }, 80),
  result,
]

test('Hosted.messages splits SSE and keeps an unfinished message', () => {
  const got: string[] = []
  const rest = Hosted.messages('data: a\n\ndata: b\r\n\r\nevent: x\ndata: c', (data) =>
    got.push(data),
  )
  assert.deepEqual(got, ['a', 'b'])
  assert.equal(rest, 'event: x\ndata: c')
})

test('Hosted.kind names cells by tool', () => {
  assert.equal(Hosted.kind('shell'), 'shell')
  assert.equal(Hosted.kind('python'), 'python')
  assert.equal(Hosted.kind('exec'), 'code')
  assert.equal(Hosted.kind('read_file'), 'tool')
})

test('Hosted.nanocodeTs reads the build from a version string', () => {
  assert.equal(Hosted.nanocodeTs('pin-03b425f-ncts-6d58e23'), '6d58e23')
  assert.equal(Hosted.nanocodeTs('03b425f'), undefined)
})

test('Hosted.Reader maps server first byte onto the client clock', () => {
  const reader = new Hosted.Reader()
  reader.read(JSON.parse(agent('run.started', {}, 10)), 1_000)
  reader.read(JSON.parse(agent('assistant.message', { text: 'x' }, 30)), 1_025)
  reader.read(JSON.parse(result), 1_100)
  const sample = Hosted.sample(reader, {
    doneMs: 1_100,
    sendMs: 950,
    stalled: false,
    timedOut: false,
  })
  assert.equal(sample.ok, true)
  // The result (observed_ms 90) arrived at 1100, so first byte (server 40) was 50 before it.
  assert.equal(sample.firstByteMs, 1_050)
  assert.equal(sample.firstTokenMs, 1_025)
  assert.equal(sample.outputTokens, 4)
  assert.equal(sample.text, 'pong')
  assert.equal(sample.metrics?.['serverFirstByteMs'], 40)
  assert.equal(sample.metrics?.['costUsd'], 0.02)
  assert.equal(sample.metrics?.['runtimeReused'], 0)
})

test('Hosted first byte is never after the first delta', () => {
  const reader = new Hosted.Reader()
  reader.read(JSON.parse(agent('assistant.delta', { text: 'p' }, 30)), 1_020)
  reader.read(JSON.parse(result), 1_100)
  const sample = Hosted.sample(reader, {
    doneMs: 1_100,
    sendMs: 950,
    stalled: false,
    timedOut: false,
  })
  assert.equal(sample.firstByteMs, 1_020)
  assert.equal(sample.firstTokenMs, 1_020)
})

test('release-worker runs a turn, times it and reports cells', async () => {
  const fake = await server((seen) => {
    if (
      seen.method === 'POST' &&
      /^\/sessions\/systems-a-[0-9a-f-]+\/turns\?live=1$/.test(seen.url)
    )
      return { messages: turnMessages, status: 200 }
    return undefined
  })
  try {
    const target = Release.target({ token: 't0', url: fake.url })
    const session = await target.open(
      { label: 'a' },
      { deadlineMs: 5_000, model: 'claude-haiku-4-5', stallMs: 2_000 },
    )
    const sample = await session.turn('say pong')
    assert.equal(sample.ok, true, sample.error)
    assert.equal(sample.text, 'pong')
    assert.equal(sample.outputTokens, 4)
    assert.ok(sample.firstTokenMs! >= sample.sendMs && sample.firstTokenMs! <= sample.doneMs)
    assert.ok(sample.firstByteMs! >= sample.sendMs - 50 && sample.firstByteMs! <= sample.doneMs)
    assert.deepEqual(
      sample.cells.map((cell) => [cell.kind, cell.ok, Math.round(cell.endMs - cell.startMs)]),
      [
        ['shell', true, 3],
        ['python', false, 4],
      ],
    )
    const body = JSON.parse(fake.seen[0]!.body)
    assert.equal(body.provider, 'claude')
    assert.equal(body.model, 'claude-haiku-4-5')
    assert.equal(body.prompt, 'say pong')
    assert.equal(fake.seen[0]!.headers.authorization, 'Bearer t0')
    const again = await target.resume!({ label: 'a' }, session.id)
    assert.equal(again.id, session.id)
  } finally {
    fake.close()
  }
})

test('release-worker checks the deployed version and describes the build', async () => {
  const fake = await server((seen) => {
    if (seen.url === '/health') return { body: JSON.stringify({ ok: true }), status: 200 }
    if (seen.url === '/v1/version')
      return { body: JSON.stringify({ commit: 'pin-03b425f-ncts-6d58e23' }), status: 200 }
    if (seen.url === '/v1/routes') return { body: JSON.stringify({ claude: 'payer' }), status: 200 }
    return undefined
  })
  try {
    const target = Release.target({
      release: async (sha) => ({
        nanocodeRev: '8c19740',
        nanocodeTs: sha + 'full',
        tarball: '',
        wasmSha256: 'abc',
      }),
      token: 't0',
      url: fake.url,
    })
    const description = await target.describe({ label: 'a' })
    assert.equal(description.nanocodeTs, '6d58e23full')
    assert.equal(description.nanocodeRev, '8c19740')
    assert.equal(description.wasmSha256, 'abc')
    assert.equal(description.overrides['deployed'], 'pin-03b425f-ncts-6d58e23')
    assert.equal(description.overrides['hands'], 'always')
    assert.equal(description.overrides['healthy'], true)
    await assert.rejects(
      target.open({ label: 'a', version: 'deadbee' }),
      /serves pin-03b425f-ncts-6d58e23/,
    )
    assert.ok(await target.open({ label: 'a', version: '6d58e23' }))
    await assert.rejects(target.open({ binary: './nanocode', label: 'a' }), /deployed build/)
  } finally {
    fake.close()
  }
})

test('release-worker reports a stall and an HTTP failure', async () => {
  const fake = await server((seen) => {
    if (seen.url.includes('-bad-')) return { body: 'nope', status: 401 }
    return { messages: [agent('run.started', {}, 1)], status: 200 }
  })
  try {
    const target = Release.target({ token: 't0', url: fake.url })
    const bad = await (await target.open({ label: 'bad' })).turn('x')
    assert.equal(bad.ok, false)
    assert.match(bad.error!, /HTTP 401: nope/)
    const cut = await (
      await target.open({ label: 'cut' }, { deadlineMs: 5_000, stallMs: 2_000 })
    ).turn('x')
    assert.equal(cut.ok, false)
    assert.match(cut.error!, /ended before the turn finished/)
  } finally {
    fake.close()
  }
})

test('gateway creates an agent, runs a turn, reads its spend and deletes it', async () => {
  const fake = await server((seen) => {
    if (seen.method === 'POST' && seen.url === '/v1/agents')
      return { body: JSON.stringify({ harness: 'claude', id: 'ag1' }), status: 201 }
    if (seen.method === 'POST' && seen.url === '/v1/agents/ag1/turns')
      return { messages: turnMessages, status: 200 }
    if (seen.method === 'GET' && seen.url.startsWith('/v1/agents/ag1/turns/'))
      return { body: JSON.stringify({ spent_usd: 0.03 }), status: 200 }
    if (seen.method === 'DELETE' && seen.url === '/v1/agents/ag1')
      return { body: '{}', status: 200 }
    if (seen.url === '/v1/agents/health')
      return { body: JSON.stringify({ model: 'm0', ok: true }), status: 200 }
    return undefined
  })
  try {
    const target = Gateway.target({ app: 'bench', key: 'k0', payer: 'credit', url: fake.url })
    const session = await target.open(
      { label: 'g' },
      { deadlineMs: 5_000, model: 'claude-haiku-4-5', stallMs: 2_000 },
    )
    assert.equal(session.id, 'ag1')
    const create = JSON.parse(fake.seen[0]!.body)
    assert.equal(create.model, 'claude-haiku-4-5')
    assert.equal(create.payer, 'credit')
    assert.match(create.name, /^systems-g-/)
    assert.equal(fake.seen[0]!.headers.authorization, 'Bearer k0')
    assert.equal(fake.seen[0]!.headers['gateway-app'], 'bench')
    const sample = await session.turn('say pong')
    assert.equal(sample.ok, true, sample.error)
    assert.equal(sample.text, 'pong')
    assert.equal(sample.metrics?.['spentUsd'], 0.03)
    assert.ok((sample.metrics?.['createMs'] ?? -1) >= 0)
    const turn = JSON.parse(fake.seen[1]!.body)
    assert.equal(turn.prompt, 'say pong')
    assert.match(turn.id, /^[0-9a-f-]{36}$/)
    const second = await session.turn('again')
    assert.equal(second.metrics?.['createMs'], undefined)
    await session.close()
    assert.ok(fake.seen.some((seen) => seen.method === 'DELETE'))
    const description = await target.describe({ label: 'g' })
    assert.equal(description.overrides['defaultModel'], 'm0')
    assert.equal(description.overrides['payer'], 'credit')
  } finally {
    fake.close()
  }
})

test('gateway needs a URL and a key', async () => {
  const saved = {
    key: process.env['NANOEVAL_SYSTEMS_GATEWAY_KEY'],
    url: process.env['NANOEVAL_SYSTEMS_GATEWAY_URL'],
  }
  delete process.env['NANOEVAL_SYSTEMS_GATEWAY_KEY']
  delete process.env['NANOEVAL_SYSTEMS_GATEWAY_URL']
  try {
    await assert.rejects(Gateway.target().open({ label: 'g' }), /NANOEVAL_SYSTEMS_GATEWAY_URL/)
    await assert.rejects(
      Gateway.target({ url: 'http://127.0.0.1:1' }).open({ label: 'g' }),
      /NANOEVAL_SYSTEMS_GATEWAY_KEY/,
    )
  } finally {
    if (saved.key !== undefined) process.env['NANOEVAL_SYSTEMS_GATEWAY_KEY'] = saved.key
    if (saved.url !== undefined) process.env['NANOEVAL_SYSTEMS_GATEWAY_URL'] = saved.url
  }
})

test('gateway surfaces a refused create', async () => {
  const fake = await server(() => ({ body: '{"error":"payment required"}', status: 402 }))
  try {
    await assert.rejects(
      Gateway.target({ key: 'k0', url: fake.url }).open({ label: 'g' }),
      /402: .*payment required/,
    )
  } finally {
    fake.close()
  }
})

test('Hosted.release reads a build release and caches it', async () => {
  const cache = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'systems-'))
  let asked = 0
  const fakeFetch = (async (url: string) => {
    asked++
    if (String(url).includes('/releases/tags/'))
      return new Response(
        JSON.stringify({
          body:
            'Built from ' +
            'a'.repeat(40) +
            ' against SDK 8c19740b653b. WASM build f70a4a233355bb5bf82c.',
        }),
      )
    return new Response('missing', { status: 404 })
  }) as unknown as typeof fetch
  try {
    const found = await Hosted.release('6d58e23', { cache, fetch: fakeFetch })
    assert.equal(found.nanocodeTs, 'a'.repeat(40))
    assert.equal(found.nanocodeRev, '8c19740b653b')
    assert.equal(found.wasmFingerprint, 'f70a4a233355bb5bf82c')
    assert.match(found.tarball, /build-6d58e23\/nanocode-ts-6d58e23\.tgz$/)
    assert.equal(asked, 2)
  } finally {
    await Fs.rm(cache, { force: true, recursive: true })
  }
})
