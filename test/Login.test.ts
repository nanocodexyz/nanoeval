import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, before, test } from 'node:test'
import * as Login from '../cli/Login.ts'
import * as Logins from '../src/Logins.ts'

const kinds = ['claude', 'codex'] as const
const now = 1_800_000_000_000
const hour = 3_600_000
const early = Login.tools.codex.refreshEarlyMs

let directory: string

before(() => {
  directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-login-'))
})

after(() => {
  Fs.rmSync(directory, { force: true, recursive: true })
})

function jwt(claims: unknown): string {
  return ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join(
    '.',
  )
}

function access(kind: Login.Kind, input: { endsAt: number; n: number }): string {
  return kind === 'codex'
    ? jwt({ exp: input.endsAt / 1000, n: input.n })
    : 'claude-access-' + input.n
}

function home(): string {
  return Fs.mkdtempSync(Path.join(directory, 'home-'))
}

function file(
  kind: Login.Kind,
  input: { endsAt: number; extra?: Record<string, unknown>; n?: number; refresh?: string },
): string {
  const refresh = input.refresh ?? 'refresh-0'
  const held = access(kind, { endsAt: input.endsAt, n: input.n ?? 0 })
  const path = Path.join(home(), kind === 'codex' ? 'auth.json' : '.credentials.json')
  const text =
    kind === 'codex'
      ? JSON.stringify(
          {
            auth_mode: 'chatgpt',
            OPENAI_API_KEY: null,
            tokens: {
              id_token: jwt({ email: 'owner@example.com' }),
              access_token: held,
              refresh_token: refresh,
              account_id: 'account-1',
              ...input.extra,
            },
            last_refresh: '2026-11-05T05:45:29.123456789Z',
          },
          null,
          2,
        )
      : JSON.stringify({
          claudeAiOauth: {
            accessToken: held,
            refreshToken: refresh,
            expiresAt: input.endsAt,
            scopes: ['user:inference', 'user:profile'],
            subscriptionType: 'max',
            rateLimitTier: 'default_claude_max_20x',
            ...input.extra,
          },
          mcpOAuth: { kept: true },
        })
  Fs.writeFileSync(path, text, { mode: 0o600 })
  return path
}

function parsed(path: string): Record<string, any> {
  return JSON.parse(Fs.readFileSync(path, 'utf8'))
}

function tokens(kind: Login.Kind, path: string): { access: string; refresh: string } {
  const stored = parsed(path)
  return kind === 'codex'
    ? { access: stored['tokens'].access_token, refresh: stored['tokens'].refresh_token }
    : { access: stored['claudeAiOauth'].accessToken, refresh: stored['claudeAiOauth'].refreshToken }
}

type Issuer = {
  asked: { body: Record<string, string>; url: string }[]
  before?: () => void
  current: string
  delayMs: number
  down?: { body: unknown; status: number }
  extra: Record<string, unknown>
  fetch(url: string, init: RequestInit): Promise<Response>
  grants: number
  lifetimeMs: number
  rotate: boolean
}

function issuer(kind: Login.Kind): Issuer {
  const state: Issuer = {
    asked: [],
    current: 'refresh-0',
    delayMs: 0,
    extra: {},
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, string>
      state.asked.push({ body, url })
      state.before?.()
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
      if (state.down) return Response.json(state.down.body, { status: state.down.status })
      if (body['refresh_token'] !== state.current)
        return kind === 'codex'
          ? Response.json(
              {
                error: {
                  code: 'refresh_token_reused',
                  message: 'already used: ' + body['refresh_token'],
                },
              },
              { status: 401 },
            )
          : Response.json(
              { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' },
              { status: 400 },
            )
      state.grants++
      if (state.rotate) state.current = 'refresh-' + state.grants
      const fresh = access(kind, { endsAt: now + state.lifetimeMs, n: state.grants })
      return Response.json(
        kind === 'codex'
          ? {
              access_token: fresh,
              id_token: jwt({
                'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
                n: state.grants,
              }),
              ...(state.rotate ? { refresh_token: state.current } : {}),
              ...state.extra,
            }
          : {
              access_token: fresh,
              expires_in: state.lifetimeMs / 1000,
              ...(state.rotate ? { refresh_token: state.current } : {}),
              scope: 'user:inference user:profile user:file_upload',
              ...state.extra,
            },
      )
    },
    grants: 0,
    lifetimeMs: 240 * hour,
    rotate: true,
  }
  return state
}

function clean(lines: readonly string[], path: string): void {
  const said = lines.join('\n')
  const { access: held, refresh } = tokens(path.endsWith('auth.json') ? 'codex' : 'claude', path)
  for (const secret of [held, refresh, 'refresh-0', 'refresh-1', 'claude-access-', 'eyJleHAi'])
    assert.ok(!said.includes(secret), 'a line holds ' + secret + ': ' + said)
}

for (const kind of kinds)
  test('a ' + kind + ' login whose token ends later is read and left alone', async () => {
    const path = file(kind, { endsAt: now + hour })
    const before = Fs.readFileSync(path, 'utf8')
    const endpoint = issuer(kind)
    const kept = await Login.refresh(kind, {
      path: path,
      fetch: endpoint.fetch,
      now: () => now,
      withinMs: early,
    })
    assert.equal(kept.outcome, 'kept')
    assert.equal(kept.login.expiresAt, now + hour)
    assert.equal(Logins.token(kept.login.headers), tokens(kind, path).access)
    if (kind === 'codex') assert.equal(kept.login.headers['chatgpt-account-id'], 'account-1')
    assert.equal(endpoint.asked.length, 0)
    assert.equal(Fs.readFileSync(path, 'utf8'), before)
    assert.deepEqual(Fs.readdirSync(Path.dirname(path)), [Path.basename(path)])
    assert.ok(!JSON.stringify(kept).includes('refresh-0'))
  })

for (const kind of kinds)
  for (const [name, endsAt] of [
    ['ended', now - hour],
    ['ends within five minutes', now + early - 1000],
  ] as const)
    test(
      'a ' + kind + ' login whose token ' + name + ' is refreshed as its tool does',
      async () => {
        const path = file(kind, { endsAt })
        const before = parsed(path)
        const endpoint = issuer(kind)
        const result = await Login.refresh(kind, {
          path: path,
          fetch: endpoint.fetch,
          now: () => now,
          withinMs: early,
        })
        assert.equal(result.outcome, 'refreshed')
        assert.equal(result.login.expiresAt, now + endpoint.lifetimeMs)
        assert.deepEqual(endpoint.asked, [
          kind === 'codex'
            ? {
                body: {
                  client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
                  grant_type: 'refresh_token',
                  refresh_token: 'refresh-0',
                },
                url: 'https://auth.openai.com/oauth/token',
              }
            : {
                body: {
                  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
                  grant_type: 'refresh_token',
                  refresh_token: 'refresh-0',
                  scope: 'user:inference user:profile',
                },
                url: 'https://platform.claude.com/v1/oauth/token',
              },
        ])
        const text = Fs.readFileSync(path, 'utf8')
        const stored = JSON.parse(text)
        const fresh = access(kind, { endsAt: now + endpoint.lifetimeMs, n: 1 })
        assert.equal(Logins.token(result.login.headers), fresh)
        if (kind === 'codex') {
          assert.deepEqual(stored, {
            ...before,
            last_refresh: new Date(now).toISOString(),
            tokens: {
              ...before['tokens'],
              access_token: fresh,
              id_token: stored.tokens.id_token,
              refresh_token: 'refresh-1',
            },
          })
          assert.notEqual(stored.tokens.id_token, before['tokens'].id_token)
          assert.deepEqual(Object.keys(stored), Object.keys(before))
          assert.deepEqual(Object.keys(stored.tokens), Object.keys(before['tokens']))
          assert.equal(text, JSON.stringify(stored, null, 2))
          assert.deepEqual(Fs.readdirSync(Path.dirname(path)).sort(), [
            'auth.json',
            'auth.json.lock',
            'auth.json.nanoeval.lock',
            'auth.lock',
          ])
        } else {
          assert.deepEqual(stored, {
            ...before,
            claudeAiOauth: {
              ...before['claudeAiOauth'],
              accessToken: fresh,
              expiresAt: now + endpoint.lifetimeMs,
              refreshToken: 'refresh-1',
              scopes: ['user:inference', 'user:profile', 'user:file_upload'],
            },
          })
          assert.deepEqual(Object.keys(stored.claudeAiOauth), Object.keys(before['claudeAiOauth']))
          assert.equal(text, JSON.stringify(stored))
          assert.deepEqual(Fs.readdirSync(Path.dirname(path)), ['.credentials.json'])
          assert.ok(!Fs.existsSync(Path.dirname(path) + '.lock'))
        }
        for (const name of Fs.readdirSync(Path.dirname(path)))
          assert.equal(Fs.statSync(Path.join(Path.dirname(path), name)).mode & 0o777, 0o600)
      },
    )

for (const kind of kinds)
  test(
    'a ' + kind + ' token that the provider rejects is refreshed once, and the request sent again',
    async () => {
      const path = file(kind, { endsAt: now + hour })
      const endpoint = issuer(kind)
      const lines: string[] = []
      const current = Login.keeper(
        { [kind]: path },
        { fetch: endpoint.fetch, log: (line) => lines.push(line), now: () => now },
      )
      const accepted = { token: access(kind, { endsAt: now + endpoint.lifetimeMs, n: 1 }) }
      const sent: (string | undefined)[] = []
      const send = () =>
        Logins.send({
          attempt: async (headers) => {
            sent.push(Logins.token(headers))
            return new Response(null, {
              status: Logins.token(headers) === accepted.token ? 200 : 401,
            })
          },
          credential: async (rejected) => (await current(kind, rejected)).headers,
        })
      assert.equal((await send()).status, 200)
      assert.deepEqual(sent, [access(kind, { endsAt: now + hour, n: 0 }), accepted.token])
      assert.equal(endpoint.grants, 1)
      assert.equal(tokens(kind, path).access, accepted.token)
      assert.equal(tokens(kind, path).refresh, 'refresh-1')
      assert.equal((await send()).status, 200)
      assert.equal(sent.length, 3)

      accepted.token = 'none'
      assert.equal((await send()).status, 401)
      assert.equal(sent.length, 5, 'a request is sent again once, not until it is accepted')
      assert.equal(endpoint.grants, 2, 'each token that is rejected is refreshed once')
      assert.equal(lines.length, 2)
      for (const line of lines)
        assert.match(
          line,
          /^refreshed: the (Claude|ChatGPT) login of .* holds a token that ends at /,
        )
      clean(lines, path)
    },
  )

for (const kind of kinds)
  test('a ' + kind + ' login whose refresh is refused says that it is signed out', async () => {
    const path = file(kind, { endsAt: now - hour })
    const before = Fs.readFileSync(path, 'utf8')
    const endpoint = issuer(kind)
    endpoint.down =
      kind === 'codex'
        ? {
            body: { error: { code: 'refresh_token_expired', message: 'refresh-0 has expired' } },
            status: 401,
          }
        : {
            body: { error: 'invalid_grant', error_description: 'refresh-0 not found or invalid' },
            status: 400,
          }
    const lines: string[] = []
    const current = Login.keeper(
      { [kind]: path },
      { fetch: endpoint.fetch, log: (line) => lines.push(line), now: () => now },
    )
    const refused = await current(kind).then(
      () => undefined,
      (error: unknown) => error,
    )
    assert.ok(refused instanceof Login.RefusedError)
    assert.equal(
      refused.message,
      kind === 'codex'
        ? 'the ChatGPT login of ' +
            path +
            ' is signed out: its refresh was refused with 401 (refresh_token_expired). Sign in again with codex login'
        : 'the Claude login of ' +
            path +
            ' is signed out: its refresh was refused with 400 (invalid_grant). Sign in again with claude auth login',
    )
    assert.equal(Fs.readFileSync(path, 'utf8'), before)
    await assert.rejects(current(kind), Login.RefusedError)
    await assert.rejects(current(kind, tokens(kind, path).access), Login.RefusedError)
    assert.equal(endpoint.asked.length, 1, 'a refused login is not asked for again')
    assert.deepEqual(lines, [refused.message])
    clean(lines, path)

    Fs.copyFileSync(file(kind, { endsAt: now + hour, n: 5 }), path)
    assert.equal((await current(kind)).expiresAt, now + hour, 'a new sign-in is used at once')
  })

for (const kind of kinds)
  test('a ' + kind + ' refresh token that rotates is never sent twice', async () => {
    const path = file(kind, { endsAt: now - hour })
    const endpoint = issuer(kind)
    endpoint.lifetimeMs = early / 2
    for (const n of [1, 2, 3]) {
      const result = await Login.refresh(kind, {
        path: path,
        fetch: endpoint.fetch,
        now: () => now,
        withinMs: early,
      })
      assert.equal(result.outcome, 'refreshed')
      assert.equal(tokens(kind, path).refresh, 'refresh-' + n)
    }
    assert.deepEqual(
      endpoint.asked.map((asked) => asked.body['refresh_token']),
      ['refresh-0', 'refresh-1', 'refresh-2'],
    )
    endpoint.rotate = false
    await Login.refresh(kind, {
      path: path,
      fetch: endpoint.fetch,
      now: () => now,
      withinMs: early,
    })
    assert.equal(tokens(kind, path).refresh, 'refresh-3', 'an answer without one keeps the old')
    assert.equal(endpoint.grants, 4)
  })

for (const kind of kinds)
  test('two Workers that refresh a ' + kind + ' login at once make one refresh', async () => {
    const path = file(kind, { endsAt: now - hour })
    const endpoint = issuer(kind)
    endpoint.delayMs = 300
    const lines: string[] = []
    const workers = [1, 2, 3].map(() =>
      Login.keeper(
        { [kind]: path },
        { fetch: endpoint.fetch, log: (line) => lines.push(line), now: () => now },
      ),
    )
    const held = await Promise.all(workers.map((current) => current(kind)))
    assert.equal(endpoint.asked.length, 1)
    assert.equal(endpoint.grants, 1)
    const fresh = access(kind, { endsAt: now + endpoint.lifetimeMs, n: 1 })
    assert.deepEqual(
      held.map((login) => Logins.token(login.headers)),
      [fresh, fresh, fresh],
    )
    assert.equal(lines.length, 1)
    const same = await Promise.all([workers[0]!(kind), workers[0]!(kind)])
    assert.equal(same[0], same[1])
    assert.equal(endpoint.asked.length, 1)
  })

test('two plan refresh commands at once make one refresh, and a signed-out login ends a command with 1', async () => {
  const path = file('codex', { endsAt: Date.now() + hour })
  const asked: string[] = []
  let down = false
  const server = Http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      asked.push(JSON.parse(Buffer.concat(chunks).toString()).refresh_token)
      setTimeout(() => {
        response.writeHead(down ? 400 : 200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            down
              ? { error: 'invalid_grant' }
              : {
                  access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 864_000 }),
                  refresh_token: 'refresh-1',
                },
          ),
        )
      }, 300)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const command = (args: readonly string[]) =>
    new Promise<{ code: number | null; err: string; out: string }>((resolve) => {
      const child = spawn(process.execPath, [Path.resolve('cli/nanoeval.ts'), ...args], {
        env: {
          ...process.env,
          NANOEVAL_CODEX_TOKEN_URL:
            'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/oauth/token',
        },
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.once('close', (code) =>
        resolve({ code, err: Buffer.concat(err).toString(), out: Buffer.concat(out).toString() }),
      )
    })
  const run = (withinSec: number) =>
    command(['plan', 'refresh', '--codex-login', path, '--within-sec', String(withinSec)])
  try {
    const both = await Promise.all([run(7200), run(7200)])
    assert.deepEqual(asked, ['refresh-0'])
    assert.deepEqual(
      both.map((ended) => ended.code),
      [0, 0],
    )
    assert.deepEqual(both.map((ended) => ended.out.split(':')[0]).sort(), ['kept', 'refreshed'])
    for (const ended of both)
      assert.match(ended.out, /: the ChatGPT login of .*auth\.json holds a token that ends at 20/)
    assert.equal(tokens('codex', path).refresh, 'refresh-1')

    down = true
    const refused = await run(864_000 * 2)
    assert.equal(refused.code, 1)
    assert.equal(
      refused.err.trim(),
      'nanoeval: the ChatGPT login of ' +
        path +
        ' is signed out: its refresh was refused with 400 (invalid_grant). Sign in again with codex login',
    )
    assert.equal(tokens('codex', path).refresh, 'refresh-1')
    clean([...both.map((ended) => ended.out + ended.err), refused.out, refused.err], path)

    const ended = file('codex', { endsAt: Date.now() - hour })
    const lab = Path.join(home(), 'lab')
    const evaluation = await command([
      'revision',
      '--nanocode',
      'pinned',
      '--nanocode-ts',
      'pinned',
      '--eval',
      'samples',
      '--agent',
      'luna=codex:gpt-6-luna',
      '--codex-login',
      ended,
      '--lab',
      lab,
    ])
    assert.equal(evaluation.code, 1)
    assert.equal(
      evaluation.err.trim(),
      'nanoeval: the ChatGPT login of ' +
        ended +
        ' is signed out: its refresh was refused with 400 (invalid_grant). Sign in again with codex login',
    )
    assert.ok(!Fs.existsSync(lab), 'an evaluation on a login that is signed out builds nothing')
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

for (const kind of kinds)
  test(
    'tokens that the tool itself wrote while nanoeval refreshed a ' + kind + ' login are kept',
    async () => {
      const path = file(kind, { endsAt: now - hour })
      const theirs = file(kind, { endsAt: now + 2 * hour, n: 7, refresh: 'refresh-of-the-tool' })
      const endpoint = issuer(kind)
      endpoint.before = () => Fs.copyFileSync(theirs, path)
      const result = await Login.refresh(kind, {
        path: path,
        fetch: endpoint.fetch,
        now: () => now,
        withinMs: early,
      })
      assert.equal(result.outcome, 'adopted')
      assert.equal(endpoint.grants, 1)
      assert.equal(Fs.readFileSync(path, 'utf8'), Fs.readFileSync(theirs, 'utf8'))
      assert.equal(result.login.expiresAt, now + 2 * hour)

      const second = file(kind, { endsAt: now - hour })
      endpoint.current = 'spent'
      endpoint.before = () => Fs.copyFileSync(theirs, second)
      const adopted = await Login.refresh(kind, {
        path: second,
        fetch: endpoint.fetch,
        now: () => now,
        withinMs: early,
      })
      assert.equal(adopted.outcome, 'adopted', 'a refusal after the tool refreshed is no sign-out')
      assert.equal(adopted.login.expiresAt, now + 2 * hour)
    },
  )

for (const kind of kinds)
  test(
    'a ' + kind + ' refresh that fails without a refusal leaves the file and the login in use',
    async () => {
      const path = file(kind, { endsAt: now + early / 2 })
      const before = Fs.readFileSync(path, 'utf8')
      const endpoint = issuer(kind)
      const lines: string[] = []
      const current = Login.keeper(
        { [kind]: path },
        { fetch: endpoint.fetch, log: (line) => lines.push(line), now: () => now },
      )
      const name = kind === 'codex' ? 'ChatGPT' : 'Claude'
      const cases: [Issuer['down'] | Error | Record<string, unknown>, string][] = [
        [{ body: { error: 'server_error' }, status: 503 }, 'answered 503 \\(server_error\\)'],
        [{ body: 'refresh-0 <html>', status: 502 }, 'answered 502'],
        [{ body: { error: 'invalid_scope' }, status: 400 }, 'answered 400 \\(invalid_scope\\)'],
        [new Error('connect ECONNREFUSED'), 'was not reached: connect ECONNREFUSED'],
        [{ access_token: '' }, 'answered no access token'],
        kind === 'codex'
          ? [{ id_token: 'not a token' }, 'answered an id token that is no JWT']
          : [{ expires_in: 'soon' }, 'did not say when the token ends'],
        ...(kind === 'codex'
          ? ([
              [
                {
                  id_token: jwt({
                    'https://api.openai.com/auth': { chatgpt_account_id: 'account-2' },
                  }),
                },
                'answered tokens of another account',
              ],
            ] as [Record<string, unknown>, string][])
          : []),
      ]
      for (const [failure, said] of cases) {
        delete endpoint.down
        endpoint.extra = {}
        const fetch =
          failure instanceof Error
            ? async () => {
                throw failure
              }
            : endpoint.fetch
        if (failure && !(failure instanceof Error) && 'status' in failure)
          endpoint.down = failure as NonNullable<Issuer['down']>
        else if (failure && !(failure instanceof Error)) endpoint.extra = failure
        endpoint.current = 'refresh-0'
        const pattern = new RegExp(
          '^the ' + name + ' login of .* was not refreshed: the token endpoint ' + said + '$',
        )
        await assert.rejects(
          Login.refresh(kind, { path: path, fetch, now: () => now, withinMs: early }),
          (error: unknown) => error instanceof Login.RefreshError && pattern.test(error.message),
        )
        assert.equal(Fs.readFileSync(path, 'utf8'), before)
      }
      endpoint.extra = {}
      endpoint.down = { body: {}, status: 500 }
      const held = await current(kind)
      assert.equal(Logins.token(held.headers), tokens(kind, path).access)
      await current(kind)
      assert.deepEqual(lines, [
        'the ' +
          name +
          ' login of ' +
          path +
          ' was not refreshed: the token endpoint answered 500; it is used as it is',
      ])
      clean(lines, path)
      delete endpoint.down
      endpoint.current = 'refresh-0'
      await current(kind)
      assert.equal(lines.length, 2)
      assert.match(lines[1]!, /^refreshed: /)
    },
  )

test('a login file that others can read, is missing, is not JSON or holds no login is refused', async () => {
  const path = file('claude', { endsAt: now + hour })
  Fs.chmodSync(path, 0o644)
  await assert.rejects(Login.login('claude', path), /must not be readable/)
  await assert.rejects(
    Login.login('claude', Path.join(directory, 'missing.json')),
    Login.LoginError,
  )
  const text = Path.join(directory, 'text.json')
  Fs.writeFileSync(text, 'not json', { mode: 0o600 })
  await assert.rejects(Login.login('codex', text), /is not JSON/)
  Fs.writeFileSync(text, '{}')
  await assert.rejects(Login.login('claude', text), /holds no Claude plan login/)
  Fs.writeFileSync(text, JSON.stringify({ OPENAI_API_KEY: 'key', auth_mode: 'apikey' }))
  await assert.rejects(Login.login('codex', text), /holds no ChatGPT plan login/)
  Fs.writeFileSync(
    text,
    JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: 0, refreshToken: '' } }),
  )
  await assert.rejects(
    Login.login('claude', text),
    (error: unknown) =>
      error instanceof Login.RefusedError &&
      error.message ===
        'the Claude login of ' +
          text +
          ' is signed out: the file holds no token any more. Sign in again with claude auth login',
  )
})

test('a login without a refresh token is used until its token ends, and is signed out then', async () => {
  for (const kind of kinds) {
    const endpoint = issuer(kind)
    const soon = file(kind, { endsAt: now + early / 2, refresh: '' })
    const kept = await Login.refresh(kind, {
      path: soon,
      fetch: endpoint.fetch,
      now: () => now,
      withinMs: early,
    })
    assert.equal(kept.outcome, 'kept')
    await assert.rejects(
      Login.refresh(kind, {
        path: file(kind, { endsAt: now - 1, refresh: '' }),
        fetch: endpoint.fetch,
        now: () => now,
        withinMs: early,
      }),
      /is signed out: it holds no refresh token\. Sign in again with/,
    )
    assert.equal(endpoint.asked.length, 0)
  }
})

test('a login file that cannot be replaced whole is refused before its refresh token is spent', async () => {
  const endpoint = issuer('codex')
  const linked = file('codex', { endsAt: now - hour })
  Fs.linkSync(linked, linked + '.copy')
  await assert.rejects(
    Login.refresh('codex', {
      path: linked,
      fetch: endpoint.fetch,
      now: () => now,
      withinMs: early,
    }),
    /has hard links/,
  )
  assert.equal(endpoint.asked.length, 0)

  const target = file('codex', { endsAt: now - hour })
  const link = Path.join(home(), 'auth.json')
  Fs.symlinkSync(target, link)
  const result = await Login.refresh('codex', {
    path: link,
    fetch: endpoint.fetch,
    now: () => now,
    withinMs: early,
  })
  assert.equal(result.outcome, 'refreshed')
  assert.ok(Fs.lstatSync(link).isSymbolicLink())
  assert.equal(tokens('codex', target).refresh, 'refresh-1')
  assert.ok(Fs.existsSync(target + '.lock'), 'the lock of the file that Codex replaces')
})

test(
  'a login whose directory cannot be written is used as it is and never asked for',
  { skip: process.getuid?.() === 0 },
  async () => {
    for (const kind of kinds) {
      const endpoint = issuer(kind)
      const path = file(kind, { endsAt: now + early / 2 })
      Fs.chmodSync(Path.dirname(path), 0o500)
      try {
        await assert.rejects(
          Login.refresh(kind, { fetch: endpoint.fetch, now: () => now, path, withinMs: early }),
          (error: unknown) =>
            error instanceof Login.RefreshError &&
            /^the (Claude|ChatGPT) login of .* was not refreshed: its lock was not taken: EACCES/.test(
              error.message,
            ),
        )
        assert.equal(endpoint.asked.length, 0)
      } finally {
        Fs.chmodSync(Path.dirname(path), 0o700)
      }
    }
  },
)

test('a Claude refresh waits for the lock of Claude Code and takes one that went stale', async () => {
  const endpoint = issuer('claude')
  const path = file('claude', { endsAt: now - hour })
  const lock = Path.join(Path.dirname(path), '.oauth_refresh.lock')
  Fs.mkdirSync(lock)
  const started = Date.now()
  setTimeout(() => Fs.rmdirSync(lock), 400)
  const waited = await Login.refresh('claude', {
    path: path,
    fetch: endpoint.fetch,
    now: () => now,
    withinMs: early,
  })
  assert.equal(waited.outcome, 'refreshed')
  assert.ok(Date.now() - started >= 400, 'the refresh waited for the lock')

  const stale = file('claude', { endsAt: now - hour, refresh: 'refresh-1' })
  const left = Path.join(Path.dirname(stale), '.oauth_refresh.lock')
  const legacy = Path.dirname(stale) + '.lock'
  const write = Path.join(Path.dirname(stale), '.storage-write.lock')
  for (const [directory, ageMs] of [
    [left, 61_000],
    [legacy, 61_000],
    [write, 16_000],
  ] as const) {
    Fs.mkdirSync(directory)
    Fs.utimesSync(directory, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs))
  }
  endpoint.before = () => {
    held = Fs.existsSync(left) && Fs.existsSync(legacy)
  }
  let held = false
  const taken = await Login.refresh('claude', {
    path: stale,
    fetch: endpoint.fetch,
    now: () => now,
    withinMs: early,
  })
  assert.equal(taken.outcome, 'refreshed')
  assert.ok(held, 'both locks of Claude Code are held while it asks')
  assert.ok(!Fs.existsSync(left) && !Fs.existsSync(legacy) && !Fs.existsSync(write))
})

test('a Codex refresh writes under the locks of Codex, and asks under none of them', async () => {
  const endpoint = issuer('codex')
  const path = file('codex', { endsAt: now - hour })
  const lock = Path.join(Path.dirname(path), 'auth.lock')
  let holder: ReturnType<typeof spawn> | undefined
  endpoint.before = () => {
    holder = spawn('flock', [lock, 'sleep', '0.5'], { stdio: 'ignore' })
  }
  const started = Date.now()
  const result = await Login.refresh('codex', {
    path: path,
    fetch: endpoint.fetch,
    now: () => now,
    withinMs: early,
  })
  assert.equal(result.outcome, 'refreshed')
  assert.ok(holder)
  assert.ok(Date.now() - started >= 400, 'the write waited for the lock that Codex held')
})

test('a Claude refresh sends the client and the scopes of the file, and keeps the earlier end of its refresh token', async () => {
  const endpoint = issuer('claude')
  endpoint.extra = { refresh_token_expires_in: 86_400 * 30 }
  const path = file('claude', {
    endsAt: now - hour,
    extra: { clientId: 'client-of-the-file', refreshTokenExpiresAt: now + 86_400_000 },
  })
  await Login.refresh('claude', {
    path: path,
    fetch: endpoint.fetch,
    now: () => now,
    withinMs: early,
  })
  assert.equal(endpoint.asked[0]!.body['client_id'], 'client-of-the-file')
  assert.equal(parsed(path)['claudeAiOauth'].refreshTokenExpiresAt, now + 86_400_000)

  const bare = file('claude', { endsAt: now - hour, extra: { scopes: undefined } })
  endpoint.current = 'refresh-0'
  endpoint.extra = { refresh_token_expires_in: 86_400, scope: undefined }
  await Login.refresh('claude', {
    path: bare,
    fetch: endpoint.fetch,
    now: () => now,
    withinMs: early,
  })
  assert.equal('scope' in endpoint.asked[1]!.body, false)
  assert.equal('refreshTokenExpiresAt' in parsed(bare)['claudeAiOauth'], false)
  assert.equal('scopes' in parsed(bare)['claudeAiOauth'], false)
})

test('a Codex refresh goes to the issuer and the client that the file records', async () => {
  const endpoint = issuer('codex')
  const path = file('codex', {
    endsAt: now - hour,
    extra: {
      oauth_provenance: { client_id: 'client-of-the-file', issuer: 'https://issuer.example/' },
    },
  })
  await Login.refresh('codex', {
    path: path,
    fetch: endpoint.fetch,
    now: () => now,
    withinMs: early,
  })
  assert.deepEqual(endpoint.asked[0], {
    body: {
      client_id: 'client-of-the-file',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-0',
    },
    url: 'https://issuer.example/oauth/token',
  })
  endpoint.current = 'refresh-0'
  await Login.refresh('codex', {
    path: file('codex', { endsAt: now - hour }),
    fetch: endpoint.fetch,
    now: () => now,
    url: 'http://127.0.0.1:1/token',
    withinMs: early,
  })
  assert.equal(endpoint.asked[1]!.url, 'http://127.0.0.1:1/token')
  assert.deepEqual(
    Login.urls({ NANOEVAL_CLAUDE_TOKEN_URL: 'http://a', NANOEVAL_CODEX_TOKEN_URL: '' }),
    { claude: 'http://a' },
  )
})

test('the login service gives a Worker the headers of each login, and only with its secret', async () => {
  const claude = file('claude', { endsAt: now - hour })
  const codex = file('codex', { endsAt: now + hour })
  const endpoints = { claude: issuer('claude'), codex: issuer('codex') }
  const lines: string[] = []
  const server = await Login.serve(
    { claude, codex },
    {
      fetch: (url, init) => endpoints[url.includes('claude') ? 'claude' : 'codex'].fetch(url, init),
      log: (line) => lines.push(line),
      now: () => now,
    },
  )
  try {
    assert.deepEqual(Object.keys(server.vars).sort(), [
      'CHATGPT_LOGIN_URL',
      'CLAUDE_LOGIN_URL',
      'LOGIN_SECRET',
    ])
    assert.ok(!JSON.stringify(server.vars).includes('access'))
    assert.ok(Logins.held(server.vars, 'claude') && Logins.held(server.vars, 'codex'))
    const fresh = access('claude', { endsAt: 0, n: 1 })
    assert.deepEqual(await Logins.headers(server.vars, { provider: 'claude' }), {
      authorization: 'Bearer ' + fresh,
    })
    assert.equal(endpoints.claude.grants, 1)
    const held = tokens('codex', codex).access
    assert.deepEqual(await Logins.headers(server.vars, { provider: 'codex' }), {
      authorization: 'Bearer ' + held,
      'chatgpt-account-id': 'account-1',
    })
    assert.equal(endpoints.codex.grants, 0)
    const again = await Logins.headers(server.vars, { provider: 'codex', rejected: held })
    assert.equal(endpoints.codex.grants, 1)
    assert.equal(Logins.token(again), tokens('codex', codex).access)
    assert.notEqual(Logins.token(again), held)

    await assert.rejects(
      Logins.headers({ ...server.vars, LOGIN_SECRET: 'wrong' }, { provider: 'codex' }),
      (error: unknown) =>
        error instanceof Logins.ServiceError &&
        /answered 403: the login secret/.test(error.message),
    )
    const bare = await fetch(server.vars['CHATGPT_LOGIN_URL']!, { body: '{}', method: 'POST' })
    assert.equal(bare.status, 403)
    assert.ok(!(await bare.text()).includes('Bearer'))
    const elsewhere = await fetch(server.vars['CHATGPT_LOGIN_URL']! + '/other', {
      body: '{}',
      headers: { [Logins.secretHeader]: server.vars['LOGIN_SECRET']! },
      method: 'POST',
    })
    assert.equal(elsewhere.status, 404)

    endpoints.codex.down = { body: { error: 'refresh_token_invalidated' }, status: 400 }
    Fs.copyFileSync(file('codex', { endsAt: now - hour }), codex)
    const refused = await Logins.headers(server.vars, { provider: 'codex' }).then(
      () => undefined,
      (error: unknown) => error,
    )
    assert.ok(refused instanceof Logins.RefusedError)
    assert.match(
      refused.message,
      /^the ChatGPT login of .* is signed out: its refresh was refused with 400 \(refresh_token_invalidated\)\. Sign in again with codex login$/,
    )
    Fs.chmodSync(claude, 0o644)
    await assert.rejects(Logins.headers(server.vars, { provider: 'claude' }), Logins.RefusedError)
    clean(lines, codex)
  } finally {
    await server.close()
  }
  await assert.rejects(Logins.headers(server.vars, { provider: 'codex' }), Logins.ServiceError)
})

test('a login that a variable holds is sent as it is, and a rejected one is not sent again', async () => {
  const variables = { CHATGPT_ACCESS_TOKEN: 'fixed', CHATGPT_ACCOUNT_ID: 'account-1' }
  assert.equal(Logins.held(variables, 'codex'), true)
  assert.equal(Logins.held(variables, 'claude'), false)
  assert.equal(Logins.held({ CHATGPT_ACCESS_TOKEN: 'fixed' }, 'codex'), false)
  assert.equal(Logins.held({ CLAUDE_CODE_OAUTH_TOKEN: 'fixed' }, 'claude'), true)
  await assert.rejects(Logins.headers(variables, { provider: 'claude' }), Logins.RefusedError)
  let attempts = 0
  const response = await Logins.send({
    attempt: async (headers) => {
      attempts++
      assert.deepEqual(headers, {
        authorization: 'Bearer fixed',
        'chatgpt-account-id': 'account-1',
      })
      return new Response('rejected', { status: 401 })
    },
    credential: (rejected) =>
      Logins.headers(variables, {
        provider: 'codex',
        ...(rejected === undefined ? {} : { rejected }),
      }),
  })
  assert.equal(attempts, 1)
  assert.equal(await response.text(), 'rejected')

  let cancelled = false
  await assert.rejects(
    Logins.send({
      attempt: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          { status: 401 },
        ),
      credential: async (rejected) => {
        if (rejected) throw new Logins.RefusedError('signed out')
        return Logins.claude('ended')
      },
    }),
    /signed out/,
  )
  assert.equal(cancelled, true)
})
