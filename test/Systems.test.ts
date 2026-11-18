import * as Assert from 'node:assert/strict'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { describe, it } from 'node:test'
import * as Compare from '../cli/systems/Compare.ts'
import * as Main from '../cli/systems/main.ts'
import * as Runner from '../cli/systems/Runner.ts'
import * as Stats from '../cli/systems/Stats.ts'
import * as Suite from '../cli/systems/Suite.ts'
import * as Target from '../cli/systems/Target.ts'
import * as CliLocal from '../cli/systems/targets/cli-local.ts'
import fake from '../cli/systems/targets/fake.ts'

const raw = {
  defaults: { deadlineMs: 2000, reps: 2, stallMs: 1000 },
  name: 'systems-test',
  scenarios: [
    {
      concurrency: [1, 3],
      description: 'three chat turns',
      id: 'chat',
      slo: [
        { max: 1000, metric: 'ttftMs', stat: 'p95' },
        { metric: 'pass', min: 1, stat: 'mean' },
      ],
      turns: [
        { expect: { text: 'alpha' }, prompt: 'Reply with exactly: alpha' },
        { expect: { text: 'beta' }, prompt: 'Reply with exactly: beta' },
        {
          expect: { cells: 1, text: 'gamma' },
          prompt: 'Run a code cell, then reply with exactly: gamma',
        },
      ],
    },
    {
      description: 'cold then warm',
      id: 'coldwarm',
      kind: 'coldwarm',
      slo: [{ max: 500, metric: 'cold.startupMs', stat: 'p50' }],
      turns: [{ prompt: 'Reply with exactly: one' }, { prompt: 'Reply with exactly: two' }],
    },
    {
      deadlineMs: 300,
      description: 'a cell past the deadline, a refusal and a stall',
      id: 'errors',
      stallMs: 100,
      turns: [
        { expect: { timedOut: true }, prompt: 'sleep 5' },
        { expect: { ok: false }, prompt: 'please fail' },
        { expect: { stalled: true }, prompt: 'sleep 2 then reply with exactly: late' },
      ],
    },
    {
      concurrency: [2],
      description: 'two sessions for one second',
      durationS: 1,
      id: 'sustained',
      kind: 'sustained',
      reps: 1,
      slo: [{ metric: 'aggTokS', min: 1, stat: 'p50' }],
      turns: [{ prompt: 'Reply with exactly: on' }],
    },
  ],
  version: '1',
}

describe('systems suite', () => {
  it('parses defaults and rejects bad scenarios', () => {
    const suite = Suite.parse(raw)
    Assert.equal(suite.scenarios[0]!.deadlineMs, 2000)
    Assert.deepEqual(suite.scenarios[0]!.concurrency, [1, 3])
    Assert.equal(suite.scenarios[2]!.deadlineMs, 300)
    Assert.throws(
      () => Suite.parse({ ...raw, scenarios: [{ id: 'x', turns: [] }] }),
      Suite.InvalidError,
    )
    Assert.throws(
      () =>
        Suite.parse({
          ...raw,
          scenarios: [{ id: 'x', kind: 'coldwarm', turns: [{ prompt: 'a' }] }],
        }),
      /cold turn and a warm turn/,
    )
    Assert.throws(
      () =>
        Suite.parse({
          ...raw,
          scenarios: [
            { id: 'x', slo: [{ metric: 'ttftMs', stat: 'p95' }], turns: [{ prompt: 'a' }] },
          ],
        }),
      /max or a min/,
    )
  })

  it('picks scenarios and concurrency levels', () => {
    const suite = Suite.pick(Suite.parse(raw), ['chat', 'errors'], [3])
    Assert.deepEqual(
      suite.scenarios.map((scenario) => scenario.id),
      ['chat'],
    )
    Assert.throws(() => Suite.pick(Suite.parse(raw), ['nope']), /has no scenario nope/)
  })

  it('loads a suite from NANOEVAL_SUITES', async () => {
    const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'suites-'))
    await Fs.mkdir(Path.join(root, 'systems', 'systems-test'), { recursive: true })
    await Fs.writeFile(
      Path.join(root, 'systems', 'systems-test', 'suite.json'),
      JSON.stringify(raw),
    )
    const before = process.env['NANOEVAL_SUITES']
    process.env['NANOEVAL_SUITES'] = root
    try {
      const suite = await Suite.load('systems-test')
      Assert.equal(suite.name, 'systems-test')
      Assert.match(suite.digest, /^[0-9a-f]{12}$/)
    } finally {
      if (before === undefined) delete process.env['NANOEVAL_SUITES']
      else process.env['NANOEVAL_SUITES'] = before
    }
  })
})

describe('systems stats', () => {
  it('takes percentiles with linear interpolation', () => {
    Assert.equal(Stats.percentile([1, 2, 3, 4], 0.5), 2.5)
    Assert.equal(Stats.percentile([5], 0.95), 5)
    Assert.equal(Stats.percentile([], 0.5), null)
    Assert.deepEqual(Stats.summarize([1, 2, 3]), { mean: 2, n: 3, p50: 2, p95: 2.9 })
  })

  it('bootstraps a ratio the same way twice and labels it', () => {
    const base = [
      [100, 110],
      [200, 210],
      [300, 290],
    ]
    const head = [
      [50, 55],
      [100, 105],
      [150, 145],
    ]
    const found = Stats.ratio(base, head)
    Assert.deepEqual(found, Stats.ratio(base, head))
    Assert.ok(Math.abs(found.value! - 0.5) < 0.01)
    Assert.ok(found.high! < 1)
    Assert.equal(Stats.verdict('ttftMs', found), 'WIN')
    Assert.equal(Stats.verdict('tokS', found), 'LOSS')
    Assert.equal(Stats.verdict('ttftMs', Stats.ratio(base, base)), 'TIE')
  })
})

describe('systems runner', () => {
  it('judges turns against their expectations', () => {
    const turn: Target.TurnSample = { cells: [], doneMs: 10, ok: true, sendMs: 0, text: 'Alpha.' }
    Assert.deepEqual(Runner.judge({ text: 'alpha' }, turn), [])
    Assert.equal(Runner.judge({ cells: 1 }, turn).length, 1)
    Assert.deepEqual(Runner.judge({ timedOut: true }, { ...turn, ok: false, timedOut: true }), [])
    Assert.match(Runner.judge(undefined, { ...turn, error: 'boom', ok: false })[0]!, /boom/)
    Assert.deepEqual(
      Runner.judge({ stalled: true, text: 'alpha' }, { ...turn, stalled: true, timedOut: true }),
      ['timed out'],
    )
  })

  it('runs the fake target, writes run.json and summary.md, and compares two builds', async () => {
    const out = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'systems-'))
    const { dir, run } = await Runner.run({
      builds: [Target.build('a=1'), Target.build('b=0.5')],
      out,
      suite: Suite.parse(raw),
      targets: [fake],
    })
    Assert.equal(dir, out)
    const chat = run.samples.filter((sample) => sample.scenario === 'chat')
    Assert.equal(chat.length, 2 * 2 * (1 + 3) * 3)
    Assert.ok(
      chat.every((sample) => sample.pass),
      JSON.stringify(chat.find((sample) => !sample.pass)),
    )
    const errors = run.samples.filter((sample) => sample.scenario === 'errors')
    Assert.ok(
      errors.every((sample) => sample.pass),
      JSON.stringify(errors.filter((sample) => !sample.pass)),
    )
    Assert.ok(run.samples.some((sample) => sample.phase === 'cold'))
    Assert.ok(run.samples.filter((sample) => sample.scenario === 'sustained').length >= 2)
    Assert.ok(
      run.verdicts.every((verdict) => verdict.passed),
      JSON.stringify(run.verdicts.filter((v) => !v.passed)),
    )
    const stored = JSON.parse(await Fs.readFile(Path.join(out, 'run.json'), 'utf8')) as Runner.Run
    Assert.equal(stored.samples.length, run.samples.length)
    Assert.match(
      await Fs.readFile(Path.join(out, 'summary.md'), 'utf8'),
      /\| chat \| fake \| a \| \*\*PASS\*\*/,
    )
    const files = await Fs.readdir(Path.join(out, 'samples', 'fake', 'a', 'chat', 'c3'))
    Assert.equal(files.length, 2 * 3 * 3)

    const picked = Compare.arms([stored], { base: 'a' })
    Assert.equal(picked.head.build, 'b')
    const result = Compare.compare(picked.base, picked.head)
    const ttft = result.rows.find(
      (row) => row.scenario === 'chat' && row.concurrency === 1 && row.metric === 'ttftMs',
    )!
    Assert.equal(ttft.clustered, 'prompt')
    Assert.ok(ttft.ratio! < 0.75, String(ttft.ratio))
    Assert.equal(ttft.verdict, 'WIN')
    const pass = result.rows.find((row) => row.scenario === 'chat' && row.metric === 'pass')!
    Assert.equal(pass.verdict, 'TIE')
    Assert.match(Compare.markdown(result), /ratio \[95% CI\]/)
  })

  it('runs and compares through the command line', async () => {
    const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'systems-cli-'))
    await Fs.writeFile(Path.join(root, 'suite.json'), JSON.stringify(raw))
    const printed: string[] = []
    const print = (line: string) => printed.push(line)
    const first = Path.join(root, 'one')
    const second = Path.join(root, 'two')
    const args = [
      'run',
      '--suite',
      root,
      '--target',
      'fake',
      '--scenario',
      'chat',
      '--concurrency',
      '1',
      '--reps',
      '2',
      '--quiet',
    ]
    Assert.equal(await Main.main([...args, '--build', 'old=1', '--out', first], print), 0)
    Assert.equal(await Main.main([...args, '--build', 'new=0.5', '--out', second], print), 0)
    Assert.match(printed.join('\n'), /1\/1 scenario runs met their SLOs/)
    Assert.equal(await Main.main(['compare', first, second, '--draws', '500'], print), 0)
    const result = JSON.parse(
      await Fs.readFile(Path.join(second, 'compare.json'), 'utf8'),
    ) as Compare.Result
    Assert.equal(result.base, 'old')
    Assert.equal(result.head, 'new')
    Assert.equal(result.draws, 500)
    await Assert.rejects(Main.main(['run', '--suite', root], print), /needs --build/)
    await Assert.rejects(Main.target('no-such-target'), /no target no-such-target/)
  })
})

describe('cli-local target', () => {
  it('parses builds', () => {
    Assert.deepEqual(Target.build('rolling=23e21f8952f8'), {
      label: 'rolling',
      version: '23e21f8952f8',
    })
    Assert.deepEqual(Target.build('dist=./target/nanocode'), {
      binary: './target/nanocode',
      label: 'dist',
    })
    Assert.deepEqual(Target.build('x=https://e.com/n.xz'), {
      label: 'x',
      url: 'https://e.com/n.xz',
    })
    Assert.throws(() => Target.build('nolabel'), Target.InvalidError)
    Assert.match(CliLocal.release('23e21f8952f8'), /nanocode-cli\/nanocode-.+\.23e21f8952f8\.xz$/)
  })

  it('reads Anthropic and Responses streams into calls and cells', () => {
    const call: CliLocal.Call = { path: '/v1/messages', tReq: 0, tools: [] }
    let rest = CliLocal.sse(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\ndata: {"type":"content_block_delta"}\n',
      (payload) => CliLocal.observe(call, payload, 5),
    )
    rest = CliLocal.sse(
      rest +
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"exec"}}\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n',
      (payload) => CliLocal.observe(call, payload, 9),
    )
    Assert.equal(call.tFirstDelta, 5)
    Assert.deepEqual(call.tools, ['exec'])
    Assert.deepEqual(call.usage, { input: 12, output: 30 })
    const codex: CliLocal.Call = { path: '/responses', tReq: 0, tools: [] }
    CliLocal.observe(
      codex,
      { item: { name: 'shell', type: 'function_call' }, type: 'response.output_item.added' },
      3,
    )
    CliLocal.observe(
      codex,
      { response: { usage: { input_tokens: 1, output_tokens: 7 } }, type: 'response.completed' },
      4,
    )
    Assert.equal(codex.tFirstDelta, 3)
    Assert.deepEqual(codex.usage, { input: 1, output: 7 })
    const found = CliLocal.cells(
      [
        { ...call, tDone: 20 },
        { path: '/v1/messages', tReq: 120, tools: [] },
      ],
      200,
    )
    Assert.deepEqual(found, [{ endMs: 120, kind: 'code', name: 'exec', ok: true, startMs: 20 }])
    Assert.equal(CliLocal.provider('claude-haiku-4-5'), 'claude')
    Assert.equal(CliLocal.provider('gpt-6.1-sol'), 'codex')
  })

  it('meters a streamed request through the proxy without passing the local key upstream', async () => {
    const seen: Http.IncomingHttpHeaders[] = []
    const upstream = Http.createServer((request, response) => {
      seen.push(request.headers)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n')
      setTimeout(() => {
        response.write(
          'data: {"type":"content_block_delta"}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
        )
        response.end()
      }, 20)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const before = process.env['NANOEVAL_SYSTEMS_ANTHROPIC_KEY']
    process.env['NANOEVAL_SYSTEMS_ANTHROPIC_KEY'] = 'upstream-secret'
    const route = await CliLocal.proxy(
      'claude',
      'http://127.0.0.1:' + (upstream.address() as { port: number }).port,
    )
    try {
      const answer = await fetch(route.url + '/v1/messages', {
        body: '{}',
        headers: { 'x-api-key': 'sk-nanoeval-systems-local' },
        method: 'POST',
      })
      Assert.match(await answer.text(), /message_delta/)
      Assert.equal(route.calls.length, 1)
      const call = route.calls[0]!
      Assert.deepEqual(call.usage, { input: 3, output: 4 })
      Assert.ok(call.tFirstByte! <= call.tFirstDelta! && call.tFirstDelta! <= call.tDone!)
      Assert.equal(seen[0]!['x-api-key'], 'upstream-secret')
    } finally {
      await route.close()
      upstream.close()
      if (before === undefined) delete process.env['NANOEVAL_SYSTEMS_ANTHROPIC_KEY']
      else process.env['NANOEVAL_SYSTEMS_ANTHROPIC_KEY'] = before
    }
  })
})
