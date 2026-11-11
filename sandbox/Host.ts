import * as Fs from 'node:fs'
import * as FsPromises from 'node:fs/promises'
import * as Path from 'node:path'
import type * as Eval from '../src/Eval.ts'

const krun = Path.resolve(import.meta.dirname, '../krun')

export function environment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...(!base['NANOEVAL_KRUN'] && !base['NANOEVAL_KRUN_SOURCE'] && Fs.existsSync(krun)
      ? { NANOEVAL_KRUN_SOURCE: krun }
      : {}),
    ...base,
  }
}

export async function describe(prefix: string, meta: Eval.Meta): Promise<void> {
  await FsPromises.writeFile(prefix + '.env', meta.env.map((line) => line + '\n').join(''))
  await FsPromises.writeFile(prefix + '.user', meta.user + '\n')
  await FsPromises.writeFile(prefix + '.workdir', meta.workdir + '\n')
}
