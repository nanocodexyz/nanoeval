import { spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Runtime from '../cli/Runtime.ts'
import * as Converter from '../sandbox/Converter.ts'
import * as Host from '../sandbox/Host.ts'
import type * as Sandboxd from '../sandbox/Sandboxd.ts'
import * as Store from '../sandbox/Store.ts'
import * as Krun from './Krun.ts'

export type Guest = {
  close(): void
  machine: Sandboxd.Machine
  variables: Record<string, string>
}

export const root = '/var/nanoeval'

const repository = Path.resolve(import.meta.dirname, '..')
const kept = Path.join(repository, 'output', 'guest')
const share = '/opt/nanoeval'
const path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const diskMb = 8192
const upperMb = 65_536
const bundles = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
]

export function missing(): string | undefined {
  return Krun.missing('private')
}

export function inside(host: string): string {
  const relative = Path.relative(repository, Path.resolve(host))
  if (relative.startsWith('..') || Path.isAbsolute(relative))
    throw new Error('the guest sees only this checkout, not ' + host)
  return Path.posix.join(share, ...relative.split(Path.sep))
}

function run(
  program: string,
  rest: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const result = spawnSync(program, rest, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    encoding: 'utf8',
    env: {
      ...Host.environment(),
      ...options.env,
      PATH: process.env['PATH'] + ':' + Path.join(Os.homedir(), '.cargo/bin'),
    },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(
      program + ' ' + rest.join(' ') + ' failed: ' + (result.stderr || result.stdout).slice(-2000),
    )
  return result.stdout
}

function launcher(): string {
  const home = Path.join(kept, 'launcher')
  run('bash', [Path.join(repository, 'sandbox', 'slot.sh'), 'tools'], {
    env: { NANOEVAL_HOME: home },
  })
  return Path.join(home, 'rt', 'krun')
}

export async function start(options: start.Options): Promise<Guest> {
  Fs.mkdirSync(kept, { recursive: true })
  const krun = launcher()
  const tools = Path.join(kept, 'krun')
  await Runtime.tools(tools)
  const disk = Path.join(kept, 'guest.ext4')
  if (!Fs.existsSync(disk))
    run(Path.join(krun, 'nanoeval-krun'), [
      'image',
      'build',
      '--dockerfile',
      Path.join(repository, 'test', 'guest'),
      '--size-mb',
      String(diskMb),
      '--out',
      disk,
      '--meta',
      disk + '.json',
      '--cache',
      Converter.defaultLayers(Store.defaultCache()),
    ])
  const bundle = process.env['SSL_CERT_FILE'] ?? bundles.find((file) => Fs.existsSync(file))
  if (bundle) Fs.copyFileSync(bundle, Path.join(kept, 'ca.pem'))

  const home = Path.resolve(options.home)
  Fs.rmSync(home, { force: true, recursive: true })
  Fs.mkdirSync(Path.join(home, 'io'), { recursive: true })
  Fs.mkdirSync(Path.join(home, 'net'))
  Fs.writeFileSync(Path.join(home, 'allow'), options.forwards.map((line) => line + '\n').join(''))
  run('truncate', ['-s', upperMb + 'M', Path.join(home, 'upper.ext4')])
  run('bash', [
    '-c',
    'PATH=$PATH:/usr/sbin:/sbin mke2fs -q -t ext4 -O ^has_journal -E root_owner=0:0 "$1"',
    'bash',
    Path.join(home, 'upper.ext4'),
  ])
  const relay = Number(
    run(
      Path.join(tools, 'nanoeval-net'),
      ['detach', 'relay.log', 'host', 'net/relay.sock', 'allow'],
      { cwd: home },
    ).trim(),
  )
  const log = Fs.openSync(Path.join(home, 'vm.log'), 'a')
  const machine = spawn(
    Path.join(krun, 'nanoeval-krun'),
    [
      'vm',
      '--boot',
      Path.join(krun, 'boot'),
      '--rt',
      repository,
      '--io',
      'io',
      '--socket',
      'vm.sock',
      '--cpus',
      String(options.cpus),
      '--memory-mib',
      String(options.memoryMb),
      '--lower',
      disk,
      '--upper',
      'upper.ext4',
      '--passt',
      run('bash', ['-c', 'command -v passt']).trim(),
      '--relay',
      'net/relay.sock',
      ...options.forwards.flatMap((forward) => ['--forward', forward]),
    ],
    { cwd: home, detached: true, stdio: ['ignore', log, log] },
  )
  Fs.closeSync(log)
  const close = () => {
    for (const process of [machine.pid, relay])
      try {
        if (process) globalThis.process.kill(process, 'SIGKILL')
      } catch {}
    Fs.rmSync(Path.join(home, 'upper.ext4'), { force: true })
  }
  try {
    run(
      Path.join(krun, 'nanoeval-krun'),
      ['ready', '--log', 'vm.log', '--pid', String(machine.pid), '--socket', 'vm.sock'],
      { cwd: home },
    )
  } catch (error) {
    close()
    throw error
  }

  const exec: Sandboxd.Machine['exec'] = (command, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        Path.join(krun, 'nanoeval-krun'),
        [
          'exec',
          '--socket',
          'vm.sock',
          '--cwd',
          input.cwd,
          ...Object.entries({ HOME: '/root', PATH: path, ...input.env }).flatMap(
            ([name, value]) => ['--env', name + '=' + value],
          ),
          '--',
          'bash',
          '-c',
          command,
        ],
        { cwd: home, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const timer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({
          exitCode: code ?? (signal === 'SIGKILL' ? 137 : 1),
          stderr: Buffer.concat(stderr).toString(),
          stdout: Buffer.concat(stdout).toString(),
        })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input.input)
    })
  const prepared = await exec(
    'mkdir -p ' +
      root +
      " && printf '#!/bin/sh\\nexec /usr/local/bin/node " +
      share +
      '/cli/nanoeval.ts "$@"\\n\' >/usr/local/bin/nanoeval && chmod +x /usr/local/bin/nanoeval',
    { cwd: '/', env: {}, timeoutMs: 60_000 },
  )
  if (prepared.exitCode !== 0) {
    close()
    throw new Error('the guest was not prepared: ' + prepared.stderr)
  }
  return {
    close,
    machine: { exec },
    variables: {
      NANOEVAL_KRUN: inside(tools),
      PATH: (options.node ? Path.posix.dirname(inside(options.node)) + ':' : '') + path,
      ...(bundle
        ? {
            CURL_CA_BUNDLE: inside(Path.join(kept, 'ca.pem')),
            SSL_CERT_FILE: inside(Path.join(kept, 'ca.pem')),
          }
        : {}),
    },
  }
}

export declare namespace start {
  type Options = {
    cpus: number
    forwards: readonly string[]
    home: string
    memoryMb: number
    node?: string
  }
}
