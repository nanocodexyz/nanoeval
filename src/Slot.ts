import type * as Installed from './Installed.ts'
import * as Sandbox from './Sandbox.ts'
import * as Task from './Task.ts'

export type Backend = 'dir' | 'krun' | 'ns'

export type Network = 'host' | 'private'

export const networks: Record<Backend, readonly Network[]> = {
  dir: ['host'],
  krun: ['host', 'private'],
  ns: ['host', 'private'],
}

export type Phase = 'none' | 'running' | `exit:${number}`

export type Status = {
  disk_mb: number
  setup: Phase
  slots: Record<
    string,
    {
      hand: Phase
      oom: number | null
      reward: number | null
      solve: Phase
      up: Phase
      verify: Phase
    }
  >
}

export type Runtime = {
  release: string
  sha256: string
}

export const runtime: Runtime = {
  release: 'https://github.com/nanocodexyz/nanocode/releases/download/nanocode-cli',
  sha256: 'a5305c5a052d424d331a6d558c7d7820a0af1ef1c94c27a1c2f1682598bd7754',
}

export function create(options: create.Options) {
  const home = options.home
  const script = home + '/slot.sh'
  const call = (...args: readonly string[]) =>
    'NANOEVAL_HOME=' +
    Sandbox.quote(home) +
    ' bash ' +
    Sandbox.quote(script) +
    ' ' +
    args.map(Sandbox.quote).join(' ')

  return {
    home,
    script,
    agent: (slot: string, input: { timeoutSec: number; url: string }) =>
      call('agent', slot, String(Math.ceil(input.timeoutSec)), input.url),
    agentFile: (slot: string, name: 'instruction.md' | 'run.sh' | 'token') =>
      home + '/slots/' + slot + '/agent/' + name,
    agentOutput: (slot: string) => home + '/slots/' + slot + '/agent.out',
    agents: (kind: Installed.Kind, release: Installed.Release) =>
      call(
        'agents',
        kind,
        release.version,
        release.entry,
        release.format,
        ...release.binaries.flatMap((binary) => [
          binary.arch,
          binary.libc,
          binary.sha256,
          binary.url,
        ]),
      ),
    destroy: () => call('destroy'),
    disk: (input: { out: string; storageMb: number }) =>
      call('disk', String(input.storageMb), input.out),
    down: (slot: string, disks: 'keep' | 'remove') => call('down', slot, disks),
    drop: (disk: string) => call('drop', disk),
    envFile: (slot: string, name: 'env' | 'solution.env' | 'verifier.env') =>
      home + '/slots/' + slot + '/' + name,
    file: (slot: string, path: string) => call('file', slot, path),
    files: (slot: string) => call('files', slot),
    hand: (slot: string, input: { name: string; url: string }) =>
      call('hand', slot, input.url, input.name),
    log: (
      slot: string,
      phase: 'agent' | 'hand' | 'judge' | 'setup' | 'solve' | 'up' | 'verify',
      bytes: number,
    ) => call('log', slot, phase, String(bytes)),
    offlineFile: (slot: string) => home + '/slots/' + slot + '/offline',
    probe: () => call('probe'),
    reverify: (slot: string, timeoutSec: number) =>
      call('verify', slot, String(Math.ceil(timeoutSec)), '2'),
    setup: (input: { backend: Backend; network: Network; runtime: Runtime }) =>
      call('setup', input.runtime.release, input.runtime.sha256, input.backend, input.network),
    solve: (slot: string, timeoutSec: number) => call('solve', slot, String(Math.ceil(timeoutSec))),
    status: () => call('status'),
    taskFile: (slot: string, part = 'task') => home + '/slots/' + slot + '/' + part + '.tar',
    tools: () => call('tools'),
    up: (
      slot: string,
      input: {
        backend: Backend
        cpus: number
        disk?: string
        memoryMb: number
        network: Network
        storageMb: number
      },
    ) =>
      call(
        'up',
        slot,
        input.backend,
        String(input.cpus),
        String(input.memoryMb),
        input.network,
        String(input.storageMb),
        ...(input.disk ? [input.disk] : []),
      ),
    verifierCacheFile: (slot: string) => home + '/slots/' + slot + '/verifier.cache',
    verifierInput: (slot: string, name: string) =>
      home + '/slots/' + slot + '/task/' + Task.verifierInputs + '/' + name,
    verify: (slot: string, timeoutSec: number) =>
      call('verify', slot, String(Math.ceil(timeoutSec))),
  }
}

export declare namespace create {
  type Options = {
    home: string
  }
}

export function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => name + '=' + value + '\n')
    .join('')
}

export function exit(phase: Phase): number | undefined {
  return phase.startsWith('exit:') ? Number(phase.slice('exit:'.length)) : undefined
}

export function parseFiles(text: string): { bytes: number; path: string }[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const bytes = Number(line.slice(0, tab))
      if (tab < 1 || !Number.isSafeInteger(bytes) || tab === line.length - 1)
        throw new Error('the slot file listing is malformed: ' + line.slice(0, 200))
      return { bytes, path: line.slice(tab + 1) }
    })
}

export function parseStatus(text: string): Status {
  const status = JSON.parse(text) as Status
  if (
    typeof status?.setup !== 'string' ||
    typeof status.disk_mb !== 'number' ||
    typeof status.slots !== 'object' ||
    !status.slots
  )
    throw new Error('the slot status is malformed: ' + text.slice(0, 200))
  return status
}
