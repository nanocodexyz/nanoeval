export type Pins = { hands: readonly string[]; harness: string | null }

const digits = 12

export function short(revision: string): string {
  return revision.slice(0, digits)
}

export function release(url: string): string {
  return /\/releases\/download\/([^/]+)/.exec(url)?.[1] ?? url
}

export function pinned(url: string): string {
  return 'nanocode-ts ' + release(url)
}

export function harness(input: { nanocode: string; nanocodeTs: string }): string {
  return 'nanocode-ts ' + input.nanocodeTs + ' on nanocode ' + input.nanocode
}

export function hand(nanocode: string): string {
  return 'nanocode ' + nanocode
}

export function file(sha256: string): string {
  return 'sha256 ' + short(sha256)
}

export function text(pins: Pins): string {
  return (
    (pins.harness ?? 'harness not recorded') +
    ', hand ' +
    (pins.hands.length ? pins.hands.join(' and ') : 'not reported')
  )
}
