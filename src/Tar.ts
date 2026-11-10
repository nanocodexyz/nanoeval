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

export function unpack(archive: Uint8Array): Entry[] {
  const entries: Entry[] = []
  const text = (offset: number, length: number) => {
    const field = archive.subarray(offset, offset + length)
    const end = field.indexOf(0)
    return Bytes.toText(end === -1 ? field : field.subarray(0, end))
  }
  let long: string | undefined
  for (let offset = 0; offset + block <= archive.length; ) {
    if (archive.subarray(offset, offset + block).every((byte) => byte === 0)) break
    if (archive[offset + 124]! & 0x80)
      throw new PathError('the archive holds an entry too large for an octal size')
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(archive[offset + 156]!)
    const data = archive.subarray(offset + block, offset + block + size)
    if (!Number.isSafeInteger(size) || data.length !== size)
      throw new PathError('the archive is truncated')
    const prefix = text(offset + 345, 155)
    const path = long ?? (prefix ? prefix + '/' : '') + text(offset, 100)
    const mode = Number.parseInt(text(offset + 100, 8).trim() || '0', 8)
    offset += block + Math.ceil(size / block) * block

    if (type === 'x') {
      long = paxPath(Bytes.toText(data)) ?? long
      continue
    }
    if (type === 'L') {
      const end = data.indexOf(0)
      long = Bytes.toText(end === -1 ? data : data.subarray(0, end))
      continue
    }
    long = undefined
    if (type === 'g' || type === '5') continue
    if (type !== '0' && type !== '\0')
      throw new PathError(path + ' is neither a file nor a directory')
    const clean = path.replace(/^(\.\/)+/, '')
    relative(clean)
    entries.push({ data: data.slice(), executable: (mode & 0o111) !== 0, path: clean })
  }
  return entries
}

function paxPath(records: string): string | undefined {
  let path: string | undefined
  for (let rest = records; rest; ) {
    const space = rest.indexOf(' ')
    const length = Number.parseInt(rest.slice(0, space), 10)
    if (space === -1 || !Number.isSafeInteger(length) || length <= space)
      throw new PathError('the archive holds a malformed pax header')
    const encoded = Bytes.fromText(rest)
    const record = Bytes.toText(encoded.subarray(space + 1, length - 1))
    if (record.startsWith('path=')) path = record.slice('path='.length)
    rest = Bytes.toText(encoded.subarray(length))
  }
  return path
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

function relative(path: string): void {
  if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '..'))
    throw new PathError(path + ' is not a relative path inside the archive')
}

function split(path: string): { name: string; prefix: string } {
  relative(path)
  if (Bytes.fromText(path).length <= 100) return { name: path, prefix: '' }

  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Bytes.fromText(prefix).length <= 155 && Bytes.fromText(name).length <= 100)
      return { name, prefix }
  }
  throw new PathError(path + ' does not fit a ustar header')
}
