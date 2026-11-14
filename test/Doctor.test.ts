import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Doctor from '../cli/Doctor.ts'

const release = 'https://github.com/nanocodexyz/nanocode/releases/download/nanocode-cli-d2473f9'
const pinned =
  'https://github.com/nanocodexyz/nanocode-ts/releases/download/build-f3aa94f/nanocode-ts-f3aa94f.tgz'

const ready: Doctor.Facts = {
  arch: 'x64',
  cgroup: true,
  credentials: { claude: ['ANTHROPIC_API_KEY'], codex: [] },
  disk: [
    { freeMb: 400_000, holds: 'the blob store, the cache of disks and blobs', path: '/data/store' },
  ],
  endpoints: [],
  hand: { release },
  krunfw: true,
  kvm: 'open',
  kvmGroup: 'kvm',
  launcher: 'built',
  memory: { availableMb: 10_000, totalMb: 16_000 },
  node: '24.11.0',
  overlay: true,
  packages: { installed: pinned, pinned, workerd: true },
  registry: { kind: 'answered', limit: 100, remaining: 89, windowSec: 21_600 },
  root: false,
  systemd: true,
  tools: {
    cargo: '/home/u/.cargo/bin/cargo',
    chroot: '/usr/sbin/chroot',
    ip: '/usr/sbin/ip',
    losetup: '/usr/sbin/losetup',
    mke2fs: '/usr/sbin/mke2fs',
    mount: '/usr/bin/mount',
    mountpoint: '/usr/bin/mountpoint',
    nft: '/usr/sbin/nft',
    passt: '/usr/bin/passt',
    pgrep: '/usr/bin/pgrep',
    setpriv: '/usr/bin/setpriv',
    unshare: '/usr/bin/unshare',
  },
  user: 'u',
  worker: undefined,
  workerUrl: undefined,
}

const misses = (found: readonly Doctor.Check[]) =>
  found.flatMap((check) => (check.level === 'miss' ? [[check.text, check.fix]] : []))

test('a machine with everything is ready for krun slots, and says what it found', () => {
  const found = Doctor.checks(ready)
  assert.equal(Doctor.backend(ready), 'krun')
  assert.deepEqual(misses(found), [])
  assert.equal(
    Doctor.report(found, 'krun'),
    [
      'ok   Node 24.11.0',
      'ok   the pinned packages are installed: nanocode-ts build-f3aa94f and workerd',
      'ok   the pinned hand, nanocode-cli-d2473f9, is published for x64 and answers',
      'ok   /dev/kvm opens for u',
      'ok   libkrunfw.so.5 is installed',
      'ok   mke2fs at /usr/sbin/mke2fs',
      'ok   passt at /usr/bin/passt',
      'ok   the launcher is built in krun/target',
      'ok   10,000 MB of memory available of 16,000: a runner admits rows that ask for 8,000 MB together, and a row that asks for more runs alone',
      'ok   400,000 MB of disk free for the blob store, the cache of disks and blobs (/data/store)',
      'ok   Docker Hub answers: 89 of 100 pulls are left to this address in a window of 21600 s, and an import pulls each image once',
      'note no Worker is named (--url or NANOEVAL_URL): nanoeval revision starts its own, and nanoeval run needs one, see "Run it locally" in README.md',
      'ok   this shell holds a model credential for claude agents: ANTHROPIC_API_KEY, which nanoeval worker and nanoeval revision take from it',
      'ready for krun slots',
    ].join('\n'),
  )
})

test('a base URL of this shell where nothing answers is missing, with what to do', () => {
  const dead = {
    name: 'ANTHROPIC_BASE_URL',
    said: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8790',
    url: 'http://127.0.0.1:8790',
  }
  const lines = (endpoints: Doctor.Facts['endpoints']) =>
    Doctor.checks({ ...ready, endpoints }).flatMap((check) =>
      check.text.includes('BASE_URL') ? [check.level + ' ' + check.text.split(':')[0]] : [],
    )
  assert.deepEqual(lines([dead]), ['miss nothing answers at ANTHROPIC_BASE_URL http'])
  assert.deepEqual(
    misses(Doctor.checks({ ...ready, endpoints: [dead] })).map(([, fix]) => fix),
    [
      'start what serves it again, node scripts/scripted-model.ts --task DIR for the scripted model, or unset ANTHROPIC_BASE_URL',
    ],
  )
  assert.deepEqual(lines([{ name: 'OPENAI_BASE_URL', url: 'http://127.0.0.1:8790' }]), [
    'ok OPENAI_BASE_URL http',
  ])
  assert.deepEqual(lines([]), [])
})

test('a bare machine with KVM gets one command for each thing it lacks, in the order to run them', () => {
  const bare: Doctor.Facts = {
    ...ready,
    credentials: { claude: [], codex: [] },
    krunfw: false,
    kvm: 'closed',
    launcher: 'none',
    packages: { installed: undefined, pinned, workerd: false },
    tools: { mke2fs: '/usr/sbin/mke2fs' },
  }
  assert.deepEqual(misses(Doctor.checks(bare)), [
    [
      'node_modules holds no nanocode-ts, and package.json pins nanocode-ts build-f3aa94f',
      'npm ci',
    ],
    ['u cannot read and write /dev/kvm', 'sudo usermod -aG kvm u, then log in again'],
    [
      'libkrunfw.so.5 is not where the dynamic loader finds it',
      "curl -fsSL -o /tmp/libkrunfw-x86_64.tgz https://github.com/containers/libkrunfw/releases/download/v5.5.0/libkrunfw-x86_64.tgz && echo 'c169206b01c89fbe134f1728bf4f988702bc7f73b4cf73e6fdece447d6fceca1  /tmp/libkrunfw-x86_64.tgz' | sha256sum -c - && sudo tar -xzf /tmp/libkrunfw-x86_64.tgz -C /usr/local/lib --strip-components=1 lib64/libkrunfw.so.5.5.0 && sudo ln -sf libkrunfw.so.5.5.0 /usr/local/lib/libkrunfw.so.5 && sudo ldconfig",
    ],
    [
      'passt is not installed: slots on a private network and the RUN steps of a Dockerfile reach the internet through it',
      'sudo apt-get install -y passt',
    ],
    [
      'the launcher is not built and cargo is not installed (NANOEVAL_KRUN names a directory with a built one instead)',
      "curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none",
    ],
    [
      'this shell holds no model credential, so a Worker started from it runs --oracle only. OPENAI_API_KEY, TEMPO_KEY and a plan login (--claude-login, --codex-login) serve too, and scripts/scripted-model.ts stands in for a model at no cost',
      'export ANTHROPIC_API_KEY=KEY',
    ],
  ])
  assert.match(
    Doctor.report(Doctor.checks(bare), 'krun'),
    /\n6 missing for krun slots: the fix under each is the one command that gives it$/,
  )
  assert.match(
    Doctor.report(Doctor.checks(bare), 'krun'),
    /\nmiss u cannot read and write \/dev\/kvm\n     fix: sudo usermod -aG kvm u, then log in again\n/,
  )
})

test('the libkrunfw that the doctor installs is the one that ci-machine.sh installs', () => {
  const script = Fs.readFileSync(
    Path.resolve(import.meta.dirname, '../scripts/ci-machine.sh'),
    'utf8',
  )
  assert.ok(script.includes('version=' + Doctor.krunfwRelease.version + '\n'))
  assert.ok(script.includes('x86_64) sha256=' + Doctor.krunfwRelease.sha256['x64'] + ' ;;'))
})

test('a machine without KVM is checked for the slots a runner takes there, and for krun when asked', () => {
  const plain: Doctor.Facts = {
    ...ready,
    krunfw: false,
    kvm: 'absent',
    kvmGroup: undefined,
    systemd: false,
  }
  assert.equal(Doctor.backend(plain), 'dir')
  assert.equal(Doctor.backend({ ...plain, root: true }), 'ns')
  const found = Doctor.checks(plain)
  assert.deepEqual(misses(found), [])
  assert.deepEqual(
    found.filter((check) => check.level === 'note').map((check) => check.text.split(':')[0]),
    [
      'this machine has no /dev/kvm',
      'ns slots, which isolate as a container does, need root',
      'directory slots keep attempts apart by directory only, and run tasks on this machine as u',
      'no Worker is named (--url or NANOEVAL_URL)',
      'no systemd user session here',
    ],
  )
  assert.match(Doctor.report(found, 'dir'), /\nready for dir slots$/)
  assert.deepEqual(misses(Doctor.checks(plain, 'krun')).slice(0, 2), [
    [
      'this machine has no /dev/kvm, so no microVM starts on it',
      'none on this machine: a bare-metal machine or a virtual machine with nested virtualization has it; nanoeval doctor --backend dir checks this one for directory slots',
    ],
    [
      'libkrunfw.so.5 is not where the dynamic loader finds it',
      misses(Doctor.checks(plain, 'krun'))[1]![1],
    ],
  ])
  assert.deepEqual(misses(Doctor.checks(plain, 'ns')), [
    [
      'ns slots need root, and this is u',
      'run the runner, sandboxd or revision as root: sudo -E node cli/nanoeval.ts ...',
    ],
  ])
  assert.deepEqual(
    misses(
      Doctor.checks(
        { ...plain, overlay: false, root: true, tools: { ...ready.tools, nft: undefined } },
        'ns',
      ),
    ),
    [
      ['the kernel lists no overlayfs', 'sudo modprobe overlay'],
      ['nft is not installed: ns slots use it', 'sudo apt-get install -y nftables'],
    ],
  )
})

test('a registry that is out of pulls or out of reach, little disk and an old Node are said', () => {
  const found = Doctor.checks({
    ...ready,
    disk: [
      { freeMb: 12_000, holds: 'the blob store', path: '/home/u/.local/share/nanoeval/store' },
      {
        freeMb: 300_000,
        holds: 'the cache of disks and blobs, image layers',
        path: '/var/cache/nanoeval',
      },
    ],
    hand: { release, said: 'fetch failed: connect ETIMEDOUT' },
    node: '22.20.0',
    registry: { kind: 'answered', limit: 100, remaining: 0, windowSec: 21_600 },
  })
  assert.deepEqual(misses(found), [
    [
      'Node 22.20.0, and nanoeval runs on Node 24',
      'install Node 24 from https://nodejs.org/dist/latest-v24.x/, step 3 of "A bare machine" in README.md',
    ],
    [
      'the pinned hand, nanocode-cli-d2473f9, which a runner fetches once, was not reached: fetch failed: connect ETIMEDOUT',
      'curl -fsSIL ' +
        release +
        '/ shows what the network answers; NANOEVAL_NANOCODE=FILE names a hand that is already here',
    ],
    [
      'Docker Hub answers, and this address has none of its 100 pulls left in this window of 21600 s',
      'node cli/nanoeval.ts import DATASET --pull-wait 21600 waits for the window; the layers read so far stay in the cache',
    ],
  ])
  const disk = found.find((check) => check.text.includes('of disk free'))
  assert.equal(disk?.level, 'note')
  assert.equal(
    disk?.text,
    '12,000 MB of disk free for the blob store (/home/u/.local/share/nanoeval/store), and 300,000 MB of disk free for the cache of disks and blobs, image layers (/var/cache/nanoeval): the sample tasks fit, and all of Terminal-Bench 2.1 took 18,000 MB of store, 16,000 MB of layers and 51,000 MB of unpacked disks, which run --disks remove gives back as rows end',
  )
  assert.deepEqual(
    misses(
      Doctor.checks({
        ...ready,
        registry: { kind: 'unreached', said: 'fetch failed: getaddrinfo ENOTFOUND auth.docker.io' },
      }),
    ),
    [
      [
        'Docker Hub, which task images are read from, was not reached: fetch failed: getaddrinfo ENOTFOUND auth.docker.io',
        'curl -sI https://registry-1.docker.io/v2/ shows what the network answers; an import of images that the layer cache holds asks for none',
      ],
    ],
  )
  assert.equal(
    Doctor.checks({ ...ready, registry: { kind: 'answered' } }).find((check) =>
      check.text.startsWith('Docker Hub'),
    )?.text,
    'Docker Hub answers and names no pull limit for this address',
  )
})

test('a Worker that is named is asked for its protocol and for how it pays for models', () => {
  const url = 'http://127.0.0.1:8787'
  const none = { ...ready, credentials: { claude: [], codex: [] }, workerUrl: url }
  assert.deepEqual(
    misses(
      Doctor.checks({
        ...none,
        worker: { kind: 'unreached', said: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8787' },
      }),
    ).map(([text]) => text),
    [
      'no Worker answers at http://127.0.0.1:8787: fetch failed: connect ECONNREFUSED 127.0.0.1:8787',
      'this shell holds no model credential, so a Worker started from it runs --oracle only. OPENAI_API_KEY, TEMPO_KEY and a plan login (--claude-login, --codex-login) serve too, and scripts/scripted-model.ts stands in for a model at no cost',
    ],
  )
  const answered = (routes: {
    claude: { payer: 'key' } | null
    codex: { payer: 'login'; through: 'relay' } | null
  }) =>
    Doctor.checks({
      ...none,
      worker: { kind: 'answered', routes, version: { commit: null, protocol: 2 } },
    })
  const paid = answered({ claude: { payer: 'key' }, codex: { payer: 'login', through: 'relay' } })
  assert.deepEqual(misses(paid), [])
  assert.deepEqual(
    paid.slice(-2).map((check) => check.text),
    [
      'the Worker at http://127.0.0.1:8787 answers and speaks protocol 2, as this checkout does',
      'the Worker pays for claude models with the provider key and for codex models with a plan login through the relay',
    ],
  )
  assert.deepEqual(misses(answered({ claude: null, codex: null })), [
    [
      'the Worker holds no model credential: it runs --oracle only. A key of the provider, TEMPO_KEY, a plan login file or the scripted model of scripts/scripted-model.ts gives it one',
      'start nanoeval worker again with ANTHROPIC_API_KEY=KEY in its environment',
    ],
  ])
  assert.deepEqual(
    misses(
      Doctor.checks({
        ...none,
        worker: { kind: 'answered', routes: undefined, version: { commit: null, protocol: 1 } },
      }),
    )[0],
    [
      'the Worker at http://127.0.0.1:8787 speaks protocol 1 and this checkout 2',
      'git pull --ff-only && npm ci on the side that is behind, the Worker first',
    ],
  )
})
