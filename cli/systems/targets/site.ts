import * as Target from '../Target.ts'
import * as Demo from './cf-demo.ts'

export const origin = 'https://nanocode.xyz'

export const homepage = {
  model: 'gpt-6-luna',
  note: 'the homepage chat runs nanocode-wasm in the browser against /api/openai/responses, so it is not a server session',
  serviceTier: 'priority',
  thinking: 'low',
} as const

export const limits = {
  cloudflare:
    'the /cloudflare/* service binding forwards client headers, so the demo Worker limit applies: ' +
    Demo.limits.publicRate,
  vercel:
    'DEMO_LIMIT 30 requests per 60 s per client address (IPv6 /64) on /vercel/api/*, then 429 with Retry-After 60',
} as const

const maxAssets = 160

const parallel = 8

export type Route = { base: string; kind: 'cloudflare' | 'vercel'; site: string }

export function route(build: Target.Build): Route {
  const url = new URL(build.url ?? origin + '/cloudflare')
  const path = url.pathname.replace(/\/+$/, '')
  const site = url.origin
  if (path === '' || path === '/cloudflare')
    return { base: site + '/cloudflare', kind: 'cloudflare', site }
  if (path === '/vercel') return { base: site + '/vercel', kind: 'vercel', site }
  throw new Target.InvalidError(
    'a site build URL is <origin>, <origin>/cloudflare or <origin>/vercel, not ' + url.href,
  )
}

export function assets(text: string): { scripts: string[]; wasm: string[] } {
  const scripts = new Set<string>()
  const wasm = new Set<string>()
  for (const match of text.matchAll(/assets\/[A-Za-z0-9_.-]+\.(js|wasm)/g))
    (match[1] === 'wasm' ? wasm : scripts).add(match[0])
  return { scripts: [...scripts], wasm: [...wasm] }
}

async function body(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': 'nanoeval' } }).catch(
    (error: unknown) => {
      throw new Error(url + ': ' + String((error as { cause?: unknown }).cause ?? error))
    },
  )
  if (!response.ok) throw new Error(url + ' returned HTTP ' + response.status)
  return await response.text()
}

export async function wasm(
  site: string,
): Promise<{ asset: string; bytes: number; sha256: string } | undefined> {
  const seen = new Set<string>()
  let queue = assets(await body(site + '/')).scripts
  let found: string | undefined
  while (queue.length > 0 && !found && seen.size < maxAssets) {
    const next = new Set<string>()
    const batch = queue.filter((path) => !seen.has(path)).slice(0, maxAssets - seen.size)
    for (const path of batch) seen.add(path)
    for (let start = 0; start < batch.length && !found; start += parallel)
      for (const text of await Promise.all(
        batch.slice(start, start + parallel).map((path) => body(site + '/' + path)),
      )) {
        const listed = assets(text)
        found ??= listed.wasm.find((path) => /\/nanocode_wasm-[^/]+\.wasm$/.test(path))
        for (const path of listed.scripts) if (!seen.has(path)) next.add(path)
      }
    queue = [...next]
  }
  if (!found) return undefined
  const response = await fetch(site + '/' + found)
  if (!response.ok) throw new Error(found + ' returned HTTP ' + response.status)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  return { asset: found, bytes: bytes.length, sha256: digest }
}

async function vercel(): Promise<Target.Target> {
  const path = './vercel-demo.ts'
  const found = (await import(path).catch(() => undefined)) as
    | { default?: Target.Target }
    | undefined
  if (!found?.default)
    throw new Target.InvalidError('the site /vercel route needs the vercel-demo target')
  return found.default
}

async function describe(build: Target.Build): Promise<Target.Description> {
  const at = route(build)
  const [asset, inner] = await Promise.all([
    wasm(at.site).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
    at.kind === 'vercel'
      ? (await vercel()).describe({ ...build, url: at.base })
      : Demo.overrides(Demo.endpoint(at.base, 'SITE')).then(
          (overrides) => ({ overrides }) as Target.Description,
        ),
  ])
  const sha256 = asset && 'sha256' in asset ? asset.sha256 : undefined
  return {
    ...(build.version ? { nanocodeTs: build.version } : {}),
    overrides: {
      demo: { kind: at.kind, ...inner.overrides },
      homepage: { ...homepage, wasm: asset ?? 'no nanocode_wasm asset found' },
      limits,
      turns:
        'turns run in the ' +
        at.kind +
        ' demo behind the site proxy; wasmSha256 is the homepage browser core',
    },
    url: at.base,
    ...(sha256 ? { wasmSha256: sha256 } : {}),
  }
}

const target: Target.Target = {
  describe,
  name: 'site',
  async open(build, context) {
    const at = route(build)
    if (at.kind === 'vercel') return (await vercel()).open({ ...build, url: at.base }, context)
    return Demo.session(Demo.endpoint(at.base, 'SITE'), { context, id: Demo.id() })
  },
  async resume(build, id, context) {
    const at = route(build)
    if (at.kind === 'vercel') {
      const inner = await vercel()
      if (!inner.resume)
        throw new Target.InvalidError('the vercel-demo target cannot resume sessions')
      return inner.resume({ ...build, url: at.base }, id, context)
    }
    const endpoint = Demo.endpoint(at.base, 'SITE')
    return Demo.session(endpoint, { context, id, resumeMs: await Demo.replay(endpoint, id) })
  },
}

export default target
