import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Memory from '../sandbox/Memory.ts'

const gib = 1024 ** 3

function tree(groups: Record<string, Record<string, string>>, self: string) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-memory-'))
  const cgroups = Path.join(root, 'cgroup')
  for (const [group, files] of Object.entries(groups)) {
    Fs.mkdirSync(Path.join(cgroups, group), { recursive: true })
    for (const [name, content] of Object.entries(files))
      Fs.writeFileSync(Path.join(cgroups, group, name), content + '\n')
  }
  Fs.writeFileSync(Path.join(root, 'self'), self)
  return { cgroups, self: Path.join(root, 'self') }
}

const unit = 'user.slice/user-1000.slice/user@1000.service/app.slice/nc-losers.service'

test('a runner in a unit with MemoryMax may use what the unit allows, not the machine', async () => {
  const options = tree(
    {
      '': { 'memory.max': 'max' },
      'user.slice/user-1000.slice/user@1000.service': { 'memory.max': 'max' },
      [unit]: {
        'memory.current': String(5 * gib),
        'memory.max': String(12 * gib),
        'memory.stat': 'anon ' + 3 * gib + '\nfile ' + 2 * gib + '\nkernel 0',
      },
    },
    '0::/' + unit + '\n',
  )
  assert.deepEqual(await Memory.limit(options), { headroomMb: 9 * 1024, limitMb: 12 * 1024 })
})

test('the tightest limit of the control groups above the runner counts', async () => {
  const options = tree(
    {
      'user.slice': { 'memory.current': String(7 * gib), 'memory.max': String(8 * gib) },
      [unit]: { 'memory.current': String(gib), 'memory.max': String(12 * gib) },
    },
    '0::/' + unit + '\n',
  )
  assert.deepEqual(await Memory.limit(options), { headroomMb: 1024, limitMb: 8 * 1024 })
})

test('a runner that no control group limits has no limit', async () => {
  assert.equal(await Memory.limit(tree({ '': {} }, '0::/\n')), undefined)
  assert.equal(
    await Memory.limit(tree({ [unit]: { 'memory.max': 'max' } }, '0::/' + unit + '\n')),
    undefined,
  )
  assert.equal(await Memory.limit(tree({}, '1:name=systemd:/x\n')), undefined)
  assert.equal(Memory.group('12:pids:/a\n0::/b/c\n'), '/b/c')
})
