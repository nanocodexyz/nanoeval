import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import * as Zlib from 'node:zlib'
import vercel, * as Vercel from '../cli/systems/targets/vercel-demo.ts'

const textTurn = [
  'retry: 1000',
  'id: 0.0',
  '',
  'id: 0.1',
  'data: {"type":"text","delta":"hello there","item":"gen_1","seq":16389,"at":1794958036549}',
  '',
  'id: 0.2',
  'data: {"type":"usage","index":1,"replayed":false,"first_output_ms":758.36,"duration_ms":763.42,"input_tokens":14962,"cached_tokens":0,"output_tokens":5}',
  '',
  'id: 0.3',
  'data: {"type":"turn","status":"completed","message":"hello there","seq":16392,"at":1794958036562}',
  '',
  'id: 0.4;end',
  'data: {"type":"idle"}',
  '',
  'event: end',
  'data: {}',
  '',
  '',
].join('\n')

const cellTurn = [
  'id: 1.0',
  '',
  'id: 1.1',
  'data: {"type":"tool_input","name":"exec","delta":"{"code": "const r","call_id":"toolu_A","at":1000}',
  '',
  'id: 1.2',
  'data: {"type":"usage","index":1,"replayed":false,"first_output_ms":1678.8,"input_tokens":15182,"cached_tokens":15111,"output_tokens":226}',
  '',
  'id: 1.3',
  'data: {"type":"tool_start","name":"exec","args":{"code":"..."},"call_id":"toolu_A","at":2000}',
  '',
  'id: 1.4',
  'data: {"type":"tool_start","name":"Bash","args":{"command":"python3 -c \u0027print(1)\u0027"},"call_id":"toolu_A/code-1","parent":"toolu_A","at":2030}',
  '',
  'id: 1.5',
  'data: {"type":"tool_end","name":"Bash","call_id":"toolu_A/code-1","parent":"toolu_A","status":"completed","structured":{"exit_code":0},"at":2930}',
  '',
  'id: 1.6',
  'data: {"type":"tool_start","name":"Bash","args":{"command":"ls /nope"},"call_id":"toolu_A/code-2","parent":"toolu_A","at":2940}',
  '',
  'id: 1.7',
  'data: {"type":"tool_end","name":"Bash","call_id":"toolu_A/code-2","parent":"toolu_A","status":"completed","structured":{"exit_code":2},"at":2990}',
  '',
  'id: 1.8',
  'data: {"type":"tool_end","name":"exec","call_id":"toolu_A","status":"completed","structured":null,"duration_ns":1036468530,"at":3036}',
  '',
  'id: 1.9',
  'data: {"type":"usage","index":2,"replayed":false,"first_output_ms":544.7,"input_tokens":15461,"cached_tokens":15178,"output_tokens":11}',
  '',
  'id: 1.10',
  'data: {"type":"text","delta":"The output is **1**.","at":3500}',
  '',
  'id: 1.11',
  'data: {"type":"turn","status":"completed","message":"The output is **1**.","at":3600}',
  '',
  'id: 1.12;end',
  'data: {"type":"idle"}',
  '',
  'event: end',
  'data: {}',
  '',
  '',
].join('\n')

function fold(stream: string, chunk = 7, at = 0): Vercel.Turn {
  const sse = new Vercel.Sse()
  const turn = new Vercel.Turn(0)
  for (let index = 0; index < stream.length; index += chunk)
    for (const frame of sse.push(stream.slice(index, index + chunk))) turn.frame(frame, at + index)
  return turn
}

test('the SSE parser frames ids, events and multi-line data across chunks and CRLF', () => {
  const sse = new Vercel.Sse()
  const frames = [
    ...sse.push('retry: 1000\r\nid: 0.0\r'),
    ...sse.push('\n\r\n: keepalive\n\ndata: a\ndata:b\n'),
    ...sse.push('\nevent: end\ndata: {}\n\n'),
  ]
  assert.deepEqual(frames, [{ id: '0.0' }, { data: 'a\nb' }, { data: '{}', event: 'end' }])
})

test('a text turn yields its text, first token, usage and end', () => {
  const turn = fold(textTurn)
  assert.equal(turn.ended, true)
  assert.equal(turn.cursor, '0.4;end')
  const sample = turn.sample(9_000)
  assert.equal(sample.ok, true)
  assert.equal(sample.text, 'hello there')
  assert.equal(sample.outputTokens, 5)
  assert.equal(sample.estimated, undefined)
  assert.ok(sample.firstTokenMs !== undefined && sample.firstTokenMs > 0)
  assert.deepEqual(sample.cells, [])
  assert.equal(sample.metrics?.['modelCalls'], 1)
  assert.equal(sample.metrics?.['inputTokens'], 14962)
  assert.equal(sample.metrics?.['serverFirstOutputMs'], 758.36)
})

test('Code Mode and Python cells are timed on the server clock', () => {
  const turn = fold(cellTurn, 4096, 50_000)
  const sample = turn.sample(60_000)
  assert.equal(sample.ok, true)
  assert.equal(sample.outputTokens, 237)
  assert.equal(sample.metrics?.['cachedTokens'], 30289)
  assert.equal(sample.firstTokenMs, 50_000)
  assert.deepEqual(
    sample.cells.map((cell) => [
      cell.kind,
      cell.name,
      cell.ok,
      Math.round(cell.endMs - cell.startMs),
    ]),
    [
      ['python', 'Bash', true, 900],
      ['shell', 'Bash', false, 50],
      ['code', 'exec', true, 1036],
    ],
  )
  assert.equal(sample.metrics?.['cells'], 3)
})

test('failures, replays and missing ends are reported', () => {
  const failed = new Vercel.Turn(0)
  failed.event({ type: 'usage', replayed: true, output_tokens: 99 }, 1)
  failed.event({ type: 'text', delta: 'abcdefgh' }, 2)
  failed.event({ type: 'turn', status: 'failed', message: 'model gateway 503' }, 3)
  failed.ended = true
  const sample = failed.sample(4)
  assert.equal(sample.ok, false)
  assert.equal(sample.error, 'turn failed: model gateway 503')
  assert.equal(sample.estimated, true)
  assert.equal(sample.outputTokens, 2)
  assert.equal(sample.metrics?.['replayedModelCalls'], 1)

  const dropped = fold(textTurn.slice(0, textTurn.indexOf('id: 0.3')))
  assert.equal(dropped.sample(1).error, 'stream ended early')
  assert.equal(dropped.cursor, '0.2')
  const late = dropped.sample(1, { stalled: true, timedOut: true })
  assert.equal(late.timedOut, true)
  assert.equal(late.stalled, true)
  assert.equal(late.ok, false)
})

test('cell kinds, selections and URLs', () => {
  assert.equal(Vercel.kind({ name: 'exec' }), 'code')
  assert.equal(Vercel.kind({ name: 'exec', parent: 'x' }), 'tool')
  assert.equal(
    Vercel.kind({ name: 'Bash', args: { command: 'cd /w && python3 main.py' } }),
    'python',
  )
  assert.equal(Vercel.kind({ name: 'Bash', args: { command: 'uv run python -c 1' } }), 'python')
  assert.equal(Vercel.kind({ name: 'Bash', args: { command: 'pythonista' } }), 'shell')
  assert.equal(Vercel.kind({ name: 'WebFetch' }), 'tool')
  assert.deepEqual(Vercel.selection('gpt-6-luna@medium', {}), {
    effort: 'medium',
    harness: 'codex',
    model: 'gpt-6-luna',
  })
  assert.deepEqual(Vercel.selection('claude:zai/glm-5.3', {}), {
    harness: 'claude',
    model: 'zai/glm-5.3',
  })
  assert.deepEqual(Vercel.selection(undefined, { NANOEVAL_SYSTEMS_VERCEL_DEMO_EFFORT: 'high' }), {
    effort: 'high',
  })
  assert.deepEqual(Vercel.selection('claude-sonnet-5-5', {}, 'medium'), {
    effort: 'medium',
    harness: 'claude',
    model: 'claude-sonnet-5-5',
  })
  assert.equal(Vercel.base({ label: 'a' }, {}), Vercel.production)
  assert.equal(
    Vercel.base({ label: 'a', url: 'https://nanocode.xyz/vercel/' }, {}),
    'https://nanocode.xyz/vercel',
  )
  assert.equal(
    Vercel.base({ label: 'a', url: 'https://x.vercel.app/api/chat' }, {}),
    'https://x.vercel.app',
  )
  assert.throws(() =>
    Vercel.base({ label: 'a', binary: './nc' }, { NANOEVAL_SYSTEMS_VERCEL_DEMO_URL: 'nope' }),
  )
  const sent = Vercel.headers(
    { a: '1' },
    { NANOEVAL_SYSTEMS_VERCEL_DEMO_BYPASS: 'b', NANOEVAL_SYSTEMS_VERCEL_DEMO_TOKEN: 't' },
  )
  assert.deepEqual(sent, { a: '1', authorization: 'Bearer t', 'x-vercel-protection-bypass': 'b' })
})

function entry(name: string, body: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write(Buffer.byteLength(body).toString(8).padStart(11, '0'), 124)
  const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512)
  data.write(body)
  return Buffer.concat([header, data])
}

test('untar finds the wasm manifest in a gzipped tarball streamed in small chunks', async () => {
  const tar = Buffer.concat([
    entry('package/dist/big.wasm', 'x'.repeat(3000)),
    entry('package/dist/nanocode-wasm.json', '{"fingerprint":"f7"}'),
    Buffer.alloc(1024),
  ])
  const gz = Zlib.gzipSync(tar)
  const chunks = Array.from({ length: Math.ceil(gz.length / 100) }, (_, index) =>
    gz.subarray(index * 100, index * 100 + 100),
  )
  const found = await Vercel.untar(
    Readable.from(chunks).pipe(Zlib.createGunzip()),
    /dist\/nanocode-wasm\.json$/,
  )
  assert.equal(found, '{"fingerprint":"f7"}')
  assert.equal(await Vercel.untar(Readable.from([tar]), /missing/), undefined)
})

test('a session warms, streams a turn, resumes a dropped stream and reuses its id', async () => {
  const seen: string[] = []
  const server = Http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.push(request.method + ' ' + url.search + ' ' + body)
      if (request.method === 'POST' && JSON.parse(body).warm) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ sessionId: 'wrun_1' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-session-id': 'wrun_1' })
      if (request.method === 'POST') {
        response.end(textTurn.slice(0, textTurn.indexOf('id: 0.3')))
        return
      }
      response.end(textTurn.slice(textTurn.indexOf('id: 0.3')))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    const session = await vercel.open(
      { label: 'local', url },
      { deadlineMs: 5_000, model: 'claude-haiku-5-5', stallMs: 2_000 },
    )
    assert.equal(session.id, 'wrun_1')
    const sample = await session.turn('say hello')
    assert.equal(sample.ok, true, sample.error)
    assert.equal(sample.text, 'hello there')
    assert.equal(sample.metrics?.['reconnects'], 1)
    assert.ok((sample.metrics?.['openMs'] ?? -1) >= 0)
    assert.ok(sample.firstByteMs !== undefined && sample.firstByteMs >= sample.sendMs)
    assert.ok(sample.doneMs >= (sample.firstTokenMs ?? 0))
    assert.deepEqual(seen, [
      'POST  {"harness":"claude","model":"claude-haiku-5-5","warm":true}',
      'POST  {"sessionId":"wrun_1","text":"say hello"}',
      'GET ?sessionId=wrun_1&cursor=0.2 ',
    ])
    const resumed = await vercel.resume!({ label: 'local', url }, 'wrun_1', {
      deadlineMs: 5_000,
      stallMs: 2_000,
    })
    assert.equal(resumed.id, 'wrun_1')
  } finally {
    server.close()
  }
})

test('a fast cell whose start and end share a journal time keeps its run time', () => {
  const turn = new Vercel.Turn(0)
  turn.event({ type: 'tool_start', name: 'exec', call_id: 'c', at: 5_000 }, 10)
  turn.event(
    {
      type: 'tool_end',
      name: 'exec',
      call_id: 'c',
      status: 'completed',
      duration_ns: 168_571_469,
      at: 5_000,
    },
    20,
  )
  const [cell] = turn.sample(30).cells
  assert.equal(cell?.kind, 'code')
  assert.equal(Math.round((cell?.endMs ?? 0) - (cell?.startMs ?? 0)), 169)
})

test('a model the demo does not serve falls back to the deployment default', () => {
  assert.deepEqual(Vercel.choose({ model: 'claude-haiku-4-5' }, {}), { choice: {}, fallback: true })
  assert.deepEqual(Vercel.choose({ model: 'claude-haiku-4-5', thinking: 'medium' }, {}), {
    choice: { effort: 'medium', harness: 'claude', model: 'claude-haiku-5-5' },
    fallback: true,
  })
  assert.deepEqual(Vercel.choose({ model: 'gpt-6-luna' }, {}), {
    choice: { harness: 'codex', model: 'gpt-6-luna' },
    fallback: false,
  })
  assert.deepEqual(
    Vercel.choose(
      { model: 'claude-haiku-4-5' },
      { NANOEVAL_SYSTEMS_VERCEL_DEMO_MODEL: 'claude-sonnet-5-5' },
    ),
    { choice: { harness: 'claude', model: 'claude-sonnet-5-5' }, fallback: false },
  )
  assert.deepEqual(Vercel.choose({}, {}), { choice: {}, fallback: false })
})
