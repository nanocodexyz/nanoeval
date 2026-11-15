import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import type * as Net from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Archive from '../sandbox/Archive.ts'

type Answer = { body: string; headers: Http.IncomingHttpHeaders; status: number }

async function origin(files: Record<string, string>, seen: string[]) {
  const server = Http.createServer((request, response) => {
    seen.push(request.method + ' ' + request.headers.host + request.url)
    const body = files[request.url ?? '']
    if (body === undefined) response.writeHead(404).end('not here')
    else response.writeHead(200, { 'content-length': body.length, etag: '"1"' }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as Net.AddressInfo).port, server }
}

function get(address: string, host: string, path: string, method = 'GET'): Promise<Answer> {
  const [name, port] = address.split(':')
  return new Promise((resolve, reject) => {
    Http.request({ headers: { host }, host: name, method, path, port }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () =>
        resolve({ body, headers: response.headers, status: response.statusCode ?? 0 }),
      )
    })
      .on('error', reject)
      .end()
  })
}

const pool = '/debian-security/pool/updates/main/c/curl/curl_7.74.0-1.3+deb11u16_amd64.deb'
const index = '/debian-security/dists/bullseye-security/InRelease'
const gone = '/debian-security/dists/bullseye-security/main/binary-amd64/Packages.xz'

async function world() {
  const seen: string[] = []
  const mirror = await origin(
    { [index]: 'the signed index', '/debian/pool/kept.deb': 'kept' },
    seen,
  )
  const archive = await origin({ [gone]: 'an older index', [pool]: 'the package' }, seen)
  const log = Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-archive-')), 'archive.log')
  const opened = await Archive.open({
    address: '127.0.0.1',
    archives: { 'mirror.test': 'archive.test' },
    log,
    origin: (name) => ({
      host: '127.0.0.1',
      port: name === 'archive.test' ? archive.port : mirror.port,
    }),
    port: 0,
  })
  const close = () => {
    opened.close()
    mirror.server.close()
    archive.server.close()
  }
  return { address: opened.address, close, log, seen }
}

test('a request the mirror answers is passed on as the mirror answered it', async () => {
  const { address, close, log, seen } = await world()
  const answer = await get(address, 'mirror.test', index)
  assert.deepEqual([answer.status, answer.body], [200, 'the signed index'])
  assert.equal(answer.headers.etag, '"1"')
  assert.equal((await get(address, 'mirror.test:80', '/debian/pool/kept.deb')).body, 'kept')
  assert.deepEqual(seen, ['GET mirror.test' + index, 'GET mirror.test/debian/pool/kept.deb'])
  assert.deepEqual(await Archive.served(log), [])
  close()
})

test('a pool file the mirror no longer has is served from the archive and recorded', async () => {
  const { address, close, log, seen } = await world()
  const answer = await get(address, 'mirror.test', pool)
  assert.deepEqual([answer.status, answer.body], [200, 'the package'])
  assert.deepEqual(seen, ['GET mirror.test' + pool, 'GET archive.test' + pool])
  assert.equal((await get(address, 'mirror.test', pool, 'HEAD')).status, 200)
  assert.deepEqual(await Archive.served(log), ['mirror.test' + pool])
  close()
})

test('an index the mirror no longer has is never taken from the archive', async () => {
  const { address, close, log, seen } = await world()
  const answer = await get(address, 'mirror.test', gone)
  assert.deepEqual([answer.status, answer.body], [404, 'not here'])
  assert.deepEqual(seen, ['GET mirror.test' + gone])
  assert.deepEqual(await Archive.served(log), [])
  close()
})

test('a pool file that neither has stays the 404 of the mirror', async () => {
  const { address, close, log, seen } = await world()
  const answer = await get(address, 'mirror.test', '/debian/pool/never.deb')
  assert.equal(answer.status, 404)
  assert.deepEqual(seen, [
    'GET mirror.test/debian/pool/never.deb',
    'GET archive.test/debian/pool/never.deb',
  ])
  assert.deepEqual(await Archive.served(log), [])
  close()
})

test('a name without an archive, and a request that is no read, are refused', async () => {
  const { address, close, seen } = await world()
  assert.equal((await get(address, 'other.test', pool)).status, 421)
  assert.equal((await get(address, 'mirror.test', pool, 'POST')).status, 405)
  assert.deepEqual(seen, [])
  close()
})

test('an archive that is not named an address listens on a loopback address of its own', async () => {
  const log = Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), 'nanoeval-archive-')), 'archive.log')
  const [first, second] = await Promise.all([
    Archive.open({ log, port: 0 }),
    Archive.open({ log, port: 0 }),
  ])
  assert.match(first.address, /^127(\.[0-9]{1,3}){3}:[0-9]+$/)
  assert.notEqual(first.address.split(':')[0], second.address.split(':')[0])
  first.close()
  second.close()
})

test('the names a slot is given are each mirror and the hosts its service record names', async () => {
  const asked: string[] = []
  const names = await Archive.names(async (name) => {
    asked.push(name)
    if (name !== '_http._tcp.deb.debian.org') throw new Error('ENODATA')
    return [{ name: 'Mirror.Example.Net.' }, { name: 'mirror.example.net' }]
  })
  assert.deepEqual(asked, ['_http._tcp.deb.debian.org', '_http._tcp.security.debian.org'])
  assert.deepEqual(names, ['deb.debian.org', 'mirror.example.net', 'security.debian.org'])
})

test('the archives of this build are those of Debian', () => {
  assert.deepEqual(Archive.archives, {
    'deb.debian.org': 'archive.debian.org',
    'security.debian.org': 'archive.debian.org',
  })
  assert.equal(Archive.port, 80)
})
