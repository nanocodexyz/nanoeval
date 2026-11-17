export type Build = { binary?: string; label: string; url?: string; version?: string }

export type CellTiming = {
  endMs: number
  kind: 'code' | 'python' | 'shell' | 'tool'
  name: string
  ok: boolean
  startMs: number
}

export type TurnSample = {
  cells: readonly CellTiming[]
  doneMs: number
  error?: string
  estimated?: boolean
  firstByteMs?: number
  firstTokenMs?: number
  metrics?: Readonly<Record<string, number>>
  ok: boolean
  outputTokens?: number
  sendMs: number
  stalled?: boolean
  text: string
  timedOut?: boolean
}

export type Session = { close(): Promise<void>; id: string; turn(prompt: string): Promise<TurnSample> }

export type Description = {
  nanocodeRev?: string
  nanocodeTs?: string
  overrides: Record<string, unknown>
  url?: string
  wasmSha256?: string
}

export type Context = { deadlineMs: number; model?: string; stallMs: number }

export type Target = {
  describe(build: Build): Promise<Description>
  name: string
  open(build: Build, context?: Context): Promise<Session>
  resume?(build: Build, id: string, context?: Context): Promise<Session>
}

export class InvalidError extends Error {
  override name = 'Target.InvalidError'
}

export function now(): number {
  return performance.timeOrigin + performance.now()
}

export function build(spec: string): Build {
  const at = spec.indexOf('=')
  if (at < 1 || at === spec.length - 1)
    throw new InvalidError('a build is label=<url|path|version>, not ' + spec)
  const label = spec.slice(0, at)
  const value = spec.slice(at + 1)
  if (/^https?:\/\//.test(value)) return { label, url: value }
  if (/^[./~]/.test(value) || value.includes('/')) return { binary: value, label }
  return { label, version: value }
}

export function estimate(text: string): number {
  return Math.ceil(text.length / 4)
}
