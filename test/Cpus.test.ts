import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Cpus from '../sandbox/Cpus.ts'

function tree(groups: Record<string, string>, input: { self: string; status: string }) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-cpus-'))
  const cgroups = Path.join(root, 'cgroup')
  for (const [group, max] of Object.entries(groups)) {
    Fs.mkdirSync(Path.join(cgroups, group), { recursive: true })
    Fs.writeFileSync(Path.join(cgroups, group, 'cpu.max'), max + '\n')
  }
  Fs.writeFileSync(Path.join(root, 'self'), input.self)
  Fs.writeFileSync(Path.join(root, 'status'), input.status)
  return { cgroups, self: Path.join(root, 'self'), status: Path.join(root, 'status') }
}

const unit = 'user.slice/user-1000.slice/user@1000.service/app.slice/runner.service'
const status = (list: string) =>
  'Name:\tnode\nCpus_allowed:\tff\nCpus_allowed_list:\t' + list + '\n'

test('the hardware threads a runner is pinned to are those of its affinity list', () => {
  assert.equal(Cpus.allowed(status('0-47'))?.length, 48)
  assert.equal(Cpus.allowed(status('12-39'))?.length, 28)
  assert.deepEqual(Cpus.allowed(status('0,2,4-7,46')), [0, 2, 4, 5, 6, 7, 46])
  assert.deepEqual(Cpus.allowed(status('5')), [5])
  assert.equal(Cpus.allowed('Name:\tnode\n'), undefined)
})

test('a control group quota is the CPUs it gives in each period', () => {
  assert.equal(Cpus.quota('400000 100000'), 4)
  assert.equal(Cpus.quota('150000 100000\n'), 1.5)
  assert.equal(Cpus.quota('max 100000'), undefined)
  assert.equal(Cpus.quota(''), undefined)
})

test('a runner may use the fewest of its affinity and the quotas of the control groups above it', async () => {
  const pinned = { self: '0::/' + unit + '\n', status: status('12-39') }
  assert.equal(
    await Cpus.limit(tree({ '': 'max 100000', [unit]: 'max 100000' }, pinned)),
    28,
    'no quota: the threads it is pinned to',
  )
  assert.equal(
    await Cpus.limit(tree({ [unit]: '800000 100000', 'user.slice': '1600000 100000' }, pinned)),
    8,
    'the quota of its unit is under its affinity',
  )
  assert.equal(
    await Cpus.limit(tree({ [unit]: '800000 100000', 'user.slice': '250000 100000' }, pinned)),
    2.5,
    'the tightest quota above it counts',
  )
  assert.equal(
    await Cpus.limit(tree({ [unit]: '6400000 100000' }, pinned)),
    28,
    'a quota above its affinity changes nothing',
  )
  assert.equal(
    await Cpus.limit(tree({ '': '400000 100000' }, { self: '0::/\n', status: 'Name:\tnode\n' })),
    4,
  )
  assert.equal(
    await Cpus.limit(tree({}, { self: '1:name=systemd:/x\n', status: 'Name:\tnode\n' })),
    undefined,
  )
})

test('a runner has one slot for each whole thread it may use, of those that are online, and never none', () => {
  assert.equal(Cpus.threads(48, 28), 28)
  assert.equal(Cpus.threads(48, undefined), 48)
  assert.equal(Cpus.threads(4, 64), 4, 'an affinity list may name threads that are not online')
  assert.equal(Cpus.threads(48, 2.5), 2)
  assert.equal(Cpus.threads(48, 0.5), 1)
})
