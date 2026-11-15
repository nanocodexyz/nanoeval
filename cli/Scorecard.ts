import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Scorecard from '../src/Scorecard.ts'

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
