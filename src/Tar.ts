import * as Bytes from './internal/Bytes.ts'

export class PathError extends Error {
  override name = 'Tar.PathError'
}

export type Entry = {
  data: Uint8Array
  executable?: boolean
  path: string
}

const block = 512

export function pack(entries: readonly Entry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of [...entries].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    chunks.push(header(entry))
    chunks.push(entry.data)
    const padding = (block - (entry.data.length % block)) % block
    if (padding) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(block * 2))

  const archive = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.length
  }
  return archive
}

function header(entry: Entry): Uint8Array {
  const { name, prefix } = split(entry.path)
  const bytes = new Uint8Array(block)
  const field = (text: string, offset: number, length: number) => {
    const encoded = Bytes.fromText(text)
    if (encoded.length > length) throw new PathError(entry.path + ' does not fit a ustar header')
    bytes.set(encoded, offset)
  }
  const octal = (value: number, offset: number, length: number) =>
    field(value.toString(8).padStart(length - 1, '0'), offset, length - 1)

  field(name, 0, 100)
  octal(entry.executable ? 0o755 : 0o644, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(entry.data.length, 124, 12)
  octal(0, 136, 12)
  bytes.fill(0x20, 148, 156)
  bytes[156] = 0x30
  field('ustar', 257, 6)
  field('00', 263, 2)
  field(prefix, 345, 155)

  let sum = 0
  for (const byte of bytes) sum += byte
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return bytes
}

function split(path: string): { name: string; prefix: string } {
  if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '..'))
    throw new PathError(path + ' is not a relative path inside the archive')
  if (Bytes.fromText(path).length <= 100) return { name: path, prefix: '' }

  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Bytes.fromText(prefix).length <= 155 && Bytes.fromText(name).length <= 100)
      return { name, prefix }
  }
  throw new PathError(path + ' does not fit a ustar header')
}
