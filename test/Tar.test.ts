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

test('unpack reads a packed archive and the long names that system tar writes', () => {
  const entries = [
    {
      data: Bytes.fromText('FROM alpine:3.21\n'),
      executable: false,
      path: 'environment/Dockerfile',
    },
    { data: Bytes.fromText('#!/bin/sh\necho ok\n'), executable: true, path: 'tests/test.sh' },
    {
      data: new Uint8Array(1500).fill(7),
      executable: false,
      path: 'tests/' + 'nested/'.repeat(14) + 'file.bin',
    },
  ]
  assert.deepEqual(
    Tar.unpack(Tar.pack(entries)),
    entries.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
  )

  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-tar-'))
  const long = 'tests/' + 'n'.repeat(120) + '.txt'
  Fs.mkdirSync(Path.join(directory, 'task/tests'), { recursive: true })
  Fs.writeFileSync(Path.join(directory, 'task', long), 'long\n')
  Fs.writeFileSync(Path.join(directory, 'task/tests/test.sh'), 'echo ok\n', { mode: 0o755 })
  for (const format of ['gnu', 'pax', 'ustar']) {
    if (format === 'ustar') Fs.rmSync(Path.join(directory, 'task', long))
    execFileSync('tar', ['--format=' + format, '-cf', format + '.tar', '-C', 'task', '.'], {
      cwd: directory,
    })
    const unpacked = Tar.unpack(Fs.readFileSync(Path.join(directory, format + '.tar')))
    assert.deepEqual(
      unpacked.map((entry) => [entry.path, entry.executable, Bytes.toText(entry.data)]).sort(),
      [
        ...(format === 'ustar' ? [] : [[long, false, 'long\n']]),
        ['tests/test.sh', true, 'echo ok\n'],
      ],
    )
  }
  Fs.rmSync(directory, { recursive: true })
})

test('unpack refuses an entry that leaves the archive, a link and a truncated archive', () => {
  const archive = Tar.pack([{ data: Bytes.fromText('x'), path: 'aa/escape' }])
  const escaping = archive.slice()
  escaping.set(Bytes.fromText('../'), 0)
  assert.throws(() => Tar.unpack(escaping), Tar.PathError)
  const link = archive.slice()
  link[156] = 0x32
  assert.throws(() => Tar.unpack(link), Tar.PathError)
  assert.throws(() => Tar.unpack(archive.subarray(0, 512)), Tar.PathError)
})
