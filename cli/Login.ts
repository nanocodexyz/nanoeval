import { spawn } from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'
import * as Logins from '../src/Logins.ts'

export class LoginError extends Error {
  override name = 'Login.LoginError'
}

export class RefreshError extends Error {
  override name = 'Login.RefreshError'
}

export class RefusedError extends Error {
  override name = 'Login.RefusedError'
}

class HeldError extends Error {
  override name = 'Login.HeldError'
}

export type Kind = Logins.Provider

export type Login = { expiresAt: number | undefined; headers: Logins.Headers }

export type Outcome = 'adopted' | 'kept' | 'refreshed'

export type Server = {
  close(): Promise<void>
  current(kind: Kind): Promise<Login>
  vars: Record<string, string>
}

type Held = Login & { access: string; file: Record<string, any>; refresh: string; text: string }

type Fresh = {
  access: string
  expiresInSec?: number
  id?: string
  refresh?: string
  refreshExpiresInSec?: number
  scopes?: string[]
}

type Release = () => Promise<void>

export const tools = {
  claude: {
    client: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    name: 'Claude',
    refreshEarlyMs: 300_000,
    signIn: 'claude auth login',
    timeoutMs: 30_000,
    url: 'https://platform.claude.com/v1/oauth/token',
  },
  codex: {
    client: 'app_EMoamEEZ73f0CkXaXp7hrann',
    name: 'ChatGPT',
    refreshEarlyMs: 300_000,
    signIn: 'codex login',
    timeoutMs: 45_000,
    url: 'https://auth.openai.com/oauth/token',
  },
} as const

const claudeLocks = {
  refresh: { name: '.oauth_refresh.lock', staleMs: 60_000, updateMs: 5000 },
  retryMs: 100,
  write: { name: '.storage-write.lock', staleMs: 15_000, updateMs: 7500 },
} as const

const writes = { pauseMs: 500, tries: 3 } as const

const unwritten = new Map<string, { access: string; at: number; fresh: Fresh; refresh: string }>()

const codexRefusals = ['refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']

function signedOut(kind: Kind, input: { path: string; why: string }): string {
  return (
    'the ' +
    tools[kind].name +
    ' login of ' +
    input.path +
    ' is signed out: ' +
    input.why +
    '. Sign in again with ' +
    tools[kind].signIn
  )
}

function unrefreshed(kind: Kind, input: { path: string; why: string }): string {
  return 'the ' + tools[kind].name + ' login of ' + input.path + ' was not refreshed: ' + input.why
}

function claims(jwt: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

async function load(path: string): Promise<{ file: Record<string, any>; text: string }> {
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
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    throw new LoginError(path + ' is not JSON')
  }
  if (typeof file !== 'object' || file === null) throw new LoginError(path + ' is not JSON')
  return { file, text }
}

async function read(kind: Kind, path: string): Promise<Held> {
  const { file, text } = await load(path)
  if (kind === 'claude') {
    const login = file['claudeAiOauth']
    if (typeof login?.accessToken !== 'string')
      throw new LoginError(path + ' holds no Claude plan login')
    if (!login.accessToken)
      throw new RefusedError(signedOut(kind, { path, why: 'the file holds no token any more' }))
    return {
      access: login.accessToken,
      expiresAt: typeof login.expiresAt === 'number' ? login.expiresAt : undefined,
      file,
      headers: Logins.claude(login.accessToken),
      refresh: typeof login.refreshToken === 'string' ? login.refreshToken : '',
      text,
    }
  }
  const tokens = file['tokens']
  if (
    file['auth_mode'] !== 'chatgpt' ||
    typeof tokens?.access_token !== 'string' ||
    !tokens.access_token ||
    typeof tokens.account_id !== 'string'
  )
    throw new LoginError(path + ' holds no ChatGPT plan login')
  const expires = claims(tokens.access_token)?.['exp']
  return {
    access: tokens.access_token,
    expiresAt: typeof expires === 'number' ? expires * 1000 : undefined,
    file,
    headers: Logins.codex(tokens.access_token, tokens.account_id),
    refresh: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
    text,
  }
}

export async function login(kind: Kind, path: string): Promise<Login> {
  const { expiresAt, headers } = await read(kind, path)
  return { expiresAt, headers }
}

async function own(handle: Fs.FileHandle, owner: { gid: number; uid: number }): Promise<void> {
  if (process.geteuid?.() !== 0) return
  const made = await handle.stat()
  if (made.uid !== owner.uid || made.gid !== owner.gid) await handle.chown(owner.uid, owner.gid)
}

async function flock(files: readonly string[]): Promise<Release> {
  for (const file of files) {
    const made = await Fs.open(file, 'ax', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
      return undefined
    })
    if (!made) continue
    try {
      await own(made, await Fs.stat(Path.dirname(file)))
    } finally {
      await made.close()
    }
  }
  const child = spawn(
    'flock',
    [...files.flatMap((file) => ['flock', file]).slice(1), 'sh', '-c', 'echo held && exec cat'],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  )
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
  const failed = await new Promise<string | undefined>((resolve) => {
    child.stdout!.once('data', () => resolve(undefined))
    child.once('error', (error) => resolve('flock of util-linux did not start: ' + error.message))
    void closed.then((code) => resolve('flock exited with ' + code))
  })
  if (failed !== undefined) throw new Error(files.join(' and ') + ' were not locked: ' + failed)
  return async () => {
    child.stdin!.end()
    await closed
  }
}

async function claim(
  lock: string,
  options: { staleMs: number; updateMs: number },
): Promise<Release> {
  for (const started = Date.now(); ; ) {
    try {
      await Fs.mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await Fs.stat(lock).catch(() => undefined)
    if (stat && stat.mtimeMs < Date.now() - options.staleMs) await Fs.rmdir(lock).catch(() => {})
    else if (Date.now() - started > options.staleMs)
      throw new HeldError(lock + ' is held by another process')
    else if (stat) await new Promise((resolve) => setTimeout(resolve, claudeLocks.retryMs))
  }
  const timer = setInterval(() => {
    const at = new Date()
    void Fs.utimes(lock, at, at).catch(() => {})
  }, options.updateMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await Fs.rmdir(lock).catch(() => {})
  }
}

async function hold(kind: Kind, path: string): Promise<Release> {
  if (kind === 'codex') return flock([path + '.nanoeval.lock'])
  const directory = Path.dirname(path)
  const current = await claim(Path.join(directory, claudeLocks.refresh.name), claudeLocks.refresh)
  let legacy: Release | undefined
  try {
    legacy = await claim((await Fs.realpath(directory)) + '.lock', claudeLocks.refresh)
  } catch (error) {
    if (error instanceof HeldError) {
      await current()
      throw error
    }
  }
  return async () => {
    await legacy?.()
    await current()
  }
}

function code(body: unknown): string | undefined {
  const value = body as { code?: unknown; error?: unknown } | null | undefined
  const found =
    typeof value?.error === 'string'
      ? value.error
      : typeof (value?.error as { code?: unknown } | null | undefined)?.code === 'string'
        ? (value!.error as { code: string }).code
        : typeof value?.code === 'string'
          ? value.code
          : undefined
  return found !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(found) ? found : undefined
}

async function ask(
  kind: Kind,
  input: { fetch: refresh.Input['fetch']; held: Held; path: string; url: string | undefined },
): Promise<Fresh> {
  const { held, path } = input
  const tool = tools[kind]
  const stored = kind === 'claude' ? held.file['claudeAiOauth'] : held.file['tokens']
  const provenance = kind === 'codex' ? stored.oauth_provenance : undefined
  const scopes: string[] =
    kind === 'claude' && Array.isArray(stored.scopes)
      ? stored.scopes.filter((scope: unknown) => typeof scope === 'string' && scope)
      : []
  const client =
    kind === 'claude'
      ? typeof stored.clientId === 'string' && stored.clientId
        ? stored.clientId
        : tool.client
      : typeof provenance?.client_id === 'string' && provenance.client_id
        ? provenance.client_id
        : tool.client
  const url =
    input.url ??
    (typeof provenance?.issuer === 'string' && provenance.issuer
      ? provenance.issuer.replace(/\/+$/, '') + '/oauth/token'
      : tool.url)
  let response: Response
  let answer: Record<string, unknown> | undefined
  try {
    response = await (input.fetch ?? fetch)(url, {
      body: JSON.stringify({
        client_id: client,
        grant_type: 'refresh_token',
        refresh_token: held.refresh,
        ...(scopes.length ? { scope: scopes.join(' ') } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(tool.timeoutMs),
    })
    answer = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  } catch (error) {
    throw new RefreshError(
      unrefreshed(kind, {
        path,
        why: 'the token endpoint was not reached: ' + (error as Error).message,
      }),
    )
  }
  if (!response.ok) {
    const named = code(answer)
    const said = response.status + (named ? ' (' + named + ')' : '')
    const lower = named?.toLowerCase()
    const refused =
      kind === 'claude'
        ? (response.status === 400 || response.status === 401) && lower === 'invalid_grant'
        : response.status === 401 ||
          (lower !== undefined && codexRefusals.includes(lower)) ||
          (response.status === 400 && lower === 'invalid_grant')
    if (refused)
      throw new RefusedError(signedOut(kind, { path, why: 'its refresh was refused with ' + said }))
    throw new RefreshError(unrefreshed(kind, { path, why: 'the token endpoint answered ' + said }))
  }
  const text = (name: string): string | undefined =>
    typeof answer?.[name] === 'string' && answer[name] ? (answer[name] as string) : undefined
  const access = text('access_token')
  if (!access)
    throw new RefreshError(
      unrefreshed(kind, { path, why: 'the token endpoint answered no access token' }),
    )
  const refreshed = text('refresh_token')
  if (kind === 'claude') {
    const expires = answer?.['expires_in']
    if (typeof expires !== 'number' || !(expires > 0))
      throw new RefreshError(
        unrefreshed(kind, { path, why: 'the token endpoint did not say when the token ends' }),
      )
    const scope = text('scope')
    const refreshExpires = answer?.['refresh_token_expires_in']
    return {
      access,
      expiresInSec: expires,
      ...(refreshed ? { refresh: refreshed } : {}),
      ...(typeof refreshExpires === 'number' ? { refreshExpiresInSec: refreshExpires } : {}),
      ...(scope ? { scopes: scope.split(' ').filter(Boolean) } : {}),
    }
  }
  const id = text('id_token')
  const identity = id === undefined ? undefined : claims(id)
  if (id !== undefined && !identity)
    throw new RefreshError(
      unrefreshed(kind, { path, why: 'the token endpoint answered an id token that is no JWT' }),
    )
  const account = identity?.['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof account === 'string' && account !== stored.account_id)
    throw new RefreshError(
      unrefreshed(kind, { path, why: 'the token endpoint answered tokens of another account' }),
    )
  return { access, ...(id ? { id } : {}), ...(refreshed ? { refresh: refreshed } : {}) }
}

function next(
  kind: Kind,
  input: { file: Record<string, any>; fresh: Fresh; now: number },
): Record<string, any> {
  const { file, fresh, now } = input
  if (kind === 'codex')
    return {
      ...file,
      last_refresh: new Date(now).toISOString(),
      tokens: {
        ...file['tokens'],
        access_token: fresh.access,
        ...(fresh.id ? { id_token: fresh.id } : {}),
        ...(fresh.refresh ? { refresh_token: fresh.refresh } : {}),
      },
    }
  const stored = file['claudeAiOauth']
  const ends = stored.refreshTokenExpiresAt
  return {
    ...file,
    claudeAiOauth: {
      ...stored,
      accessToken: fresh.access,
      expiresAt: now + fresh.expiresInSec! * 1000,
      ...(fresh.refresh ? { refreshToken: fresh.refresh } : {}),
      ...(typeof ends === 'number' && fresh.refreshExpiresInSec !== undefined
        ? { refreshTokenExpiresAt: Math.min(ends, now + fresh.refreshExpiresInSec * 1000) }
        : {}),
      ...(fresh.scopes ? { scopes: fresh.scopes } : {}),
    },
  }
}

function format(text: string, value: unknown): string {
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1]
  return JSON.stringify(value, null, indent) + (text.endsWith('\n') ? '\n' : '')
}

async function replaceable(
  path: string,
): Promise<{ gid: number; mode: number; target: string; uid: number }> {
  const target = await Fs.realpath(path)
  const stat = await Fs.stat(target)
  if (stat.nlink > 1)
    throw new LoginError(
      path + ' has hard links, and replacing it would leave them with the old login',
    )
  try {
    await Fs.access(Path.dirname(target), Fs.constants.W_OK)
  } catch {
    throw new LoginError(path + ' cannot be replaced: its directory is not writable')
  }
  return { gid: stat.gid, mode: stat.mode & 0o777, target, uid: stat.uid }
}

async function replace(path: string, text: string): Promise<void> {
  const { gid, mode, target, uid } = await replaceable(path)
  const staged = Path.join(
    Path.dirname(target),
    '.' + Path.basename(target) + '.' + Crypto.randomBytes(6).toString('hex') + '.tmp',
  )
  try {
    const handle = await Fs.open(staged, 'wx', mode)
    try {
      await handle.writeFile(text)
      await own(handle, { gid, uid })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await Fs.rename(staged, target)
  } catch (error) {
    await Fs.rm(staged, { force: true })
    throw error
  }
}

async function commit(
  kind: Kind,
  input: { fresh: Fresh; held: Held; now: number; path: string },
): Promise<boolean> {
  const { held, path } = input
  const directory = Path.dirname(path)
  const release =
    kind === 'codex'
      ? await flock([Path.join(directory, 'auth.lock'), (await Fs.realpath(path)) + '.lock'])
      : await claim(Path.join(directory, claudeLocks.write.name), claudeLocks.write)
  try {
    const stored = await read(kind, path)
    if (stored.access !== held.access || stored.refresh !== held.refresh) return false
    await replace(
      path,
      format(stored.text, next(kind, { file: stored.file, fresh: input.fresh, now: input.now })),
    )
    return true
  } finally {
    await release()
  }
}

export async function refresh(
  kind: Kind,
  input: refresh.Input,
): Promise<{ login: Login; outcome: Outcome }> {
  const { path } = input
  const now = input.now ?? Date.now
  const due = (held: Held) =>
    held.access === input.rejected ||
    (held.expiresAt !== undefined && held.expiresAt - now() <= input.withinMs)
  const shown = ({ expiresAt, headers }: Held): Login => ({ expiresAt, headers })
  const first = await read(kind, path)
  if (!due(first)) return { login: shown(first), outcome: 'kept' }
  const failed = (why: string) => (error: unknown) => {
    if (error instanceof LoginError || error instanceof RefusedError) throw error
    throw new RefreshError(unrefreshed(kind, { path, why: why + ': ' + (error as Error).message }))
  }
  const release = await hold(kind, path).catch(failed('its lock was not taken'))
  try {
    const held = await read(kind, path)
    if (!due(held)) return { login: shown(held), outcome: 'adopted' }
    if (!held.refresh) {
      if (held.access !== input.rejected && (held.expiresAt ?? 0) > now())
        return { login: shown(held), outcome: 'kept' }
      throw new RefusedError(signedOut(kind, { path, why: 'it holds no refresh token' }))
    }
    await replaceable(path)
    const kept = unwritten.get(path)
    let answered = kept?.access === held.access && kept.refresh === held.refresh ? kept : undefined
    if (!answered) {
      unwritten.delete(path)
      try {
        const fresh = await ask(kind, { fetch: input.fetch, held, path, url: input.url })
        answered = { access: held.access, at: now(), fresh, refresh: held.refresh }
      } catch (error) {
        if (!(error instanceof RefusedError)) throw error
        const stored = await read(kind, path)
        if (stored.access === held.access) throw error
        return { login: shown(stored), outcome: 'adopted' }
      }
    }
    let written: boolean | undefined
    let why: unknown
    for (let tries = 0; written === undefined && tries < writes.tries; tries++) {
      if (tries) await new Promise((resolve) => setTimeout(resolve, writes.pauseMs))
      try {
        written = await commit(kind, { fresh: answered.fresh, held, now: answered.at, path })
      } catch (error) {
        if (error instanceof LoginError || error instanceof RefusedError) throw error
        why = error
      }
    }
    if (written === undefined) {
      unwritten.set(path, answered)
      throw new RefreshError(
        unrefreshed(kind, {
          path,
          why:
            'its refresh token is spent and its new tokens were not written: ' +
            (why as Error).message +
            '. This command writes them with its next request, and one that ends before that leaves a login to sign in again with ' +
            tools[kind].signIn,
        }),
      )
    }
    unwritten.delete(path)
    return { login: shown(await read(kind, path)), outcome: written ? 'refreshed' : 'adopted' }
  } finally {
    await release()
  }
}

export declare namespace refresh {
  type Input = {
    fetch?: (input: string, init: RequestInit) => Promise<Response>
    now?: () => number
    path: string
    rejected?: string
    url?: string
    withinMs: number
  }
}

export function urls(variables: Record<string, string | undefined>): Partial<Record<Kind, string>> {
  return {
    ...(variables['NANOEVAL_CLAUDE_TOKEN_URL']
      ? { claude: variables['NANOEVAL_CLAUDE_TOKEN_URL'] }
      : {}),
    ...(variables['NANOEVAL_CODEX_TOKEN_URL']
      ? { codex: variables['NANOEVAL_CODEX_TOKEN_URL'] }
      : {}),
  }
}

export function describe(kind: Kind, input: { login: Login; path: string }): string {
  const { expiresAt } = input.login
  return (
    'the ' +
    tools[kind].name +
    ' login of ' +
    input.path +
    (expiresAt === undefined
      ? ' holds a token that does not say when it ends'
      : ' holds a token that ends at ' + new Date(expiresAt).toISOString())
  )
}

export function keeper(
  logins: Partial<Record<Kind, string>>,
  options: keeper.Options,
): (kind: Kind, rejected?: string) => Promise<Login> {
  const states: Record<
    Kind,
    {
      failed?: string
      flying: Map<string, Promise<Login>>
      refused?: { access: string; error: RefusedError }
    }
  > = { claude: { flying: new Map() }, codex: { flying: new Map() } }
  const current = async (kind: Kind, rejected: string | undefined): Promise<Login> => {
    const path = logins[kind]
    if (!path) throw new LoginError('no ' + kind + ' login file is named')
    const state = states[kind]
    const before = await read(kind, path)
    if (state.refused?.access === before.access) throw state.refused.error
    try {
      const result = await refresh(kind, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
        path,
        ...(rejected === undefined ? {} : { rejected }),
        ...(options.urls?.[kind] ? { url: options.urls[kind] } : {}),
        withinMs: tools[kind].refreshEarlyMs,
      })
      if (result.outcome === 'refreshed')
        options.log('refreshed: ' + describe(kind, { login: result.login, path }))
      delete state.failed
      return result.login
    } catch (error) {
      if (error instanceof RefusedError) {
        state.refused = { access: before.access, error }
        options.log(error.message)
        throw error
      }
      if (!(error instanceof RefreshError)) throw error
      if (state.failed !== error.message) options.log(error.message + '; it is used as it is')
      state.failed = error.message
      return login(kind, path)
    }
  }
  return (kind, rejected) => {
    const state = states[kind]
    const key = rejected ?? ''
    const flying =
      state.flying.get(key) ?? current(kind, rejected).finally(() => state.flying.delete(key))
    state.flying.set(key, flying)
    return flying
  }
}

export declare namespace keeper {
  type Options = {
    fetch?: refresh.Input['fetch']
    log(line: string): void
    now?: () => number
    urls?: Partial<Record<Kind, string>>
  }
}

export async function serve(
  logins: Partial<Record<Kind, string>>,
  options: keeper.Options,
): Promise<Server> {
  const secret = Crypto.randomBytes(32).toString('hex')
  const expected = Crypto.createHash('sha256').update(secret).digest()
  const current = keeper(logins, options)
  const server = Http.createServer((request, response) => {
    const answer = (status: number, body: unknown) =>
      void response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify(body))
    const kind = (['claude', 'codex'] as const).find((name) => request.url === '/' + name)
    const presented = Crypto.createHash('sha256')
      .update(String(request.headers[Logins.secretHeader] ?? ''))
      .digest()
    if (!Crypto.timingSafeEqual(presented, expected))
      return answer(403, { error: 'the login secret is missing or wrong' })
    if (!kind || !logins[kind] || request.method !== 'POST')
      return answer(404, { error: 'no login is served at ' + request.method + ' ' + request.url })
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let rejected: unknown
      try {
        rejected = (JSON.parse(Buffer.concat(chunks).toString() || '{}') as { rejected?: unknown })
          .rejected
      } catch {
        return answer(400, { error: 'the request is not JSON' })
      }
      current(kind, typeof rejected === 'string' && rejected ? rejected : undefined).then(
        (held) => answer(200, { headers: held.headers }),
        (error: unknown) =>
          answer(error instanceof RefusedError || error instanceof LoginError ? 401 : 500, {
            error: error instanceof Error ? error.message : String(error),
          }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
    current: (kind) => current(kind),
    vars: {
      ...(logins.claude ? { CLAUDE_LOGIN_URL: url + '/claude' } : {}),
      ...(logins.codex ? { CHATGPT_LOGIN_URL: url + '/codex' } : {}),
      LOGIN_SECRET: secret,
    },
  }
}
