#!/usr/bin/env node
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import type * as Config from '../src/Config.ts'
import * as Task from '../src/Task.ts'

const usage = `nanoeval <command>

  sandboxd  --token T [--host 127.0.0.1] [--port 8788] [--root DIR] [--exec-timeout-ms 600000]
            Serve this machine as a local sandbox provider.
  run       --url URL --token T --task DIR... --agent ID=PROVIDER:MODEL[:THINKING]...
            [--attempts 1] [--provider local|e2b] [--backend docker|dir] [--slots 4] [--sandboxes 1]
            [--memory-mb N] [--limits enforce|none] [--network bridge|host] [--docker keep|install]
            [--template NAME] [--sandbox-timeout-sec 3600] [--sandbox-budget-usd 0] [--model-budget-usd N]
            [--setup-sec 600] [--attach-sec 60] [--step-retries 3] [--name NAME] [--wait] [--out DIR]
            Submit a run. With --wait, poll until it finishes and print the summary.
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

export async function loadTask(root: string): Promise<Task.Task> {
  const entries = await walk(root)
  const files: Record<string, Uint8Array> = {}
  for (const entry of entries) files[entry.path] = await Fs.readFile(Path.join(root, entry.path))
  return Task.load({
    executable: entries.filter((entry) => entry.executable).map((entry) => entry.path),
    files,
  })
}

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
      (
        (await (await call('/v1/runs/' + run + '/harbor')).json()) as {
          files: Record<string, string>
        }
      ).files,
    status: async (run: string) =>
      (await call('/v1/runs/' + run)).json() as Promise<Record<string, any>>,
  }
}

export async function exportJob(files: Record<string, string>, out: string): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = Path.join(out, path)
    await Fs.mkdir(Path.dirname(target), { recursive: true })
    await Fs.writeFile(target, contents)
  }
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
      docker: { default: 'keep', type: 'string' },
      'exec-timeout-ms': { default: '600000', type: 'string' },
      host: { default: '127.0.0.1', type: 'string' },
      limits: { default: 'enforce', type: 'string' },
      'memory-mb': { type: 'string' },
      'model-budget-usd': { type: 'string' },
      name: { type: 'string' },
      network: { type: 'string' },
      out: { type: 'string' },
      port: { default: '8788', type: 'string' },
      provider: { default: 'local', type: 'string' },
      root: { type: 'string' },
      'sandbox-budget-usd': { default: '0', type: 'string' },
      'sandbox-timeout-sec': { default: '3600', type: 'string' },
      sandboxes: { default: '1', type: 'string' },
      'setup-sec': { default: '600', type: 'string' },
      slots: { default: '4', type: 'string' },
      'step-retries': { default: '3', type: 'string' },
      task: { multiple: true, type: 'string' },
      template: { type: 'string' },
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
      execTimeoutMs: Number(values['exec-timeout-ms']),
      host: values.host,
      port: Number(values.port),
      root: values.root ?? Path.join(process.cwd(), 'output', 'sandboxes'),
      token: required(values.token, 'token'),
    })
    console.log('nanoeval sandboxd listening on ' + server.url)
    return
  }

  if (!command || !['attempt', 'cancel', 'export', 'run', 'status'].includes(command)) {
    console.log(usage)
    process.exitCode = command ? 2 : 0
    return
  }
  const api = client({ token: required(values.token, 'token'), url: required(values.url, 'url') })

  if (command === 'run') {
    const tasks = await Promise.all((values.task ?? []).map((directory) => loadTask(directory)))
    const provider = values.provider as Config.Config['sandbox']['provider']
    const config: Config.Config = {
      agents: (values.agent ?? []).map(parseAgent),
      attempts: Number(values.attempts),
      budget: {
        ...(values['model-budget-usd'] ? { modelUsd: Number(values['model-budget-usd']) } : {}),
        sandboxUsd: Number(values['sandbox-budget-usd']),
      },
      limits: {
        attachSec: Number(values['attach-sec']),
        setupSec: Number(values['setup-sec']),
        stepRetries: Number(values['step-retries']),
      },
      name:
        values.name ?? 'nanoeval-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
      sandbox: {
        backend: values.backend as Config.Config['sandbox']['backend'],
        docker: values.docker as 'install' | 'keep',
        limits: values.limits as 'enforce' | 'none',
        max: Number(values.sandboxes),
        ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
        network: (values.network ?? (provider === 'local' ? 'host' : 'bridge')) as
          | 'bridge'
          | 'host',
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
        if (values.out) await exportJob(await api.harbor(created.id), values.out)
        process.exitCode = status['counts'].errored ? 1 : 0
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  const run = required(rest[0], 'RUN')
  if (command === 'status') console.log(summary(await api.status(run)))
  if (command === 'cancel') console.log(JSON.stringify(await api.cancel(run)))
  if (command === 'export') await exportJob(await api.harbor(run), required(values.out, 'out'))
  if (command === 'attempt') {
    const attempt = required(rest[1], 'ATTEMPT')
    if (rest[2]) process.stdout.write(await api.artifact(run, attempt, rest[2]))
    else console.log(JSON.stringify(await api.attempt(run, attempt), null, 2))
  }
}

if (import.meta.main) await main()
