import * as Child from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import type * as Atif from '../src/Atif.ts'
import * as Mine from '../src/Mine.ts'
import type * as Result from '../src/Result.ts'

export const usage = `mine-failures --runs ID[,ID...] [--agents REGEX] [--out DIR] [--classify heuristic|codex]
  [--codex-model MODEL] [--concurrency N] [--examples N] [--excerpt CHARS] [--tail LINES] [--offline]

Pull every failed attempt of the agents --agents matches (^nano by default) from the runs, pair
each with a passing attempt of another agent on the same task (the same run first, then the
other runs), summarize both trajectories and verifier output, put each failure in one class,
and write report.md, report.json and cases.json under --out (output/mine by default). A run is
named by its id or a unique prefix of it. Everything fetched is kept under --out/cache, and
--offline reads only that. --classify codex asks codex exec, signed in as its user, for each
class instead of the heuristic, and keeps the heuristic scores beside its answer. NANOEVAL_URL
and NANOEVAL_TOKEN name the Worker.`

export class UsageError extends Error {
  override name = 'MineFailures.UsageError'
}

export class FetchError extends Error {
  override name = 'MineFailures.FetchError'
}

type Options = {
  cache: string
  offline: boolean
  token: string
  url: string
}

type Located = Result.Attempt & { run: string }

async function cached(options: Options, file: string, path: string): Promise<string | null> {
  const target = Path.join(options.cache, file)
  const absent = target + '.absent'
  const hit = await Fs.readFile(target, 'utf8').catch(() => undefined)
  if (hit !== undefined) return hit
  if (
    await Fs.access(absent).then(
      () => true,
      () => false,
    )
  )
    return null
  if (options.offline) throw new FetchError('--offline and the cache has no ' + target)
  const response = await fetch(options.url + path, {
    headers: { authorization: 'Bearer ' + options.token },
  })
  await Fs.mkdir(Path.dirname(target), { recursive: true })
  if (response.status === 404) {
    await Fs.writeFile(absent, '')
    return null
  }
  if (!response.ok)
    throw new FetchError(
      'GET ' + path + ' answered ' + response.status + ': ' + (await response.text()).slice(0, 300),
    )
  const body = await response.text()
  await Fs.writeFile(target, body)
  return body
}

async function resolve(options: Options, given: readonly string[]): Promise<string[]> {
  if (given.every((id) => /^[0-9a-f-]{36}$/.test(id))) return [...given]
  const listed = await cached(options, 'runs.json', '/v1/runs')
  if (listed === null) throw new FetchError('GET /v1/runs answered 404')
  const ids = (JSON.parse(listed) as { runs: { id: string }[] }).runs.map((run) => run.id)
  return given.map((prefix) => {
    const found = ids.filter((id) => id.startsWith(prefix))
    if (found.length !== 1)
      throw new UsageError(
        'the run prefix ' +
          prefix +
          ' matches ' +
          found.length +
          ' runs' +
          (found.length ? ': ' + found.join(', ') : ''),
      )
    return found[0]!
  })
}

async function attempts(options: Options, run: string): Promise<Located[]> {
  const body = await cached(options, Path.join(run, 'results.json'), '/v1/runs/' + run + '/results')
  if (body === null) throw new FetchError('the run ' + run + ' has no results')
  return (JSON.parse(body) as { attempts: Result.Attempt[] }).attempts.map((attempt) => ({
    ...attempt,
    run,
  }))
}

async function artifact(options: Options, attempt: Located, name: string): Promise<string | null> {
  return cached(
    options,
    Path.join(attempt.run, attempt.id, name),
    '/v1/runs/' +
      attempt.run +
      '/attempts/' +
      attempt.id +
      '/artifacts/' +
      encodeURIComponent(name),
  )
}

async function side(
  options: Options,
  attempt: Located,
  input: { excerpt: number; tail: number },
): Promise<Mine.Side> {
  const [trajectory, verifier] = await Promise.all([
    artifact(options, attempt, 'agent/trajectory.json'),
    artifact(options, attempt, 'verifier/test-stdout.txt'),
  ])
  const phase = attempt.timing.agentExecution
  return {
    agent: attempt.agent.id,
    attempt: attempt.id,
    durationSec: phase ? (phase.finishedAt - phase.startedAt) / 1000 : null,
    failure: attempt.failure ?? null,
    outcome: attempt.outcome,
    run: attempt.run,
    summary:
      trajectory === null
        ? null
        : Mine.summarize(JSON.parse(trajectory) as Atif.Trajectory, input.excerpt),
    verifierTail:
      verifier === null ? '' : verifier.trimEnd().split('\n').slice(-input.tail).join('\n'),
  }
}

async function pool<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await work(items[index]!)
      }
    }),
  )
  return results
}

async function codex(
  entry: Mine.Case,
  verdict: Mine.Verdict,
  model: string | undefined,
): Promise<Mine.Verdict> {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'mine-'))
  const last = Path.join(directory, 'answer.txt')
  try {
    await new Promise<void>((done, fail) => {
      const child = Child.spawn(
        'codex',
        [
          'exec',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--output-last-message',
          last,
          ...(model ? ['--model', model] : []),
          '-',
        ],
        { cwd: directory, stdio: ['pipe', 'ignore', 'pipe'] },
      )
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', fail)
      child.on('close', (code) =>
        code === 0
          ? done()
          : fail(
              new FetchError(
                'codex exec exited with ' +
                  code +
                  ': ' +
                  stderr.trim().split('\n').slice(-3).join(' '),
              ),
            ),
      )
      child.stdin.end(Mine.prompt(entry))
    })
    return Mine.answer(await Fs.readFile(last, 'utf8'), verdict)
  } finally {
    await Fs.rm(directory, { force: true, recursive: true })
  }
}

function count(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new UsageError('--' + name + ' is a number above zero, not ' + value)
  return Number(value)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agents: { default: '^nano', type: 'string' },
      classify: { default: 'heuristic', type: 'string' },
      'codex-model': { type: 'string' },
      concurrency: { default: '4', type: 'string' },
      examples: { default: '5', type: 'string' },
      excerpt: { default: '160', type: 'string' },
      help: { type: 'boolean' },
      offline: { type: 'boolean' },
      out: { default: 'output/mine', type: 'string' },
      runs: { type: 'string' },
      tail: { default: '20', type: 'string' },
      token: { default: process.env['NANOEVAL_TOKEN'], type: 'string' },
      url: { default: process.env['NANOEVAL_URL'], type: 'string' },
    },
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (!values.runs) throw new UsageError('--runs is required\n\n' + usage)
  if (values.classify !== 'heuristic' && values.classify !== 'codex')
    throw new UsageError('--classify is heuristic or codex, not ' + values.classify)
  if (!values.offline && (!values.url || !values.token))
    throw new UsageError(
      'NANOEVAL_URL and NANOEVAL_TOKEN (or --url and --token) name the Worker, unless --offline',
    )
  const options: Options = {
    cache: Path.join(values.out, 'cache'),
    offline: values.offline ?? false,
    token: values.token ?? '',
    url: (values.url ?? '').replace(/\/+$/, ''),
  }
  const concurrency = count(values.concurrency, 'concurrency')
  const shape = { excerpt: count(values.excerpt, 'excerpt'), tail: count(values.tail, 'tail') }
  const runs = await resolve(
    options,
    values.runs
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
  const all = (await Promise.all(runs.map((run) => attempts(options, run)))).flat()
  const pairs = Mine.pair(all, new RegExp(values.agents))
  console.error(
    all.length +
      ' attempts in ' +
      runs.length +
      ' runs, ' +
      pairs.length +
      ' failures of ' +
      values.agents,
  )
  const cases = await pool(
    pairs,
    concurrency,
    async (found): Promise<Mine.Case> => ({
      competitor: found.competitor ? await side(options, found.competitor, shape) : null,
      failed: await side(options, found.failed, shape),
      task: found.failed.task.name,
    }),
  )
  const llmErrors: { attempt: string; error: string; run: string }[] = []
  const classified = await pool(cases, concurrency, async (entry): Promise<Mine.Classified> => {
    const verdict = Mine.classify(entry)
    if (values.classify === 'heuristic') return { ...entry, verdict }
    try {
      return { ...entry, verdict: await codex(entry, verdict, values['codex-model']) }
    } catch (error) {
      llmErrors.push({ attempt: entry.failed.attempt, error: String(error), run: entry.failed.run })
      console.error(
        'codex could not classify ' +
          entry.failed.run +
          '/' +
          entry.failed.attempt +
          ': ' +
          String(error),
      )
      return { ...entry, verdict }
    }
  })
  const value = Mine.report(classified, { examples: count(values.examples, 'examples'), runs })
  await Fs.mkdir(values.out, { recursive: true })
  await Promise.all([
    Fs.writeFile(Path.join(values.out, 'report.md'), Mine.markdown(value)),
    Fs.writeFile(
      Path.join(values.out, 'report.json'),
      JSON.stringify({ ...value, llmErrors }, null, 2) + '\n',
    ),
    Fs.writeFile(Path.join(values.out, 'cases.json'), JSON.stringify(classified, null, 2) + '\n'),
  ])
  console.error(
    'wrote ' +
      Path.join(values.out, 'report.md') +
      (llmErrors.length
        ? ', ' + llmErrors.length + ' kept the heuristic class because codex failed'
        : ''),
  )
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error('mine-failures: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  })
