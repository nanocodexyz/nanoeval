import * as Proxy from '../src/Proxy.ts'

/**
 * A deployment's own ChatGPT relay: the `RelayContainer` of nanocode-egress bound as `CHATGPT_RELAY`, so a Worker pays
 * codex sessions with a ChatGPT plan without a relay at a public URL. chatgpt.com refuses requests from the Workers
 * runtime; the container's are not. `CHATGPT_RELAY_INSTANCES` spreads requests over that many containers, named
 * `relay-0` and on, and `CHATGPT_RELAY_URL` still wins when both are set.
 */
export type Variables = {
  CHATGPT_RELAY?: Namespace
  CHATGPT_RELAY_INSTANCES?: string
  CHATGPT_RELAY_URL?: string
  PLAN_SECRET?: string
}

export type Namespace = {
  get(id: never): { fetch(request: Request): Promise<Response> }
  idFromName(name: string): unknown
}

/** Origin of the requests a relayed credential sends; the container stub routes them, whatever the host. */
export const origin = 'http://relay.internal'

/** Most containers one deployment spreads over, so a typo cannot ask for thousands. */
export const most = 64

/** Returns whether codex plan requests of `env` go through its bound relay container. */
export function bound(env: Variables): boolean {
  return !env.CHATGPT_RELAY_URL && env.CHATGPT_RELAY !== undefined
}

/** Returns how many relay containers `env` spreads over. */
export function instances(env: Variables): number {
  const count = Number(env.CHATGPT_RELAY_INSTANCES ?? 1)
  return Number.isInteger(count) && count > 0 ? Math.min(count, most) : 1
}

/** Returns the container name of `key`, the same for every request of one key. */
export function name(env: Variables, key: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index++)
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0
  return 'relay-' + (hash % instances(env))
}

/**
 * Returns the fetch of `env`'s relay container for `key`, which sends a request's path and query to it with the
 * secret the container derives from `PLAN_SECRET`, or `undefined` when `env` binds no relay.
 */
export function fetcher(
  env: Variables,
  key: string,
): ((request: Request) => Promise<Response>) | undefined {
  const namespace = env.CHATGPT_RELAY
  if (!bound(env) || !namespace) return undefined
  return async (request) => {
    if (!env.PLAN_SECRET) throw new Error('set PLAN_SECRET for the ChatGPT relay container')
    const source = new URL(request.url)
    const forwarded = new Request(new URL(source.pathname + source.search, origin), request)
    forwarded.headers.set(Proxy.relaySecretHeader, await secret(env.PLAN_SECRET))
    return namespace.get(namespace.idFromName(name(env, key)) as never).fetch(forwarded)
  }
}

/**
 * Returns the relay secret derived from `planSecret` with HKDF-SHA-256, as `secret` of
 * `nanocode-egress/cloudflare/container` derives it for the container.
 */
export async function secret(planSecret: string): Promise<string> {
  if (planSecret.length < 32) throw new Error('PLAN_SECRET needs at least 32 characters')
  const encoder = new TextEncoder()
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(planSecret),
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      hash: 'SHA-256',
      info: encoder.encode('relay secret v1'),
      name: 'HKDF',
      salt: encoder.encode('nanocode-egress'),
    },
    material,
    256,
  )
  return btoa(String.fromCharCode(...new Uint8Array(bits)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
