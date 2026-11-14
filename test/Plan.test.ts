import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, before, test } from 'node:test'
import * as Plan from '../cli/Plan.ts'

let directory: string

before(() => {
  directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-plan-'))
})

after(() => {
  Fs.rmSync(directory, { force: true, recursive: true })
})

function write(name: string, value: unknown, mode = 0o600): string {
  const path = Path.join(directory, name)
  Fs.writeFileSync(path, JSON.stringify(value), { mode })
  return path
}

function jwt(claims: unknown): string {
  return ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join(
    '.',
  )
}

test('a Codex login gives the access token, the account and the expiry, never the refresh token', async () => {
  const access = jwt({ exp: 1_800_000_000 })
  const login = await Plan.codex(
    write('codex.json', {
      auth_mode: 'chatgpt',
      tokens: { access_token: access, account_id: 'account-1', refresh_token: 'refresh-1' },
    }),
  )
  assert.deepEqual(login, {
    expiresAt: 1_800_000_000_000,
    vars: { CHATGPT_ACCESS_TOKEN: access, CHATGPT_ACCOUNT_ID: 'account-1' },
  })
  assert.ok(!JSON.stringify(login).includes('refresh-1'))
  await assert.rejects(
    Plan.codex(write('key.json', { auth_mode: 'apikey', OPENAI_API_KEY: 'key' })),
    Plan.LoginError,
  )
})

test('a Claude login gives the access token and the expiry, never the refresh token', async () => {
  const login = await Plan.claude(
    write('claude.json', {
      claudeAiOauth: { accessToken: 'access-1', expiresAt: 1_800_000_000_000, refreshToken: 'r' },
    }),
  )
  assert.deepEqual(login, {
    expiresAt: 1_800_000_000_000,
    vars: { CLAUDE_CODE_OAUTH_TOKEN: 'access-1' },
  })
  await assert.rejects(Plan.claude(write('empty.json', {})), Plan.LoginError)
})

test('a login file that others can read, is missing or is not JSON is refused', async () => {
  const open = write('open.json', { claudeAiOauth: { accessToken: 'access-1' } }, 0o644)
  await assert.rejects(Plan.claude(open), /must not be readable/)
  await assert.rejects(Plan.claude(Path.join(directory, 'missing.json')), Plan.LoginError)
  const text = Path.join(directory, 'text.json')
  Fs.writeFileSync(text, 'not json', { mode: 0o600 })
  await assert.rejects(Plan.codex(text), /is not JSON/)
})

test('the relay listens on loopback and refuses a caller without its secret', async () => {
  const relay = await Plan.relay()
  try {
    assert.match(relay.vars['CHATGPT_RELAY_URL']!, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(relay.vars['CHATGPT_RELAY_SECRET']!.length, 64)
    const response = await fetch(relay.vars['CHATGPT_RELAY_URL'] + '/backend-api/codex/responses', {
      body: '{}',
      method: 'POST',
    })
    assert.equal(response.status, 401)
  } finally {
    await relay.close()
  }
})

test('an env file quotes its values', () => {
  assert.equal(Plan.envFile({ A: 'one two', B: 'a"b' }), 'A="one two"\nB="a\\"b"\n')
})

test('the secret that seals a plan is made once, in a private file', async () => {
  const path = Path.join(directory, 'state', 'plan.secret')
  const made = await Plan.secret(path)
  assert.match(made, /^[0-9a-f]{64}$/)
  assert.equal(Fs.statSync(path).mode & 0o777, 0o600)
  assert.equal(await Plan.secret(path), made)
  Fs.chmodSync(path, 0o644)
  await assert.rejects(Plan.secret(path), /must not be readable/)
})

test('a ChatGPT login is refreshed only when it expires soon, and the file keeps the new tokens', async () => {
  const now = 1_800_000_000_000
  const old = jwt({ exp: now / 1000 + 3600 })
  const fresh = jwt({ exp: now / 1000 + 864_000 })
  const path = write('refresh.json', {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      access_token: old,
      account_id: 'account-1',
      id_token: 'id-1',
      refresh_token: 'refresh-1',
    },
  })
  const asked: unknown[] = []
  const answer = (status: number, body: unknown) => async (url: string, init?: RequestInit) => {
    asked.push([url, JSON.parse(String(init?.body))])
    return Response.json(body, { status })
  }

  const kept = await Plan.refresh(path, {
    fetch: answer(200, {}),
    now,
    withinMs: 1800 * 1000,
  })
  assert.equal(kept.refreshed, false)
  assert.equal(asked.length, 0)

  await assert.rejects(
    Plan.refresh(path, {
      fetch: answer(401, { error: 'invalid_grant' }),
      now,
      withinMs: 6 * 3600 * 1000,
    }),
    (error: unknown) =>
      error instanceof Plan.LoginError && /refused a refresh with 401/.test(error.message),
  )
  assert.equal(JSON.parse(Fs.readFileSync(path, 'utf8')).tokens.access_token, old)

  const refreshed = await Plan.refresh(path, {
    fetch: answer(200, { access_token: fresh, id_token: 'id-2', refresh_token: 'refresh-2' }),
    now,
    withinMs: 6 * 3600 * 1000,
  })
  assert.equal(refreshed.refreshed, true)
  assert.deepEqual(refreshed.login, {
    expiresAt: now + 864_000_000,
    vars: { CHATGPT_ACCESS_TOKEN: fresh, CHATGPT_ACCOUNT_ID: 'account-1' },
  })
  assert.deepEqual(asked.at(-1), [
    Plan.codexTokenUrl,
    {
      client_id: Plan.codexClient,
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      scope: 'openid profile email',
    },
  ])
  const file = JSON.parse(Fs.readFileSync(path, 'utf8'))
  assert.deepEqual(file.tokens, {
    access_token: fresh,
    account_id: 'account-1',
    id_token: 'id-2',
    refresh_token: 'refresh-2',
  })
  assert.equal(file.OPENAI_API_KEY, null)
  assert.equal(file.last_refresh, new Date(now).toISOString())
  assert.equal(Fs.statSync(path).mode & 0o777, 0o600)
})

test('a push runs the command for each value that changed, with the value on its input', async () => {
  const out = Fs.mkdtempSync(Path.join(directory, 'pushed-'))
  const state = Path.join(directory, 'pushed.json')
  const command = 'cat > ' + JSON.stringify(out) + '/"$NANOEVAL_SECRET_NAME"'
  const vars = { CHATGPT_ACCESS_TOKEN: 'token-1', CHATGPT_RELAY_URL: 'https://a.example' }
  assert.deepEqual(await Plan.push(vars, { command, state }), [
    'CHATGPT_ACCESS_TOKEN',
    'CHATGPT_RELAY_URL',
  ])
  assert.equal(Fs.readFileSync(Path.join(out, 'CHATGPT_ACCESS_TOKEN'), 'utf8'), 'token-1')
  assert.equal(Fs.statSync(state).mode & 0o777, 0o600)
  assert.doesNotMatch(Fs.readFileSync(state, 'utf8'), /token-1/)
  assert.deepEqual(await Plan.push(vars, { command, state }), [])
  assert.deepEqual(
    await Plan.push({ ...vars, CHATGPT_RELAY_URL: 'https://b.example' }, { command, state }),
    ['CHATGPT_RELAY_URL'],
  )
  assert.equal(Fs.readFileSync(Path.join(out, 'CHATGPT_RELAY_URL'), 'utf8'), 'https://b.example')
  await assert.rejects(
    Plan.push({ CHATGPT_ACCOUNT_ID: 'account-2' }, { command: 'exit 3', state }),
    (error: unknown) => error instanceof Plan.PushError && /exited with 3/.test(error.message),
  )
  assert.equal(JSON.parse(Fs.readFileSync(state, 'utf8'))['CHATGPT_ACCOUNT_ID'], undefined)
})

test('a relay address is one https origin', async () => {
  Fs.writeFileSync(Path.join(directory, 'url'), 'https://relay.example.trycloudflare.com\n')
  assert.equal(
    await Plan.relayUrl(Path.join(directory, 'url')),
    'https://relay.example.trycloudflare.com',
  )
  Fs.writeFileSync(Path.join(directory, 'url'), 'http://127.0.0.1:8799')
  await assert.rejects(Plan.relayUrl(Path.join(directory, 'url')), Plan.LoginError)
})
