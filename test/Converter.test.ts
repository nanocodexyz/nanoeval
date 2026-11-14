import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Converter from '../sandbox/Converter.ts'
import * as Host from '../sandbox/Host.ts'

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

test('the host policy of a conversion is read from the environment', () => {
  assert.deepEqual(Converter.policy({}), {})
  assert.deepEqual(
    Converter.policy({
      NANOEVAL_CA_BUNDLE: '/ca.pem',
      NANOEVAL_PULL_WAIT_SEC: '90',
      NANOEVAL_SLOT_ENV: '/slot.env',
      NANOEVAL_SLOT_FORWARD: '127.0.0.1:1 127.0.0.1:2',
    }),
    {
      caBundle: '/ca.pem',
      envFile: '/slot.env',
      forwards: ['127.0.0.1:1', '127.0.0.1:2'],
      pullWaitSec: 90,
    },
  )
  assert.deepEqual(Converter.policy({ NANOEVAL_PULL_WAIT_SEC: '0' }), { pullWaitSec: 0 })
})

test('a wait for a registry that is not a whole number of seconds is refused', () => {
  for (const wait of ['', '-1', '1.5', 'soon'])
    assert.throws(
      () => Converter.policy({ NANOEVAL_PULL_WAIT_SEC: wait }),
      /NANOEVAL_PULL_WAIT_SEC is a whole number of seconds, not /,
    )
})

test('an environment is refused on a machine that cannot start a microVM, before anything is built or pulled', async () => {
  const home = await Fs.promises.mkdtemp(Path.join(Os.tmpdir(), 'nanoeval-converter-'))
  try {
    const said: string[] = []
    const converter = (machine: Host.Machine) =>
      Converter.create({
        home,
        layers: Path.join(home, 'oci'),
        machine: () => machine,
        notice: (line) => said.push(line),
      })
    const environment = { context: Path.join(home, 'context'), storageMb: 16 }
    for (const [machine, lacks] of [
      [{ krunfw: true, kvm: 'absent' }, 'this machine has no /dev/kvm'],
      [{ krunfw: true, kvm: 'closed' }, 'this user cannot read and write /dev/kvm'],
      [{ krunfw: false, kvm: 'open' }, 'libkrunfw.so.5 is not installed on this machine'],
    ] as const)
      await assert.rejects(
        converter(machine).convert(environment, Path.join(home, 'disk')),
        new Converter.ConvertError(
          'its environment is a Dockerfile, which is built in a microVM, and ' +
            lacks +
            ': import it with --backend dir, which keeps the files and runs them on directory slots without isolation, or on a machine with KVM. nanoeval doctor says what this machine lacks',
        ),
      )
    await assert.rejects(
      converter({ krunfw: true, kvm: 'absent' }).convert(
        { image: 'alpine:3.21', storageMb: 16 },
        Path.join(home, 'disk'),
      ),
      new Converter.ConvertError(
        'its environment is an image, which is written to its disk in a microVM, and this machine has no /dev/kvm: import it with --backend dir, which keeps the files and runs them on directory slots without isolation, or on a machine with KVM. nanoeval doctor says what this machine lacks',
      ),
    )
    assert.deepEqual(said, [])
    assert.deepEqual(await Fs.promises.readdir(home), [])
  } finally {
    await Fs.promises.rm(home, { force: true, recursive: true })
  }
})

test('a machine can start a microVM with /dev/kvm open and libkrunfw installed', () => {
  assert.equal(Host.microvm({ krunfw: true, kvm: 'open' }), undefined)
  assert.equal(Host.kvm('/nonexistent/kvm'), 'absent')
  assert.equal(Host.kvm('/dev/null'), 'open')
  assert.equal(Host.launcher({ NANOEVAL_KRUN: '/opt/krun' }), 'given')
  assert.equal(Host.launcher({ NANOEVAL_KRUN_SOURCE: '/nonexistent/krun' }), 'none')
  assert.equal(Host.launcher({}), 'none')
})
