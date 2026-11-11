import { execFile } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Zlib from 'node:zlib'
import * as Esbuild from 'esbuild'
import * as Store from '../sandbox/Store.ts'
import * as Bootstrap from '../src/Bootstrap.ts'
import type * as Eval from '../src/Eval.ts'
import * as Slot from '../src/Slot.ts'

export class BuildError extends Error {
  override name = 'Runtime.BuildError'
}

export const binaries = ['nanoeval-krun', 'nanoeval-krun-guest', 'nanoeval-net'] as const

const repository = Path.resolve(import.meta.dirname, '..')
const banner =
  "import { dirname as nanoevalDirname } from 'node:path'\n" +
  "import { fileURLToPath as nanoevalPath } from 'node:url'\n" +
  'const nanoevalDirectory = nanoevalDirname(nanoevalPath(import.meta.url))\n'

function run(command: readonly [program: string, ...rest: string[]], cwd: string): Promise<string> {
  const [program, ...rest] = command
  return new Promise((resolve, reject) => {
    execFile(
      program,
      rest,
      {
        cwd,
        env: {
          ...process.env,
          PATH: process.env['PATH'] + Path.delimiter + Path.join(Os.homedir(), '.cargo', 'bin'),
        },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new BuildError(
              program + ' ' + rest.join(' ') + ' failed: ' + (stderr || stdout).slice(-2000),
            ),
          )
        else resolve(stdout)
      },
    )
  })
}

function targets(arch: string): { hand: string; tools: string } {
  if (arch === 'x64')
    return { hand: 'x86_64-unknown-linux-gnu', tools: 'x86_64-unknown-linux-musl' }
  if (arch === 'arm64')
    return { hand: 'aarch64-unknown-linux-gnu', tools: 'aarch64-unknown-linux-musl' }
  throw new BuildError('the runner runtime has no build for ' + arch)
}

export async function tools(directory: string): Promise<void> {
  const target = targets(process.arch).tools
  const source = Path.join(repository, 'krun')
  for (const build of [
    ['-p', 'nanoeval-krun', '--no-default-features'],
    ['-p', 'nanoeval-krun-guest'],
    ['-p', 'nanoeval-net'],
  ])
    await run(['cargo', 'build', '--release', '--locked', '--target', target, ...build], source)
  const built = Path.join(
    process.env['CARGO_TARGET_DIR'] ?? Path.join(source, 'target'),
    target,
    'release',
  )
  await Fs.mkdir(directory, { recursive: true })
  for (const name of binaries) {
    await Fs.rm(Path.join(directory, name), { force: true })
    await Fs.copyFile(Path.join(built, name), Path.join(directory, name))
  }
}

export async function bundle(file: string): Promise<void> {
  await Esbuild.build({
    banner: { js: banner },
    bundle: true,
    define: { 'import.meta.dirname': 'nanoevalDirectory' },
    entryPoints: [Path.join(repository, 'sandbox', 'Main.ts')],
    format: 'esm',
    logLevel: 'silent',
    outfile: file,
    platform: 'node',
    target: 'node' + Bootstrap.node.major,
  })
}

export async function hand(file: string, cache: string): Promise<void> {
  const packed = Path.join(cache, 'nanocode-' + Slot.runtime.sha256 + '.gz')
  const present = await Fs.stat(packed).then(
    () => true,
    () => false,
  )
  if (!present) {
    const response = await fetch(
      Slot.runtime.release + '/nanocode-' + targets(process.arch).hand + '.gz',
    )
    if (!response.ok) throw new BuildError('the hand release answered ' + response.status)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (Crypto.createHash('sha256').update(bytes).digest('hex') !== Slot.runtime.sha256)
      throw new BuildError('the hand release does not match its pinned checksum')
    await Fs.mkdir(cache, { recursive: true })
    await Fs.writeFile(packed + '.' + process.pid, bytes)
    await Fs.rename(packed + '.' + process.pid, packed)
  }
  await Fs.writeFile(file, Zlib.gunzipSync(await Fs.readFile(packed)), { mode: 0o755 })
}

export async function build(options: build.Options): Promise<Eval.Blob & { file: string }> {
  const staging = options.out + '.staging'
  await Fs.rm(staging, { force: true, recursive: true })
  await Fs.mkdir(staging, { recursive: true })
  if (options.tools) {
    await Fs.mkdir(Path.join(staging, Bootstrap.files.tools))
    for (const name of binaries)
      await Fs.copyFile(
        Path.join(options.tools, name),
        Path.join(staging, Bootstrap.files.tools, name),
      )
  } else await tools(Path.join(staging, Bootstrap.files.tools))
  await bundle(Path.join(staging, Bootstrap.files.runner))
  await Fs.copyFile(Path.join(repository, 'sandbox', 'slot.sh'), Path.join(staging, 'slot.sh'))
  await hand(Path.join(staging, Bootstrap.files.hand), options.cache)
  await run(
    [
      'bash',
      '-c',
      'tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C "$1" . | gzip -n >"$2"',
      'bash',
      staging,
      options.out,
    ],
    repository,
  )
  await Fs.rm(staging, { force: true, recursive: true })
  return { ...(await Store.digest(options.out)), file: options.out }
}

export declare namespace build {
  type Options = {
    cache: string
    out: string
    tools?: string
  }
}

export async function publish(store: Store.Store, options: build.Options): Promise<Eval.Blob> {
  const built = await build(options)
  if (!(await store.has(built.digest))) await store.put(built.digest, built.file)
  return { bytes: built.bytes, digest: built.digest }
}
