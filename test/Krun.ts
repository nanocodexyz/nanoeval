import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'

export function machines(root: string): string[] {
  return spawnSync('ps', ['-eo', 'args='])
    .stdout.toString()
    .split('\n')
    .filter(
      (line) => line.startsWith(root + Path.sep) && line.includes('/rt/krun/nanoeval-krun vm '),
    )
}

export function missing(network: 'host' | 'private' = 'host'): string | undefined {
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
  if (spawnSync('docker', ['info']).status !== 0) return 'a working Docker daemon'
  const cargo =
    spawnSync('cargo', ['--version']).status === 0 ||
    Fs.existsSync(Path.join(Os.homedir(), '.cargo/bin/cargo'))
  if (!process.env['NANOEVAL_KRUN'] && !cargo)
    return 'cargo, or NANOEVAL_KRUN with the built launcher'
  if (network === 'private' && spawnSync('passt', ['--version']).error) return 'passt'
  return undefined
}

export function sizes(root: string): string[] {
  return machines(root).flatMap((line) => {
    const size = / --cpus (\d+) --memory-mib (\d+) --lower /.exec(line)
    return size ? [size[1] + ' ' + size[2]] : []
  })
}
