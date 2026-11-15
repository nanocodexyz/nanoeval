export class InvalidError extends Error {
  override name = 'Price.InvalidError'
}

export type Price = { cachedUsd: number; inputUsd: number; outputUsd: number }

export type List = Readonly<Record<string, Price>>

export type Tokens = { cachedTokens: number; inputTokens: number; outputTokens: number }

export const perTokens = 1_000_000

export const form = 'MODEL=INPUT,CACHED,OUTPUT'

export function valid(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
}

export function parse(text: string): [model: string, price: Price] {
  const at = text.lastIndexOf('=')
  const amounts = at < 1 ? [] : text.slice(at + 1).split(',')
  const [inputUsd, cachedUsd, outputUsd] = amounts.map((amount) =>
    amount.trim() === '' ? Number.NaN : Number(amount),
  )
  if (amounts.length !== 3 || !valid(inputUsd) || !valid(cachedUsd) || !valid(outputUsd))
    throw new InvalidError(
      'a model price is ' +
        form +
        ', in USD for a million input tokens, cached input tokens and output tokens, not ' +
        text,
    )
  return [text.slice(0, at), { cachedUsd, inputUsd, outputUsd }]
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
  return (
    ((tokens.inputTokens - tokens.cachedTokens) * price.inputUsd +
      tokens.cachedTokens * price.cachedUsd +
      tokens.outputTokens * price.outputUsd) /
    perTokens
  )
}
