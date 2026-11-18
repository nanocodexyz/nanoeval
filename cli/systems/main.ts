import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import * as Compare from './Compare.ts'
import * as Report from './Report.ts'
import * as Runner from './Runner.ts'
import * as Stats from './Stats.ts'
import * as Suite from './Suite.ts'
import * as Target from './Target.ts'

export const usage = `nanoeval systems: latency, throughput and robustness of nanocode builds on one or more targets

  nanoeval systems run --suite <dir|name> --target <name>[,<name>] --build <label>=<path|version|url> [--build ...]
      [--scenario a,b] [--concurrency 1,10] [--reps N] [--preset a,b | --model M] [--thinking T] [--out DIR] [--strict]
    Runs every scenario of the suite (a directory with suite.json, or a name under NANOEVAL_SUITES) on every
    target and build, builds interleaved per repetition, and writes run.json, summary.md and samples/ under
    output/systems/<UTC timestamp>/. A suite's model matrix (defaults.matrix of its presets) runs each preset
    into its own subdirectory, with a summary.md of all of them; --preset picks presets, --model runs one
    model instead. --strict exits 1 when a scenario misses an SLO.
    Builds: a path is a nanocode binary, a URL is downloaded, anything else is a nanocode-cli release version
    (such as 23e21f8952f8, or latest).

  nanoeval systems compare <run-dir> [<run-dir>] [--base <label>] [--head <label>] [--draws 4000] [--seed 1] [--out DIR] [--json]
    Ratios head/base per scenario, concurrency and metric with a 95 % clustered-bootstrap interval and
    WIN/TIE/LOSS, client signals first and what includes model work apart. Model-matrix directories compare
    preset by preset. Writes compare.md and compare.json to --out (default: the last run directory).

  nanoeval systems targets
    Lists the built-in targets; any other name loads cli/systems/targets/<name>.ts.
`

export const builtins = ['cli-local', 'fake']

export async function target(name: string): Promise<Target.Target> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    throw new Target.InvalidError('no target ' + JSON.stringify(name))
  const module = (await import('./targets/' + name + '.ts').catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND')
      throw new Target.InvalidError('no target ' + name + ' (cli/systems/targets/' + name + '.ts)')
    throw error
  })) as { default?: Target.Target }
  if (!module.default?.open)
    throw new Target.InvalidError('cli/systems/targets/' + name + '.ts exports no Target')
  return module.default
}

function list(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((item) =>
    item
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )
}

function whole(value: string | undefined, what: string): number | undefined {
  if (value === undefined) return undefined
  const found = Number(value)
  if (!Number.isInteger(found) || found < 0)
    throw new Target.InvalidError(what + ' is a whole number, not ' + value)
  return found
}

export async function main(
  argv: readonly string[],
  print = (line: string) => console.log(line),
): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    print(usage)
    return 0
  }
  if (command === 'targets') {
    print(builtins.join('\n'))
    return 0
  }
  if (command === 'run') {
    const { values } = parseArgs({
      args: [...rest],
      options: {
        build: { multiple: true, type: 'string' },
        concurrency: { type: 'string' },
        model: { type: 'string' },
        out: { type: 'string' },
        preset: { type: 'string' },
        quiet: { type: 'boolean' },
        reps: { type: 'string' },
        scenario: { type: 'string' },
        strict: { type: 'boolean' },
        suite: { type: 'string' },
        target: { multiple: true, type: 'string' },
        thinking: { type: 'string' },
      },
      strict: true,
    })
    if (!values.suite) throw new Target.InvalidError('systems run needs --suite')
    if (values.model && values.preset)
      throw new Target.InvalidError('systems run takes --model or --preset, not both')
    const builds = list(values.build).map(Target.build)
    if (!builds.length)
      throw new Target.InvalidError('systems run needs --build label=<path|version|url>')
    const names = list(values.target)
    if (!names.length) throw new Target.InvalidError('systems run needs --target')
    const targets = await Promise.all(names.map(target))
    let suite = Suite.pick(
      await Suite.load(values.suite),
      list(values.scenario),
      list(values.concurrency).map((level) => whole(level, 'a concurrency')!),
    )
    const reps = whole(values.reps, '--reps')
    if (reps)
      suite = { ...suite, scenarios: suite.scenarios.map((scenario) => ({ ...scenario, reps })) }
    if (!suite.scenarios.length) throw new Target.InvalidError('no scenario is left to run')
    const thinking = values.thinking ? { thinking: values.thinking } : {}
    const chosen: Suite.Preset[] = values.model
      ? [
          {
            model: values.model,
            name: (values.model + (values.thinking ? '-' + values.thinking : ''))
              .toLowerCase()
              .replace(/[^a-z0-9.-]/g, '-'),
            ...thinking,
          },
        ]
      : Suite.presets(suite, list(values.preset).length ? list(values.preset) : suite.matrix).map(
          (preset) => ({ ...preset, ...thinking }),
        )
    if (!chosen.length && values.thinking)
      suite = {
        ...suite,
        scenarios: suite.scenarios.map((scenario) => ({ ...scenario, thinking: values.thinking! })),
      }
    const root = values.out ?? Path.join('output', 'systems', Runner.stamp())
    const index: { dir: string; preset?: Suite.Preset; run: Runner.Run }[] = []
    for (const preset of chosen.length ? chosen : [undefined]) {
      const { dir, run } = await Runner.run({
        builds,
        command: 'nanoeval systems ' + argv.join(' '),
        log: values.quiet ? undefined : (line) => print((preset ? preset.name + ' ' : '') + line),
        out: preset ? Path.join(root, preset.name) : root,
        ...(preset ? { preset } : {}),
        suite: preset ? Suite.preset(suite, preset) : suite,
        targets,
      })
      index.push({ dir, ...(preset ? { preset } : {}), run })
      const failed = run.verdicts.filter((verdict) => !verdict.passed)
      print(
        'systems run ' +
          run.id +
          (preset ? ' ' + preset.name : '') +
          ': ' +
          (run.verdicts.length - failed.length) +
          '/' +
          run.verdicts.length +
          ' scenario runs met their SLOs; ' +
          Path.join(dir, 'summary.md'),
      )
    }
    if (chosen.length) {
      await Fs.writeFile(Path.join(root, 'summary.md'), Report.matrix(index))
      print('systems matrix: ' + Path.join(Path.resolve(root), 'summary.md'))
    }
    const missed = index.some(({ run }) => run.verdicts.some((verdict) => !verdict.passed))
    return values.strict && missed ? 1 : 0
  }
  if (command === 'compare') {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: [...rest],
      options: {
        base: { type: 'string' },
        draws: { type: 'string' },
        head: { type: 'string' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        seed: { type: 'string' },
      },
      strict: true,
    })
    if (!positionals.length || positionals.length > 2)
      throw new Target.InvalidError('systems compare takes one or two run directories')
    const options = {
      draws: whole(values.draws, '--draws') ?? Stats.defaults.draws,
      seed: whole(values.seed, '--seed') ?? Stats.defaults.seed,
    }
    const wanted = {
      ...(values.base ? { base: values.base } : {}),
      ...(values.head ? { head: values.head } : {}),
    }
    const layouts = await Promise.all(positionals.map(Compare.layout))
    const presets = layouts.every((layout) => layout)
      ? Object.keys(layouts[0]!).filter((name) => layouts.every((layout) => layout![name]))
      : []
    if (layouts.some((layout) => layout) && !presets.length)
      throw new Target.InvalidError(
        'compare takes run directories, or model-matrix directories that share a preset',
      )
    const results: Compare.Result[] = []
    for (const preset of presets.length ? presets : [undefined]) {
      const runs = await Promise.all(
        positionals.map((dir, at) => Compare.read(preset ? layouts[at]![preset]! : dir)),
      )
      const picked = Compare.arms(runs, wanted)
      results.push(Compare.compare(picked.base, picked.head, options))
    }
    const out = values.out ?? positionals.at(-1)!.replace(/\/run\.json$/, '')
    await Fs.mkdir(out, { recursive: true })
    const markdown = results.map(Compare.markdown).join('\n')
    const json = presets.length
      ? Object.fromEntries(results.map((result, at) => [presets[at]!, result]))
      : results[0]
    await Fs.writeFile(Path.join(out, 'compare.md'), markdown)
    await Fs.writeFile(Path.join(out, 'compare.json'), JSON.stringify(json, null, 2) + '\n')
    print(values.json ? JSON.stringify(json, null, 2) : markdown)
    return 0
  }
  throw new Target.InvalidError('no systems command ' + command + '\n\n' + usage)
}
