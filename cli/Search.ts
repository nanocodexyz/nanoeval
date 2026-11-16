import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import type * as Compare from '../src/Compare.ts'
import * as Overlay from '../src/Overlay.ts'
import * as Promote from '../src/Promote.ts'
import * as Search from '../src/Search.ts'
import { agentText } from './nanoeval.ts'

const usage = `node cli/Search.ts generate --space FILE --parents FILE|DIR... --n N --seed S --gen G --out DIR
            [--seen FILE|DIR]...
            Write one generation of candidate overlays, made by changing one dimension of a
            parent and by crossing pairs of parents, each read as Overlay.parse reads an
            overlay, none the same as a parent or a seen overlay. The same inputs write the
            same candidates.
       node cli/Search.ts plan --stage A|B|C --overlays DIR --baseline FILE [--eval NAME@DIGEST]
            [--only-file FILE] [--attempts N] [--inline] [--cli COMMAND] [--name NAME]
            Print the one nanoeval run that measures the runnable overlays of DIR beside the
            baseline: stage A on cheap10.txt once, stage B on dev44.txt three times, stage C
            on the whole eval three times. --inline names the tasks of the file with --only.
       node cli/Search.ts select --stage A|B --results FILE... --baseline ID|FILE
            [--survivors N] [--overlays DIR --out DIR]
            Score each arm of the results, what a Worker answers for /v1/runs/RUN/results,
            against the baseline arm of its run, and print the survivors: at stage A the
            Pareto front of pass rate and USD a pass filled to N (4 unless given), at stage B
            every win and tie. With --overlays and --out it copies the overlays of the
            baseline and the survivors to DIR, the parents of the next generation.`

async function overlayFiles(paths: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const path of paths) {
    if (!(await Fs.stat(path)).isDirectory()) {
      found.push(path)
      continue
    }
    for (const name of (await Fs.readdir(path)).sort())
      if (name.endsWith('.json')) found.push(Path.join(path, name))
  }
  return found
}

async function readOverlays(
  paths: readonly string[],
): Promise<{ file: string; overlay: Overlay.Overlay }[]> {
  return Promise.all(
    (await overlayFiles(paths)).map(async (file) => {
      try {
        return { file, overlay: Overlay.parse(JSON.parse(await Fs.readFile(file, 'utf8'))) }
      } catch (error) {
        throw new Search.InvalidError(file + ': ' + (error as Error).message)
      }
    }),
  )
}

function quoted(word: string): string {
  return /^[A-Za-z0-9=:@/._,+-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'"
}

function whole(text: string | undefined, name: string): number {
  const value = Number(text)
  if (text === undefined || !Number.isSafeInteger(value) || value < 1)
    throw new Search.InvalidError('--' + name + ' is a whole number of at least 1')
  return value
}

function required(text: string | undefined, name: string): string {
  if (!text) throw new Search.InvalidError('--' + name + ' is required')
  return text
}

async function generate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      gen: { type: 'string' },
      n: { type: 'string' },
      out: { type: 'string' },
      parents: { multiple: true, type: 'string' },
      seed: { type: 'string' },
      seen: { multiple: true, type: 'string' },
      space: { type: 'string' },
    },
  })
  const space = Search.parseSpace(
    JSON.parse(await Fs.readFile(required(values.space, 'space'), 'utf8')),
  )
  const out = required(values.out, 'out')
  const generated = Search.generate(space, {
    gen: whole(values.gen, 'gen'),
    n: whole(values.n, 'n'),
    parents: (await readOverlays(values.parents ?? [])).map((read) => read.overlay),
    seed: required(values.seed, 'seed'),
    seen: (await readOverlays(values.seen ?? [])).map((read) => read.overlay),
  })
  await Fs.mkdir(out, { recursive: true })
  for (const overlay of generated.candidates) {
    await Fs.writeFile(
      Path.join(out, overlay.id + '.json'),
      JSON.stringify(overlay, null, 2) + '\n',
      {
        flag: 'wx',
      },
    )
    console.log(
      (Search.runnable(overlay)
        ? agentText(Overlay.compile(overlay))
        : overlay.id + ' pending ' + JSON.stringify(overlay.pending)) +
        '  # ' +
        overlay.hypothesis,
    )
  }
  console.error(
    generated.candidates.length +
      ' of ' +
      generated.pool +
      ' valid candidates written to ' +
      out +
      ', ' +
      generated.refused.length +
      ' refused',
  )
  for (const refused of generated.refused)
    console.error('refused: ' + refused.hypothesis + ': ' + refused.reason)
}

async function plan(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      attempts: { type: 'string' },
      baseline: { type: 'string' },
      cli: { default: 'node cli/nanoeval.ts', type: 'string' },
      eval: { type: 'string' },
      inline: { default: false, type: 'boolean' },
      name: { type: 'string' },
      'only-file': { type: 'string' },
      overlays: { type: 'string' },
      stage: { type: 'string' },
    },
  })
  const stage = values.stage as Search.Stage
  if (!Object.hasOwn(Search.stages, stage ?? ''))
    throw new Search.InvalidError('--stage is A, B or C')
  const defaults = Search.stages[stage]
  const [baseline] = await readOverlays([required(values.baseline, 'baseline')])
  const overlays = (await readOverlays([required(values.overlays, 'overlays')])).map(
    (read) => read.overlay,
  )
  const members = Search.members(overlays, baseline!.overlay)
  for (const overlay of overlays)
    if (!Search.runnable(overlay))
      console.error(
        'skipped ' +
          overlay.id +
          ': the Worker does not take ' +
          Overlay.pendingKeys(overlay).join(', '),
      )
  if (members.length < 2)
    throw new Search.InvalidError('no runnable overlay to run beside the baseline')
  const onlyFile = values['only-file'] ?? defaults.onlyFile
  const tasks =
    onlyFile && values.inline
      ? (await Fs.readFile(onlyFile, 'utf8'))
          .split('\n')
          .map((line) => line.replace(/#.*/, '').trim())
          .filter(Boolean)
          .flatMap((task) => ['--only', task])
      : onlyFile
        ? ['--only-file', onlyFile]
        : []
  const attempts =
    values.attempts === undefined ? defaults.attempts : whole(values.attempts, 'attempts')
  const words = [
    'run',
    '--eval',
    values.eval ?? defaults.eval,
    ...tasks,
    '--attempts',
    String(attempts),
    ...members.flatMap((overlay) => ['--agent', agentText(Overlay.compile(overlay))]),
    '--name',
    values.name ?? 'b3-' + members[1]!.id.replace(/-[0-9]+$/, '') + '-' + stage,
  ]
  console.log(values.cli + ' ' + words.map(quoted).join(' '))
}

async function select(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      baseline: { type: 'string' },
      out: { type: 'string' },
      overlays: { type: 'string' },
      results: { multiple: true, type: 'string' },
      stage: { type: 'string' },
      survivors: { default: '4', type: 'string' },
    },
  })
  if (values.stage !== 'A' && values.stage !== 'B')
    throw new Search.InvalidError('--stage is A or B')
  if (Boolean(values.out) !== Boolean(values.overlays))
    throw new Search.InvalidError('--out and --overlays go together')
  const named = required(values.baseline, 'baseline')
  const baseline = named.endsWith('.json') ? (await readOverlays([named]))[0]!.overlay.id : named
  const runs = await Promise.all(
    (values.results ?? []).map(
      async (file) => JSON.parse(await Fs.readFile(file, 'utf8')) as Compare.Run,
    ),
  )
  if (!runs.length) throw new Search.InvalidError('--results names at least one results file')
  const cells = Promote.cells(runs, { baseline })
  const chosen = Promote.select(
    cells,
    values.stage === 'A'
      ? { stage: 'A', survivors: whole(values.survivors, 'survivors') }
      : { stage: 'B' },
  )
  console.log(Promote.text(cells))
  console.log('survivors: ' + (chosen.survivors.map((cell) => cell.id).join(' ') || 'none'))
  if (!values.out || !values.overlays) return
  const wanted = new Set([baseline, ...chosen.survivors.map((cell) => cell.id)])
  const found = (await readOverlays([values.overlays])).filter((read) =>
    wanted.has(read.overlay.id),
  )
  const lost = [...wanted].filter((id) => !found.some((read) => read.overlay.id === id))
  if (lost.length)
    throw new Search.InvalidError(values.overlays + ' holds no overlay of ' + lost.join(', '))
  await Fs.mkdir(values.out, { recursive: true })
  for (const read of found)
    await Fs.copyFile(
      read.file,
      Path.join(values.out, read.overlay.id + '.json'),
      Fs.constants.COPYFILE_EXCL,
    )
  console.error(found.length + ' overlays copied to ' + values.out)
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const run =
    command === 'generate'
      ? generate
      : command === 'plan'
        ? plan
        : command === 'select'
          ? select
          : undefined
  if (!run) {
    console.error(usage)
    process.exit(2)
  }
  await run(args).catch((error: unknown) => {
    console.error('search: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  })
}
