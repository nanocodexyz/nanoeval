import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Closed from '../cli/Closed.ts'
import * as Dataset from '../datasets/Dataset.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Tar from '../src/Tar.ts'
import * as Task from '../src/Task.ts'

const checkout =
  '# Run the last line of before_repo_set_cmd to checkout gold test files\n' +
  'GOLD_CHECKOUT=$(python3 -c "print(1)" 2>/dev/null || echo "")\n' +
  '\n' +
  'if [ -n "$GOLD_CHECKOUT" ]; then\n' +
  '    echo "Running gold tests checkout: $GOLD_CHECKOUT"\n' +
  '    eval "$GOLD_CHECKOUT" || { echo "ERROR: Gold tests checkout failed"; exit 1; }\n' +
  'fi\n'

function sh(directory: string, args: readonly string[]): string {
  const result = spawnSync(args[0]!, args.slice(1), { cwd: directory, encoding: 'utf8' })
  assert.equal(result.status, 0, args.join(' ') + ': ' + result.stderr)
  return result.stdout.trim()
}

function upstream(): { base: string; fix: string; root: string } {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-closed-'))
  const git = (...args: string[]) =>
    sh(root, ['git', '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args])
  const write = (path: string, text: string) => {
    Fs.mkdirSync(Path.dirname(Path.join(root, path)), { recursive: true })
    Fs.writeFileSync(Path.join(root, path), text)
  }
  git('init', '-q', '-b', 'base')
  write('src/sum.py', 'def sum(a, b):\n    return a - b\n')
  write('tests/test_sum.py', 'old test\n')
  write('tests/keep/test_other.py', 'other\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'fix')
  write('src/sum.py', 'def sum(a, b):\n    return a + b\n')
  write('tests/test_sum.py', 'new test\n')
  write('tests/new/test_added.py', 'added test\n')
  Fs.chmodSync(Path.join(root, 'tests/new/test_added.py'), 0o755)
  git('add', '-A')
  git('commit', '-q', '-m', 'fix')
  return { base, fix: git('rev-parse', 'HEAD'), root }
}

function task(input: { base: string; last: string }): Dataset.Case {
  return {
    executable: ['tests/test.sh'],
    files: {
      'environment/Dockerfile': Bytes.fromText(
        'FROM example/image\nWORKDIR /app\nRUN set -e && git reset --hard ' +
          input.base +
          ' && git clean -fd\nRUN true\n',
      ),
      'instruction.md': Bytes.fromText('Fix sum.\n'),
      'task.toml': Dataset.toml({
        agent: { timeout_sec: 60 },
        environment: { allow_internet: true, cpus: 1, memory_mb: 512, storage_mb: 1024 },
        schema_version: '1.1',
        task: { name: 'org/sum' },
        verifier: { timeout_sec: 60 },
      }),
      'tests/config.json': Dataset.json({
        base_commit: input.base,
        before_repo_set_cmd: 'git reset --hard ' + input.base + '\n' + input.last,
        repo: 'org/sum',
      }),
      'tests/test.sh': Bytes.fromText(
        '#!/bin/bash\ncd /app\n' + checkout + 'bash /tests/run_script.sh\n',
      ),
    },
    id: 'sum',
  }
}

const text = (item: Dataset.Case, path: string) => Bytes.toText(item.files[path]!)

test('a closed task keeps the gold test files with its tests, re-makes the repository as one commit and closes the agent network', async () => {
  const { base, fix, root } = upstream()
  const scratch = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-closed-scratch-'))
  const asked: string[] = []
  const open = task({ base, last: 'git checkout ' + fix + ' -- tests/test_sum.py tests/new' })
  const closed = await Closed.close(open, {
    remote: (repository) => {
      asked.push(repository)
      return root
    },
    root: scratch,
  })

  assert.deepEqual(asked, ['org/sum'])
  assert.deepEqual(Fs.readdirSync(scratch), [])
  const gold = Tar.unpack(closed.files['tests/gold.tar']!)
  assert.deepEqual(
    gold.map((entry) => [entry.path, Bytes.toText(entry.data), entry.executable]),
    [
      ['tests/new/test_added.py', 'added test\n', true],
      ['tests/test_sum.py', 'new test\n', false],
    ],
  )
  const manifest = JSON.parse(text(closed, 'tests/gold-manifest.json')) as {
    files: { base: string | null; path: string }[]
    fix: string
  }
  assert.equal(manifest.fix, fix)
  assert.deepEqual(
    manifest.files.map((file) => [file.path, file.base]),
    [
      ['tests/new/test_added.py', null],
      ['tests/test_sum.py', sh(root, ['git', 'rev-parse', base + ':tests/test_sum.py'])],
    ],
  )

  const check = JSON.parse(text(closed, 'environment/closed-check.json')) as {
    blobs: { blob: string; path: string }[]
    fix: string
  }
  assert.equal(check.fix, fix)
  assert.deepEqual(check.blobs.map((entry) => entry.path).sort(), [
    'src/sum.py',
    'tests/new/test_added.py',
    'tests/test_sum.py',
  ])

  const lines = text(closed, 'environment/Dockerfile').split('\n')
  const reset = lines.findIndex((line) => line.includes('git reset --hard ' + base))
  assert.match(lines[reset + 1]!, /rm -rf \.git && git init -q \. .* commit -q --no-verify -m base/)
  assert.equal(lines[reset + 2], 'RUN true')
  assert.deepEqual(lines.slice(-3), [
    'COPY closed-check.py closed-check.json /tmp/',
    'RUN python3 /tmp/closed-check.py /tmp/closed-check.json / && rm -f /tmp/closed-check.py /tmp/closed-check.json',
    '',
  ])

  const script = text(closed, 'tests/test.sh')
  assert.ok(!script.includes('GOLD_CHECKOUT'))
  assert.match(
    script,
    /cd \/app\npython3 \/tests\/closed-place\.py \/tests \/logs\/verifier \|\| \{ echo "ERROR: Gold tests placement failed"; exit 1; \}\nbash \/tests\/run_script\.sh\n$/,
  )

  const loaded = await Task.load(closed)
  assert.equal(loaded.environment.allowInternet, false)
  assert.equal((await Task.load(open)).environment.allowInternet, true)
  assert.deepEqual(closed.files['instruction.md'], open.files['instruction.md'])
  for (const directory of [root, scratch]) Fs.rmSync(directory, { recursive: true })
})

test('a task that cannot be closed is refused by name', async () => {
  const { base, fix, root } = upstream()
  const options = { remote: () => root, root: Path.join(root, 'scratch') }
  const refused = async (item: Dataset.Case, message: RegExp) => {
    const seen: Dataset.Case[] = []
    await assert.rejects(async () => {
      for await (const closed of Closed.cases(
        (async function* () {
          yield item
        })(),
        options,
      ))
        seen.push(closed)
    }, message)
    assert.deepEqual(seen, [])
  }

  await refused(
    task({ base, last: 'git checkout ' + fix + ' -- "tests/test_sum.py"' }),
    /^Closed\.UnsupportedError: sum: the last line of before_repo_set_cmd/,
  )
  await refused(
    task({ base, last: 'git checkout ' + fix + ' -- ../etc' }),
    /sum: the test path \.\.\/etc leaves the repository/,
  )
  await refused(
    task({ base, last: 'git checkout ' + fix + ' -- tests/missing.py' }),
    /sum: the fix commit has no file at the test path tests\/missing\.py/,
  )
  const twice = task({ base, last: 'git checkout ' + fix + ' -- tests/test_sum.py' })
  await refused(
    {
      ...twice,
      files: {
        ...twice.files,
        'environment/Dockerfile': Bytes.fromText('FROM example/image\nRUN true\n'),
      },
    },
    /sum: environment\/Dockerfile has 0 steps that reset to the base commit/,
  )
  const allowed = task({ base, last: 'git checkout ' + fix + ' -- tests/test_sum.py' })
  await refused(
    {
      ...allowed,
      files: {
        ...allowed.files,
        'task.toml': Dataset.toml({
          agent: { allowed_hosts: ['example.com'] },
          task: { name: 'org/sum' },
        }),
      },
    },
    /sum: the task gives its agent a network allowlist/,
  )
  Fs.rmSync(root, { recursive: true })
})

test('the verifier places its own test files, counts the ones the agent changed and fails closed', async () => {
  const { base, fix, root } = upstream()
  const closed = await Closed.close(
    task({ base, last: 'git checkout ' + fix + ' -- tests/test_sum.py tests/new' }),
    { remote: () => root, root: Path.join(root, 'scratch') },
  )
  const slot = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-closed-slot-'))
  const tests = Path.join(slot, 'tests')
  const logs = Path.join(slot, 'logs')
  const place = (app: string) =>
    spawnSync('python3', [Path.join(tests, 'closed-place.py'), tests, logs], {
      cwd: app,
      encoding: 'utf8',
    })
  const app = (name: string) => {
    const directory = Path.join(slot, name)
    sh(slot, ['git', 'clone', '-q', '--branch', 'base', root, directory])
    return directory
  }
  Fs.mkdirSync(tests)
  for (const name of ['closed-place.py', 'gold-manifest.json', 'gold.tar'])
    Fs.writeFileSync(Path.join(tests, name), closed.files['tests/' + name]!)
  const counted = () => JSON.parse(Fs.readFileSync(Path.join(logs, 'tests_modified.json'), 'utf8'))

  const untouched = app('untouched')
  assert.equal(place(untouched).status, 0)
  assert.deepEqual(counted(), { paths: [], placed: 2, tests_modified: 0 })
  assert.equal(Fs.readFileSync(Path.join(untouched, 'tests/test_sum.py'), 'utf8'), 'new test\n')
  assert.equal(Fs.statSync(Path.join(untouched, 'tests/new/test_added.py')).mode & 0o111, 0o111)
  assert.equal(Fs.readFileSync(Path.join(untouched, 'tests/keep/test_other.py'), 'utf8'), 'other\n')

  const changed = app('changed')
  Fs.writeFileSync(Path.join(changed, 'tests/test_sum.py'), 'assert True\n')
  Fs.mkdirSync(Path.join(changed, 'tests/new'))
  Fs.symlinkSync('/etc/hostname', Path.join(changed, 'tests/new/test_added.py'))
  assert.equal(place(changed).status, 0)
  assert.deepEqual(counted(), {
    paths: ['tests/new/test_added.py', 'tests/test_sum.py'],
    placed: 2,
    tests_modified: 2,
  })
  assert.equal(Fs.readFileSync(Path.join(changed, 'tests/test_sum.py'), 'utf8'), 'new test\n')
  assert.ok(!Fs.lstatSync(Path.join(changed, 'tests/new/test_added.py')).isSymbolicLink())

  const linked = app('linked')
  Fs.mkdirSync(Path.join(slot, 'elsewhere'))
  Fs.symlinkSync(Path.join(slot, 'elsewhere'), Path.join(linked, 'tests/new'))
  const escaped = place(linked)
  assert.equal(escaped.status, 1)
  assert.match(escaped.stderr, /ERROR: gold directory is a link: tests\/new/)
  assert.deepEqual(Fs.readdirSync(Path.join(slot, 'elsewhere')), [])

  Fs.writeFileSync(Path.join(tests, 'gold.tar'), Tar.pack([]))
  const missing = place(app('missing'))
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /ERROR: gold file missing or unsafe/)
  for (const directory of [root, slot]) Fs.rmSync(directory, { recursive: true })
})

test('the image check finds the fix commit in a repository and a file the fix added anywhere', async () => {
  const { base, fix, root } = upstream()
  const closed = await Closed.close(
    task({ base, last: 'git checkout ' + fix + ' -- tests/test_sum.py tests/new' }),
    { remote: () => root, root: Path.join(root, 'scratch') },
  )
  const work = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-closed-image-'))
  for (const name of ['closed-check.json', 'closed-check.py'])
    Fs.writeFileSync(Path.join(work, name), closed.files['environment/' + name]!)
  const check = (image: string) =>
    spawnSync(
      'python3',
      [Path.join(work, 'closed-check.py'), Path.join(work, 'closed-check.json'), image],
      { encoding: 'utf8' },
    )
  const image = (name: string) => {
    const directory = Path.join(work, name)
    Fs.mkdirSync(Path.join(directory, 'app'), { recursive: true })
    sh(Path.join(directory, 'app'), ['git', 'init', '-q'])
    Fs.writeFileSync(Path.join(directory, 'app/sum.py'), 'def sum(a, b):\n    return a - b\n')
    return directory
  }

  const clean = check(image('clean'))
  assert.equal(clean.status, 0, clean.stderr)
  assert.match(clean.stdout, /for 3 blobs of the fix commit, none found/)

  const cached = image('cached')
  Fs.mkdirSync(Path.join(cached, 'usr/lib/cache'), { recursive: true })
  Fs.writeFileSync(Path.join(cached, 'usr/lib/cache/renamed'), 'def sum(a, b):\n    return a + b\n')
  const leak = check(cached)
  assert.equal(leak.status, 1)
  assert.match(leak.stderr, /usr\/lib\/cache\/renamed is src\/sum\.py of the fix commit/)

  const fetched = image('fetched')
  sh(Path.join(fetched, 'app'), ['git', 'fetch', '-q', root, 'fix'])
  const history = check(fetched)
  assert.equal(history.status, 1)
  assert.match(history.stderr, new RegExp('app/\\.git holds the object ' + fix))
  for (const directory of [root, work]) Fs.rmSync(directory, { recursive: true })
})
