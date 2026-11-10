export type Random = {
  shuffle<T>(values: T[]): void
}

export function seedZero(): Random {
  const state = new Uint32Array(624)
  state[0] = 19650218
  for (let index = 1; index < 624; index++) {
    const previous = state[index - 1]!
    state[index] = (Math.imul(1812433253, previous ^ (previous >>> 30)) + index) >>> 0
  }
  let position = 1
  for (let count = 0; count < 624; count++) {
    const previous = state[position - 1]!
    state[position] = (state[position]! ^ Math.imul(previous ^ (previous >>> 30), 1664525)) >>> 0
    if (++position >= 624) {
      state[0] = state[623]!
      position = 1
    }
  }
  for (let count = 0; count < 623; count++) {
    const previous = state[position - 1]!
    state[position] =
      ((state[position]! ^ Math.imul(previous ^ (previous >>> 30), 1566083941)) - position) >>> 0
    if (++position >= 624) {
      state[0] = state[623]!
      position = 1
    }
  }
  state[0] = 0x80000000

  let cursor = 624
  const next = (): number => {
    if (cursor >= 624) {
      for (let index = 0; index < 624; index++) {
        const mixed = (state[index]! & 0x80000000) | (state[(index + 1) % 624]! & 0x7fffffff)
        state[index] =
          (state[(index + 397) % 624]! ^ (mixed >>> 1) ^ (mixed & 1 ? 0x9908b0df : 0)) >>> 0
      }
      cursor = 0
    }
    let value = state[cursor++]!
    value ^= value >>> 11
    value ^= (value << 7) & 0x9d2c5680
    value ^= (value << 15) & 0xefc60000
    value ^= value >>> 18
    return value >>> 0
  }
  const below = (upper: number): number => {
    const bits = 32 - Math.clz32(upper)
    for (;;) {
      const candidate = next() >>> (32 - bits)
      if (candidate < upper) return candidate
    }
  }
  return {
    shuffle(values) {
      for (let index = values.length - 1; index > 0; index--) {
        const selected = below(index + 1)
        const kept = values[index]!
        values[index] = values[selected]!
        values[selected] = kept
      }
    },
  }
}
