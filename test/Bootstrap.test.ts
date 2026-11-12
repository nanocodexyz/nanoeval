import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import * as Bootstrap from '../src/Bootstrap.ts'

test('one command of a sandbox writes the configuration of its runner and starts the runner', async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'nanoeval-bootstrap-'))
  try {
    const digest = 'a'.repeat(64)
    const home = Path.join(root, 'home')
    const runtime = Path.join(home, 'cache', 'runtime', digest)
    const bin = Path.join(root, 'bin')
    await Fs.mkdir(runtime, { recursive: true })
    await Fs.mkdir(bin)
    await Fs.writeFile(Path.join(bin, 'sudo'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })
    await Fs.writeFile(
      Path.join(runtime, Bootstrap.files.runner),
      "import * as Fs from 'node:fs'\n" +
        'const file = process.argv.at(-1)\n' +
        "Fs.writeFileSync(file + '.seen', JSON.stringify({ argv: process.argv.slice(2), config: Fs.readFileSync(file, 'utf8') }))\n",
    )
    const config = JSON.stringify({ run: 'run', token: "it's $HOME `id` \\ $(id)" })
    await promisify(execFile)(
      'bash',
      [
        '-c',
        Bootstrap.script({
          config,
          home,
          run: 'run',
          runtime: { bytes: 1, digest },
          token: 'secret',
          url: 'http://127.0.0.1:9',
        }),
      ],
      {
        env: {
          ...process.env,
          PATH: bin + ':' + Path.dirname(process.execPath) + ':' + process.env['PATH'],
        },
      },
    )
    const file = Path.join(home, Bootstrap.files.config)
    assert.equal(await Fs.readFile(file, 'utf8'), config + '\n')
    assert.equal((await Fs.stat(file)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await Fs.readFile(file + '.seen', 'utf8')), {
      argv: ['runner', '--detach', '--config', file],
      config: config + '\n',
    })
    assert.deepEqual(
      (await Fs.readFile(Path.join(home, Bootstrap.files.marks), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => line.split(' ')[0]),
      ['bootstrap.start', 'bootstrap.node', 'bootstrap.runtime'],
    )
  } finally {
    await Fs.rm(root, { force: true, recursive: true })
  }
})
