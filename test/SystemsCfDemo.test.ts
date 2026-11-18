import assert from 'node:assert/strict'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import * as Demo from '../cli/systems/targets/cf-demo.ts'

const runtime = 'runtime-1'

const agent = (
  createdAt: number,
  type: string,
  payload: Record<string, unknown>,
  emittedMs = 0,
) => ({
  created_at: createdAt,
  event: {
    event: { payload, protocol_version: 1, type },
    host_timing: { runtime_id: runtime },
    sdk_timing: { emitted_ns: emittedMs * 1e6 },
    source: 'agent',
  },
  request_id: 'r1',
})

const result = (createdAt: number, extra: Record<string, unknown>) => ({
  created_at: createdAt,
  event: { request_id: 'r1', type: 'result', ...extra },
  request_id: 'r1',
  seq: 9,
})

const completed = (message: string) =>
  result(1_200, {
    ok: { message, usage: { estimated_cost: { usd: '0.00042' }, output_tokens: 17 } },
    status: 'completed',
    timing: { admission_ms: 12 },
  })

test('read parses frames, comments and a frame split across chunks', () => {
  const first = Demo.read(
    ': server-timing session;dur=830, pool_total;dur=974\n\ndata: {"a":1}\n\nevent: live\ndata: {"b"',
  )
  assert.deepEqual(first.comments, ['server-timing session;dur=830, pool_total;dur=974'])
  assert.deepEqual(first.frames, [{ data: '{"a":1}' }])
  const second = Demo.read(first.rest + ':2}\r\n\r\n: keepalive\n\n')
  assert.deepEqual(second.frames, [{ data: '{"b":2}', event: 'live' }])
  assert.deepEqual(second.comments, ['keepalive'])
  assert.equal(second.rest, '')
})

test('read joins multi-line data', () => {
  assert.deepEqual(Demo.read('data: one\ndata: two\n\n').frames, [{ data: 'one\ntwo' }])
})

test('timing reads server-timing durations', () => {
  assert.deepEqual(
    Demo.timing(['server-timing session;dur=830, pool_claim;dur=0;desc=pooled', 'keepalive']),
    {
      pool_claim: 0,
      session: 830,
    },
  )
})

test('kind classifies Code Mode, Python and shell cells', () => {
  assert.equal(Demo.kind({ tool: 'exec' }), 'code')
  assert.equal(
    Demo.kind({
      arguments: { cmd: "python3 -c 'print(1)'" },
      parent_call_id: 'c',
      tool: 'exec_command',
    }),
    'python',
  )
  assert.equal(
    Demo.kind({ arguments: { cmd: 'ls -la' }, parent_call_id: 'c', tool: 'exec_command' }),
    'shell',
  )
  assert.equal(Demo.kind({ tool: 'python' }), 'python')
  assert.equal(Demo.kind({ tool: 'web_search' }), 'tool')
})

test('model maps provider prefixes and bare ids', () => {
  assert.deepEqual(Demo.model(undefined), {})
  assert.deepEqual(Demo.model('gpt-6-luna'), { model: 'gpt-6-luna', provider: 'codex' })
  assert.deepEqual(Demo.model('claude-haiku-5-5'), {
    model: 'claude-haiku-5-5',
    provider: 'claude',
  })
  assert.deepEqual(Demo.model('codex/glm-5.3'), { model: 'glm-5.3', provider: 'codex' })
  assert.throws(() => Demo.model('other/x'), /claude\/<id>/)
})

test('summarize times deltas and cells and reads usage from the result', () => {
  const offset = 10_000
  const at = (createdAt: number) => createdAt + offset
  const entries = [
    {
      arrivalMs: at(100),
      record: { created_at: 100, event: { request_id: 'r1', type: 'queued' }, request_id: 'r1' },
    },
    { arrivalMs: at(110), record: agent(110, 'run.started', { model: 'gpt-6-luna' }) },
    {
      arrivalMs: at(400),
      record: agent(400, 'assistant.delta', { item_id: 'm1', offset: 0, text: 'Hel' }),
    },
    {
      arrivalMs: at(400),
      record: agent(400, 'assistant.delta', { item_id: 'm1', offset: 0, text: 'Hel' }),
    },
    {
      arrivalMs: at(450),
      record: agent(450, 'assistant.delta', { item_id: 'm1', offset: 3, text: 'lo' }),
    },
    { arrivalMs: at(500), record: agent(500, 'tool.call', { call_id: 'c1', tool: 'exec' }, 1_000) },
    {
      arrivalMs: at(500),
      record: agent(
        500,
        'tool.call',
        {
          arguments: { cmd: 'python3 x.py' },
          call_id: 'c1/code-1',
          parent_call_id: 'c1',
          tool: 'exec_command',
        },
        1_010,
      ),
    },
    {
      arrivalMs: at(600),
      record: agent(
        600,
        'tool.result',
        { call_id: 'c1/code-1', status: 'completed', structured_result: { exit_code: 1 } },
        1_050,
      ),
    },
    {
      arrivalMs: at(600),
      record: agent(600, 'tool.result', { call_id: 'c1', status: 'completed' }, 1_300),
    },
    { arrivalMs: at(700), record: agent(700, 'tool.call', { call_id: 'c2', tool: 'exec' }, 1_400) },
    {
      arrivalMs: at(1_100),
      record: agent(1_100, 'run.completed', {
        duration_ms: 990,
        model_calls: 2,
        tool_calls: 3,
        usage: { output_tokens: 99 },
      }),
    },
    { arrivalMs: at(1_200), record: completed('Hello') },
  ]
  const sample = Demo.summarize({
    comments: ['server-timing session;dur=13, pool_total;dur=65'],
    doneMs: at(1_250),
    entries,
    firstByteMs: at(50),
    sendMs: at(0),
  })
  assert.equal(sample.ok, true)
  assert.equal(sample.text, 'Hello')
  assert.equal(sample.outputTokens, 17)
  assert.equal(sample.estimated, undefined)
  assert.equal(sample.firstTokenMs, at(400))
  assert.equal(sample.firstByteMs, at(50))
  assert.deepEqual(
    sample.cells.map((cell) => [cell.kind, cell.name, cell.ok, cell.endMs - cell.startMs]),
    [
      ['code', 'exec', true, 300],
      ['python', 'exec_command', false, 40],
      ['code', 'exec', false, 550],
    ],
  )
  assert.deepEqual(sample.metrics, {
    admissionMs: 12,
    costUsd: 0.00042,
    modelCalls: 2,
    runMs: 990,
    serverPoolMs: 65,
    serverSessionMs: 13,
    toolCalls: 3,
  })
})

test('summarize falls back to deduplicated deltas and an estimate', () => {
  const sample = Demo.summarize({
    comments: [],
    doneMs: 900,
    entries: [
      {
        arrivalMs: 300,
        record: agent(300, 'assistant.delta', { item_id: 'm1', offset: 0, text: 'abcd' }),
      },
      {
        arrivalMs: 301,
        record: agent(300, 'assistant.delta', { item_id: 'm1', offset: 0, text: 'abcd' }),
      },
      {
        arrivalMs: 400,
        record: agent(400, 'assistant.delta', { item_id: 'm1', offset: 4, text: 'efgh' }),
      },
      { arrivalMs: 500, record: result(500, { ok: {}, status: 'completed' }) },
    ],
    sendMs: 0,
  })
  assert.equal(sample.text, 'abcdefgh')
  assert.equal(sample.outputTokens, 2)
  assert.equal(sample.estimated, true)
})

test('summarize reports failures', () => {
  const failed = Demo.summarize({
    comments: [],
    doneMs: 10,
    entries: [{ arrivalMs: 5, record: result(5, { error: 'model refused', status: 'failed' }) }],
    sendMs: 0,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'model refused')
  const cut = Demo.summarize({ comments: [], doneMs: 10, entries: [], sendMs: 0 })
  assert.equal(cut.error, 'the stream ended without a result event')
  const limited = Demo.summarize({
    comments: [],
    doneMs: 10,
    entries: [],
    error: 'HTTP 429',
    sendMs: 0,
  })
  assert.equal(limited.error, 'HTTP 429')
  const stalled = Demo.summarize({
    comments: [],
    doneMs: 10,
    entries: [],
    error: 'the stream stalled',
    sendMs: 0,
    stalled: true,
  })
  assert.equal(stalled.stalled, true)
})

async function serve(
  handler: Http.RequestListener,
): Promise<{ close(): Promise<void>; url: string }> {
  const server = Http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
  }
}

test('a session streams a turn, sends the visitor and the model, and resumes', async () => {
  const seen: { body: unknown; path: string; visitor: string | undefined }[] = []
  const server = await serve((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.push({
        body: body ? JSON.parse(body) : undefined,
        path: request.url ?? '',
        visitor: request.headers['x-nanocode-visitor'] as string,
      })
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ events: [{ seq: 1 }] }))
        return
      }
      response.setHeader('content-type', 'text/event-stream')
      response.write(': server-timing session;dur=7\n\n')
      const delta = JSON.stringify(
        agent(1, 'assistant.delta', { item_id: 'm', offset: 0, text: 'ok' }),
      )
      response.write('event: live\ndata: ' + delta.slice(0, 20))
      setTimeout(() => {
        response.write(delta.slice(20) + '\n\n')
        response.write('data: ' + JSON.stringify(completed('ok')) + '\n\n')
      }, 20)
    })
  })
  const visitor = 'a'.repeat(64)
  process.env['NANOEVAL_SYSTEMS_CF_DEMO_VISITOR'] = visitor
  try {
    const context = { deadlineMs: 5_000, model: 'gpt-6-luna', stallMs: 2_000, thinking: 'low' }
    const session = await Demo.default.open({ label: 'test', url: server.url + '/' }, context)
    const sample = await session.turn('hi')
    assert.equal(sample.ok, true, sample.error)
    assert.equal(sample.text, 'ok')
    assert.equal(sample.metrics?.['serverSessionMs'], 7)
    assert.ok(sample.firstTokenMs !== undefined && sample.firstTokenMs >= sample.sendMs)
    const posted = seen[0]!
    assert.equal(posted.path, '/sessions/' + session.id + '/turns?live=1')
    assert.equal(posted.visitor, visitor)
    assert.deepEqual(
      { ...(posted.body as object), request_id: undefined },
      {
        model: 'gpt-6-luna',
        prompt: 'hi',
        provider: 'codex',
        request_id: undefined,
        thinking: 'low',
      },
    )
    const resumed = await Demo.default.resume!(
      { label: 'test', url: server.url },
      session.id,
      context,
    )
    assert.equal(seen[1]!.path, '/sessions/' + session.id + '/events?after=0&limit=1')
    const again = await resumed.turn('again')
    assert.equal(typeof again.metrics?.['resumeMs'], 'number')
  } finally {
    delete process.env['NANOEVAL_SYSTEMS_CF_DEMO_VISITOR']
    await server.close()
  }
})

test('a rate-limited turn reports the status and retry-after', async () => {
  const server = await serve((_request, response) => {
    response.writeHead(429, { 'retry-after': '60' })
    response.end('rate limited')
  })
  try {
    const session = await Demo.default.open({ label: 'test', url: server.url })
    const sample = await session.turn('hi')
    assert.equal(sample.ok, false)
    assert.equal(sample.error, 'HTTP 429 (retry-after 60 s): rate limited')
  } finally {
    await server.close()
  }
})

test('a silent stream is reported as stalled', async () => {
  const server = await serve((_request, response) => {
    response.setHeader('content-type', 'text/event-stream')
    response.write(': open\n\n')
  })
  try {
    const session = await Demo.default.open(
      { label: 'test', url: server.url },
      { deadlineMs: 5_000, stallMs: 100 },
    )
    const sample = await session.turn('hi')
    assert.equal(sample.stalled, true)
    assert.equal(sample.ok, false)
  } finally {
    await server.close()
  }
})

test('visitor rejects a malformed configured id', () => {
  process.env['NANOEVAL_SYSTEMS_X_VISITOR'] = 'nope'
  try {
    assert.throws(() => Demo.visitor('NANOEVAL_SYSTEMS_X_VISITOR'), /64 lowercase hex/)
  } finally {
    delete process.env['NANOEVAL_SYSTEMS_X_VISITOR']
  }
  assert.match(Demo.visitor('NANOEVAL_SYSTEMS_UNSET_VISITOR'), /^[0-9a-f]{64}$/)
})

test('spec reads the nanocode-ts pin from a release tarball or a git ref', () => {
  assert.equal(
    Demo.spec(
      'https://github.com/nanocodexyz/nanocode-ts/releases/download/build-6d58e23/nanocode-ts-6d58e23.tgz',
    ),
    '6d58e23',
  )
  assert.equal(Demo.spec('github:nanocodexyz/nanocode-ts#c49cf386'), 'c49cf386')
  assert.equal(Demo.spec('^1.2.3'), '^1.2.3')
  assert.equal(Demo.spec(undefined), undefined)
})
