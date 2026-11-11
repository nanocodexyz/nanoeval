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
import * as Converter from '../sandbox/Converter.ts'
import * as Prune from '../sandbox/Prune.ts'
import * as Runner from '../sandbox/Runner.ts'
import * as Store from '../sandbox/Store.ts'
import * as Config from '../src/Config.ts'
import type * as Eval from '../src/Eval.ts'
import type * as Ledger from '../src/Ledger.ts'
import * as Task from '../src/Task.ts'
import * as Import from './Import.ts'
import * as Plan from './Plan.ts'

const usage = `nanoeval <command>

  sandboxd  --token T [--host 127.0.0.1] [--port 8788] [--root DIR] [--exec-timeout-ms 600000]
            [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT...]
            [--store DIR] [--cache DIR]
            Serve this machine as a local sandbox provider: a run starts one task runner in
            each sandbox it opens here. With --ca-bundle, slots trust that certificate bundle,
            for a machine whose network re-signs TLS. With --slot-env, they start with the
            variables of that file. With --slot-forward, a slot on a private network reaches
            that listener on this machine's loopback at the same address. --store names the
            directory blob store its runners read, and --cache where they keep verified blobs
            and unpacked environment disks.
  worker    --token T [--host 127.0.0.1] [--port 8787] [--state DIR] [--tick-ms 500]
            [--sandbox-url URL --sandbox-token T] [--claude-login FILE] [--codex-login FILE]
            Run the Worker under local workerd. Model API keys and base URLs are taken from
            ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, OPENAI_API_KEY and OPENAI_BASE_URL. A login
            file (~/.claude/.credentials.json, ~/.codex/auth.json) makes that provider's
            agents run on the plan signed in there: its access token is read once at start,
            is never refreshed, and reaches workerd through a private file.
  datasets  List the datasets that import knows, with the source each is pinned to and what
            was run end to end.
  import    --url URL --token T (DATASET | --task DIR...) [--eval NAME] [--only ID]... [--limit N]
            [--backend krun|dir] [--store DIR|r2] [--cache DIR] [--layers DIR] [--sources DIR]
            [--report FILE] [--keep-going]
            [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT...]
            Import a dataset, or local task directories, as a version of a durable eval:
            the adapter writes each task, its instruction, tests and solution become blobs
            kept apart, and its environment is converted once into the disk a microVM boots
            (krun) or kept as files (dir). Blobs go to a directory store (--store DIR,
            ~/.local/share/nanoeval/store) or to R2 through the Worker (--store r2). The
            layers of the images it reads from their registries are kept in --layers
            (CACHE/oci), so a later import downloads none of them again. The eval is named
            after the dataset unless --eval names it. --report writes the time each
            task took in the adapter, the conversion, the packing and the upload. With
            --keep-going, a task whose environment does not convert is named and left out,
            and the rest become the version. --limit N takes the first N tasks in the order
            of their ids, which is the order run --limit counts in. The RUN steps of a
            task's Dockerfile get the host policy that slots get, from --ca-bundle,
            --slot-env and --slot-forward or from NANOEVAL_CA_BUNDLE, NANOEVAL_SLOT_ENV and
            NANOEVAL_SLOT_FORWARD, and the disk keeps none of it.
  import    DATASET --out DIR [--only ID]... [--limit N] [--sources DIR]
            Write the dataset's tasks as Harbor task directories instead, with dataset.json.
  evals     --url URL --token T
  eval      --url URL --token T NAME[@DIGEST]
            List the imported evals, or the versions and tasks of one.
  run       --url URL --token T (--eval NAME[@DIGEST] [--only ID]... [--limit N] | --task DIR...
            | --rerun RUN [--failed | --errored])
            (--agent ID=PROVIDER:MODEL[:THINKING]... | --oracle) [--judge PROVIDER:MODEL[:THINKING]]
            [--attempts 1] [--provider local|e2b] [--backend krun|dir] [--slots 4] [--sandboxes 1]
            [--memory-mb N] [--network private|host] [--template NAME] [--sandbox-timeout-sec 3600]
            [--sandbox-budget-usd 0] [--model-budget-usd N] [--setup-sec 600] [--attach-sec 60]
            [--lease-sec 60] [--claims 3] [--step-retries 3] [--poll-ms 250]
            [--disks keep|remove] [--free-disk-mb N] [--name NAME] [--wait] [--out DIR]
            Create the rows of a run, task x agent x attempt, against one version of an eval.
            Task runners claim the rows: the run starts one in each sandbox it opens
            (--sandboxes, with --slots attempts at once each), and nanoeval runner attaches
            more from any machine. --sandboxes 0 waits for attached runners only. --task
            imports the directories into the eval named local first. --rerun makes a run of
            the attempts of RUN that did not pass (--failed or --errored narrow it), each
            pointing at the attempt it retries, on the same eval version and agents.
            A row whose runner stops answering for --lease-sec is claimable again, at most
            --claims times in all, and then ends as an error.
            With --disks remove, a runner removes each environment disk it unpacked once no
            row of the run needs it. With --free-disk-mb, a runner claims only while its
            machine has that much free disk, and prepares one environment at a time.
            With --oracle no model runs: each task's solution is run in its slot, then the
            verifier. --judge names the model that answers the verifiers of judged tasks.
            With --wait, poll until the run finishes, print the summary and write the Harbor
            job to --out, or under NANOEVAL_RUNS_DIR when that is set.
  runner    --url URL --token T --run RUN [--home DIR] [--slots N] [--memory-mb N]
            [--free-disk-mb N] [--poll-ms N] [--store DIR] [--cache DIR]
            [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT...]
            Attach a task runner on this machine to a run: it claims rows up to its own
            capacity, fetches their blobs by digest, boots each environment disk under a
            copy-on-write disk of its own, and reports to the run until the run is finished.
  status    --url URL --token T RUN
  attempt   --url URL --token T RUN ATTEMPT [ARTIFACT]
  export    --url URL --token T RUN --out DIR
            Write the run as a Harbor job directory.
  cancel    --url URL --token T RUN
  prune     [--dry-run] [--cache DIR]
            On this machine, remove the cached environment disks that no slot is using and
            the cached blobs.
  prune     layers --days N [--remove] [--layers DIR] [--cache DIR]
            List what the layer cache of imports (--layers, CACHE/oci) holds that no import
            used for N days: image layers, configs and manifests, and downloads abandoned
            that long ago, each with its size. With --remove, remove them. That is refused
            while an import converts an image from that cache.
  prune     store --url URL --token T [--remove] [--allow-empty] [--store DIR]
            List the blobs of a directory store that no version of any eval of the Worker
            names, and the files an import that died left staged, each with its size. With
            --remove, remove them. That is refused while an import writes to the store, and
            when the Worker names no blob of the store, unless --allow-empty says that
            emptying it is meant. Eval versions are never removed, and blobs in R2 are not
            pruned.
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
    attach: async (run: string) =>
      (await (
        await call('/v1/runs/' + run + '/runners', { method: 'POST' })
      ).json()) as Config.Runner,
    config: async (run: string) =>
      (await (await call('/v1/runs/' + run + '/config')).json()) as Config.Config & {
        eval: { name: string; version: string }
      },
    eval: async (reference: string, options: { tasks?: boolean } = {}) =>
      (await (
        await call('/v1/evals/' + encodeURIComponent(reference) + (options.tasks ? '?tasks=1' : ''))
      ).json()) as { entries: Eval.Entry[]; tasks?: Eval.Task[]; version: Eval.Version },
    evals: async () =>
      (await (await call('/v1/evals')).json()) as {
        evals: { dataset: string; digest: string; name: string; tasks: number; updatedAt: number }[]
      },
    putVersion: async (
      name: string,
      body: {
        base?: string | null
        dataset: string
        source: Record<string, string>
        tasks: readonly Eval.Task[]
      },
    ) =>
      (await (
        await call('/v1/evals/' + encodeURIComponent(name), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { name: string; version: Eval.Version },
    versions: async (name: string) =>
      (await (await call('/v1/evals/' + encodeURIComponent(name) + '/versions')).json()) as {
        versions: Eval.Version[]
      },
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
      ).json()) as { attempts: number; eval: { name: string; version: string }; id: string },
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
  if (status['eval'])
    lines.splice(1, 0, 'eval: ' + status['eval'].name + '@' + status['eval'].version)
  if (status['rerunOf'])
    lines.splice(2, 0, 'rerun of ' + status['rerunOf'].run + ' (' + status['rerunOf'].select + ')')
  for (const attempt of status['attempts'] as Record<string, any>[])
    lines.push(
      '  ' +
        [
          attempt['id'],
          attempt['task'],
          attempt['agent'],
          '#' + attempt['n'],
          attempt['outcome'] ?? attempt['phase'],
          attempt['oomKills'] ? 'oom_kills=' + attempt['oomKills'] : '',
          attempt['claims'] > 1 ? 'claims=' + attempt['claims'] : '',
          attempt['retryOf']
            ? 'retries ' + attempt['retryOf'].run.slice(0, 8) + '/' + attempt['retryOf'].attempt
            : '',
          attempt['failure']
            ? attempt['failure'].kind + ': ' + String(attempt['failure'].message).slice(0, 160)
            : '',
        ]
          .filter(Boolean)
          .join(' '),
    )
  return lines.join('\n')
}

export async function importEval(
  api: ReturnType<typeof client>,
  input: {
    backend: Config.Config['sandbox']['backend']
    cache: string
    cases: AsyncIterable<Dataset.Case>
    dataset: string
    layers: string
    log?(line: string): void
    name: string
    policy?: Converter.Policy
    refused?(id: string, error: Error): void
    source: Record<string, string>
    store: Store.Store
  },
): Promise<{ tasks: Eval.Task[]; timings: Import.Timing[]; version: Eval.Version }> {
  const held = await input.store.hold()
  try {
    const { tasks, timings } = await Import.cases(input.cases, {
      cache: input.cache,
      converter: Converter.create({
        home: Path.join(input.cache, 'converter'),
        layers: input.layers,
        ...(input.policy ? { policy: input.policy } : {}),
      }),
      format: input.backend === 'krun' ? 'disk' : 'dir',
      ...(input.log ? { log: input.log } : {}),
      ...(input.refused ? { refused: input.refused } : {}),
      store: input.store,
    })
    if (!tasks.length) throw new Error('the import selected no task')
    const { version } = await api.putVersion(input.name, {
      dataset: input.dataset,
      source: input.source,
      tasks,
    })
    return { tasks, timings, version }
  } finally {
    await held.release()
  }
}

export function blobStore(
  name: string | undefined,
  api: { token: string; url: string },
): Store.Store {
  return name === 'r2'
    ? Store.remote({ base: api.url.replace(/\/+$/, '') + '/v1/blobs', token: api.token })
    : Store.directory(Path.resolve(name ?? Store.defaultRoot()))
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { multiple: true, type: 'string' },
      'allow-empty': { default: false, type: 'boolean' },
      'attach-sec': { default: '60', type: 'string' },
      attempts: { default: '1', type: 'string' },
      backend: { default: 'krun', type: 'string' },
      'ca-bundle': { type: 'string' },
      cache: { type: 'string' },
      claims: { default: '3', type: 'string' },
      'claude-login': { type: 'string' },
      'codex-login': { type: 'string' },
      config: { type: 'string' },
      days: { type: 'string' },
      detach: { default: false, type: 'boolean' },
      disks: { default: 'keep', type: 'string' },
      'dry-run': { default: false, type: 'boolean' },
      errored: { default: false, type: 'boolean' },
      eval: { type: 'string' },
      'exec-timeout-ms': { default: '600000', type: 'string' },
      failed: { default: false, type: 'boolean' },
      'free-disk-mb': { type: 'string' },
      home: { type: 'string' },
      host: { default: '127.0.0.1', type: 'string' },
      judge: { type: 'string' },
      'keep-going': { default: false, type: 'boolean' },
      layers: { type: 'string' },
      'lease-sec': { default: '60', type: 'string' },
      limit: { type: 'string' },
      'memory-mb': { type: 'string' },
      'model-budget-usd': { type: 'string' },
      name: { type: 'string' },
      network: { type: 'string' },
      only: { multiple: true, type: 'string' },
      oracle: { default: false, type: 'boolean' },
      out: { type: 'string' },
      'poll-ms': { type: 'string' },
      port: { type: 'string' },
      provider: { default: 'local', type: 'string' },
      remove: { default: false, type: 'boolean' },
      report: { type: 'string' },
      rerun: { type: 'string' },
      root: { type: 'string' },
      run: { type: 'string' },
      'sandbox-budget-usd': { default: '0', type: 'string' },
      'sandbox-token': { default: process.env['NANOEVAL_SANDBOX_TOKEN'], type: 'string' },
      'sandbox-url': { type: 'string' },
      'sandbox-timeout-sec': { default: '3600', type: 'string' },
      sandboxes: { default: '1', type: 'string' },
      'setup-sec': { default: '600', type: 'string' },
      'slot-env': { type: 'string' },
      'slot-forward': { multiple: true, type: 'string' },
      slots: { type: 'string' },
      sources: { type: 'string' },
      state: { type: 'string' },
      'step-retries': { default: '3', type: 'string' },
      store: { type: 'string' },
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
  const hostPolicy = {
    ...(values['ca-bundle'] ? { NANOEVAL_CA_BUNDLE: Path.resolve(values['ca-bundle']) } : {}),
    ...(values.cache ? { NANOEVAL_CACHE: Path.resolve(values.cache) } : {}),
    ...(values['slot-env'] ? { NANOEVAL_SLOT_ENV: Path.resolve(values['slot-env']) } : {}),
    ...(values['slot-forward'] ? { NANOEVAL_SLOT_FORWARD: values['slot-forward'].join(' ') } : {}),
    ...(values.store ? { NANOEVAL_STORE: Path.resolve(values.store) } : {}),
  }

  if (command === 'sandboxd') {
    const server = await Sandboxd.start({
      env: hostPolicy,
      execTimeoutMs: Number(values['exec-timeout-ms']),
      host: values.host,
      port: Number(values.port ?? '8788'),
      root: values.root ?? Path.join(process.cwd(), 'output', 'sandboxes'),
      token: required(values.token, 'token'),
    })
    console.log('nanoeval sandboxd listening on ' + server.url)
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void server.close().then(() => process.exit(0)))
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
  const backend = values.backend as Config.Config['sandbox']['backend']
  const cache = Path.resolve(values.cache ?? Store.defaultCache())

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

  if (command === 'prune' && rest.length) {
    if (rest.length > 1 || (rest[0] !== 'layers' && rest[0] !== 'store'))
      throw new Error('prune takes layers, store or nothing, not ' + rest.join(' '))
    if (rest[0] === 'layers') {
      process.exitCode = await Prune.layers({
        days: required(values.days, 'days'),
        home: Path.join(cache, 'converter'),
        layers: Path.resolve(values.layers ?? Converter.defaultLayers(cache)),
        remove: values.remove,
      })
      return
    }
    if (values.store === 'r2')
      throw new Error('prune store takes a directory store: blobs in R2 are not pruned')
    await Prune.store({
      allowEmpty: values['allow-empty'],
      api: client({ token: required(values.token, 'token'), url: required(values.url, 'url') }),
      log: (line) => console.log(line),
      remove: values.remove,
      root: Path.resolve(values.store ?? Store.defaultRoot()),
    })
    return
  }

  if (command === 'prune') {
    const child = spawn(
      'bash',
      [
        Path.resolve(import.meta.dirname, '../sandbox/slot.sh'),
        'prune',
        ...(values['dry-run'] ? ['dry-run'] : []),
      ],
      { env: { ...process.env, NANOEVAL_CACHE: cache }, stdio: 'inherit' },
    )
    process.exitCode = await new Promise<number>((resolve) =>
      child.once('exit', (exit) => resolve(exit ?? 1)),
    )
    return
  }

  const adapter = command === 'import' && rest[0] ? Catalog.find(rest[0]) : undefined
  if (command === 'import' && rest[0] && !adapter)
    throw new Error(
      'no dataset is named ' +
        rest[0] +
        ': import knows ' +
        Catalog.adapters.map((candidate) => candidate.name).join(', '),
    )
  const sources = Source.create(
    values.sources ? Path.resolve(values.sources) : Source.defaultRoot(),
  )
  if (command === 'import' && adapter && values.out) {
    const manifest = await Dataset.write(adapter, { ...selection, out: values.out, store: sources })
    console.log(manifest.dataset + ': ' + manifest.tasks.length + ' tasks in ' + values.out)
    return
  }

  if (command === 'runner' && values.config) {
    const file = Path.resolve(values.config)
    const home = Path.dirname(file)
    if (values.detach) {
      const pid = await Runner.detach({
        arguments: [Path.resolve(import.meta.filename), 'runner', '--config', file],
        home,
      })
      console.log('runner started as process ' + pid)
      return
    }
    process.chdir(home)
    await Runner.run({
      cache,
      config: JSON.parse(await Fs.readFile(file, 'utf8')) as Config.Runner,
      home,
      store: Path.resolve(values.store ?? Store.defaultRoot()),
    })
    process.exit(0)
  }

  if (
    !command ||
    !['attempt', 'cancel', 'eval', 'evals', 'export', 'import', 'run', 'runner', 'status'].includes(
      command,
    )
  ) {
    console.log(usage)
    process.exitCode = command ? 2 : 0
    return
  }
  const access = { token: required(values.token, 'token'), url: required(values.url, 'url') }
  const api = client(access)

  if (command === 'evals') {
    for (const entry of (await api.evals()).evals)
      console.log(
        entry.name +
          '@' +
          entry.digest.slice(0, 12) +
          '  ' +
          entry.tasks +
          ' tasks  ' +
          entry.dataset,
      )
    return
  }

  if (command === 'eval') {
    const reference = required(rest[0], 'NAME')
    const found = await api.eval(reference)
    const name = reference.split('@')[0]!
    console.log(
      name +
        '@' +
        found.version.digest +
        '\n  dataset: ' +
        found.version.dataset +
        ' ' +
        JSON.stringify(found.version.source) +
        '\n  created: ' +
        new Date(found.version.createdAt).toISOString() +
        '\n  tasks: ' +
        found.version.tasks,
    )
    for (const version of (await api.versions(name)).versions)
      console.log(
        '  version ' +
          version.digest.slice(0, 12) +
          '  ' +
          version.tasks +
          ' tasks  ' +
          new Date(version.createdAt).toISOString() +
          (version.parent ? '  after ' + version.parent.slice(0, 12) : ''),
      )
    for (const entry of found.entries) console.log('  ' + entry.id + '  ' + entry.name)
    return
  }

  const policy = Converter.policy({ ...process.env, ...hostPolicy })
  const refusals: { error: string; id: string }[] = []
  const imported = async (
    source: AsyncIterable<Dataset.Case>,
    target: { dataset: string; name: string; source: Record<string, string> },
  ) => {
    const result = await importEval(api, {
      ...(values['keep-going']
        ? {
            refused: (id: string, error: Error) => {
              refusals.push({ error: error.message, id })
              console.error('not imported: ' + error.message)
            },
          }
        : {}),
      backend,
      cache,
      cases: source,
      dataset: target.dataset,
      layers: Path.resolve(values.layers ?? Converter.defaultLayers(cache)),
      log: (line) => console.error(line),
      name: target.name,
      policy,
      source: target.source,
      store: blobStore(values.store, access),
    })
    if (values.report)
      await Fs.writeFile(
        values.report,
        JSON.stringify(
          {
            name: target.name,
            policy: {
              caBundle: policy.caBundle !== undefined,
              slotEnv: policy.envFile !== undefined,
              slotForward: policy.forwards !== undefined,
            },
            refused: refusals,
            timings: result.timings,
            version: result.version,
          },
          null,
          2,
        ) + '\n',
      )
    return result
  }

  if (command === 'import') {
    if (adapter && adapter.state !== 'verified')
      console.error(adapter.name + ' is not verified end to end: ' + adapter.proof)
    if (!adapter && !values.task?.length) throw new Error('import takes a DATASET or --task DIR')
    const result = adapter
      ? await imported(adapter.cases({ ...selection, store: sources }), {
          dataset: adapter.name,
          name: values.eval ?? adapter.name,
          source: adapter.source,
        })
      : await imported(Import.directories(values.task!), {
          ...Import.local,
          name: values.eval ?? Import.local.name,
        })
    console.log(
      (values.eval ?? adapter?.name ?? Import.local.name) +
        '@' +
        result.version.digest +
        ': ' +
        result.version.tasks +
        ' tasks, ' +
        result.tasks.length +
        ' imported now' +
        (refusals.length ? ', ' + refusals.length + ' not imported' : ''),
    )
    process.exitCode = refusals.length ? 1 : 0
    return
  }

  if (command === 'runner') {
    const run = required(values.run, 'run')
    const home = Path.resolve(values.home ?? Path.join('output', 'runners', run.slice(0, 8)))
    await Fs.mkdir(home, { recursive: true })
    const file = Path.join(home, 'runner.json')
    const earlier = await Fs.readFile(file, 'utf8').then(
      (text) => JSON.parse(text) as Config.Runner,
      () => undefined,
    )
    const answered = earlier?.run === run ? earlier : await api.attach(run)
    await Fs.writeFile(file, JSON.stringify(answered), { mode: 0o600 })
    process.chdir(home)
    Object.assign(process.env, hostPolicy)
    await Runner.run({
      cache,
      config: {
        ...answered,
        ...(values['free-disk-mb'] ? { freeDiskMb: Number(values['free-disk-mb']) } : {}),
        ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
        ...(values['poll-ms'] ? { pollMs: Number(values['poll-ms']) } : {}),
        ...(values.slots ? { slots: Number(values.slots) } : {}),
        url: access.url,
      },
      home,
      store: Path.resolve(values.store ?? Store.defaultRoot()),
    })
    process.exit(0)
  }

  if (command === 'run') {
    if (values.oracle && values.agent?.length)
      throw new Error('--oracle runs no model: leave out --agent')
    const parent = values.rerun ? await api.config(values.rerun) : undefined
    let reference: Eval.Reference
    let only = values.only
    if (parent) reference = parent.eval
    else if (values.task?.length) {
      const result = await imported(Import.directories(values.task), {
        ...Import.local,
        name: values.eval ?? Import.local.name,
      })
      reference = { name: values.eval ?? Import.local.name, version: result.version.digest }
      only = result.tasks.map((task) => task.id)
    } else {
      const [name, digest] = required(values.eval, 'eval').split('@')
      reference = { name: name!, ...(digest ? { version: digest } : {}) }
    }
    const provider = values.provider as Config.Config['sandbox']['provider']
    const select: Ledger.Selection = values.failed
      ? 'failed'
      : values.errored
        ? 'errored'
        : 'unpassed'
    const config: Config.Config = {
      agents: parent
        ? parent.agents
        : values.oracle
          ? [oracle]
          : (values.agent ?? []).map(parseAgent),
      attempts: parent ? parent.attempts : Number(values.attempts),
      budget: {
        ...(values['model-budget-usd'] ? { modelUsd: Number(values['model-budget-usd']) } : {}),
        sandboxUsd: Number(values['sandbox-budget-usd']),
      },
      eval: reference,
      ...(values.judge
        ? { judge: parseJudge(values.judge) }
        : parent?.judge
          ? { judge: parent.judge }
          : {}),
      ...(selection.limit === undefined || parent ? {} : { limit: selection.limit }),
      limits: {
        attachSec: Number(values['attach-sec']),
        claims: Number(values.claims),
        leaseSec: Number(values['lease-sec']),
        setupSec: Number(values['setup-sec']),
        stepRetries: Number(values['step-retries']),
      },
      name:
        values.name ?? 'nanoeval-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
      ...(only?.length ? { only } : {}),
      ...(values.rerun ? { rerun: { run: values.rerun, select } } : {}),
      sandbox: {
        backend,
        disks: values.disks as 'keep' | 'remove',
        ...(values['free-disk-mb'] ? { freeDiskMb: Number(values['free-disk-mb']) } : {}),
        max: Number(values.sandboxes),
        ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
        network: (values.network ??
          Config.network({ backend })) as Config.Config['sandbox']['network'],
        pollMs: Number(values['poll-ms'] ?? '250'),
        provider,
        slots: Number(values.slots ?? '4'),
        ...(values.template ? { template: values.template } : {}),
        timeoutSec: Number(values['sandbox-timeout-sec']),
      },
    }
    const created = await api.create(config)
    console.log(
      'run ' +
        created.id +
        ': ' +
        created.attempts +
        ' attempts of ' +
        created.eval.name +
        '@' +
        created.eval.version.slice(0, 12),
    )
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
