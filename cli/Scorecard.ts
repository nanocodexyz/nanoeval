import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import type * as Compare from '../src/Compare.ts'
import * as Scorecard from '../src/Scorecard.ts'
import * as Site from '../src/Site.ts'

export async function exclusion(file: string): Promise<Scorecard.Exclusion> {
  const bytes = await Fs.readFile(file).catch((error: Error) => {
    throw new Error('the list of excluded tasks ' + file + ' cannot be read: ' + error.message)
  })
  const names = bytes
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return {
    digest: Crypto.createHash('sha256').update(bytes).digest('hex'),
    file,
    names: [...new Set(names)],
  }
}

export function whole(value: string | undefined, name: 'draws' | 'seed'): number {
  if (value === undefined) return Scorecard.defaults[name]
  if (!/^\d+$/.test(value)) throw new Error('--' + name + ' is a whole number, not ' + value)
  return Number(value)
}

function quoted(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'"
}

export function command(input: command.Input): string {
  return [
    'nanoeval',
    'scorecard',
    '--url',
    input.url,
    ...input.runs.flatMap((run) => ['--run', run]),
    '--ref',
    input.reference,
    ...(input.exclude ? ['--exclude-tasks', input.exclude] : []),
    '--seed',
    String(input.seed),
    '--draws',
    String(input.draws),
    '--out',
    input.out,
  ]
    .map(quoted)
    .join(' ')
}

export declare namespace command {
  type Input = {
    draws: number
    exclude?: string | undefined
    out: string
    reference: string
    runs: readonly string[]
    seed: number
    url: string
  }
}

export async function write(
  card: Scorecard.Card,
  out: string,
): Promise<{ html: string; json: string }> {
  const files = {
    html: Path.join(out, 'scorecard.html'),
    json: Path.join(out, 'scorecard.json'),
  }
  await Fs.mkdir(out, { recursive: true })
  await Fs.writeFile(files.json, JSON.stringify(card, null, 2) + '\n')
  await Fs.writeFile(files.html, Scorecard.html(card))
  return files
}

export async function site(input: site.Input): Promise<{ index: string; site: Site.Site }> {
  const bytes = await Fs.readFile(input.manifest).catch((error: Error) => {
    throw new Error('the manifest ' + input.manifest + ' cannot be read: ' + error.message)
  })
  const manifest = Site.parse(bytes.toString('utf8'))
  const base = Path.dirname(input.manifest)
  const digest = (held: Uint8Array) => Crypto.createHash('sha256').update(held).digest('hex')
  const inputs = [{ digest: digest(bytes), name: 'manifest.json' }]
  const note = (name: string, held: Uint8Array) => {
    if (!inputs.some((found) => found.name === name)) inputs.push({ digest: digest(held), name })
  }
  const worker = manifest.sections.some((section) =>
    section.inputs.some((source) => source.from === 'worker'),
  )
  const command = [
    'nanoeval',
    'scorecard',
    ...(worker && input.url ? ['--url', input.url] : []),
    '--manifest',
    input.manifest,
    '--site',
    input.out,
  ]
    .map(quoted)
    .join(' ')
  await Fs.mkdir(input.out, { recursive: true })
  const held = new Map<string, Promise<Compare.Run>>()
  const read = (source: Site.Input): Promise<Compare.Run> => {
    const key = source.from + ' ' + source.name
    const found =
      held.get(key) ??
      (async () => {
        if (source.from === 'file') {
          const file = await Fs.readFile(Path.resolve(base, source.name)).catch((error: Error) => {
            throw new Error('the result file ' + source.name + ' cannot be read: ' + error.message)
          })
          return {
            bytes: file,
            name: source.name,
            run: (() => {
              try {
                return JSON.parse(file.toString('utf8')) as Compare.Run
              } catch {
                throw new Error('the result file ' + source.name + ' is not JSON')
              }
            })(),
          }
        }
        if (!input.fetch)
          throw new Error(
            '--url and --token are required: the manifest names the run ' +
              source.name +
              ' of a Worker',
          )
        const run = await input.fetch(source.name)
        const file = Buffer.from(JSON.stringify(run) + '\n')
        const name = 'runs/' + run.id + '.json'
        await Fs.mkdir(Path.join(input.out, 'runs'), { recursive: true })
        await Fs.writeFile(Path.join(input.out, name), file)
        return { bytes: file, name, run }
      })().then((loaded) => {
        note(loaded.name, loaded.bytes)
        return loaded.run
      })
    held.set(key, found)
    return found
  }
  const sections: { card: Scorecard.Card; section: Site.Section }[] = []
  for (const section of manifest.sections) {
    const runs: Scorecard.Run[] = []
    for (const source of section.inputs) runs.push(Site.run(await read(source), source))
    const exclude = await (async (): Promise<Scorecard.Exclusion | undefined> => {
      const given = section.exclude
      if (!given) return undefined
      if ('tasks' in given)
        return {
          digest: digest(Buffer.from(given.tasks.join('\n') + '\n')),
          file: 'manifest.json',
          names: [...new Set(given.tasks)],
          reason: given.reason,
        }
      const file = Path.resolve(base, given.file)
      const listed = await exclusion(file)
      note(given.file, await Fs.readFile(file))
      return { ...listed, file: given.file, reason: given.reason }
    })()
    sections.push({
      card: Site.card(section, {
        command,
        commit: input.commit,
        exclude,
        prices: manifest.prices,
        runs,
      }),
      section,
    })
  }
  const built: Site.Site = { command, commit: input.commit, inputs, manifest, sections }
  for (const found of sections) {
    await Fs.writeFile(
      Path.join(input.out, found.section.id + '.json'),
      JSON.stringify(found.card, null, 2) + '\n',
    )
    await Fs.writeFile(Path.join(input.out, found.section.id + '.html'), Scorecard.html(found.card))
  }
  await Fs.writeFile(Path.join(input.out, 'manifest.json'), bytes)
  await Fs.writeFile(Path.join(input.out, 'inputs.sha256'), Site.digests(inputs))
  const index = Path.join(input.out, 'index.html')
  await Fs.writeFile(index, Site.html(built))
  return { index, site: built }
}

export declare namespace site {
  type Input = {
    commit: string | undefined
    fetch?: ((run: string) => Promise<Compare.Run>) | undefined
    manifest: string
    out: string
    url?: string | undefined
  }
}
