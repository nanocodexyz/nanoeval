import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import { agentText, overlayLines, parseAgent, readOverlays } from '../cli/nanoeval.ts'
import * as Config from '../src/Config.ts'
import * as Overlay from '../src/Overlay.ts'

const base = {
  dims: ['finish'],
  evidence: ['dev44 run r1'],
  format: 'nanoeval-overlay/1',
  harness: 'claude',
  hypothesis: 'a brief finish costs less at the same pass rate',
  id: 'opus55-g1-01',
  levers: {},
  model: 'claude-opus-5-5',
  parent: null,
  pending: {},
  thinking: 'high',
}

const samples: Record<string, Record<string, unknown>> = {
  branches: { branches: 2 },
  briefFinal: { briefFinal: true },
  briefFinish: { briefFinish: true },
  cellYieldMs: { cellYieldMs: 120000 },
  clearingCacheFloors: { clearingCacheFloors: true },
  escalateContextTokens: { escalateContextTokens: 150000, escalateModel: 'claude-opus-5-5' },
  escalateModel: { escalateModel: 'claude-opus-5-5', escalateToolErrors: 3 },
  escalateToolErrors: { escalateModel: 'claude-opus-5-5', escalateToolErrors: 3 },
  finishAmbiguity: { finishAmbiguity: true },
  finishCheck: { finishCheck: true },
  finishRetries: { finishRetries: 2 },
  foldFinish: { foldFinish: true },
  lateFinishCheckMs: { lateFinishCheckMs: 600000 },
  lazy: { branches: 3, lazy: true },
  leanCells: { leanCells: true },
  lowEffortRounds: { lowEffortRounds: true },
  persistFinish: { persistFinish: true },
  picker: { branches: 2, picker: 'verify' },
  preflight: { preflight: true },
  refusalFallback: { refusalFallback: 'session' },
  resultEffort: { resultEffort: 'low' },
  skipFinishCheck: { skipFinishCheck: true },
  stopAtTarget: { stopAtTarget: true },
  subagents: { subagents: false },
  toolResultClearing: { toolResultClearing: { atLeastTokens: 30000, keep: 3 } },
  toolResultTokens: { toolResultTokens: 8000 },
  verifierModel: { branches: 2, picker: 'verify', verifierModel: 'claude-sonnet-5-5' },
  yieldFloorMs: { yieldFloorMs: 30000 },
  yieldShare: { yieldShare: 50 },
  forkOn: { branches: 2, forkOn: 'verifier_fail', picker: 'verify_lazy' },
  verifierProvider: { branches: 2, picker: 'verify', verifierProvider: 'claude' },
  verifierThinking: { branches: 2, picker: 'verify', verifierThinking: 'low' },
  fixModel: {
    branches: 2,
    fixModel: 'claude-sonnet-5-5',
    fixProvider: 'claude',
    lazy: true,
    picker: 'verify_lazy',
  },
  fixProvider: {
    branches: 2,
    fixModel: 'claude-sonnet-5-5',
    fixProvider: 'codex',
    lazy: true,
    picker: 'verify_lazy',
  },
  fixThinking: {
    branches: 2,
    fixModel: 'claude-sonnet-5-5',
    fixProvider: 'claude',
    fixThinking: 'low',
    lazy: true,
    picker: 'verify_lazy',
  },
  executorShare: {
    branches: 2,
    executorShare: 40,
    fixModel: 'claude-sonnet-5-5',
    fixProvider: 'claude',
    lazy: true,
    picker: 'verify_lazy',
  },
  verifierShare: {
    branches: 2,
    fixModel: 'claude-sonnet-5-5',
    fixProvider: 'claude',
    lazy: true,
    picker: 'verify_lazy',
    verifierShare: 20,
  },
  lenientPatches: { lenientPatches: true },
  minWaitMs: { minWaitMs: 5000 },
  maxOutputTokens: { maxOutputTokens: 32000 },
  contextWindow: { contextWindow: 200000 },
  codesign: { codesign: false },
  verificationRequested: { verificationRequested: true },
  promptVariant: { promptVariant: 'compact' },
  toolProfile: { toolProfile: 'lean' },
  omitMediaOnEmptyCut: { omitMediaOnEmptyCut: true },
  stallNudgeMs: { stallNudgeMs: 300000 },
}

// Levers only a codex session takes, and levers that need a picker or a fix model the combined
// overlay below does not hold.
const codexLevers = [
  'contextWindow',
  'lenientPatches',
  'maxOutputTokens',
  'minWaitMs',
  'promptVariant',
  'toolProfile',
  'verificationRequested',
]
const apart = [
  ...codexLevers,
  'executorShare',
  'fixModel',
  'fixProvider',
  'fixThinking',
  'forkOn',
  'verifierProvider',
  'verifierShare',
  'verifierThinking',
]

test('every lever of an agent round-trips from an overlay through the agent string', () => {
  assert.deepEqual(Object.keys(samples).sort(), [...Overlay.leverKeys].sort())
  for (const [key, levers] of Object.entries(samples)) {
    const codex = codexLevers.includes(key) ? { harness: 'codex', model: 'gpt-6-luna' } : {}
    const overlay = Overlay.parse({ ...base, ...codex, id: 'lever-' + key, levers })
    const agent = Overlay.compile(overlay)
    assert.equal(agent[key as keyof Config.Agent] !== undefined, true, key)
    // verify_lazy implies lazy, which the agent string leaves out and Config.parseAgents restores.
    assert.deepEqual(Config.parseAgents([parseAgent(agentText(agent))])[0], agent, key)
  }
  const all = Overlay.parse({
    ...base,
    levers: Object.assign(
      {},
      ...Object.entries(samples)
        .filter(
          ([key]) =>
            ![
              'finishCheck',
              'finishAmbiguity',
              'finishRetries',
              'lateFinishCheckMs',
              ...apart,
            ].includes(key),
        )
        .map(([, levers]) => levers),
    ),
  })
  assert.deepEqual(parseAgent(agentText(Overlay.compile(all))), Overlay.compile(all))
})

test('a harness of an overlay is the harness of its agent string', () => {
  for (const harness of Object.keys(Overlay.harnesses)) {
    const overlay = Overlay.parse({
      ...base,
      harness,
      id: 'h-' + harness,
      levers: { cellYieldMs: 60000, persistFinish: true, preflight: true },
      thinking: 'none',
    })
    const text = agentText(Overlay.compile(overlay))
    assert.equal(
      text,
      'h-' +
        harness +
        '=' +
        harness +
        '+preflight:claude-opus-5-5:none:cell_yield_ms=60000:persist_finish=on',
    )
    assert.deepEqual(parseAgent(text), Overlay.compile(overlay))
  }
})

test('an overlay compiles to the agent of the hand-written string', () => {
  const overlay = Overlay.parse({
    ...base,
    levers: { briefFinish: true, cellYieldMs: 120000, lowEffortRounds: true },
  })
  assert.deepEqual(
    Overlay.compile(overlay),
    parseAgent(
      'opus55-g1-01=claude:claude-opus-5-5:high:cell_yield_ms=120000:brief_finish=on:low_effort_rounds=on',
    ),
  )
  assert.deepEqual(Config.parseAgents([Overlay.compile(overlay)]), [Overlay.compile(overlay)])
})

test('an overlay with pending keys is not runnable', () => {
  const overlay = Overlay.parse({
    ...base,
    dims: ['prompt', 'tools'],
    pending: { toolSet: 'lean', promptStyle: 'terse' },
  })
  assert.deepEqual(Overlay.pendingKeys(overlay), ['promptStyle', 'toolSet'])
  assert.throws(
    () => Overlay.compile(overlay),
    (error: Error) =>
      error.name === 'Overlay.PendingError' &&
      error.message === 'opus55-g1-01 is not runnable until a Worker accepts promptStyle, toolSet',
  )
  assert.deepEqual(overlayLines([overlay, Overlay.parse({ ...base, id: 'b' })]), {
    runnable: ['--agent b=claude:claude-opus-5-5:high'],
    unrunnable: ['not runnable: opus55-g1-01 (pending promptStyle, toolSet)'],
  })
})

test('an overlay is refused where run would refuse its agent', () => {
  const refused: [Record<string, unknown>, RegExp][] = [
    [{ format: 'nanoeval-overlay/2' }, /format nanoeval-overlay\/1/],
    [{ id: 'a b' }, /letters, digits/],
    [{ extra: 1 }, /keys an overlay does not have: extra/],
    [{ model: '' }, /names no model/],
    [{ harness: 'codex-cli' }, /harness must be one of/],
    [{ thinking: 'huge' }, /thinking must be one of/],
    [{ parent: '' }, /parent is the id/],
    [{ levers: { promptStyle: 'terse' } }, /put a lever no Worker accepts in pending/],
    [{ levers: { model: 'x' } }, /levers this checkout does not know \(model\)/],
    [{ pending: { briefFinish: true } }, /put them in levers/],
    [{ dims: ['speed'] }, /dims is a list of/],
    [{ hypothesis: '' }, /states no hypothesis/],
    [{ evidence: [1] }, /evidence is a list of strings/],
    [{ harness: 'codex', levers: { briefFinish: true } }, /only a claude session takes/],
    [{ levers: { cellYieldMs: 0 } }, /cellYieldMs must be an integer of at least 1/],
    [{ levers: { finishCheck: true, skipFinishCheck: true } }, /never go in one arm/],
    [{ levers: { lazy: true } }, /only an agent that branches can be/],
  ]
  for (const [change, message] of refused)
    assert.throws(() => Overlay.parse({ ...base, ...change }), message)
  assert.throws(() => Overlay.parse([]), /a JSON object/)
})

test('nanoeval overlay prints an --agent for each runnable overlay of a directory', async () => {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'overlay-'))
  const write = (name: string, value: unknown) =>
    Fs.writeFile(Path.join(directory, name), JSON.stringify(value))
  await write('b.json', { ...base, id: 'b', levers: { briefFinish: true } })
  await write('a.json', { ...base, harness: 'codex-jobs', id: 'a', thinking: 'xhigh' })
  await write('c.json', { ...base, id: 'c', pending: { toolSet: 'lean' } })
  await write('notes.txt', 'not an overlay')
  assert.deepEqual(
    (await readOverlays([directory])).map((overlay) => overlay.id),
    ['a', 'b', 'c'],
  )
  const ran = spawnSync(
    process.execPath,
    [Path.join(import.meta.dirname, '..', 'cli', 'nanoeval.ts'), 'overlay', directory],
    { encoding: 'utf8' },
  )
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(
    ran.stdout,
    '--agent a=codex-jobs:claude-opus-5-5:xhigh\n--agent b=claude:claude-opus-5-5:high:brief_finish=on\n',
  )
  assert.match(ran.stderr, /not runnable: c \(pending toolSet\)/)
  await write('d.json', { ...base, id: 'b' })
  await assert.rejects(readOverlays([directory]), /overlay ids must be unique: b/)
  await write('d.json', { ...base, id: 'd', levers: { yieldShare: 0 } })
  await assert.rejects(readOverlays([directory]), /d\.json: d: yieldShare must be a whole percent/)
  await Fs.rm(directory, { recursive: true })
})
