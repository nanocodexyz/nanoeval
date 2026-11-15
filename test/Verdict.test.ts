import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Retry from '../src/Retry.ts'
import * as Verdict from '../src/Verdict.ts'

const base = { ctrf: true, now: 5, timeoutSec: 900 }
const unreported = { code: 0, files: ['reward.txt', 'test-stdout.txt'], reward: 0 }

const torch = [
  ' Downloading nvidia-cublas-cu12',
  '  × Failed to download `torch==2.7.0`',
  '  ├─▶ Failed to extract archive:',
  '  │   torch-2.7.0-cp313-cp313-manylinux_2_28_x86_64.whl',
  '  ├─▶ I/O operation failed during extraction',
  '  ╰─▶ Failed to download distribution due to network timeout. Try increasing',
  '      UV_HTTP_TIMEOUT (current value: 30s).',
].join('\n')

const installer = [
  'downloading uv 0.9.5 x86_64-unknown-linux-gnu',
  'curl: (56) Recv failure: Connection timed out',
  'failed to download https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz',
  '/tests/test.sh: line 19: uvx: command not found',
].join('\n')

const withdrawn = [
  'Err:5 http://deb.debian.org/debian-security bullseye-security/main amd64 libcurl4 amd64 7.74.0-1.3+deb11u16',
  '  404  Not Found [IP: 146.75.118.132 80]',
  'Fetched 557 kB in 0s (10.5 MB/s)',
  'E: Failed to fetch http://deb.debian.org/debian-security/pool/updates/main/c/curl/curl_7.74.0-1.3%2bdeb11u16_amd64.deb  404  Not Found [IP: 146.75.118.132 80]',
  'E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?',
  '/tests/test.sh: line 8: curl: command not found',
].join('\n')

const broken = [
  '  × Failed to download `pandas==2.3.2`',
  '  ╰─▶ failed to create file',
  '      `/root/.cache/uv/.tmpJk8Meh/pandas/tests/indexes/numeric/test_numeric.py`:',
  '      Input/output error (os error 5)',
].join('\n')

function retried(failure: { kind: string; message: string } | undefined) {
  return Retry.infrastructure({
    failure: failure as Parameters<typeof Retry.infrastructure>[0]['failure'],
    statuses: [],
  })
}

test('a verifier that could not download what its test.sh installs is an error of the slot and is retried', () => {
  for (const log of [torch, installer]) {
    const verdict = Verdict.verifier({ ...base, facts: unreported, log })
    assert.equal(verdict.reward, null)
    assert.equal(verdict.failure!.kind, 'environment')
    assert.ok(verdict.failure!.message.startsWith(Verdict.unfetchedPrefix))
    assert.ok(verdict.failure!.message.endsWith(log))
    assert.equal(retried(verdict.failure), 'the verifier could not download its dependencies')
  }
  const silent = Verdict.verifier({
    ...base,
    facts: { code: 1, files: [], reward: null },
    log: installer,
  })
  assert.equal(silent.failure!.kind, 'environment')
})

test('a package that its archive no longer serves is an error of the task and is not retried', () => {
  const verdict = Verdict.verifier({ ...base, facts: unreported, log: withdrawn })
  assert.equal(verdict.reward, null)
  assert.equal(verdict.failure!.kind, 'verifier')
  assert.ok(verdict.failure!.message.startsWith(Verdict.withdrawnPrefix))
  assert.equal(retried(verdict.failure), undefined)
})

test('a verifier whose disk failed or filled is an error of the slot and is retried', () => {
  const failed = Verdict.verifier({ ...base, facts: unreported, log: broken })
  assert.equal(failed.failure!.kind, 'environment')
  assert.ok(failed.failure!.message.startsWith(Verdict.brokenPrefix))
  assert.equal(retried(failed.failure), 'the disk of the slot failed')
  const cut =
    'Installed 7 packages in 23ms\n=========== test session starts ===========\nplatform linux -- Python 3'
  const full = Verdict.verifier({
    ...base,
    facts: { code: 101, diskMb: 0, files: [], reward: null },
    log: cut,
  })
  assert.equal(full.reward, null)
  assert.equal(full.failure!.kind, 'environment')
  assert.ok(full.failure!.message.startsWith(Verdict.fullPrefix))
  assert.equal(retried(full.failure), 'the slot ran out of disk')
  const roomy = Verdict.verifier({
    ...base,
    facts: { code: 101, diskMb: 4096, files: [], reward: null },
    log: cut,
  })
  assert.equal(roomy.failure!.kind, 'verifier')
  assert.equal(roomy.failure!.message, 'the verifier exited with 101 and wrote no reward: ' + cut)
  assert.equal(retried(roomy.failure), undefined)
})

test('a verifier whose tests ran is scored whatever its log or the disk says', () => {
  const ran = { code: 1, diskMb: 0, files: ['ctrf.json', 'reward.txt'], reward: 0 }
  assert.deepEqual(Verdict.verifier({ ...base, facts: ran, log: installer }), { reward: 0 })
  assert.deepEqual(
    Verdict.verifier({ ...base, facts: { ...ran, code: 0, reward: 1 }, log: broken }),
    { reward: 1 },
  )
  assert.deepEqual(
    Verdict.verifier({
      ...base,
      ctrf: false,
      facts: { code: 1, files: ['reward.txt'], reward: 0 },
      log: torch,
    }),
    { reward: 0 },
  )
})

test('a verifier that the limit of the run ended is not a verifier timeout, and never has a reward', () => {
  for (const code of Verdict.timeoutCodes) {
    const own = Verdict.verifier({
      ...base,
      facts: { code, files: ['reward.txt', 'ctrf.json'], reward: 1 },
      log: '',
    })
    assert.deepEqual(
      [own.reward, own.failure!.kind, own.failure!.message],
      [null, 'verifier_timeout', 'the verifier did not finish within 900 s'],
    )
    const cut = Verdict.verifier({
      ...base,
      facts: { code, files: ['reward.txt', 'ctrf.json'], reward: 1 },
      log: '',
      ownSec: 900,
      timeoutSec: 240,
    })
    assert.deepEqual(
      [cut.reward, cut.failure!.kind, cut.failure!.message],
      [
        null,
        'verifier_limit',
        'the limit of the run ended the verifier, which its task allows 900 s: the verifier did not finish within 240 s',
      ],
      'a reward that a verifier wrote before the limit ended it does not count',
    )
    assert.equal(Retry.infrastructure({ failure: cut.failure!, statuses: [] }), undefined)
  }
  const done = { code: 0, files: ['reward.txt', 'ctrf.json'], reward: 1 }
  assert.deepEqual(
    Verdict.verifier({ ...base, facts: done, log: '', ownSec: 900, timeoutSec: 240 }),
    { reward: 1 },
    'a verifier that ended in time is scored as without the limit',
  )
  assert.deepEqual(
    Verdict.verifier({
      ...base,
      facts: { ...done, reward: 0 },
      log: '',
      ownSec: 900,
      timeoutSec: 240,
    }),
    { reward: 0 },
  )
  const late = { at: 1, kind: 'agent_timeout' as const, message: 'late' }
  assert.deepEqual(
    Verdict.verifier({ ...base, earlier: late, facts: done, log: '', ownSec: 900 }).failure,
    late,
  )
  const slow = { at: 1, kind: 'verifier_timeout' as const, message: 'no report' }
  assert.equal(Verdict.bounded(slow, undefined), slow)
  assert.deepEqual(Verdict.bounded(slow, 900), {
    at: 1,
    kind: 'verifier_limit',
    message: 'the limit of the run ended the verifier, which its task allows 900 s: no report',
  })
  const other = { at: 1, kind: 'verifier' as const, message: 'no reward' }
  assert.equal(Verdict.bounded(other, 900), other)
})
