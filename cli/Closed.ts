import { execFile } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Toml from 'smol-toml'
import * as Dataset from '../datasets/Dataset.ts'
import * as Source from '../datasets/Source.ts'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Tar from '../src/Tar.ts'

export class GitError extends Error {
  override name = 'Closed.GitError'
}

export class UnsupportedError extends Error {
  override name = 'Closed.UnsupportedError'
}

export type Gold = {
  absent: readonly { blob: string; path: string; size: number }[]
  files: readonly { base: string | null; data: Uint8Array; executable: boolean; path: string }[]
}

export type Options = { remote(repository: string): string; root: string }

export type Plan = { base: string; fix: string; paths: readonly string[]; repository: string }

type Entry = { blob: string; mode: string; path: string; size: number; type: string }

export const recipe = 'gold-tests-1'

const checkoutEnd =
  'if [ -n "$GOLD_CHECKOUT" ]; then\n' +
  '    echo "Running gold tests checkout: $GOLD_CHECKOUT"\n' +
  '    eval "$GOLD_CHECKOUT" || { echo "ERROR: Gold tests checkout failed"; exit 1; }\n' +
  'fi\n'
const checkoutStart = '# Run the last line of before_repo_set_cmd to checkout gold test files\n'
const check =
  'COPY closed-check.py closed-check.json /tmp/\n' +
  'RUN python3 /tmp/closed-check.py /tmp/closed-check.json / && rm -f /tmp/closed-check.py /tmp/closed-check.json\n'
const place =
  'python3 /tests/closed-place.py /tests /logs/verifier || { echo "ERROR: Gold tests placement failed"; exit 1; }\n'
const reinit =
  'RUN set -e && git ls-files -z > /tmp/closed-tracked' +
  ' && git ls-files -s | awk \'$1 == "160000"\' | cut -f2- | while IFS= read -r p; do rm -rf "$p/.git"; done' +
  ' && rm -rf .git && git init -q . && xargs -0 -r git add -f -- < /tmp/closed-tracked && rm -f /tmp/closed-tracked' +
  " && GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z'" +
  ' git -c user.name=base -c user.email=base@localhost -c commit.gpgsign=false commit -q --no-verify -m base' +
  ' && [ "$(git rev-list --all | wc -l)" -eq 1 ]' +
  ' && [ "$(git cat-file --batch-all-objects --batch-check | wc -l)" -eq "$(git rev-list --objects --all | wc -l)" ]'

export function github(repository: string): string {
  return 'https://github.com/' + repository + '.git'
}

function git(directory: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', directory, ...args],
      { encoding: 'buffer', maxBuffer: Number.POSITIVE_INFINITY },
      (error, stdout, stderr) => {
        if (error) reject(new GitError('git ' + args.join(' ') + ' failed: ' + stderr.toString()))
        else resolve(stdout)
      },
    )
  })
}

async function tree(directory: string, commit: string): Promise<Entry[]> {
  const listing = await git(directory, ['ls-tree', '-r', '-l', '-z', commit])
  return listing
    .toString()
    .split('\0')
    .filter((line) => line)
    .map((line) => {
      const tab = line.indexOf('\t')
      const [mode, type, blob, size] = line.slice(0, tab).split(/ +/) as [
        string,
        string,
        string,
        string,
      ]
      return { blob, mode, path: line.slice(tab + 1), size: Number(size), type }
    })
}

export function plan(item: Dataset.Case): Plan {
  const config = item.files['tests/config.json']
  if (!config) throw new UnsupportedError('a closed import needs tests/config.json')
  const value = JSON.parse(Bytes.toText(config)) as Record<string, unknown>
  const base = value['base_commit']
  const repository = value['repo']
  const commands = value['before_repo_set_cmd']
  if (typeof base !== 'string' || !/^[0-9a-f]{40}$/.test(base))
    throw new UnsupportedError('tests/config.json has no base_commit')
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new UnsupportedError('tests/config.json has no repo')
  const last = typeof commands === 'string' ? commands.trim().split('\n').at(-1)! : ''
  const checkout = /^git checkout ([0-9a-f]{40}) -- ([^"'\\$`]+)$/.exec(last)
  if (!checkout)
    throw new UnsupportedError(
      'the last line of before_repo_set_cmd is not git checkout COMMIT -- PATHS',
    )
  const paths = checkout[2]!.split(/\s+/).filter((path) => path)
  for (const path of paths)
    if (path.startsWith('/') || path.startsWith('-') || path.split('/').includes('..'))
      throw new UnsupportedError('the test path ' + path + ' leaves the repository')
  return { base, fix: checkout[1]!, paths, repository }
}

export async function gold(plan: Plan, options: Options): Promise<Gold> {
  await Fs.mkdir(options.root, { recursive: true })
  const directory = await Fs.mkdtemp(Path.join(options.root, 'gold-'))
  try {
    await git(directory, ['init', '-q', '--bare'])
    await git(directory, [
      'fetch',
      '-q',
      '--depth',
      '1',
      '--no-tags',
      options.remote(plan.repository),
      plan.base,
      plan.fix,
    ])
    const base = await tree(directory, plan.base)
    const fix = await tree(directory, plan.fix)
    const before = new Map(base.map((entry) => [entry.path, entry.blob]))
    const known = new Set(base.map((entry) => entry.blob))
    const tests = fix.filter((entry) =>
      plan.paths.some(
        (path) => entry.path === path || entry.path.startsWith(path.replace(/\/+$/, '') + '/'),
      ),
    )
    for (const path of plan.paths)
      if (
        !tests.some(
          (entry) => entry.path === path || entry.path.startsWith(path.replace(/\/+$/, '') + '/'),
        )
      )
        throw new UnsupportedError('the fix commit has no file at the test path ' + path)

    const files: Gold['files'][number][] = []
    for (const entry of tests) {
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755'))
        throw new UnsupportedError('the test path ' + entry.path + ' is not a regular file')
      files.push({
        base: before.get(entry.path) ?? null,
        data: new Uint8Array(await git(directory, ['cat-file', 'blob', entry.blob])),
        executable: entry.mode === '100755',
        path: entry.path,
      })
    }

    const absent = new Map<string, Gold['absent'][number]>()
    for (const entry of fix)
      if (entry.type === 'blob' && entry.size > 0 && !known.has(entry.blob))
        absent.set(entry.blob, { blob: entry.blob, path: entry.path, size: entry.size })
    return { absent: [...absent.values()], files }
  } finally {
    await Fs.rm(directory, { force: true, recursive: true })
  }
}

export function apply(item: Dataset.Case, input: apply.Input): Dataset.Case {
  const manifest = item.files['task.toml']
  const dockerfile = item.files['environment/Dockerfile']
  const script = item.files['tests/test.sh']
  if (!manifest || !dockerfile || !script)
    throw new UnsupportedError(
      'a closed import needs task.toml, environment/Dockerfile and tests/test.sh',
    )

  const task = Toml.parse(Bytes.toText(manifest)) as Record<string, unknown>
  const agent = { ...(task['agent'] as Record<string, unknown> | undefined) }
  if (agent['allowed_hosts'] !== undefined)
    throw new UnsupportedError('the task gives its agent a network allowlist')

  const lines = Bytes.toText(dockerfile).split('\n')
  const resets = lines.flatMap((line, index) =>
    /^RUN\s/.test(line) && line.includes('git reset --hard ' + input.plan.base) ? [index] : [],
  )
  if (resets.length !== 1)
    throw new UnsupportedError(
      'environment/Dockerfile has ' + resets.length + ' steps that reset to the base commit',
    )
  lines.splice(resets[0]! + 1, 0, reinit)

  const text = Bytes.toText(script)
  const start = text.indexOf(checkoutStart)
  const end = text.indexOf(checkoutEnd)
  if (start === -1 || end < start)
    throw new UnsupportedError('tests/test.sh has no checkout of the gold test files')

  return {
    ...item,
    files: {
      ...item.files,
      'environment/closed-check.json': Dataset.json({
        blobs: input.gold.absent,
        fix: input.plan.fix,
      }),
      'environment/closed-check.py': input.assets['check.py']!,
      'environment/Dockerfile': Bytes.fromText(lines.join('\n').replace(/\n*$/, '\n') + check),
      'task.toml': Dataset.toml({ ...task, agent: { ...agent, network_mode: 'no-network' } }),
      'tests/closed-place.py': input.assets['place.py']!,
      'tests/gold-manifest.json': Dataset.json({
        base: input.plan.base,
        files: input.gold.files.map((file) => ({
          base: file.base,
          executable: file.executable,
          path: file.path,
          sha256: Source.sha256(file.data),
        })),
        fix: input.plan.fix,
        repository: input.plan.repository,
      }),
      'tests/gold.tar': Tar.pack(input.gold.files),
      'tests/test.sh': Bytes.fromText(
        text.slice(0, start) + place + text.slice(end + checkoutEnd.length),
      ),
    },
  }
}

export declare namespace apply {
  type Input = { assets: Record<string, Uint8Array>; gold: Gold; plan: Plan }
}

export async function close(item: Dataset.Case, options: Options): Promise<Dataset.Case> {
  const found = plan(item)
  return apply(item, {
    assets: await Dataset.assets('closed'),
    gold: await gold(found, options),
    plan: found,
  })
}

export async function* cases(
  source: AsyncIterable<Dataset.Case>,
  options: Options,
): AsyncIterable<Dataset.Case> {
  for await (const item of source)
    yield await close(item, options).catch((error: Error) => {
      error.message = item.id + ': ' + error.message
      throw error
    })
}
