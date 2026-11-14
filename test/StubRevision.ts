import { spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import type * as Atif from '../src/Atif.ts'
import * as Harbor from '../src/Harbor.ts'
import type * as Result from '../src/Result.ts'

export type Scenario = {
  buildMs?: number
  builds?: Record<string, 'fail'>
  credential?: 'expired' | 'missing'
  hold?: Record<string, number>
  ignoreOut?: boolean
  outcomes?: Record<string, Record<string, string>>
  tasks?: string[]
  unpriced?: boolean
}

async function hold(lab: string): Promise<void> {
  const take = (wait: boolean) => {
    const child = spawn(
      'flock',
      [...(wait ? [] : ['--nonblock']), Path.join(lab, 'lock'), 'sh', '-c', 'echo held; exec cat'],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    )
    return Promise.race([
      new Promise<boolean>((done) => child.stdout!.once('data', () => done(true))),
      new Promise<boolean>((done) => child.once('exit', () => done(false))),
    ])
  }
  if (await take(false)) return
  console.error('another evaluation holds the lock of ' + lab + ': waiting for it')
  if (!(await take(true))) throw new Error('the lock of ' + lab + ' could not be taken')
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      agent: { multiple: true, type: 'string' },
      attempts: { default: '1', type: 'string' },
      'build-only': { default: false, type: 'boolean' },
      eval: { type: 'string' },
      lab: { default: process.env['NANOEVAL_LAB'], type: 'string' },
      'model-budget-usd': { type: 'string' },
      name: { type: 'string' },
      nanocode: { default: 'pinned', type: 'string' },
      'nanocode-repository': { type: 'string' },
      'nanocode-ts': { default: 'master', type: 'string' },
      'nanocode-ts-repository': { type: 'string' },
      only: { multiple: true, type: 'string' },
      out: { type: 'string' },
      slots: { type: 'string' },
    },
    strict: false,
  })
  const lab = String(values.lab)
  Fs.mkdirSync(lab, { recursive: true })
  const scenario = JSON.parse(Fs.readFileSync(Path.join(lab, 'stub.json'), 'utf8')) as Scenario

  await hold(lab)
  Fs.appendFileSync(Path.join(lab, 'stub-calls.jsonl'), JSON.stringify(argv) + '\n')
  const nanocode = String(values.nanocode)
  const nanocodeTs = String(values['nanocode-ts'])
  const agents = ((values.agent ?? []) as string[]).map((text) => {
    const [id, provider, model] = text.split(/[=:]/)
    return { id: id!, model: model!, provider: provider as 'claude' | 'codex' }
  })
  if (!values['build-only'] && scenario.credential === 'missing') {
    console.error(
      'no model credential serves the agent ' +
        agents[0]?.id +
        ': set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN or TEMPO_KEY, or name --claude-login FILE',
    )
    process.exitCode = 1
    return
  }

  for (const [directory, revision] of [
    ['hands', nanocode],
    ['packages', nanocodeTs + '-on-' + nanocode],
  ] as const) {
    const built = Path.join(lab, directory, revision.replaceAll('/', '_'))
    if (Fs.existsSync(built)) continue
    await sleep(scenario.buildMs ?? 0)
    const failed = revision.split('-on-').find((part) => scenario.builds?.[part] === 'fail')
    if (failed) {
      console.error('error: could not compile nanocode-cli at ' + failed)
      process.exitCode = 101
      return
    }
    Fs.mkdirSync(built, { recursive: true })
    console.error('built ' + directory + '/' + revision)
  }
  if (values['build-only']) {
    console.log('NANOEVAL_NANOCODE=' + Path.join(lab, 'hands', nanocode))
    console.log(
      'NANOEVAL_NANOCODE_TS=' + Path.join(lab, 'packages', nanocodeTs + '-on-' + nanocode),
    )
    return
  }

  const run = Crypto.randomUUID()
  const tasks = ((values.only as string[] | undefined) ?? scenario.tasks ?? []).slice()
  const attempts = Number(values.attempts)
  console.log(
    'run ' + run + ': ' + tasks.length * agents.length * attempts + ' attempts of ' + values.eval,
  )
  await sleep(scenario.hold?.[nanocode] ?? scenario.hold?.[nanocodeTs] ?? 0)

  const countersFile = Path.join(lab, 'stub-counters.json')
  const counters = Fs.existsSync(countersFile)
    ? (JSON.parse(Fs.readFileSync(countersFile, 'utf8')) as Record<string, number>)
    : {}
  const usage: Atif.Usage = {
    cacheWriteTokens: 0,
    cachedTokens: 400,
    costUsd: scenario.unpriced ? undefined : 0.01,
    inputTokens: 1000,
    modelCalls: 2,
    outputTokens: 50,
    toolCalls: 2,
  }
  const now = Date.now()
  const rows: Result.Attempt[] = []
  for (const agent of agents)
    for (const task of tasks)
      for (let index = 1; index <= attempts; index++) {
        const sequence =
          [nanocode, nanocodeTs, '*']
            .flatMap((revision) => [
              scenario.outcomes?.[revision]?.[agent.id + '/' + task],
              scenario.outcomes?.[revision]?.[task],
            ])
            .find((found) => found !== undefined) ?? 'p'
        const counter = [nanocode, nanocodeTs, agent.id, task].join(' ')
        const position = counters[counter] ?? 0
        counters[counter] = position + 1
        const mark =
          scenario.credential === 'expired'
            ? 'x'
            : sequence[Math.min(position, sequence.length - 1)]
        const failure: Result.Failure | undefined =
          mark === 'x'
            ? { at: now, kind: 'agent', message: '401 Unauthorized: the access token expired' }
            : mark === 'e'
              ? { at: now, kind: 'verifier', message: 'the verifier wrote no reward' }
              : mark === 't'
                ? { at: now, kind: 'agent_timeout', message: 'the agent ran out of time' }
                : undefined
        const reward = mark === 'x' || mark === 'e' ? null : mark === 'p' ? 1 : 0
        rows.push({
          agent,
          ...(failure ? { failure } : {}),
          finishedAt: now + 2000,
          id: 'a' + String(rows.length + 1).padStart(5, '0'),
          index,
          outcome: reward === null ? 'errored' : reward === 1 ? 'passed' : 'failed',
          reward,
          sandbox: null,
          session: 's' + rows.length,
          startedAt: now,
          task: { checksum: 'c', name: values.eval + '/' + task },
          timing: { agentExecution: { finishedAt: now + 1500, startedAt: now + 500 } },
          usage: mark === 'x' ? null : usage,
        })
      }
  Fs.writeFileSync(countersFile, JSON.stringify(counters))

  const name = String(values.name ?? 'nanoeval-stub')
  const out =
    values.out && !scenario.ignoreOut
      ? String(values.out)
      : Path.join(lab, 'runs', name + '-' + run.slice(0, 8))
  const files = Harbor.files({
    artifacts: {},
    attempts: rows,
    job: { finishedAt: now + 2000, id: run, name, startedAt: now },
    running: 0,
    source: String(values.eval),
    total: rows.length,
    version: 'stub',
  })
  for (const [path, contents] of Object.entries(files)) {
    Fs.mkdirSync(Path.dirname(Path.join(out, path)), { recursive: true })
    Fs.writeFileSync(Path.join(out, path), contents)
  }
  Fs.appendFileSync(
    Path.join(lab, 'runs.jsonl'),
    JSON.stringify({ name, nanocode, nanocodeTs, run }) + '\n',
  )
  const errored = rows.filter((row) => row.outcome === 'errored').length
  console.log('run ' + run + ' (' + name + '): finished')
  console.log('job written to ' + out)
  process.exitCode = errored ? 1 : 0
}

await main()
process.exit()
