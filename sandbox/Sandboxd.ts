import { spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'

export type Options = {
  env?: Record<string, string>
  execTimeoutMs: number
  host: string
  port: number
  root: string
  token: string
}

export type Server = {
  close(): Promise<void>
  url: string
}

type Output = { exitCode: number; stderr: string; stdout: string }

function run(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode: code ?? (signal === 'SIGKILL' ? 137 : 1),
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
      })
    })
  })
}

async function body(request: Http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function start(options: Options): Promise<Server> {
  const root = Path.resolve(options.root)
  await Fs.mkdir(root, { recursive: true })
  const expected = Crypto.createHash('sha256').update(options.token).digest()
  const env = { ...process.env, ...options.env }
  const home = (id: string) => Path.join(root, id)

  const handle = async (
    request: Http.IncomingMessage,
  ): Promise<{ status: number; value: unknown }> => {
    const url = new URL(request.url ?? '/', 'http://sandboxd')
    if (url.pathname === '/health') return { status: 200, value: { ok: true } }

    const header = request.headers.authorization ?? ''
    const actual = Crypto.createHash('sha256')
      .update(header.replace(/^Bearer /, ''))
      .digest()
    if (!header.startsWith('Bearer ') || !Crypto.timingSafeEqual(actual, expected))
      return { status: 401, value: { error: 'unauthorized' } }

    if (url.pathname === '/sandboxes' && request.method === 'POST') {
      const id = Crypto.randomBytes(8).toString('hex')
      await Fs.mkdir(home(id), { recursive: true })
      return { status: 201, value: { home: home(id), id } }
    }

    const match = /^\/sandboxes\/([0-9a-f]{16})(\/exec|\/files)?$/.exec(url.pathname)
    if (!match) return { status: 404, value: { error: 'route not found' } }
    const directory = home(match[1]!)
    const exists = await Fs.stat(directory).then(
      (stat) => stat.isDirectory(),
      () => false,
    )
    if (!exists) return { status: 404, value: { error: 'sandbox not found' } }

    if (match[2] === '/exec' && request.method === 'POST') {
      const input = JSON.parse((await body(request)).toString()) as { command?: unknown }
      if (typeof input.command !== 'string')
        return { status: 400, value: { error: 'command must be a string' } }
      return {
        status: 200,
        value: await run(input.command, { cwd: directory, env, timeoutMs: options.execTimeoutMs }),
      }
    }

    if (match[2] === '/files' && request.method === 'PUT') {
      const target = Path.resolve(directory, url.searchParams.get('path') ?? '')
      if (target !== directory && !target.startsWith(directory + Path.sep))
        return { status: 400, value: { error: 'path is outside the sandbox' } }
      await Fs.mkdir(Path.dirname(target), { recursive: true })
      await Fs.writeFile(target, await body(request), { mode: 0o600 })
      return { status: 200, value: { written: target } }
    }

    if (!match[2] && request.method === 'DELETE') {
      const script = Path.join(directory, 'slot.sh')
      const scripted = await Fs.stat(script).then(
        () => true,
        () => false,
      )
      if (scripted)
        await run('bash "$1" destroy', {
          cwd: root,
          env: { ...env, NANOEVAL_HOME: directory },
          timeoutMs: options.execTimeoutMs,
        }).catch(() => undefined)
      await Fs.rm(directory, { force: true, recursive: true })
      return { status: 200, value: { deleted: true } }
    }
    return { status: 405, value: { error: 'method not allowed' } }
  }

  const server = Http.createServer((request, response) => {
    handle(request)
      .catch((error: unknown) => ({
        status: 500,
        value: { error: error instanceof Error ? error.message : String(error) },
      }))
      .then((result) => {
        response.writeHead(result.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result.value))
      })
  })
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve))
  const address = server.address() as AddressInfo
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
    url: 'http://' + options.host + ':' + address.port,
  }
}
