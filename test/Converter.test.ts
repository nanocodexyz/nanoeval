import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Converter from '../sandbox/Converter.ts'

function launcher(script: string): string {
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-converter-'))
  const file = Path.join(directory, 'nanoeval-krun')
  Fs.writeFileSync(file, '#!/bin/sh\n' + script + '\n', { mode: 0o755 })
  return file
}

const stall =
  'echo "nanoeval-krun: layer sha256:0: the builder guest read nothing of its input for 310 s, though it answered a ping" >&2; exit ' +
  Converter.stalledCode

test('a launcher that exits with the stall code is a stall, and another failure is not', async () => {
  await assert.rejects(
    Converter.run('build', [launcher(stall)]),
    (error) =>
      error instanceof Converter.StalledError &&
      error.message.includes('read nothing of its input'),
  )
  await assert.rejects(
    Converter.run('build', [launcher('echo "nanoeval-krun: manifest unknown" >&2; exit 125')]),
    (error) =>
      error instanceof Converter.ConvertError &&
      !(error instanceof Converter.StalledError) &&
      error.message.includes('manifest unknown'),
  )
})

test('a conversion that stalled runs once more and says so', async () => {
  const count = launcher('')
  const file = Path.join(Path.dirname(count), 'runs')
  const program = launcher(
    'echo x >>' + file + '; [ "$(wc -l <' + file + ')" -gt 1 ] && echo built && exit 0; ' + stall,
  )
  const lines: string[] = []
  assert.equal(
    await Converter.again(
      () => Converter.run('build', [program]),
      (line) => lines.push(line),
    ),
    'built\n',
  )
  assert.equal(Fs.readFileSync(file, 'utf8'), 'x\nx\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /read nothing of its input .*, so the image is converted again$/)
})

test('a conversion that stalls twice fails, and one that failed otherwise runs once', async () => {
  let runs = 0
  await assert.rejects(
    Converter.again(() => {
      runs++
      return Converter.run('build', [launcher(stall)])
    }),
    Converter.StalledError,
  )
  assert.equal(runs, 2)
  runs = 0
  await assert.rejects(
    Converter.again(() => {
      runs++
      return Converter.run('build', [launcher('exit 1')])
    }),
    (error) =>
      error instanceof Converter.ConvertError && !(error instanceof Converter.StalledError),
  )
  assert.equal(runs, 1)
})
