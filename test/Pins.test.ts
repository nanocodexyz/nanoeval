import assert from 'node:assert/strict'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Runner from '../sandbox/Runner.ts'
import * as Pins from '../src/Pins.ts'
import * as Slot from '../src/Slot.ts'

test('a release is named by its tag, and anything else by itself', () => {
  assert.equal(
    Pins.release('https://github.com/o/nanocode/releases/download/nanocode-cli-1234567'),
    'nanocode-cli-1234567',
  )
  assert.equal(
    Pins.pinned(
      'https://github.com/o/nanocode-ts/releases/download/build-abcdef0/nanocode-ts-abcdef0.tgz',
    ),
    'nanocode-ts build-abcdef0',
  )
  assert.equal(Pins.release('github:o/nanocode-ts#0123'), 'github:o/nanocode-ts#0123')
})

test('the pins of a run read as its harness and the hands of its runners', () => {
  assert.equal(
    Pins.text({
      hands: [Pins.hand('0123456789ab')],
      harness: Pins.harness({ nanocode: '0123456789ab', nanocodeTs: 'fedcba987654' }),
    }),
    'nanocode-ts fedcba987654 on nanocode 0123456789ab, hand nanocode 0123456789ab',
  )
  assert.equal(
    Pins.text({ hands: ['a', 'b'], harness: null }),
    'harness not recorded, hand a and b',
  )
  assert.equal(Pins.text({ hands: [], harness: 'h' }), 'h, hand not reported')
})

test('a runner names the hand it places: the pinned release, the revision it was given, or the file', async () => {
  assert.equal(await Runner.hand({}), Pins.release(Slot.runtime.release))
  assert.match(await Runner.hand({}), /^nanocode-cli-[0-9a-f]{7}$/)
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-pins-'))
  try {
    const file = Path.join(directory, 'nanocode')
    Fs.writeFileSync(file, 'a hand')
    assert.equal(
      await Runner.hand({ NANOEVAL_NANOCODE: file }),
      'sha256 ' + Crypto.createHash('sha256').update('a hand').digest('hex').slice(0, 12),
    )
    assert.equal(
      await Runner.hand({ NANOEVAL_NANOCODE: file, NANOEVAL_NANOCODE_REVISION: 'nanocode 0123' }),
      'nanocode 0123',
    )
  } finally {
    Fs.rmSync(directory, { force: true, recursive: true })
  }
})
