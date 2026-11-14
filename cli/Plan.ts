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

export const codexClient = 'app_EMoamEEZ73f0CkXaXp7hrann'

export const codexTokenUrl = 'https://auth.openai.com/oauth/token'

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

export async function refresh(
  path: string,
  input: refresh.Input,
): Promise<{ login: Login; refreshed: boolean }> {
  const login = await codex(path)
  if (login.expiresAt !== undefined && login.expiresAt - input.now > input.withinMs)
    return { login, refreshed: false }
  const file = await read(path)
  const tokens = file['tokens'] as Record<string, unknown>
  if (typeof tokens['refresh_token'] !== 'string' || !tokens['refresh_token'])
    throw new LoginError(path + ' holds no refresh token')
  const response = await (input.fetch ?? fetch)(input.url ?? codexTokenUrl, {
    body: JSON.stringify({
      client_id: codexClient,
      grant_type: 'refresh_token',
      refresh_token: tokens['refresh_token'],
      scope: 'openid profile email',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const text = await response.text()
  if (!response.ok)
    throw new LoginError(
      'the ChatGPT login was refused a refresh with ' + response.status + ': ' + text.slice(0, 300),
    )
  let answer: Record<string, unknown>
  try {
    answer = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new LoginError('the refresh of the ChatGPT login answered without JSON')
  }
  if (typeof answer['access_token'] !== 'string' || !answer['access_token'])
    throw new LoginError('the refresh of the ChatGPT login answered no access token')
  const fresh: Record<string, unknown> = { access_token: answer['access_token'] }
  for (const name of ['id_token', 'refresh_token'])
    if (typeof answer[name] === 'string' && answer[name]) fresh[name] = answer[name]
  await writePrivate(
    path,
    JSON.stringify(
      { ...file, last_refresh: new Date(input.now).toISOString(), tokens: { ...tokens, ...fresh } },
      null,
      2,
    ),
  )
  return { login: await codex(path), refreshed: true }
}

export declare namespace refresh {
  type Input = {
    fetch?: (input: string, init?: RequestInit) => Promise<Response>
    now: number
    url?: string
    withinMs: number
  }
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
