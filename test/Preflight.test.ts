import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { after, test } from 'node:test'
import { agentText, parseAgent } from '../cli/nanoeval.ts'
import * as Compare from '../src/Compare.ts'
import * as Config from '../src/Config.ts'
import * as Preflight from '../src/Preflight.ts'
import * as Turn from '../src/Turn.ts'

const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-preflight-'))
after(() => Fs.rmSync(root, { force: true, recursive: true }))

const config = {
  attempts: 1,
  budget: { sandboxUsd: 0 },
  eval: { name: 'example' },
  limits: { attachSec: 60, claims: 3, leaseSec: 60, setupSec: 600, stepRetries: 3 },
  name: 'preflight',
  sandbox: {
    backend: 'krun',
    max: 1,
    network: 'private',
    pollMs: 250,
    provider: 'local',
    slots: 1,
  },
}

test('an agent takes a preflight with +preflight after a session harness', () => {
  assert.deepEqual(parseAgent('nanoxp=codex+preflight:gpt-6-luna:high'), {
    id: 'nanoxp',
    model: 'gpt-6-luna',
    preflight: true,
    provider: 'codex',
    thinking: 'high',
  })
  assert.deepEqual(parseAgent('nanoxdp=codex-direct+preflight:gpt-6-luna:high'), {
    id: 'nanoxdp',
    model: 'gpt-6-luna',
    orchestration: 'direct',
    preflight: true,
    provider: 'codex',
    thinking: 'high',
  })
  assert.deepEqual(parseAgent('nanop=claude+preflight:claude-opus-5-5:high'), {
    id: 'nanop',
    model: 'claude-opus-5-5',
    preflight: true,
    provider: 'claude',
    thinking: 'high',
  })
  assert.equal(parseAgent('nanox=codex:gpt-6-luna:high').preflight, undefined)
  for (const text of [
    'nanoxp=codex+preflight:gpt-6-luna:high',
    'nanoxdp=codex-direct+preflight:gpt-6-luna:high',
    'nanox=codex:gpt-6-luna:high',
  ])
    assert.equal(agentText(parseAgent(text)), text)
  assert.throws(() => parseAgent('x=codex+warmup:gpt-6-luna'), /ID=HARNESS:MODEL/)
})

test('only claude and codex sessions take a preflight, and it is off unless asked', () => {
  const agents = Config.parse({
    ...config,
    agents: [
      parseAgent('nanox=codex:gpt-6-luna:high'),
      parseAgent('nanoxp=codex+preflight:gpt-6-luna:high'),
    ],
  }).agents
  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.preflight]),
    [
      ['nanox', undefined],
      ['nanoxp', true],
    ],
  )
  assert.throws(
    () => Config.parse({ ...config, agents: [parseAgent('cx=codex-cli+preflight:gpt-6-luna')] }),
    /cx has a preflight, which only claude and codex sessions take/,
  )
  assert.throws(
    () =>
      Config.parse({
        ...config,
        agents: [{ id: 'x', model: 'm', preflight: 'yes', provider: 'codex' }],
      }),
    /x has a preflight that is not true/,
  )
})

test('a preflight arm is its own kind of agent in comparisons', () => {
  const plain = { id: 'nanox', model: 'gpt-6-luna', provider: 'codex' as const, thinking: 'high' }
  const probed = { ...plain, id: 'nanoxp', preflight: true as const }
  assert.equal(Compare.model(plain), 'codex:gpt-6-luna:high')
  assert.equal(Compare.model(probed), 'codex+preflight:gpt-6-luna:high')
})

test('the facts go before the unchanged instruction of the first turn', () => {
  const instruction = 'Fix the failing build.\n'
  const prompt = Preflight.prompt({ facts: 'cpus: 2 (nproc)\nmissing: python\n', instruction })
  assert.equal(
    prompt,
    '<environment_facts>\nProbed once in this sandbox before the task started:\ncpus: 2 (nproc)\nmissing: python\n</environment_facts>\n\n' +
      instruction,
  )
  assert.ok(prompt.endsWith(instruction))
  const body = Turn.body({ model: 'm', prompt, provider: 'codex', requestId: 'r' })
  assert.equal(body['prompt'], prompt)
})

test('the probe reports the machine, its tools and what is missing, and exits 0', () => {
  const bin = Path.join(root, 'bin')
  Fs.mkdirSync(bin)
  for (const name of ['awk', 'cat', 'df', 'getconf', 'head', 'id', 'nproc', 'pwd', 'uname'])
    Fs.symlinkSync(
      spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8' }).stdout.trim(),
      Path.join(bin, name),
    )
  Fs.writeFileSync(Path.join(bin, 'python3'), '#!/bin/sh\necho "Python 3.11.2"\nexit 0\n', {
    mode: 0o755,
  })
  const shell = spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout.trim()
  const run = spawnSync(shell, [], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: bin },
    input: Preflight.script(),
  })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.trim().split('\n')
  assert.match(lines[0]!, /^os: .+; arch \S+; user \S+; cwd /)
  assert.match(lines[1]!, /^cpus: \d+ \(nproc\)/)
  assert.ok(lines.some((line) => /^memory: [\d.]+ GiB total, [\d.]+ GiB available$/.test(line)))
  assert.ok(lines.some((line) => line.startsWith('disk: ') && line.endsWith(' at /tmp')))
  assert.ok(lines.includes('python3: ' + Path.join(bin, 'python3') + ' (Python 3.11.2)'))
  const missing = lines.find((line) => line.startsWith('missing: '))!.slice('missing: '.length)
  assert.deepEqual(
    missing.split(' '),
    Preflight.tools.filter((name) => name !== 'python3'),
  )
  assert.match(lines.at(-1)!, /^network: pypi\.org (reachable|unreachable)$/)
})
