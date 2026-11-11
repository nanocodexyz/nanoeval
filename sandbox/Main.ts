import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import type * as Config from '../src/Config.ts'
import * as Runner from './Runner.ts'
import * as Store from './Store.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    cache: { type: 'string' },
    config: { type: 'string' },
    detach: { default: false, type: 'boolean' },
    store: { type: 'string' },
  },
})
if (positionals[0] !== 'runner' || !values.config) {
  console.error('usage: runner --config FILE [--detach] [--cache DIR] [--store DIR]')
  process.exit(2)
}
const file = Path.resolve(values.config)
const home = Path.dirname(file)
if (values.detach) {
  const pid = await Runner.detach({
    arguments: [
      process.argv[1]!,
      'runner',
      '--config',
      file,
      ...(values.cache ? ['--cache', values.cache] : []),
      ...(values.store ? ['--store', values.store] : []),
    ],
    home,
  })
  console.log('runner started as process ' + pid)
} else {
  process.chdir(home)
  await Runner.run({
    cache: Path.resolve(values.cache ?? Store.defaultCache()),
    config: JSON.parse(await Fs.readFile(file, 'utf8')) as Config.Runner,
    home,
    ...(values.store ? { store: Path.resolve(values.store) } : {}),
  })
  process.exit(0)
}
