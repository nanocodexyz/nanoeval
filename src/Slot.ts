import * as Sandbox from './Sandbox.ts'
import * as Task from './Task.ts'

export type Backend = 'dir' | 'docker' | 'krun'

export type Network = 'bridge' | 'host' | 'private'

export const networks: Record<Backend, readonly Network[]> = {
  dir: ['host'],
  docker: ['bridge', 'host', 'private'],
  krun: ['host', 'private'],
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
    destroy: () => call('destroy'),
    down: (slot: string, images: 'keep' | 'remove') => call('down', slot, images),
    envFile: (slot: string, name: 'env' | 'solution.env' | 'verifier.env') =>
      home + '/slots/' + slot + '/' + name,
    file: (slot: string, path: string) => call('file', slot, path),
    files: (slot: string) => call('files', slot),
    hand: (slot: string, input: { name: string; url: string }) =>
      call('hand', slot, input.url, input.name),
    log: (
      slot: string,
      phase: 'hand' | 'judge' | 'setup' | 'solve' | 'up' | 'verify',
      bytes: number,
    ) => call('log', slot, phase, String(bytes)),
    probe: () => call('probe'),
    reverify: (slot: string, timeoutSec: number) =>
      call('verify', slot, String(Math.ceil(timeoutSec)), '2'),
    setup: (input: {
      backend: Backend
      docker: 'install' | 'keep'
      network: Network
      runtime: Runtime
    }) =>
      call(
        'setup',
        input.runtime.release,
        input.runtime.sha256,
        input.docker,
        input.backend,
        input.network,
      ),
    solve: (slot: string, timeoutSec: number) => call('solve', slot, String(Math.ceil(timeoutSec))),
    status: () => call('status'),
    taskFile: (slot: string) => home + '/slots/' + slot + '/task.tar',
    up: (
      slot: string,
      input: {
        backend: Backend
        cpus: number
        image: string | undefined
        images?: 'keep' | 'remove'
        limits: 'enforce' | 'none'
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
        input.limits,
        input.network,
        String(input.storageMb),
        input.images ?? 'keep',
        ...(input.image ? [input.image] : []),
      ),
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
