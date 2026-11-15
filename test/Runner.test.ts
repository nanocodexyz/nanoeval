import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import { loadTask } from '../cli/nanoeval.ts'
import * as Runner from '../sandbox/Runner.ts'
import type * as Config from '../src/Config.ts'
import * as Protocol from '../src/Protocol.ts'
import * as Rows from './Rows.ts'

test('a runner whose slot frees while the run holds its claim ends that claim and asks again with the memory it got back', async () => {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-runner-'))
  const task = Rows.row(await loadTask('tasks/write-greeting'), 'dir')
  const memoryMb = task.resources.memoryMb + 1
  const claims: Protocol.ClaimRequest[] = []
  const ended: string[] = []
  let end: ((by: string) => void) | undefined
  let held = () => {}
  const holding = new Promise<void>((resolve) => (held = resolve))
  const server = Http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      const path = request.url!.slice('/v1/runs/run/runner'.length)
      if (path.startsWith('/blobs/')) return answer(404, {})
      if (path.startsWith('/rows/')) {
        await holding
        return answer(410, { error: 'the row is gone' })
      }
      if (path === '/heartbeat')
        return answer(200, { finished: false, lost: [] } satisfies Protocol.HeartbeatResponse)
      if (path === '/yield') {
        const yielded = end !== undefined
        end?.('the runner')
        return answer(200, { yielded } satisfies Protocol.Yielded)
      }
      if (path !== '/claims') return answer(200, {})
      const claim = JSON.parse(Buffer.concat(chunks).toString()) as Protocol.ClaimRequest
      claims.push(claim)
      if (claims.length === 1)
        return answer(200, {
          finished: false,
          rows: [
            {
              agent: { id: 'scripted', oracle: false },
              claim: 'c1',
              id: 'a00001',
              leaseUntil: Date.now() + 60_000,
              slot: 'a00001',
              task,
            },
          ],
        } satisfies Protocol.ClaimResponse)
      if (claim.offer.memoryMb >= task.resources.memoryMb)
        return answer(200, { finished: true, rows: [] } satisfies Protocol.ClaimResponse)
      const timer = setTimeout(() => end?.('the hold'), claim.waitMs)
      end = (by) => {
        clearTimeout(timer)
        end = undefined
        ended.push(by)
        answer(200, { finished: false, rows: [] } satisfies Protocol.ClaimResponse)
      }
      held()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const config: Config.Runner = {
    backend: 'dir',
    cpusPerThread: null,
    disks: 'keep',
    leaseSec: 60,
    limits: { attachSec: 60, setupSec: 60, stepRetries: 0 },
    memoryMb,
    network: 'host',
    oracle: false,
    pollMs: 250,
    protocol: Protocol.version,
    run: 'run',
    runner: 1,
    slots: 2,
    token: 'test-token',
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
  }
  const hand = process.env['NANOEVAL_NANOCODE']
  process.env['NANOEVAL_NANOCODE'] = execFileSync('bash', ['-c', 'command -v bash'])
    .toString()
    .trim()
  try {
    await Runner.run({
      cache: Path.join(root, 'cache'),
      config,
      home: Path.join(root, 'home'),
      log: () => {},
    })
  } finally {
    if (hand === undefined) delete process.env['NANOEVAL_NANOCODE']
    else process.env['NANOEVAL_NANOCODE'] = hand
    server.closeAllConnections()
    server.close()
    Fs.rmSync(root, { force: true, recursive: true })
  }
  assert.deepEqual(
    claims.map((claim) => claim.offer),
    [
      { capacityMb: memoryMb, memoryMb, slots: 2 },
      { capacityMb: memoryMb, memoryMb: 1, slots: 1 },
      { capacityMb: memoryMb, memoryMb, slots: 2 },
    ],
    'the claim that the run held offered a slot and no memory for a row, and the next one all of it',
  )
  assert.deepEqual(
    ended,
    ['the runner'],
    'the runner ended the held claim when its slot was down, before the hold ran out',
  )
})
