export class RequestError extends Error {
  override name = 'Judge.RequestError'
}

export type Request = {
  id: string
  prompt: string
}

export const requestBytes = 2 * 1024 * 1024
export const requestFile = 'judge-request.json'
export const responseFile = 'judge-response.json'

export function parse(text: string): Request[] {
  let value: { requests?: unknown }
  try {
    value = JSON.parse(text) as { requests?: unknown }
  } catch (error) {
    throw new RequestError('the judge request is not JSON: ' + (error as Error).message)
  }
  const requests = value?.requests
  if (!Array.isArray(requests) || !requests.length)
    throw new RequestError('the judge request lists no requests')
  const parsed = requests.map((request: Partial<Request> | null): Request => {
    if (typeof request?.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(request.id))
      throw new RequestError('a judge request id is 1 to 64 letters, digits, _ . or -')
    if (typeof request.prompt !== 'string' || !request.prompt.trim())
      throw new RequestError('the judge request ' + request.id + ' has no prompt')
    return { id: request.id, prompt: request.prompt }
  })
  if (new Set(parsed.map((request) => request.id)).size !== parsed.length)
    throw new RequestError('judge request ids must be unique')
  return parsed
}

export function answer(requests: readonly Request[], texts: readonly string[]): string {
  return (
    JSON.stringify({
      responses: requests.map((request, index) => ({ id: request.id, text: texts[index] ?? '' })),
    }) + '\n'
  )
}
