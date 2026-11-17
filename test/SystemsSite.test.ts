import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Site from '../cli/systems/targets/site.ts'

test('route picks the demo behind the site', () => {
  assert.deepEqual(Site.route({ label: 'a' }), {
    base: 'https://nanocode.xyz/cloudflare',
    kind: 'cloudflare',
    site: 'https://nanocode.xyz',
  })
  assert.deepEqual(Site.route({ label: 'a', url: 'https://preview.example/' }), {
    base: 'https://preview.example/cloudflare',
    kind: 'cloudflare',
    site: 'https://preview.example',
  })
  assert.equal(Site.route({ label: 'a', url: 'https://nanocode.xyz/vercel/' }).kind, 'vercel')
  assert.throws(
    () => Site.route({ label: 'a', url: 'https://nanocode.xyz/docs' }),
    /\/cloudflare or/,
  )
})

test('assets lists scripts and wasm binaries once', () => {
  const found = Site.assets(
    '<script src="/assets/index-Dns1TE3j.js"></script> new URL("/assets/nanocode_wasm-BjgIgAjJ.wasm") "/assets/index-Dns1TE3j.js"',
  )
  assert.deepEqual(found, {
    scripts: ['assets/index-Dns1TE3j.js'],
    wasm: ['assets/nanocode_wasm-BjgIgAjJ.wasm'],
  })
})
