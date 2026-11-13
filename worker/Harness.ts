import type * as Atif from '../src/Atif.ts'
import * as Sse from '../src/Sse.ts'
import * as Telemetry from '../src/Telemetry.ts'
import { account, type Env } from './Env.ts'
import { nanocode } from './Sessions.ts'

export class LostError extends Error {
  override name = 'Harness.LostError'
}

export class RequestError extends Error {
  override name = 'Harness.RequestError'
}

export type Report = {
  error?: string
  kind?: string
  ok?: { message?: string; model?: string; session_id?: string }
  request_id: string
  status: 'cancelled' | 'completed' | 'failed' | 'queued' | 'running'
}

export type Turn = {
  hand?: string
  model: string
  prompt: string
  provider: 'claude' | 'codex'
  requestId: string
  thinking?: string
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return nanocode.fetch(
    new Request('https://nanoeval.internal' + path, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + env.ACCESS_TOKEN },
    }),
    env,
  )
}

async function json<T>(response: Response, action: string): Promise<T> {
  if (!response.ok)
    throw new RequestError(
      action + ' answered ' + response.status + ': ' + (await response.text()).slice(0, 500),
    )
  return (await response.json()) as T
}

const session = (name: string) => '/sessions/' + encodeURIComponent(name)

export async function token(env: Env, name: string): Promise<string> {
  const minted = await json<{ token: string }>(
    await call(env, session(name) + '/hands', { method: 'POST' }),
    'minting a hand token',
  )
  return minted.token
}

export async function hands(env: Env, name: string): Promise<readonly string[]> {
  const listed = await json<{ hands: string[] }>(
    await call(env, session(name) + '/hands'),
    'listing hands',
  )
  return listed.hands
}

export async function submit(env: Env, name: string, turn: Turn): Promise<Report> {
  return json<Report>(
    await call(env, session(name) + '/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(turn.hand ? { hand: turn.hand } : {}),
        model: turn.model,
        prompt: turn.prompt,
        provider: turn.provider,
        request_id: turn.requestId,
        ...(turn.thinking ? { thinking: turn.thinking } : {}),
      }),
    }),
    'submitting the turn',
  )
}

export async function turn(env: Env, name: string, requestId: string): Promise<Report> {
  const response = await call(env, session(name) + '/turns/' + encodeURIComponent(requestId))
  if (response.status === 404)
    throw new LostError(
      'the session ' +
        name +
        ' answered 404 for the turn ' +
        requestId +
        ': ' +
        (await response.text()).slice(0, 500),
    )
  return json<Report>(response, 'reading the turn')
}

export async function cancel(env: Env, name: string, requestId: string): Promise<void> {
  const response = await call(
    env,
    session(name) + '/turns/' + encodeURIComponent(requestId) + '/cancel',
    { method: 'POST' },
  )
  await response.body?.cancel()
}

export async function events(
  env: Env,
  name: string,
  requestId: string,
): Promise<Atif.SessionEvent[]> {
  await turn(env, name, requestId)
  const all: Atif.SessionEvent[] = []
  let after = 0
  for (;;) {
    const page = await json<{
      events: Atif.SessionEvent[]
      has_more: boolean
      next_cursor: number
      telemetry?: Telemetry.Row[]
    }>(
      await call(env, session(name) + '/events?after=' + after + '&limit=' + env.EVENT_PAGE_SIZE, {
        headers: { [Telemetry.header]: '1' },
      }),
      'reading events',
    )
    if (!page.telemetry) throw new RequestError('reading events answered without their telemetry')
    all.push(...Telemetry.merge(page.events, page.telemetry))
    if (!page.has_more || page.next_cursor <= after) return all
    after = page.next_cursor
  }
}

export async function watch(env: Env, name: string, input: watch.Input): Promise<watch.Seen> {
  const response = await call(
    env,
    session(name) + '/events?after=' + input.after + '&limit=' + env.EVENT_PAGE_SIZE,
    { headers: { accept: 'text/event-stream' } },
  )
  if (!response.ok || !response.body)
    throw new RequestError(
      'watching events answered ' + response.status + ': ' + (await response.text()).slice(0, 500),
    )
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let cursor = input.after
  let rest = ''
  let stop = () => {}
  const expired = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), input.waitMs)
    stop = () => clearTimeout(timer)
  })
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), input.released, expired])
      if (!chunk || chunk.done) return { cursor }
      const parsed = Sse.parse(rest + decoder.decode(chunk.value, { stream: true }))
      rest = parsed.rest
      for (const message of parsed.messages) {
        if (message.data === undefined || message.event !== undefined) continue
        const event = JSON.parse(message.data) as Atif.SessionEvent
        cursor = Math.max(cursor, event.seq)
        const type = event.event.type
        if (
          event.request_id === input.requestId &&
          type !== undefined &&
          input.types.includes(type)
        )
          return { at: event.created_at, cursor, type }
      }
    }
  } finally {
    stop()
    await reader.cancel().catch(() => {})
  }
}

export declare namespace watch {
  type Input = {
    after: number
    released?: Promise<undefined>
    requestId: string
    types: readonly string[]
    waitMs: number
  }
  type Seen = { at?: number; cursor: number; type?: string }
}

export async function remove(env: Env, name: string): Promise<void> {
  await nanocode.deleteSession(env, { account, name })
}
