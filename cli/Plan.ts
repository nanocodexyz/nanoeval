import { spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'
import { Relay } from 'nanocode-egress/relay'

export class LoginError extends Error {
  override name = 'Plan.LoginError'
}

export class PushError extends Error {
  override name = 'Plan.PushError'
}

export type RelayServer = {
  close(): Promise<void>
  vars: Record<string, string>
}

export async function relayUrl(path: string): Promise<string> {
  const text = (await Fs.readFile(path, 'utf8')).trim()
  if (!/^https:\/\/[^\s/]+\/?$/.test(text))
    throw new LoginError(path + ' holds no https address of a relay')
  return text
}

export async function push(vars: Record<string, string>, input: push.Input): Promise<string[]> {
  const pushed = await Fs.readFile(input.state, 'utf8').then(
    (text) => JSON.parse(text) as Record<string, string>,
    () => ({}) as Record<string, string>,
  )
  const names: string[] = []
  for (const name of Object.keys(vars).sort()) {
    const digest = Crypto.createHash('sha256').update(vars[name]!).digest('hex')
    if (pushed[name] === digest) continue
    let unread: Error | undefined
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('sh', ['-c', input.command], {
        env: { ...process.env, NANOEVAL_SECRET_NAME: name },
        stdio: ['pipe', 'inherit', 'inherit'],
      })
      child.once('error', reject)
      child.once('exit', resolve)
      child.stdin.once('error', (error) => {
        unread = error
      })
      child.stdin.end(vars[name])
    })
    if (code !== 0) throw new PushError('pushing ' + name + ' exited with ' + code)
    if (unread)
      throw new PushError('pushing ' + name + ' did not read the value: ' + unread.message)
    pushed[name] = digest
    names.push(name)
    await writePrivate(input.state, JSON.stringify(pushed, null, 2) + '\n')
  }
  return names
}

export declare namespace push {
  type Input = { command: string; state: string }
}

async function writePrivate(path: string, text: string): Promise<void> {
  const staged = path + '.' + process.pid + '.tmp'
  await Fs.writeFile(staged, text, { mode: 0o600 })
  await Fs.rename(staged, path)
}

export async function relay(upstream?: string): Promise<RelayServer> {
  const secret = Crypto.randomBytes(32).toString('hex')
  const server = Relay.create({ secret, ...(upstream ? { upstream } : {}) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
    vars: {
      CHATGPT_RELAY_SECRET: secret,
      CHATGPT_RELAY_URL: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    },
  }
}

export async function secret(path: string): Promise<string> {
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  try {
    await Fs.writeFile(path, Crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if ((await Fs.stat(path)).mode & 0o077)
    throw new LoginError(path + ' must not be readable by group or other users')
  return (await Fs.readFile(path, 'utf8')).trim()
}

export function envFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => name + '=' + JSON.stringify(value) + '\n')
    .join('')
}
