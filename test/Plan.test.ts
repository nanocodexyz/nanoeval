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
