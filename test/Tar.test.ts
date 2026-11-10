import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Tar from '../src/Tar.ts'

test('system tar extracts a packed archive with contents and modes', () => {
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-tar-'))
  const long = 'environment/' + 'nested/'.repeat(14) + 'file.txt'
  const archive = Tar.pack([
    { data: Bytes.fromText('#!/bin/sh\necho ok\n'), executable: true, path: 'tests/test.sh' },
    { data: Bytes.fromText('FROM alpine:3.21\n'), path: 'environment/Dockerfile' },
    { data: new Uint8Array(1500).fill(7), path: long },
    { data: new Uint8Array(0), path: 'environment/empty' },
  ])
  Fs.writeFileSync(Path.join(directory, 'task.tar'), archive)
  execFileSync('tar', ['-xf', 'task.tar'], { cwd: directory })

  assert.equal(
    Fs.readFileSync(Path.join(directory, 'tests/test.sh'), 'utf8'),
    '#!/bin/sh\necho ok\n',
  )
  assert.equal(Fs.statSync(Path.join(directory, 'tests/test.sh')).mode & 0o111, 0o111)
  assert.equal(Fs.statSync(Path.join(directory, 'environment/Dockerfile')).mode & 0o111, 0)
  assert.equal(Fs.readFileSync(Path.join(directory, long)).length, 1500)
  assert.equal(Fs.readFileSync(Path.join(directory, 'environment/empty')).length, 0)
  Fs.rmSync(directory, { recursive: true })
})

test('pack refuses paths that leave the archive', () => {
  for (const path of ['/etc/passwd', '../escape', 'a//b', ''])
    assert.throws(() => Tar.pack([{ data: new Uint8Array(0), path }]), Tar.PathError)
})
