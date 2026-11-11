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

let writes = 0

async function replace(file: string, content: string): Promise<void> {
  const temporary = file + '.' + process.pid + '.' + ++writes
  await FsPromises.writeFile(temporary, content)
  await FsPromises.rename(temporary, file)
}

export async function describe(prefix: string, meta: Eval.Meta): Promise<void> {
  await replace(prefix + '.env', meta.env.map((line) => line + '\n').join(''))
  await replace(prefix + '.user', meta.user + '\n')
  await replace(prefix + '.workdir', meta.workdir + '\n')
}
