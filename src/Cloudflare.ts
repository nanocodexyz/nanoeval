import type * as Sandbox from './Sandbox.ts'

// A sandbox on Cloudflare Containers: one Durable Object of a container class per sandbox,
// whose Container runs the bootstrap and the runner as in an E2B sandbox. The run talks to the
// object over RPC (`Stub`), and the object drives its Container with the native exec API of
// `ctx.container` (`serve`), so neither side needs @cloudflare/sandbox.

export class CommandError extends Error {
  override name = 'Cloudflare.CommandError'
}

export class StartError extends Error {
  override name = 'Cloudflare.StartError'
}

export const home = '/root/.nanoeval'

// The exit code of a command the object ended at its time limit, as timeout(1) reports it.
export const timedOutCode = 124

export type ExecOutput = {
  readonly exitCode: number
  readonly stderr: ArrayBuffer
  readonly stdout: ArrayBuffer
}

export type Process = {
  readonly stdin: WritableStream | null
  kill(signal?: number): void
  output(): Promise<ExecOutput>
}

// The part of the Workers `Container` (ctx.container) a sandbox uses.
export type Container = {
  readonly running: boolean
  destroy(error?: unknown): Promise<void>
  exec(
    cmd: string[],
    options?: {
      signal?: AbortSignal
      stderr?: 'pipe'
      stdin?: 'pipe'
      stdout?: 'pipe'
    },
  ): Promise<Process>
  // Keeps the Container while its object gets no request: the runner in it only dials out.
  setInactivityTimeout?(durationMs: number): Promise<void>
  start(options?: { enableInternet?: boolean; env?: Record<string, string> }): void
}

export type Start = { expiresAt: number; metadata: Record<string, string> }

// What a sandbox object answers over RPC.
export type Stub = {
  exec(command: string): Promise<Sandbox.Output>
  kill(): Promise<void>
  start(input: Start): Promise<void>
  write(path: string, data: Uint8Array): Promise<void>
}

const decoder = new TextDecoder()

function text(buffer: ArrayBuffer): string {
  return decoder.decode(new Uint8Array(buffer))
}

export function serve(container: Container, options: serve.Options = {}): Stub {
  const execMs = options.execMs ?? 600_000
  const readyMs = options.readyMs ?? 120_000
  const pollMs = options.pollMs ?? 500
  const now = options.now ?? Date.now
  const pause = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  return {
    async exec(command) {
      const abort = new AbortController()
      let late = false
      const timer = setTimeout(() => {
        late = true
        abort.abort()
      }, execMs)
      try {
        const process = await container.exec(['/bin/bash', '-l', '-c', command], {
          signal: abort.signal,
          stderr: 'pipe',
          stdout: 'pipe',
        })
        const output = await process.output()
        return { exitCode: output.exitCode, stderr: text(output.stderr), stdout: text(output.stdout) }
      } catch (error) {
        if (!late) throw error
        return {
          exitCode: timedOutCode,
          stderr: 'the command ran past ' + execMs + ' ms and was ended',
          stdout: '',
        }
      } finally {
        clearTimeout(timer)
      }
    },
    async kill() {
      if (container.running) await container.destroy()
    },
    async start(input) {
      if (!container.running) container.start({ enableInternet: true, env: input.metadata })
      await container.setInactivityTimeout?.(Math.max(0, input.expiresAt - now()))
      const until = now() + readyMs
      let last: unknown
      for (;;) {
        try {
          const process = await container.exec(['/bin/true'])
          if ((await process.output()).exitCode === 0) return
        } catch (error) {
          last = error
        }
        if (now() >= until)
          throw new StartError(
            'the container did not answer a command within ' +
              readyMs +
              ' ms' +
              (last ? ': ' + String((last as Error)?.message ?? last) : ''),
          )
        await pause(pollMs)
      }
    },
    async write(path, data) {
      const process = await container.exec(
        ['/bin/sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path],
        { stderr: 'pipe', stdin: 'pipe', stdout: 'pipe' },
      )
      if (!process.stdin) throw new CommandError('the container gave no stdin to write ' + path)
      const writer = process.stdin.getWriter()
      await writer.write(data)
      await writer.close()
      const output = await process.output()
      if (output.exitCode !== 0)
        throw new CommandError(
          'writing ' + path + ' exited with ' + output.exitCode + ': ' + text(output.stderr).slice(-500),
        )
    },
  }
}

export declare namespace serve {
  type Options = {
    execMs?: number
    now?: () => number
    pollMs?: number
    readyMs?: number
    sleep?: (ms: number) => Promise<void>
  }
}

export function create(options: create.Options): Sandbox.Provider {
  const now = options.now ?? Date.now
  const id = options.id ?? (() => 'nanoeval-' + crypto.randomUUID())
  const stub = (handle: Sandbox.Handle) =>
    options.sandbox(handle.id, typeof handle['instance'] === 'string' ? handle['instance'] : undefined)
  return {
    name: 'cloudflare',
    connect(handle) {
      const object = stub(handle)
      return {
        exec: (command) => object.exec(command),
        write: (path, data) => object.write(path, data),
      }
    },
    async create(input) {
      const handle: Sandbox.Handle = {
        home,
        id: id(),
        ...(input.template ? { instance: input.template } : {}),
      }
      const expiresAt = now() + input.timeoutSec * 1000
      await stub(handle).start({ expiresAt, metadata: input.metadata })
      return { expiresAt, handle }
    },
    async kill(handle) {
      await stub(handle).kill()
    },
  }
}

export declare namespace create {
  type Options = {
    id?: () => string
    now?: () => number
    // The object of a sandbox, by its ID and the container class (instance type) it names.
    sandbox: (id: string, instance: string | undefined) => Stub
  }
}
