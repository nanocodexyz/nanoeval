import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'
import { Relay } from 'nanocode-egress/relay'

export class LoginError extends Error {
  override name = 'Plan.LoginError'
}

export type Login = {
  expiresAt: number | undefined
  vars: Record<string, string>
}

export type RelayServer = {
  close(): Promise<void>
  vars: Record<string, string>
}

async function read(path: string): Promise<Record<string, any>> {
  let text: string
  try {
    const stat = await Fs.stat(path)
    if (stat.mode & 0o077)
      throw new LoginError(path + ' must not be readable by group or other users')
    text = await Fs.readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof LoginError) throw error
    throw new LoginError('the login file cannot be read: ' + (error as Error).message)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new LoginError(path + ' is not JSON')
  }
}

export async function claude(path: string): Promise<Login> {
  const login = (await read(path))['claudeAiOauth']
  if (typeof login?.accessToken !== 'string' || !login.accessToken)
    throw new LoginError(path + ' holds no Claude plan login')
  return {
    expiresAt: typeof login.expiresAt === 'number' ? login.expiresAt : undefined,
    vars: { CLAUDE_CODE_OAUTH_TOKEN: login.accessToken },
  }
}

export async function codex(path: string): Promise<Login> {
  const file = await read(path)
  const tokens = file['tokens']
  if (
    file['auth_mode'] !== 'chatgpt' ||
    typeof tokens?.access_token !== 'string' ||
    typeof tokens.account_id !== 'string'
  )
    throw new LoginError(path + ' holds no ChatGPT plan login')
  let expiresAt: number | undefined
  try {
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[1] ?? '', 'base64url').toString(),
    )
    if (typeof claims.exp === 'number') expiresAt = claims.exp * 1000
  } catch {}
  return {
    expiresAt,
    vars: { CHATGPT_ACCESS_TOKEN: tokens.access_token, CHATGPT_ACCOUNT_ID: tokens.account_id },
  }
}

export async function relay(): Promise<RelayServer> {
  const secret = Crypto.randomBytes(32).toString('hex')
  const server = Relay.create({ secret })
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
