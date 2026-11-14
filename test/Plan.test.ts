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
