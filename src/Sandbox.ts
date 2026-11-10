export type Capabilities = {
  arch: string
  bwrap: boolean
  ca_bundle: boolean
  cpus: number
  docker: boolean
  kernel: string
  kvm: boolean
  memory_mb: number
  slot_env: boolean
  userns: boolean
}

export type Output = {
  exitCode: number
  stderr: string
  stdout: string
}

export type Handle = Record<string, unknown> & { home: string; id: string }

export type Created = {
  expiresAt: number | null
  handle: Handle
}

export type Sandbox = {
  exec(command: string): Promise<Output>
  write(path: string, data: Uint8Array): Promise<void>
}

export type Provider = {
  readonly name: string
  connect(handle: Handle): Sandbox
  create(options: {
    metadata: Record<string, string>
    template: string | undefined
    timeoutSec: number
  }): Promise<Created>
  kill(handle: Handle): Promise<void>
}

export class CommandError extends Error {
  override name = 'Sandbox.CommandError'
}

export function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

export async function run(sandbox: Sandbox, command: string): Promise<string> {
  const output = await sandbox.exec(command)
  if (output.exitCode !== 0)
    throw new CommandError(
      'the sandbox command exited with ' +
        output.exitCode +
        ': ' +
        (output.stderr.trim() || output.stdout.trim()).slice(-2000),
    )
  return output.stdout
}
