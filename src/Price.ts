export class InvalidError extends Error {
  override name = 'Price.InvalidError'
}

export type Price = {
  cachedUsd: number
  inputUsd: number
  outputUsd: number
  writeUsd?: { fiveMinutes: number; oneHour: number }
}

export type List = Readonly<Record<string, Price>>

export type Tokens = {
  cacheWriteHourTokens?: number | undefined
  cacheWriteTokens?: number
  cachedTokens: number
  inputTokens: number
  outputTokens: number
}

export const listed: List = {
  'gpt-6-luna': { cachedUsd: 0.01, inputUsd: 0.1, outputUsd: 0.5 },
}

export const perTokens = 1_000_000

export const form = 'MODEL=INPUT,CACHED,OUTPUT[,WRITE,WRITE_1H]'

export function valid(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
}

export function of(model: string, prices: List | undefined): Price | undefined {
  return prices?.[model] ?? listed[model]
}

export function parse(text: string): [model: string, price: Price] {
  const at = text.lastIndexOf('=')
  const amounts = at < 1 ? [] : text.slice(at + 1).split(',')
  const parsed = amounts.map((amount) => (amount.trim() === '' ? Number.NaN : Number(amount)))
  const [inputUsd, cachedUsd, outputUsd, fiveMinutes, oneHour] = parsed
  if (
    (amounts.length !== 3 && amounts.length !== 5) ||
    !parsed.every(valid) ||
    !valid(inputUsd) ||
    !valid(cachedUsd) ||
    !valid(outputUsd)
  )
    throw new InvalidError(
      'a model price is ' +
        form +
        ', in USD for a million input tokens, cached input tokens and output tokens, and for a million input tokens written to a cache for 5 minutes and for 1 hour, not ' +
        text,
    )
  return [
    text.slice(0, at),
    {
      cachedUsd,
      inputUsd,
      outputUsd,
      ...(valid(fiveMinutes) && valid(oneHour) ? { writeUsd: { fiveMinutes, oneHour } } : {}),
    },
  ]
}

export function list(texts: readonly string[]): List {
  const found: Record<string, Price> = {}
  for (const text of texts) {
    const [model, price] = parse(text)
    if (found[model]) throw new InvalidError('the model ' + model + ' is given two prices')
    found[model] = price
  }
  return found
}

export function usd(price: Price, tokens: Tokens): number {
  const written = price.writeUsd ? (tokens.cacheWriteTokens ?? 0) : 0
  const hour = price.writeUsd ? (tokens.cacheWriteHourTokens ?? 0) : 0
  return (
    ((tokens.inputTokens - tokens.cachedTokens - written) * price.inputUsd +
      tokens.cachedTokens * price.cachedUsd +
      (written - hour) * (price.writeUsd?.fiveMinutes ?? 0) +
      hour * (price.writeUsd?.oneHour ?? 0) +
      tokens.outputTokens * price.outputUsd) /
    perTokens
  )
}
