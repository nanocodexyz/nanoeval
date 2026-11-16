import type * as Proxy from './Proxy.ts'

type Category = 'bio' | 'cyber' | 'frontier_llm'

const named: Record<string, Partial<Record<Category, string>>> = {
  'claude-opus-5': { cyber: 'claude-opus-4-8' },
  'claude-opus-5-5': {
    bio: 'claude-opus-5',
    cyber: 'claude-opus-4-8',
    frontier_llm: 'claude-opus-5',
  },
  'claude-sonnet-5-5': { cyber: 'claude-sonnet-5', frontier_llm: 'claude-sonnet-5' },
}

const other: Record<Category, string> = {
  bio: 'claude-opus-5',
  cyber: 'claude-opus-4-8',
  frontier_llm: 'claude-opus-5',
}

export function models(input: { model: string; provider: Proxy.Provider }): string[] {
  if (input.provider !== 'claude') return []
  const reached = new Set<string>()
  const from = [input.model]
  for (const model of from)
    for (const next of Object.values(named[model] ?? other)) {
      if (next === input.model || reached.has(next)) continue
      reached.add(next)
      from.push(next)
    }
  return [...reached].sort()
}

export function served(input: { model: string; provider: Proxy.Provider }): string[] {
  return [input.model, ...models(input)]
}

export function billed(input: {
  model: string
  provider: Proxy.Provider
  reported?: string | undefined
}): string {
  return input.reported !== undefined && models(input).includes(input.reported)
    ? input.reported
    : input.model
}

export function refusal(model: unknown): string {
  return 'model ' + String(model) + ' is not served in this run'
}

export function refused(message: string): boolean {
  return /\bmodel \S+ is not served in this run\b/.test(message)
}
