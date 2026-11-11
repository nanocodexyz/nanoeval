import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'

const workspace = Path.resolve(import.meta.dirname, '../krun')
const triple = (process.arch === 'arm64' ? 'aarch64' : 'x86_64') + '-unknown-linux-musl'
const cargo = [Path.join(Os.homedir(), '.cargo/bin/cargo'), 'cargo'].find(
  (program) => spawnSync(program, ['--version']).status === 0,
)

function missing(): string | undefined {
  try {
    Fs.accessSync('/dev/kvm', Fs.constants.R_OK | Fs.constants.W_OK)
  } catch {
    return 'read and write access to /dev/kvm'
  }
  const libraries = spawnSync('ldconfig', ['-p'], {
    env: { PATH: process.env['PATH'] + ':/usr/sbin:/sbin' },
  })
  if (!String(libraries.stdout).includes('libkrunfw.so.5') && !process.env['LD_LIBRARY_PATH'])
    return 'libkrunfw.so.5'
  if (!process.env['NANOEVAL_KRUN'] && !cargo)
    return 'cargo, or NANOEVAL_KRUN with the built launcher'
  return undefined
}

function built(name: string, target?: string): string {
  const prebuilt = process.env['NANOEVAL_KRUN']
  if (prebuilt) return Path.join(prebuilt, name)
  execFileSync(
    cargo!,
    ['build', '--release', '--locked', '-p', name, ...(target ? ['--target', target] : [])],
    { cwd: workspace, stdio: 'ignore' },
  )
  const directory = process.env['CARGO_TARGET_DIR'] ?? Path.join(workspace, 'target')
  return Path.join(directory, target ?? '', 'release', name)
}

test(
  'a Dockerfile becomes a disk without Docker and boots in a microVM',
  { skip: missing() ?? false },
  async () => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-image-'))
    const krun = Path.join(home, 'nanoeval-krun')
    const tools = Path.join(home, 'tools')
    const env = { ...process.env, PATH: tools }
    const run = (...command: string[]) =>
      execFileSync(krun, command, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      Fs.mkdirSync(tools)
      for (const name of ['dev', 'mnt', 'proc', 'sys'])
        Fs.mkdirSync(Path.join(home, 'boot', name), { recursive: true })
      Fs.copyFileSync(built('nanoeval-krun'), krun)
      Fs.copyFileSync(
        built('nanoeval-krun-guest', triple),
        Path.join(home, 'boot/nanoeval-krun-guest'),
      )

      const boots = async (task: string, user: string, command: string): Promise<string> => {
        const name = Path.basename(task)
        const options = ['--size-mb', '256', '--cache', 'cache', '--network', 'host']
        const build = () =>
          JSON.parse(
            run(
              'image',
              'build',
              '--dockerfile',
              Path.resolve(task, 'environment'),
              '--out',
              name + '.ext4',
              '--meta',
              name + '.json',
              ...options,
            ).toString(),
          ) as { bytes_allocated: number; disk: string; image_digest: string; meta: string }
        const first = build()
        assert.equal(first.disk, Path.join(home, name + '.ext4'))
        assert.match(first.image_digest, /^sha256:[0-9a-f]{64}$/)
        assert.equal(build().image_digest, first.image_digest)
        const meta = JSON.parse(Fs.readFileSync(first.meta, 'utf8')) as {
          config: { user: string; working_dir: string }
        }
        assert.deepEqual(
          { user: meta.config.user, working_dir: meta.config.working_dir },
          { user, working_dir: '/app' },
        )

        const upper = Path.join(home, name + '.upper.ext4')
        Fs.writeFileSync(upper, '')
        Fs.truncateSync(upper, 64 * 1024 * 1024)
        execFileSync(
          'mke2fs',
          ['-q', '-t', 'ext4', '-O', '^has_journal', '-E', 'root_owner=0:0', upper],
          { env: { PATH: process.env['PATH'] + ':/usr/sbin:/sbin' } },
        )
        const log = Path.join(home, name + '.log')
        const socket = name + '.sock'
        const output = Fs.openSync(log, 'w')
        const machine = spawn(
          krun,
          ['vm', '--boot', 'boot', '--lower', first.disk, '--upper', upper].concat([
            '--socket',
            socket,
            '--cpus',
            '1',
            '--memory-mib',
            '256',
          ]),
          { cwd: home, env, stdio: ['ignore', output, output] },
        )
        const exited = new Promise<number | null>((resolve) => machine.once('exit', resolve))
        try {
          run('ready', '--log', log, '--pid', String(machine.pid), '--socket', socket)
          return run(
            'exec',
            '--socket',
            socket,
            '--user',
            user,
            '--cwd',
            '/app',
            '--env',
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            '--',
            'sh',
            '-c',
            command,
          ).toString()
        } finally {
          spawnSync(krun, ['stop', '--socket', socket], { cwd: home, env })
          machine.kill('SIGKILL')
          await exited
          Fs.closeSync(output)
        }
      }

      assert.equal(
        await boots(
          'tasks/extract-todos',
          '',
          'cat notes.md; ls -d /lost+found /.dockerenv 2>&1 | wc -l',
        ),
        Fs.readFileSync('tasks/extract-todos/environment/notes.md', 'utf8') + '2\n',
      )
      assert.equal(
        await boots(
          'test/fixtures/plain-user',
          'worker',
          'id -un; pwd; touch /app/mine && stat -c %U /app /app/mine',
        ),
        'worker\n/app\nworker\nworker\n',
      )
    } finally {
      Fs.rmSync(home, { force: true, recursive: true })
    }
  },
)
