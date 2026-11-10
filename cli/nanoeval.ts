#!/usr/bin/env node
import { spawn } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import * as Catalog from '../datasets/Catalog.ts'
import * as Dataset from '../datasets/Dataset.ts'
import * as Source from '../datasets/Source.ts'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import * as Config from '../src/Config.ts'
import * as Task from '../src/Task.ts'
import * as Plan from './Plan.ts'

const usage = `nanoeval <command>

  sandboxd  --token T [--host 127.0.0.1] [--port 8788] [--root DIR] [--exec-timeout-ms 600000]
            [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT...]
            Serve this machine as a local sandbox provider. With --ca-bundle, slots trust
            that certificate bundle, for a machine whose network re-signs TLS. With
            --slot-env, they start with the variables of that file, such as a proxy or a
            package index the machine's network requires. With --slot-forward, a slot on
            a private network reaches that listener on this machine's loopback at the same
            address, for a machine whose resolver names one.
  worker    --token T [--host 127.0.0.1] [--port 8787] [--state DIR] [--tick-ms 500]
            [--sandbox-url URL --sandbox-token T] [--claude-login FILE] [--codex-login FILE]
            Run the Worker under local workerd. Model API keys and base URLs are taken from
            ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, OPENAI_API_KEY and OPENAI_BASE_URL. A login
            file (~/.claude/.credentials.json, ~/.codex/auth.json) makes that provider's
            agents run on the plan signed in there: its access token is read once at start,
            is never refreshed, and reaches workerd through a private file.
  datasets  List the datasets that import knows, with the source each is pinned to and what
            was run end to end.
  import    DATASET --out DIR [--only ID]... [--limit N] [--sources DIR]
            Write a dataset's tasks as Harbor task directories under DIR, and dataset.json with
            the pinned source and the checksum of every task. Sources are downloaded once into
            --sources (~/.cache/nanoeval/sources) and refused unless they match the digests
            pinned in this repository. --only and --limit import part of a dataset.
  run       --url URL --token T (--task DIR... | --dataset DIR [--only ID]... [--limit N])
            (--agent ID=PROVIDER:MODEL[:THINKING]... | --oracle) [--judge PROVIDER:MODEL[:THINKING]]
            [--attempts 1] [--provider local|e2b] [--backend docker|dir|krun] [--slots 4] [--sandboxes 1]
            [--memory-mb N] [--limits enforce|none] [--network private|host|bridge] [--docker keep|install]
            [--template NAME] [--sandbox-timeout-sec 3600] [--sandbox-budget-usd 0] [--model-budget-usd N]
            [--setup-sec 600] [--attach-sec 60] [--step-retries 3] [--name NAME] [--wait] [--out DIR]
            Submit a run. A slot of the local provider gets a network of its own (private)
            unless --network host shares the machine's. With --wait, poll until it finishes,
            print the summary and write
            the Harbor job to --out, or to a directory named after the run under
            NANOEVAL_RUNS_DIR when that is set.
            With --oracle no model runs: each task's solution/solve.sh is sent and run in its slot,
            then the verifier, to check environments and verifiers.
            --dataset runs the tasks of an imported dataset after checking each against the
            checksum in its dataset.json, and names the tasks it skips because no slot backend
            runs them. --judge names the model that answers the verifiers of model-judged tasks.
  status    --url URL --token T RUN
  attempt   --url URL --token T RUN ATTEMPT [ARTIFACT]
  export    --url URL --token T RUN --out DIR
            Write the run as a Harbor job directory.
  cancel    --url URL --token T RUN
`

async function walk(
  root: string,
  directory = '',
): Promise<{ executable: boolean; path: string }[]> {
  const found: { executable: boolean; path: string }[] = []
  for (const entry of await Fs.readdir(Path.join(root, directory), { withFileTypes: true })) {
    const path = directory ? directory + '/' + entry.name : entry.name
    if (entry.isDirectory()) found.push(...(await walk(root, path)))
    else if (entry.isFile())
      found.push({ executable: ((await Fs.stat(Path.join(root, path))).mode & 0o111) !== 0, path })
  }
  return found
}

export async function readTask(root: string): Promise<Task.Source> {
  const entries = await walk(root)
  const files: Record<string, Uint8Array> = {}
  for (const entry of entries) files[entry.path] = await Fs.readFile(Path.join(root, entry.path))
  return {
    executable: entries.filter((entry) => entry.executable).map((entry) => entry.path),
    files,
  }
}

export async function loadTask(root: string, options: Task.load.Options = {}): Promise<Task.Task> {
  return Task.load(await readTask(root), options)
}

export async function loadDataset(
  directory: string,
  options: Dataset.Selection & Task.load.Options,
): Promise<{ skipped: { id: string; reason: string }[]; tasks: Task.Task[] }> {
  const skipped: { id: string; reason: string }[] = []
  const tasks: Task.Task[] = []
  for (const entry of await Dataset.entries(directory, options)) {
    const source = await readTask(entry.directory)
    const checksum = 'sha256:' + (await Task.checksum(source.files))
    if (checksum !== entry.checksum)
      throw new Dataset.ManifestError(
        entry.directory +
          ' has the checksum ' +
          checksum +
          ', and its dataset.json pins ' +
          entry.checksum,
      )
    try {
      tasks.push(await Task.load(source, options.solution ? { solution: true } : {}))
    } catch (error) {
      if (!(error instanceof Task.UnsupportedError)) throw error
      skipped.push({ id: entry.id, reason: error.message })
    }
  }
  return { skipped, tasks }
}

export function parseJudge(text: string): Config.Judge {
  const match = /^(claude|codex):([^:]+)(?::([a-z]+))?$/.exec(text)
  if (!match) throw new Error('a judge is PROVIDER:MODEL[:THINKING], not ' + text)
  return {
    model: match[2]!,
    provider: match[1] as Config.Judge['provider'],
    ...(match[3] ? { thinking: match[3] } : {}),
  }
}

export const oracle: Config.Agent = { id: 'oracle', model: 'solution', provider: 'oracle' }

export function parseAgent(text: string): Config.Agent {
  const match = /^([^=]+)=(claude|codex):([^:]+)(?::([a-z]+))?$/.exec(text)
  if (!match) throw new Error('an agent is ID=PROVIDER:MODEL[:THINKING], not ' + text)
  return {
    id: match[1]!,
    model: match[3]!,
    provider: match[2] as Config.Agent['provider'],
    ...(match[4] ? { thinking: match[4] } : {}),
  }
}

export function client(options: { token: string; url: string }) {
  const base = options.url.replace(/\/+$/, '')
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + options.token },
    })
    if (!response.ok)
      throw new Error(path + ' answered ' + response.status + ': ' + (await response.text()))
    return response
  }
  return {
    artifact: async (run: string, attempt: string, name: string) =>
      (
        await call(
          '/v1/runs/' + run + '/attempts/' + attempt + '/artifacts/' + encodeURIComponent(name),
        )
      ).text(),
    artifactBytes: async (run: string, attempt: string, name: string) =>
      new Uint8Array(
        await (
          await call(
            '/v1/runs/' + run + '/attempts/' + attempt + '/artifacts/' + encodeURIComponent(name),
          )
        ).arrayBuffer(),
      ),
    attempt: async (run: string, attempt: string) =>
      (await call('/v1/runs/' + run + '/attempts/' + attempt)).json() as Promise<
        Record<string, any>
      >,
    cancel: async (run: string) =>
      (await call('/v1/runs/' + run + '/cancel', { method: 'POST' })).json(),
    create: async (config: Config.Config) =>
      (await (
        await call('/v1/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        })
      ).json()) as { attempts: number; id: string },
    harbor: async (run: string) =>
      (await (await call('/v1/runs/' + run + '/harbor')).json()) as Job,
    status: async (run: string) =>
      (await call('/v1/runs/' + run)).json() as Promise<Record<string, any>>,
  }
}

export type Job = {
  artifacts: { attempt: string; names: string[]; trial: string }[]
  files: Record<string, string>
}

export async function exportJob(
  api: ReturnType<typeof client>,
  options: { out: string; run: string },
): Promise<Job> {
  const write = async (path: string, contents: string | Uint8Array) => {
    const target = Path.join(options.out, path)
    await Fs.mkdir(Path.dirname(target), { recursive: true })
    await Fs.writeFile(target, contents)
  }
  const job = await api.harbor(options.run)
  for (const [path, contents] of Object.entries(job.files)) await write(path, contents)
  for (const entry of job.artifacts)
    for (const name of entry.names)
      await write(
        entry.trial + '/' + name,
        await api.artifactBytes(options.run, entry.attempt, name),
      )
  return job
}

export function summary(status: Record<string, any>): string {
  const lines = [
    'run ' + status['id'] + ' (' + status['name'] + '): ' + status['state'],
    'attempts: ' +
      Object.entries(status['counts'] as Record<string, number>)
        .map(([name, value]) => name + ' ' + value)
        .join(', '),
    'spend: model $' +
      Number(status['spend'].modelUsd).toFixed(4) +
      ', sandboxes $' +
      Number(status['spend'].sandboxUsd).toFixed(4),
  ]
  for (const [agent, row] of Object.entries(status['agents'] as Record<string, any>))
    lines.push(
      agent +
        ': passed ' +
        row.passed +
        '/' +
        row.attempts +
        ', errored ' +
        row.errored +
        (row.meanReward === null || row.meanReward === undefined
          ? ''
          : ', mean reward ' + Number(row.meanReward).toFixed(3)) +
        ', ' +
        Object.entries(row.passAtK as Record<string, number>)
          .map(([k, value]) => 'pass@' + k + ' ' + (value * 100).toFixed(1) + '%')
          .join(', '),
    )
  for (const attempt of status['attempts'] as Record<string, any>[])
    lines.push(
      '  ' +
        [
          attempt['id'],
          attempt['task'],
          attempt['agent'],
          '#' + attempt['n'],
          attempt['outcome'] ?? attempt['phase'],
          attempt['failure']
            ? attempt['failure'].kind + ': ' + String(attempt['failure'].message).slice(0, 160)
            : '',
        ]
          .filter(Boolean)
          .join(' '),
    )
  return lines.join('\n')
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { multiple: true, type: 'string' },
      'attach-sec': { default: '60', type: 'string' },
      attempts: { default: '1', type: 'string' },
      backend: { default: 'docker', type: 'string' },
      'ca-bundle': { type: 'string' },
      'claude-login': { type: 'string' },
      'codex-login': { type: 'string' },
      dataset: { type: 'string' },
      docker: { default: 'keep', type: 'string' },
      'exec-timeout-ms': { default: '600000', type: 'string' },
      host: { default: '127.0.0.1', type: 'string' },
      judge: { type: 'string' },
      limit: { type: 'string' },
      limits: { default: 'enforce', type: 'string' },
      'memory-mb': { type: 'string' },
      'model-budget-usd': { type: 'string' },
      name: { type: 'string' },
      network: { type: 'string' },
      only: { multiple: true, type: 'string' },
      oracle: { default: false, type: 'boolean' },
      out: { type: 'string' },
      port: { type: 'string' },
      provider: { default: 'local', type: 'string' },
      root: { type: 'string' },
      'sandbox-budget-usd': { default: '0', type: 'string' },
      'sandbox-token': { default: process.env['NANOEVAL_SANDBOX_TOKEN'], type: 'string' },
      'sandbox-url': { type: 'string' },
      'sandbox-timeout-sec': { default: '3600', type: 'string' },
      sandboxes: { default: '1', type: 'string' },
      'setup-sec': { default: '600', type: 'string' },
      'slot-env': { type: 'string' },
      'slot-forward': { multiple: true, type: 'string' },
      slots: { default: '4', type: 'string' },
      sources: { type: 'string' },
      state: { type: 'string' },
      'step-retries': { default: '3', type: 'string' },
      task: { multiple: true, type: 'string' },
      template: { type: 'string' },
      'tick-ms': { default: '500', type: 'string' },
      token: { default: process.env['NANOEVAL_TOKEN'], type: 'string' },
      url: { default: process.env['NANOEVAL_URL'], type: 'string' },
      wait: { default: false, type: 'boolean' },
    },
  })
  const [command, ...rest] = positionals
  const required = (value: string | undefined, name: string): string => {
    if (!value) throw new Error('--' + name + ' is required')
    return value
  }

  if (command === 'sandboxd') {
    const server = await Sandboxd.start({
      env: {
        ...(values['ca-bundle'] ? { NANOEVAL_CA_BUNDLE: Path.resolve(values['ca-bundle']) } : {}),
        ...(values['slot-env'] ? { NANOEVAL_SLOT_ENV: Path.resolve(values['slot-env']) } : {}),
        ...(values['slot-forward']
          ? { NANOEVAL_SLOT_FORWARD: values['slot-forward'].join(' ') }
          : {}),
      },
      execTimeoutMs: Number(values['exec-timeout-ms']),
      host: values.host,
      port: Number(values.port ?? '8788'),
      root: values.root ?? Path.join(process.cwd(), 'output', 'sandboxes'),
      token: required(values.token, 'token'),
    })
    console.log('nanoeval sandboxd listening on ' + server.url)
    return
  }

  if (command === 'worker') {
    const vars: Record<string, string> = { ACCESS_TOKEN: required(values.token, 'token') }
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
    ])
      if (process.env[name]) vars[name] = process.env[name]
    if (values['sandbox-url']) {
      vars['LOCAL_SANDBOX_URL'] = values['sandbox-url']
      vars['LOCAL_SANDBOX_TOKEN'] = required(values['sandbox-token'], 'sandbox-token')
    }
    vars['TICK_MS'] = values['tick-ms']

    const logins: [name: string, login: Plan.Login][] = []
    if (values['claude-login'])
      logins.push(['Claude', await Plan.claude(Path.resolve(values['claude-login']))])
    if (values['codex-login'])
      logins.push(['ChatGPT', await Plan.codex(Path.resolve(values['codex-login']))])
    for (const [name, login] of logins) {
      Object.assign(vars, login.vars)
      const expiry =
        login.expiresAt === undefined
          ? 'at an unknown time'
          : 'at ' + new Date(login.expiresAt).toISOString()
      console.error(
        login.expiresAt !== undefined && login.expiresAt <= Date.now()
          ? 'the ' +
              name +
              ' plan login expired ' +
              expiry +
              ': its agents fail until you sign in again and restart the worker'
          : 'the ' + name + ' plan login is used until it expires ' + expiry,
      )
    }
    const relay = values['codex-login'] ? await Plan.relay() : undefined
    Object.assign(vars, relay?.vars)

    const root = Path.resolve(import.meta.dirname, '..')
    const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'nanoeval-worker-'))
    const file = Path.join(directory, 'vars.env')
    await Fs.writeFile(file, Plan.envFile(vars), { mode: 0o600 })
    const child = spawn(
      process.execPath,
      [
        Path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
        'dev',
        '--ip',
        values.host,
        '--port',
        values.port ?? '8787',
        '--persist-to',
        Path.resolve(values.state ?? Path.join('output', 'worker')),
        '--env-file',
        file,
      ],
      { cwd: root, stdio: 'inherit' },
    )
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => child.kill(signal))
    const code = await new Promise<number>((resolve) =>
      child.once('exit', (exit) => resolve(exit ?? 1)),
    )
    await relay?.close()
    await Fs.rm(directory, { force: true, recursive: true })
    process.exit(code)
  }

  const selection: Dataset.Selection = {
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.only?.length ? { only: values.only } : {}),
  }

  if (command === 'datasets') {
    for (const adapter of Catalog.adapters)
      console.log(
        [
          adapter.name + (adapter.state === 'verified' ? '' : ' (not verified end to end)'),
          '  ' + adapter.description,
          '  source: ' + JSON.stringify(adapter.source),
          '  run: ' + adapter.proof,
        ].join('\n'),
      )
    return
  }

  if (command === 'import') {
    const adapter = Catalog.find(required(rest[0], 'DATASET'))
    if (!adapter)
      throw new Error(
        'no dataset is named ' +
          rest[0] +
          ': import knows ' +
          Catalog.adapters.map((candidate) => candidate.name).join(', '),
      )
    if (adapter.state !== 'verified')
      console.error(adapter.name + ' is not verified end to end: ' + adapter.proof)
    const out = required(values.out, 'out')
    const manifest = await Dataset.write(adapter, {
      ...selection,
      out,
      store: Source.create(values.sources ? Path.resolve(values.sources) : Source.defaultRoot()),
    })
    console.log(manifest.dataset + ': ' + manifest.tasks.length + ' tasks in ' + out)
    return
  }

  if (!command || !['attempt', 'cancel', 'export', 'run', 'status'].includes(command)) {
    console.log(usage)
    process.exitCode = command ? 2 : 0
    return
  }
  const api = client({ token: required(values.token, 'token'), url: required(values.url, 'url') })

  if (command === 'run') {
    if (values.oracle && values.agent?.length)
      throw new Error('--oracle runs no model: leave out --agent')
    const tasks = await Promise.all(
      (values.task ?? []).map((directory) =>
        loadTask(directory, { solution: values.oracle }).catch((error: Error) => {
          error.message = directory + ': ' + error.message
          throw error
        }),
      ),
    )
    if (values.dataset) {
      const dataset = await loadDataset(values.dataset, { ...selection, solution: values.oracle })
      for (const entry of dataset.skipped)
        console.error('skipped ' + entry.id + ': ' + entry.reason)
      tasks.push(...dataset.tasks)
    }
    const provider = values.provider as Config.Config['sandbox']['provider']
    const backend = values.backend as Config.Config['sandbox']['backend']
    const config: Config.Config = {
      agents: values.oracle ? [oracle] : (values.agent ?? []).map(parseAgent),
      attempts: Number(values.attempts),
      budget: {
        ...(values['model-budget-usd'] ? { modelUsd: Number(values['model-budget-usd']) } : {}),
        sandboxUsd: Number(values['sandbox-budget-usd']),
      },
      ...(values.judge ? { judge: parseJudge(values.judge) } : {}),
      limits: {
        attachSec: Number(values['attach-sec']),
        setupSec: Number(values['setup-sec']),
        stepRetries: Number(values['step-retries']),
      },
      name:
        values.name ?? 'nanoeval-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
      sandbox: {
        backend,
        docker: values.docker as 'install' | 'keep',
        limits: values.limits as 'enforce' | 'none',
        max: Number(values.sandboxes),
        ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
        network: (values.network ??
          Config.network({ backend, provider })) as Config.Config['sandbox']['network'],
        provider,
        slots: Number(values.slots),
        ...(values.template ? { template: values.template } : {}),
        timeoutSec: Number(values['sandbox-timeout-sec']),
      },
      tasks,
    }
    const created = await api.create(config)
    console.log('run ' + created.id + ': ' + created.attempts + ' attempts')
    if (!values.wait) return

    for (;;) {
      const status = await api.status(created.id)
      if (status['state'] === 'finished') {
        console.log(summary(status))
        const out =
          values.out ??
          (process.env['NANOEVAL_RUNS_DIR']
            ? Path.join(
                process.env['NANOEVAL_RUNS_DIR'],
                config.name + '-' + created.id.slice(0, 8),
              )
            : undefined)
        if (out) {
          await exportJob(api, { out, run: created.id })
          console.log('job written to ' + out)
        }
        process.exitCode = status['counts'].errored ? 1 : 0
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  const run = required(rest[0], 'RUN')
  if (command === 'status') console.log(summary(await api.status(run)))
  if (command === 'cancel') console.log(JSON.stringify(await api.cancel(run)))
  if (command === 'export') await exportJob(api, { out: required(values.out, 'out'), run })
  if (command === 'attempt') {
    const attempt = required(rest[1], 'ATTEMPT')
    if (rest[2]) process.stdout.write(await api.artifactBytes(run, attempt, rest[2]))
    else console.log(JSON.stringify(await api.attempt(run, attempt), null, 2))
  }
}

if (import.meta.main) await main()
