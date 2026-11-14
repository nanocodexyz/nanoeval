import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Subset from '../src/Subset.ts'

const entries = [
  { id: 'cancel-async-tasks', name: 'terminal-bench/cancel-async-tasks' },
  { id: 'fix-git', name: 'terminal-bench/fix-git' },
  { id: 'git-leak-recovery', name: 'terminal-bench/git-leak-recovery' },
  { id: 'q7', name: 'other/fix-git-twice' },
  { id: 'q8', name: 'other/shared' },
  { id: 'q9', name: 'more/shared' },
]

test('a task is named by its id, by its name as status prints it, by the last part of its name, or by a pattern', () => {
  const ids = (...wanted: string[]) => Subset.resolve(entries, { eval: 'bench', wanted })
  assert.deepEqual(ids('fix-git'), ['fix-git'])
  assert.deepEqual(ids('terminal-bench/fix-git'), ['fix-git'])
  assert.deepEqual(ids('fix-git-twice'), ['q7'])
  assert.deepEqual(ids('q7', 'cancel-async-tasks'), ['cancel-async-tasks', 'q7'])
  assert.deepEqual(ids('*git*'), ['fix-git', 'git-leak-recovery', 'q7'])
  assert.deepEqual(ids('terminal-bench/*'), ['cancel-async-tasks', 'fix-git', 'git-leak-recovery'])
  assert.deepEqual(ids('q?'), ['q7', 'q8', 'q9'])
  assert.deepEqual(ids('fix-git', 'fix-*', 'terminal-bench/fix-git'), ['fix-git', 'q7'])
  assert.deepEqual(ids('other/shared'), ['q8'])
  assert.deepEqual(ids(), [])
})

test('a name or a pattern that finds no task is refused, and so is a short name that two tasks share', () => {
  const refused = (...wanted: string[]) => {
    try {
      Subset.resolve(entries, { eval: 'bench', wanted })
    } catch (error) {
      return (error as Error).name + ': ' + (error as Error).message
    }
    return 'taken'
  }
  assert.equal(refused('fix-gti'), 'Subset.UnknownError: the eval bench has no task fix-gti')
  assert.equal(
    refused('fix-git', 'zz*'),
    'Subset.UnknownError: no task of the eval bench matches zz*',
  )
  assert.equal(
    refused('nope', 'x?'),
    'Subset.UnknownError: the eval bench has no task nope, and no task of the eval bench matches x?',
  )
  assert.equal(refused('fix'), 'Subset.UnknownError: the eval bench has no task fix')
  assert.equal(refused('FIX-GIT'), 'Subset.UnknownError: the eval bench has no task FIX-GIT')
  assert.equal(refused('fix.git'), 'Subset.UnknownError: the eval bench has no task fix.git')
  assert.equal(refused('fix-git|q7'), 'Subset.UnknownError: the eval bench has no task fix-git|q7')
  assert.equal(
    refused('shared'),
    'Subset.InvalidError: shared names 2 tasks: other/shared, more/shared',
  )
  assert.deepEqual(Subset.match(entries, ['fix-git', 'new-task', 'zz*']), {
    ids: ['fix-git'],
    unknown: ['new-task', 'zz*'],
  })
})

test('a file of tasks holds one a line, with comments', () => {
  assert.deepEqual(
    Subset.lines(
      '# the smoke set\nfix-git\n\n  terminal-bench/cancel-async-tasks  # slow\n*leak*\n',
    ),
    ['fix-git', 'terminal-bench/cancel-async-tasks', '*leak*'],
  )
  assert.deepEqual(Subset.lines(''), [])
})

test('a subset is named once in a file, by eval', () => {
  const file = 'subsets.json'
  const subsets = Subset.parse(
    JSON.stringify({ bench: { git: ['*git*'], smoke: ['fix-git', 'q8'] }, other: { all: ['*'] } }),
    file,
  )
  assert.deepEqual(Subset.named(subsets, { eval: 'bench', file, names: ['smoke'] }), [
    'fix-git',
    'q8',
  ])
  assert.deepEqual(Subset.named(subsets, { eval: 'bench', file, names: ['smoke', 'git'] }), [
    'fix-git',
    'q8',
    '*git*',
  ])
  assert.deepEqual(Subset.named(subsets, { eval: 'bench', file, names: [] }), [])
  assert.throws(() => Subset.named(subsets, { eval: 'bench', file, names: ['smok'] }), {
    name: 'Subset.UnknownError',
    message: 'subsets.json has no subset smok of the eval bench: it has git, smoke',
  })
  assert.throws(() => Subset.named(subsets, { eval: 'none', file, names: ['smoke'] }), {
    name: 'Subset.UnknownError',
    message: 'subsets.json has no subset smoke of the eval none',
  })
  assert.throws(() => Subset.parse('{', file), /^Subset\.InvalidError: subsets\.json is not JSON: /)
  for (const wrong of [
    '[]',
    '{"bench": ["fix-git"]}',
    '{"bench": {"smoke": "fix-git"}}',
    '{"bench": {"smoke": []}}',
  ])
    assert.throws(
      () => Subset.parse(wrong, file),
      /^Subset\.InvalidError: subsets\.json has to hold /,
    )
})
