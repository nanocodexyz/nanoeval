import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import * as Blocklist from '../src/Blocklist.ts'

const list = Blocklist.lists['terminal-bench']!

const cases: [string, boolean][] = [
  ['https://hub.harborframework.com/tasks/terminal-bench/mteb-leaderboard', true],
  ['https://harborframework.com', true],
  ['http://www.tbench.ai/leaderboard?x=1', true],
  ['https://TBENCH.AI./', true],
  ['https://user@tbench.ai:443/', true],
  ['https://tbench.oblok.me/runs/1', true],
  ['https://marginlab.ai', true],
  ['https://github.com/harbor-framework/terminal-bench-2', true],
  ['https://github.com/Laude-Institute/terminal-bench/blob/main/tasks/x/solution.sh', true],
  ['https://github.com/laude-institute/terminal-bench-2', true],
  ['https://github.com./laude-institute/harbor', true],
  ['https://raw.githubusercontent.com/laude-institute/terminal-bench/main/x', true],
  ['https://codeload.github.com/harbor-framework/harbor/zip/main', true],
  ['https://api.github.com/repos/laude-institute/harbor/contents', true],
  ['tbench.ai', true],
  ['https://', true],
  ['https://github.com/laude-institute/terminal-bench-3', false],
  ['https://github.com/laude-institute', false],
  ['https://github.com/harbor-frameworks/x', false],
  ['https://github.com/pytorch/pytorch', false],
  ['https://api.github.com/harbor-framework', false],
  ['https://pypi.org/simple/mteb/', false],
  ['https://nottbench.ai/', false],
  ['https://example.com/?u=https://tbench.ai', false],
  ['https://huggingface.co/datasets/mteb/results', false],
]

test('the list of terminal-bench is valid and names the hosts of the amendment', () => {
  assert.equal(Blocklist.valid(list), list)
  assert.equal(list.length, 20)
  for (const host of ['tbench.ai', 'harborframework.com', 'tbench.oblok.me', 'marginlab.ai'])
    assert.ok(list.includes(host))
})

test('a url is blocked on a listed host, its subdomains and below a listed path', () => {
  for (const [url, blocked] of cases) assert.equal(Blocklist.blocks(list, url), blocked, url)
})

test('the hook of Claude Code refuses with exit 2 exactly the urls that blocks refuses', () => {
  const script = Blocklist.hook(list)
  for (const [url, blocked] of cases) {
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_input: { prompt: 'Read "url": "https://pypi.org" and summarise', url },
      tool_name: 'WebFetch',
    })
    const ran = spawnSync('sh', ['-c', script], { encoding: 'utf8', input })
    assert.equal(ran.status, blocked ? 2 : 0, url + ': ' + ran.stderr)
    if (blocked) assert.ok(ran.stderr.startsWith(Blocklist.message), ran.stderr)
  }
  const unread = spawnSync('sh', ['-c', script], { encoding: 'utf8', input: '{"tool_input":{}}' })
  assert.equal(unread.status, 2)
})

test('a web search tool of a request gets the list added to its blocked_domains', () => {
  const body = {
    model: 'claude-opus-5-5',
    tools: [
      { name: 'bash', type: 'bash_20250124' },
      {
        blocked_domains: ['example.com', 'tbench.ai'],
        name: 'web_search',
        type: 'web_search_20250305',
      },
    ],
  }
  const filtered = Blocklist.anthropic(body, list)
  assert.ok('body' in filtered)
  const tools = filtered.body['tools'] as Record<string, unknown>[]
  assert.deepEqual(tools[0], body.tools[0])
  const blocked = tools[1]!['blocked_domains'] as string[]
  assert.equal(blocked.length, 21)
  assert.ok(blocked.includes('example.com'))
  assert.ok(list.every((item) => blocked.includes(item)))
  assert.equal(filtered.body['model'], 'claude-opus-5-5')
  const plain = { model: 'm', tools: [{ name: 'bash', type: 'bash_20250124' }] }
  assert.equal((Blocklist.anthropic(plain, list) as { body: unknown }).body, plain)
  assert.equal(Blocklist.searches(plain), false)
})

test('a request the provider filter cannot carry is refused, never sent without the list', () => {
  const allowed = { tools: [{ allowed_domains: ['github.com'], type: 'web_search_20250305' }] }
  assert.ok('refusal' in Blocklist.anthropic(allowed, list))
  const fetch = { tools: [{ name: 'web_fetch', type: 'web_fetch_20250910' }] }
  assert.ok('refusal' in Blocklist.anthropic(fetch, list))
  const hosts = Blocklist.anthropic(fetch, ['tbench.ai'])
  assert.ok('body' in hosts)
  assert.deepEqual((hosts.body['tools'] as Record<string, unknown>[])[0]!['blocked_domains'], [
    'tbench.ai',
  ])
})

test('an entry is a lowercase host with an optional path', () => {
  assert.deepEqual(Blocklist.parse('# hosts\ntbench.ai\n\ngithub.com/a-b  # repo\n'), [
    'tbench.ai',
    'github.com/a-b',
  ])
  for (const bad of [[], ['https://tbench.ai'], ['TBench.ai'], ['*.tbench.ai'], ['tbench'], ['a.b', 'a.b']])
    assert.throws(() => Blocklist.valid(bad), Blocklist.InvalidError, JSON.stringify(bad))
  assert.throws(() => Blocklist.valid(Array.from({ length: 65 }, (_, i) => 'h' + i + '.com')))
})

test('a run with a web blocklist takes only agents that enforce it', async () => {
  const Config = await import('../src/Config.ts')
  const base = {
    agents: [{ id: 'nano', model: 'claude-opus-5-5', provider: 'claude' }],
    attempts: 3,
    budget: { sandboxUsd: 0 },
    eval: { name: 'tb21-full' },
    limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
    name: 'blocklist',
    sandbox: { backend: 'krun', disks: 'remove', max: 1, network: 'private', pollMs: 250, provider: 'local' },
  }
  const parsed = Config.parse({ ...base, webBlocklist: list })
  assert.deepEqual(parsed.webBlocklist, list)
  assert.equal(Config.parse(base).webBlocklist, undefined)
  assert.throws(
    () => Config.parse({ ...base, agents: [{ id: 'cx', model: 'gpt-6-luna', provider: 'codex-cli' }], webBlocklist: list }),
    /enforce/,
  )
  assert.throws(() => Config.parse({ ...base, webBlocklist: ['https://tbench.ai'] }), /scheme/)
})

test('Claude Code of a blocklisted run writes the hook and reads it with --settings', async () => {
  const Installed = await import('../src/Installed.ts')
  const url = 'http://127.0.0.1:8787/v1/runs/r/model/a00001'
  for (const kind of ['claude-code', 'stock-claude'] as const) {
    const plain = Installed.script({ kind, model: 'claude-opus-5-5' }, { url })
    const listed = Installed.script({ kind, model: 'claude-opus-5-5' }, { blocklist: list, url })
    assert.ok(!plain.includes('web-blocklist'))
    assert.ok(listed.includes('--settings "$NANOEVAL_AGENT_HOME/web-blocklist.json"'), kind)
    assert.ok(listed.includes(Blocklist.hook(list).trimEnd()), kind)
    assert.equal(
      listed.split('\n').filter((line) => !line.includes('web-blocklist') && !line.includes('NANOEVAL_WEB_BLOCKLIST')).length >= plain.split('\n').length - 1,
      true,
    )
  }
  const codex = Installed.script({ kind: 'codex-cli', model: 'gpt-6-luna' }, { url })
  assert.equal(Installed.script({ kind: 'codex-cli', model: 'gpt-6-luna' }, { blocklist: list, url }), codex)
})

