export class RefusedError extends Error {
  override name = 'Logins.RefusedError'
}

export class ServiceError extends Error {
  override name = 'Logins.ServiceError'
}

export type Provider = 'claude' | 'codex'

export type Headers = Record<string, string>

export type Variables = {
  CHATGPT_ACCESS_TOKEN?: string
  CHATGPT_ACCOUNT_ID?: string
  CHATGPT_LOGIN_URL?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
  CLAUDE_LOGIN_URL?: string
  LOGIN_SECRET?: string
}

export const secretHeader = 'x-nanoeval-login-secret'

const bearer = 'Bearer '

export function claude(access: string): Headers {
  return { authorization: bearer + access }
}

export function codex(access: string, account: string): Headers {
  return { authorization: bearer + access, 'chatgpt-account-id': account }
}

export function token(headers: Headers): string | undefined {
  const authorization = headers['authorization'] ?? ''
  return authorization.startsWith(bearer) ? authorization.slice(bearer.length) : undefined
}

function service(variables: Variables, provider: Provider): string | undefined {
  return (
    (provider === 'claude' ? variables.CLAUDE_LOGIN_URL : variables.CHATGPT_LOGIN_URL) || undefined
  )
}

function fixed(variables: Variables, provider: Provider): Headers | undefined {
  if (provider === 'claude')
    return variables.CLAUDE_CODE_OAUTH_TOKEN ? claude(variables.CLAUDE_CODE_OAUTH_TOKEN) : undefined
  return variables.CHATGPT_ACCESS_TOKEN && variables.CHATGPT_ACCOUNT_ID
    ? codex(variables.CHATGPT_ACCESS_TOKEN, variables.CHATGPT_ACCOUNT_ID)
    : undefined
}

export function held(variables: Variables, provider: Provider): boolean {
  return service(variables, provider) !== undefined || fixed(variables, provider) !== undefined
}

export async function headers(variables: Variables, input: headers.Input): Promise<Headers> {
  const { provider } = input
  const url = service(variables, provider)
  if (!url) {
    const known = fixed(variables, provider)
    if (!known) throw new RefusedError('no ' + provider + ' plan login is set')
    return known
  }
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(url, {
      body: JSON.stringify(input.rejected === undefined ? {} : { rejected: input.rejected }),
      headers: { 'content-type': 'application/json', [secretHeader]: variables.LOGIN_SECRET ?? '' },
      method: 'POST',
    })
  } catch (error) {
    throw new ServiceError(
      'the login service of nanoeval worker was not reached: ' +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  const answer = (await response.json().catch(() => undefined)) as
    | { error?: unknown; headers?: unknown }
    | undefined
  if (response.status === 401 && typeof answer?.error === 'string')
    throw new RefusedError(answer.error)
  const given = answer?.headers
  if (
    !response.ok ||
    typeof given !== 'object' ||
    given === null ||
    Object.values(given).some((value) => typeof value !== 'string')
  )
    throw new ServiceError(
      'the login service of nanoeval worker answered ' +
        response.status +
        (typeof answer?.error === 'string' ? ': ' + answer.error : ''),
    )
  return given as Headers
}

export declare namespace headers {
  type Input = {
    fetch?: (input: string, init: RequestInit) => Promise<Response>
    provider: Provider
    rejected?: string
  }
}

export async function send(input: send.Input): Promise<Response> {
  const first = await input.credential()
  const response = await input.attempt(first)
  const rejected = token(first)
  if (response.status !== 401 || rejected === undefined) return response
  let second: Headers
  try {
    second = await input.credential(rejected)
  } catch (error) {
    await response.body?.cancel()
    throw error
  }
  if (token(second) === rejected) return response
  await response.body?.cancel()
  return input.attempt(second)
}

export declare namespace send {
  type Input = {
    attempt(headers: Headers): Promise<Response>
    credential(rejected?: string): Promise<Headers>
  }
}
