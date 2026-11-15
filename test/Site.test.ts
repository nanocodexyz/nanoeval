import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Command from '../cli/Scorecard.ts'
import type * as Compare from '../src/Compare.ts'
import * as Scorecard from '../src/Scorecard.ts'
import * as Site from '../src/Site.ts'

const fixtures = Path.join(import.meta.dirname, 'fixtures', 'scorecard')

const temporary = async <T>(use: (directory: string) => Promise<T>): Promise<T> => {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'scorecard-site-'))
  try {
    await Fs.cp(fixtures, directory, { recursive: true })
    return await use(directory)
  } finally {
    await Fs.rm(directory, { force: true, recursive: true })
  }
}

const files = async (directory: string): Promise<Record<string, string>> => {
  const names = (await Fs.readdir(directory, { recursive: true })).sort()
  const found: Record<string, string> = {}
  for (const name of names) {
    const file = Path.join(directory, name)
    if ((await Fs.stat(file)).isFile()) found[name] = await Fs.readFile(file, 'utf8')
  }
  return found
}

const sha256 = (text: string | Uint8Array) => Crypto.createHash('sha256').update(text).digest('hex')

const manifest = (change: (given: Record<string, unknown>) => unknown): string =>
  JSON.stringify(
    change({
      sections: [{ id: 'one', reference: 'ref', results: ['run-one.json'], title: 'One' }],
      title: 'toy',
    }),
  )

const section = (change: Record<string, unknown>) =>
  manifest((given) => ({
    ...given,
    sections: [{ ...(given['sections'] as Record<string, unknown>[])[0], ...change }],
  }))

test('a manifest gives each section its inputs, reference, labels, exclusion, seed and draws', () => {
  const plain = Site.parse(manifest((given) => given))
  assert.deepEqual(plain, {
    prices: {},
    sections: [
      {
        draws: Scorecard.defaults.draws,
        id: 'one',
        inputs: [{ from: 'file', name: 'run-one.json' }],
        labels: {},
        reference: 'ref',
        seed: Scorecard.defaults.seed,
        title: 'One',
      },
    ],
    title: 'toy',
  })
  const whole = Site.parse(
    manifest((given) => ({
      ...given,
      date: '2026-01-01',
      draws: 300,
      note: 'a note',
      prices: ['model-b=2,0.5,10'],
      sections: [
        {
          draws: 50,
          exclude: { reason: 'broken', tasks: ['t3'] },
          id: 'two',
          labels: { ref: 'the reference' },
          note: 'two runs',
          reference: 'ref',
          results: ['run-one.json', { arms: ['late'], file: 'run-two.json' }],
          runs: ['a-run', { arms: ['x'], run: 'b-run' }],
          title: 'Two',
        },
        { id: 'three', reference: 'ref', runs: ['a-run'], seed: 9, title: 'Three' },
      ],
      seed: 4,
    })),
  )
  assert.deepEqual(whole.prices, { 'model-b': { cachedUsd: 0.5, inputUsd: 2, outputUsd: 10 } })
  assert.deepEqual([whole.date, whole.note], ['2026-01-01', 'a note'])
  assert.deepEqual(whole.sections[0], {
    draws: 50,
    exclude: { reason: 'broken', tasks: ['t3'] },
    id: 'two',
    inputs: [
      { from: 'file', name: 'run-one.json' },
      { arms: ['late'], from: 'file', name: 'run-two.json' },
      { from: 'worker', name: 'a-run' },
      { arms: ['x'], from: 'worker', name: 'b-run' },
    ],
    labels: { ref: 'the reference' },
    note: 'two runs',
    reference: 'ref',
    seed: 4,
    title: 'Two',
  })
  assert.deepEqual(
    [whole.sections[1]!.draws, whole.sections[1]!.seed, whole.sections[1]!.exclude],
    [300, 9, undefined],
  )
})

test('a manifest that cannot be read as one is refused with the part that is wrong', () => {
  const refused: [string, RegExp][] = [
    ['{', /the manifest is not JSON/],
    ['[]', /the manifest is an object with/],
    [manifest((given) => ({ ...given, colour: 'red' })), /the manifest has the key colour/],
    [manifest((given) => ({ ...given, title: ' ' })), /title of the manifest is a string/],
    [manifest((given) => ({ ...given, sections: [] })), /sections of the manifest is a list/],
    [manifest((given) => ({ ...given, draws: 1.5 })), /draws of the manifest is a whole number/],
    [section({ results: undefined }), /section 1 names a result file under results or a run/],
    [section({ reference: undefined }), /reference of section 1 is a string/],
    [section({ id: 'Index' }), /id of section 1 names its page with a to z/],
    [section({ id: 'index' }), /is not index or manifest: index/],
    [section({ seed: -1 }), /seed of section 1 is a whole number/],
    [section({ labels: ['x'] }), /labels of section 1 is an object of an arm to its label/],
    [section({ labels: { ref: 3 } }), /label of ref in section 1 is a string/],
    [
      section({ results: [{ arms: [], file: 'x.json' }] }),
      /arms of results of section 1 is a list/,
    ],
    [section({ results: [{ path: 'x.json' }] }), /each of results of section 1 has the key path/],
    [section({ exclude: { tasks: ['t1'] } }), /reason of exclude of section 1 is a string/],
    [
      section({ exclude: { file: 'x', reason: 'r', tasks: ['t1'] } }),
      /names its tasks under tasks or in a file, one of the two/,
    ],
    [section({ exclude: { reason: 'r' } }), /names its tasks under tasks or in a file/],
    [
      manifest((given) => ({
        ...given,
        sections: [...(given['sections'] as unknown[]), ...(given['sections'] as unknown[])],
      })),
      /two sections have the id one/,
    ],
  ]
  for (const [text, message] of refused)
    assert.throws(
      () => Site.parse(text),
      (error: Error) => error.name === 'Site.InvalidError' && message.test(error.message),
      text,
    )
  assert.throws(
    () => Site.parse(manifest((given) => ({ ...given, prices: ['model-b=2'] }))),
    /a model price is MODEL=INPUT,CACHED,OUTPUT/,
  )
})

test('the command writes a site from the fixture files, the same bytes each time', async () => {
  await temporary(async (directory) => {
    const input = {
      commit: 'abc123',
      manifest: Path.join(directory, 'manifest.json'),
      out: Path.join(directory, 'site'),
    }
    const written = await Command.site(input)
    const first = await files(input.out)
    assert.deepEqual(Object.keys(first), [
      'all.html',
      'all.json',
      'index.html',
      'inputs.sha256',
      'manifest.json',
      'sound.html',
      'sound.json',
    ])
    await Fs.rm(input.out, { recursive: true })
    await Command.site(input)
    assert.deepEqual(await files(input.out), first)

    const index = first['index.html']!
    assert.equal(written.index, Path.join(input.out, 'index.html'))
    assert.match(index, /^<!doctype html>/)
    assert.doesNotMatch(index, /https?:|src=|<script|<link|url\(|@import/)
    assert.deepEqual([...index.matchAll(/href="([^"]+)"/g)].map((found) => found[1]).sort(), [
      'all.html',
      'all.json',
      'inputs.sha256',
      'manifest.json',
      'sound.html',
      'sound.json',
    ])
    assert.match(index, /<h1>toy scorecard<\/h1>\n<p class="sub">2026-01-01<\/p>/)
    assert.match(index, /<section id="all"><h2>1\. All arms of one run<\/h2>/)
    assert.match(index, /<section id="sound"><h2>2\. Sound tasks, arms of two runs<\/h2>/)
    assert.match(index, /Intervals: 200 draws of a task-clustered bootstrap, seed 7\./)
    assert.match(index, /Intervals: 100 draws of a task-clustered bootstrap, seed 7\./)
    assert.match(index, /<td>the &lt;reference&gt; <span class="ci">ref<\/span><\/td>/)
    assert.match(index, /Difference to the &lt;reference&gt;, points \[95 %\]/)
    assert.match(
      index,
      /<td>claude : model-a : high<\/td><td>6 \/ 3<\/td><td>5 \/ 1 \/ 0<\/td><td>83\.3 <span class="ci">\[[\d.]+, [\d.]+\]<\/span><\/td><td>\$0\.500<\/td><td>\$0\.600 /,
    )
    assert.match(
      index,
      /<td>priced<\/td><td>claude : model-b : medium<\/td><td>6 \/ 3<\/td><td>5 \/ 1 \/ 0<\/td><td>83\.3 [^\n]*?<td>\$2\.400<\/td><td>\$2\.880 [^\n]*<td>list price from recorded tokens<\/td><\/tr>/,
    )
    assert.match(
      index,
      /<td>bare<\/td><td>codex : model-c : effort not set<\/td><td>6 \/ 3<\/td><td>2 \/ 4 \/ 0<\/td><td>33\.3 <span class="ci">\[[\d.]+, [\d.]+\]<\/span><\/td><td>not recorded<\/td><td>not recorded<\/td><td>-50\.0 [^\n]*?<td>not recorded<\/td><td>not recorded<\/td><\/tr>/,
    )
    assert.match(
      index,
      /priced: list price from recorded tokens \(0 recorded by the run, 6 at the list price from recorded tokens, 0 without a model call at USD 0, 0 not recorded\)\./,
    )
    assert.match(index, /bare: not recorded \(0 recorded by the run, 0 at the list price/)
    assert.match(
      index,
      /List price of model-b, USD a million tokens: input 2, cached input 0\.5, output 10\./,
    )
    assert.equal(index.match(/<p class="basis">Cost basis, in matched rows\./g)!.length, 2)
    assert.match(index, /<td>late<\/td><td>claude : model-a : medium<\/td><td>4 \/ 2<\/td>/)
    assert.doesNotMatch(index, /<td>other<\/td>/)
    assert.match(
      index,
      /Excluded: 1 tasks named by unsound\.txt \(sha256 <code>[0-9a-f]{64}<\/code>\), 8 rows: t3\. Reason: the solution of the task fails\./,
    )
    assert.match(index, /Generated from nanoeval commit <code>abc123<\/code> with the command/)
    assert.equal(
      written.site.command,
      'nanoeval scorecard --manifest ' + input.manifest + ' --site ' + input.out,
    )
    assert.ok(index.includes('<pre>' + written.site.command + '</pre>'))

    const sums = await Promise.all(
      ['manifest.json', 'run-one.json', 'run-two.json', 'unsound.txt'].map(async (name) => {
        return sha256(await Fs.readFile(Path.join(directory, name))) + '  ' + name + '\n'
      }),
    )
    assert.equal(first['inputs.sha256'], sums.join(''))
    for (const line of sums) assert.ok(index.includes(line.slice(0, 64)))
    assert.equal(first['manifest.json'], await Fs.readFile(input.manifest, 'utf8'))

    const all = JSON.parse(first['all.json']!) as Scorecard.Card
    assert.deepEqual(all, written.site.sections[0]!.card)
    assert.equal(first['all.html'], Scorecard.html(all))
    assert.deepEqual(
      all.arms.map((arm) => [arm.label, arm.recorded, arm.listed, arm.uncosted]),
      [
        ['ref', 6, 0, 0],
        ['priced', 0, 6, 0],
        ['bare', 0, 0, 6],
      ],
    )
    const bare = all.arms.find((arm) => arm.label === 'bare')!
    assert.deepEqual(
      [bare.usdPerAttempt, bare.usdPerPass, bare.against!.usdPerPassRatio, bare.passRate.value],
      [null, null, null, 2 / 6],
    )
    assert.match(first['all.html']!, /Cost basis, in matched rows\./)
    const sound = written.site.sections[1]!.card
    assert.deepEqual(sound.matched, { attempts: 4, tasks: 2 })
    assert.equal(sound.excluded!.reason, 'the solution of the task fails')
    assert.match(first['sound.html']!, /Reason: the solution of the task fails/)
    assert.deepEqual(
      sound.runs.map((run) => [run.id, run.rows]),
      [
        ['run-one', 18],
        ['run-two', 6],
      ],
    )
  })
})

test('without a list price an arm of tokens and no cost shows no USD figure, never 0', async () => {
  await temporary(async (directory) => {
    const file = Path.join(directory, 'manifest.json')
    const given = JSON.parse(await Fs.readFile(file, 'utf8')) as Record<string, unknown>
    delete given['prices']
    await Fs.writeFile(file, JSON.stringify(given))
    const written = await Command.site({
      commit: undefined,
      manifest: file,
      out: Path.join(directory, 'site'),
    })
    const index = await Fs.readFile(written.index, 'utf8')
    const priced = written.site.sections[0]!.card.arms.find((arm) => arm.label === 'priced')!
    assert.deepEqual([priced.uncosted, priced.usdPerAttempt, priced.usdPerPass], [6, null, null])
    assert.equal(priced.passRate.value, 5 / 6)
    assert.match(
      index,
      /<td>priced<\/td><td>claude : model-b : medium<\/td><td>6 \/ 3<\/td><td>5 \/ 1 \/ 0<\/td><td>83\.3 <span class="ci">\[[\d.]+, [\d.]+\]<\/span><\/td><td>not recorded<\/td><td>not recorded<\/td>/,
    )
    assert.doesNotMatch(index, /\$0\.000|List price of/)
    assert.match(index, /not recorded: the command did not run from a git checkout/)
  })
})

test('a run named by its id is read from the Worker once, kept in the site and hashed', async () => {
  await temporary(async (directory) => {
    const file = Path.join(directory, 'manifest.json')
    const run = JSON.parse(
      await Fs.readFile(Path.join(directory, 'run-two.json'), 'utf8'),
    ) as Compare.Run
    await Fs.writeFile(
      file,
      JSON.stringify({
        sections: [
          {
            exclude: { reason: 'broken', tasks: ['t3'] },
            id: 'one',
            reference: 'late',
            runs: ['two'],
            title: 'One',
          },
          { id: 'two', reference: 'other', runs: ['two'], title: 'Two' },
        ],
        title: 'toy',
      }),
    )
    const out = Path.join(directory, 'site')
    await assert.rejects(
      Command.site({ commit: undefined, manifest: file, out }),
      /--url and --token are required: the manifest names the run two of a Worker/,
    )
    const asked: string[] = []
    const written = await Command.site({
      commit: undefined,
      fetch: async (name) => {
        asked.push(name)
        return run
      },
      manifest: file,
      out,
      url: 'http://127.0.0.1:8787',
    })
    assert.deepEqual(asked, ['two'])
    assert.equal(
      written.site.command,
      'nanoeval scorecard --url http://127.0.0.1:8787 --manifest ' + file + ' --site ' + out,
    )
    const kept = await Fs.readFile(Path.join(out, 'runs', 'run-two.json'))
    assert.deepEqual(JSON.parse(kept.toString('utf8')), run)
    assert.deepEqual(written.site.inputs.slice(1), [
      { digest: sha256(kept), name: 'runs/run-two.json' },
    ])
    const card = written.site.sections[0]!.card
    assert.deepEqual(card.excluded, {
      digest: sha256('t3\n'),
      file: 'manifest.json',
      reason: 'broken',
      tasks: [{ name: 't3', rows: 4 }],
    })
    assert.deepEqual(card.matched, { attempts: 4, tasks: 2 })
  })
})

test('a section that names an arm or a file its inputs do not hold is refused', async () => {
  await temporary(async (directory) => {
    const file = Path.join(directory, 'manifest.json')
    const out = Path.join(directory, 'site')
    const attempt = async (change: Record<string, unknown>) => {
      await Fs.writeFile(file, section(change))
      return Command.site({ commit: undefined, manifest: file, out })
    }
    await assert.rejects(
      attempt({ labels: { nobody: 'x' } }),
      /section one labels the arm nobody, and its arms are ref, priced, bare/,
    )
    await assert.rejects(
      attempt({ results: [{ arms: ['late'], file: 'run-one.json' }] }),
      /run-one\.json holds no row of the arm late: its arms are ref, priced, bare/,
    )
    await assert.rejects(
      attempt({ results: ['none.json'] }),
      /the result file none\.json cannot be read/,
    )
    await assert.rejects(
      attempt({ results: ['unsound.txt'] }),
      /the result file unsound\.txt is not JSON/,
    )
    await assert.rejects(
      attempt({ results: ['manifest.json'] }),
      /manifest\.json does not hold the results of a run/,
    )
    await assert.rejects(attempt({ exclude: { file: 'none.txt', reason: 'r' } }), /cannot be read/)
    await assert.rejects(
      Command.site({ commit: undefined, manifest: Path.join(directory, 'no.json'), out }),
      /the manifest .*no\.json cannot be read/,
    )
  })
})
