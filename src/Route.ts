import type * as Atif from './Atif.ts'
import type * as Proxy from './Proxy.ts'

export type Payer = 'gateway' | 'key' | 'login' | 'plan'

export type Paid = { payer: Payer; through?: 'base' | 'relay' }

export type Route = {
  effort?: string
  host?: string
  payer?: Payer
  through?: 'base' | 'relay'
  transport?: string
}

export type Deployment = Record<Proxy.Provider, Paid | null>

export type Difference = { aspect: Aspect; left: string; right: string }

export type Aspect = 'host' | 'payer' | 'transport'

export const unrecorded = 'not recorded'

const hosts = ['api.anthropic.com', 'api.openai.com', 'chatgpt.com']

const payers: Record<Payer, string> = {
  gateway: 'the gateway key',
  key: 'the provider key',
  login: 'a plan login',
  plan: 'the plan signed in on the Worker',
}

export function paid(input: {
  gateway: string | undefined
  held: Proxy.Credential | undefined
  plan: boolean
}): Paid | undefined {
  if (input.plan) return { payer: 'plan' }
  const held = input.held
  if (!held) return undefined
  if (held.kind === 'plan')
    return { payer: 'login', ...(held.relay ? { through: 'relay' as const } : {}) }
  if (held.key === input.gateway) return { payer: 'gateway' }
  return { payer: 'key', ...(held.base ? { through: 'base' as const } : {}) }
}

export function planned(
  deployment: Deployment | undefined,
  input: { plan: boolean; provider: Proxy.Provider | 'oracle' },
): Paid | undefined {
  if (!deployment || input.provider === 'oracle') return undefined
  return input.plan ? { payer: 'plan' } : (deployment[input.provider] ?? undefined)
}

const credentials: Record<Proxy.Provider, { login: string; variables: readonly string[] }> = {
  claude: {
    login: '--claude-login FILE',
    variables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'TEMPO_KEY'],
  },
  codex: { login: '--codex-login FILE', variables: ['OPENAI_API_KEY', 'TEMPO_KEY'] },
}

export function unserved(
  deployment: Deployment | undefined,
  input: { plan: boolean; users: readonly { name: string; provider: Proxy.Provider }[] },
): string | undefined {
  if (!deployment || input.plan) return undefined
  for (const provider of ['claude', 'codex'] as const) {
    const users = input.users.filter((user) => user.provider === provider)
    if (!users.length || deployment[provider]) continue
    return (
      'the Worker holds no credential for the ' +
      provider +
      ' models of ' +
      users.map((user) => user.name).join(' and ') +
      ': start nanoeval worker with ' +
      credentials[provider].variables.join(', ').replace(/, ([^,]*)$/, ' or $1') +
      ' in its environment or with ' +
      credentials[provider].login +
      ', or give a deployed Worker one of them as a secret. A run with --oracle needs none'
    )
  }
  return undefined
}

function host(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined
  if (!URL.canParse(url)) return 'another host'
  const name = new URL(url).hostname
  return hosts.includes(name) ? name : 'another host'
}

export function reported(
  events: readonly Atif.SessionEvent[],
): Pick<Route, 'effort' | 'host' | 'transport'> {
  for (const entry of events) {
    const event = entry.event.event
    if (entry.event.source !== 'agent' || event?.type !== 'run.started') continue
    const { effort, transport, websocket_url: url } = event.payload
    const reached = host(url)
    return {
      ...(typeof effort === 'string' && effort ? { effort } : {}),
      ...(reached ? { host: reached } : {}),
      ...(typeof transport === 'string' && transport ? { transport } : {}),
    }
  }
  return {}
}

export function payer(route: Pick<Route, 'payer' | 'through'>): string | undefined {
  if (!route.payer) return undefined
  return (
    payers[route.payer] +
    (route.through === 'base'
      ? ' through a base URL'
      : route.through === 'relay'
        ? ' through the relay'
        : '')
  )
}

function reached(route: Route): string | undefined {
  if (!route.transport && !route.host) return undefined
  return [route.transport, route.host].filter(Boolean).join(' to ')
}

export function distinct(routes: readonly (Route | undefined)[]): Route[] {
  const found = new Map<string, Route>()
  for (const route of routes) {
    if (!route) continue
    const kept: Route = {
      ...(route.effort ? { effort: route.effort } : {}),
      ...(route.host ? { host: route.host } : {}),
      ...(route.payer ? { payer: route.payer } : {}),
      ...(route.through ? { through: route.through } : {}),
      ...(route.transport ? { transport: route.transport } : {}),
    }
    if (Object.keys(kept).length) found.set(JSON.stringify(kept), kept)
  }
  return [...found.keys()].sort().map((key) => found.get(key)!)
}

export function text(routes: readonly Route[] | undefined): string {
  const all = distinct(routes ?? [])
  if (!all.length) return unrecorded
  return all
    .map((route) =>
      [
        payer(route) ?? 'payer ' + unrecorded,
        ...(reached(route) ? [reached(route)!] : []),
        ...(route.effort ? ['effort ' + route.effort] : []),
      ].join(', '),
    )
    .join(' and ')
}

function values(routes: readonly Route[], aspect: Aspect): string[] {
  const read: Record<Aspect, (route: Route) => string | undefined> = {
    host: (route) => route.host,
    payer,
    transport: (route) => route.transport,
  }
  return [...new Set(routes.flatMap((route) => read[aspect](route) ?? []))].sort()
}

export function differences(
  left: readonly Route[],
  right: readonly Route[],
): { differ: Difference[]; missing: { aspect: Aspect; side: 'both' | 'left' | 'right' }[] } {
  const differ: Difference[] = []
  const missing: { aspect: Aspect; side: 'both' | 'left' | 'right' }[] = []
  for (const aspect of ['payer', 'transport', 'host'] as const) {
    const one = values(left, aspect)
    const other = values(right, aspect)
    if (!one.length || !other.length) {
      if (one.length || other.length || aspect === 'payer')
        missing.push({
          aspect,
          side: one.length ? 'right' : other.length ? 'left' : 'both',
        })
      continue
    }
    if (one.join('\n') !== other.join('\n'))
      differ.push({ aspect, left: one.join(' and '), right: other.join(' and ') })
  }
  return { differ, missing }
}
