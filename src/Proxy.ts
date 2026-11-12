import * as Gateway from './Gateway.ts'

export type Provider = 'claude' | 'codex'

export type Key = { base?: string; key: string; kind: 'key'; scheme: 'bearer' | 'x-api-key' }

export type Credential =
  | Key
  | { headers: Record<string, string>; kind: 'plan'; relay?: { secret: string; url: string } }

export type Variables = {
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  TEMPO_GATEWAY_URL?: string
  TEMPO_KEY?: string
}

export type Usage = {
  cacheWriteTokens: number
  cachedTokens: number
  costUsd?: number
  inputTokens: number
  model?: string
  outputTokens: number
}

export const oauthBeta = 'oauth-2025-04-20'
export const relaySecretHeader = 'x-nanocode-relay-secret'

const origins = { claude: 'https://api.anthropic.com', codex: 'https://api.openai.com' } as const
const chatgpt = 'https://chatgpt.com'
const routes: Record<Provider, readonly string[]> = {
  claude: ['v1/messages', 'v1/messages/count_tokens'],
  codex: ['responses', 'responses/compact'],
}
const generations: Record<Provider, readonly string[]> = {
  claude: ['v1/messages'],
  codex: ['responses', 'responses/compact'],
}
const dropped = [
  'accept-encoding',
  'authorization',
  'cdn-loop',
  'chatgpt-account-id',
  'connection',
  'content-length',
  'host',
  relaySecretHeader,
  'x-api-key',
  'x-real-ip',
]

export function key(variables: Variables, provider: Provider): Key | undefined {
  const base = provider === 'claude' ? variables.ANTHROPIC_BASE_URL : variables.OPENAI_BASE_URL
  const own = (value: string, scheme: Key['scheme']): Key => ({
    ...(base ? { base } : {}),
    key: value,
    kind: 'key',
    scheme,
  })
  if (provider === 'claude' && variables.ANTHROPIC_AUTH_TOKEN)
    return own(variables.ANTHROPIC_AUTH_TOKEN, 'bearer')
  if (provider === 'claude' && variables.ANTHROPIC_API_KEY)
    return own(variables.ANTHROPIC_API_KEY, 'x-api-key')
  if (provider === 'codex' && variables.OPENAI_API_KEY)
    return own(variables.OPENAI_API_KEY, 'bearer')
  return variables.TEMPO_KEY
    ? {
        base: variables.TEMPO_GATEWAY_URL || Gateway.origin,
        key: variables.TEMPO_KEY,
        kind: 'key',
        scheme: 'bearer',
      }
    : undefined
}

export function authorize(headers: Headers, credential: Key): void {
  headers.delete('authorization')
  headers.delete('x-api-key')
  if (credential.scheme === 'x-api-key') headers.set('x-api-key', credential.key)
  else headers.set('authorization', 'Bearer ' + credential.key)
}

export function token(headers: Headers): string | undefined {
  const authorization = headers.get('authorization') ?? ''
  if (authorization.startsWith('Bearer ')) return authorization.slice('Bearer '.length)
  return headers.get('x-api-key') ?? undefined
}

export function route(provider: Provider, path: string): string | undefined {
  const clean = path.replace(/^\/+|\/+$/g, '')
  return routes[provider].includes(clean) ? clean : undefined
}

export function generates(provider: Provider, path: string): boolean {
  return generations[provider].includes(path)
}

export function forward(input: forward.Input): { headers: Headers; url: string } {
  const { credential, provider } = input
  const headers = new Headers()
  input.headers.forEach((value, name) => {
    if (!dropped.includes(name) && !name.startsWith('cf-') && !name.startsWith('x-forwarded-'))
      headers.set(name, value)
  })
  const base = (value: string) => value.replace(/\/+$/, '')

  if (credential.kind === 'key') {
    authorize(headers, credential)
    return {
      headers,
      url:
        base(credential.base ?? origins[provider]) +
        '/' +
        (provider === 'codex' ? 'v1/' : '') +
        input.path +
        input.search,
    }
  }

  for (const [name, value] of Object.entries(credential.headers)) headers.set(name, value)
  if (provider === 'claude') {
    const betas = (headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim())
      .filter(Boolean)
    if (!betas.includes(oauthBeta)) betas.push(oauthBeta)
    headers.set('anthropic-beta', betas.join(','))
    return { headers, url: origins.claude + '/' + input.path + input.search }
  }
  if (credential.relay) headers.set(relaySecretHeader, credential.relay.secret)
  return {
    headers,
    url: base(credential.relay?.url ?? chatgpt) + '/backend-api/codex/' + input.path,
  }
}

export declare namespace forward {
  type Input = {
    credential: Credential
    headers: Headers
    path: string
    provider: Provider
    search: string
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function meter(provider: Provider): {
  push(chunk: string): void
  usage(): Usage | undefined
} {
  let pending = ''
  let whole = ''
  let stream = false
  let found: Usage | undefined
  const read = (value: Record<string, any>) => {
    if (provider === 'codex') {
      const response = value['response'] ?? value
      const used = response?.['usage']
      if (typeof used !== 'object' || used === null) return
      found = {
        cacheWriteTokens: count(used['input_tokens_details']?.['cache_write_tokens']),
        cachedTokens: count(used['input_tokens_details']?.['cached_tokens']),
        ...(typeof used['cost'] === 'number' ? { costUsd: count(used['cost']) } : {}),
        inputTokens: count(used['input_tokens']),
        ...(typeof response['model'] === 'string' ? { model: response['model'] } : {}),
        outputTokens: count(used['output_tokens']),
      }
      return
    }
    const message = value['type'] === 'message_start' ? value['message'] : value
    const used = message?.['usage']
    if (typeof used !== 'object' || used === null) return
    const write =
      'cache_creation_input_tokens' in used
        ? count(used['cache_creation_input_tokens'])
        : (found?.cacheWriteTokens ?? 0)
    const cached =
      'cache_read_input_tokens' in used
        ? count(used['cache_read_input_tokens'])
        : (found?.cachedTokens ?? 0)
    const model = typeof message['model'] === 'string' ? message['model'] : found?.model
    const cost = typeof used['cost'] === 'number' ? count(used['cost']) : found?.costUsd
    found = {
      cacheWriteTokens: write,
      cachedTokens: cached,
      ...(cost === undefined ? {} : { costUsd: cost }),
      inputTokens:
        'input_tokens' in used
          ? count(used['input_tokens']) + cached + write
          : (found?.inputTokens ?? 0),
      ...(model ? { model } : {}),
      outputTokens:
        'output_tokens' in used ? count(used['output_tokens']) : (found?.outputTokens ?? 0),
    }
  }
  const line = (text: string) => {
    if (!text.startsWith('data:')) return
    stream = true
    try {
      const value = JSON.parse(text.slice('data:'.length)) as unknown
      if (typeof value === 'object' && value !== null) read(value as Record<string, any>)
    } catch {}
  }
  return {
    push(chunk) {
      if (!stream) whole += chunk
      pending += chunk
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        line(pending.slice(0, end).replace(/\r$/, ''))
        pending = pending.slice(end + 1)
      }
      if (stream) whole = ''
    },
    usage() {
      if (pending) line(pending)
      pending = ''
      if (!stream && whole.trimStart().startsWith('{'))
        try {
          read(JSON.parse(whole) as Record<string, any>)
        } catch {}
      return found
    },
  }
}
