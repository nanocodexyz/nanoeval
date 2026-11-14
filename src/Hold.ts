export type Outcome = 'released' | 'superseded' | 'timeout'

export type Holds = {
  end(key: string): void
  has(key: string): boolean
  release(matches?: (key: string) => boolean): void
  size(): number
  wait(key: string, ms: number): Promise<Outcome>
}

export function create(): Holds {
  const held = new Map<string, (outcome: Outcome) => void>()
  return {
    end: (key) => held.get(key)?.('superseded'),
    has: (key) => held.has(key),
    release(matches) {
      for (const [key, settle] of held) if (!matches || matches(key)) settle('released')
    },
    size: () => held.size,
    wait(key, ms) {
      held.get(key)?.('superseded')
      return new Promise((resolve) => {
        const settle = (outcome: Outcome) => {
          clearTimeout(timer)
          if (held.get(key) === settle) held.delete(key)
          resolve(outcome)
        }
        const timer = setTimeout(() => settle('timeout'), ms)
        held.set(key, settle)
      })
    },
  }
}
