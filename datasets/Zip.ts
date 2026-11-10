import * as Zlib from 'node:zlib'

export class ArchiveError extends Error {
  override name = 'Zip.ArchiveError'
}

const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})

function decrypt(data: Uint8Array, password: string): Uint8Array {
  const keys = [0x12345678, 0x23456789, 0x34567890]
  const update = (byte: number) => {
    keys[0] = (table[(keys[0]! ^ byte) & 0xff]! ^ (keys[0]! >>> 8)) >>> 0
    keys[1] = (Math.imul((keys[1]! + (keys[0]! & 0xff)) >>> 0, 134775813) + 1) >>> 0
    keys[2] = (table[(keys[2]! ^ (keys[1]! >>> 24)) & 0xff]! ^ (keys[2]! >>> 8)) >>> 0
  }
  for (const byte of new TextEncoder().encode(password)) update(byte)
  const plain = new Uint8Array(data.length)
  for (let index = 0; index < data.length; index++) {
    const mask = (keys[2]! | 2) & 0xffff
    plain[index] = data[index]! ^ ((Math.imul(mask, mask ^ 1) >>> 8) & 0xff)
    update(plain[index]!)
  }
  return plain
}

export function extract(
  archive: Uint8Array,
  input: { member: string; password?: string },
): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  let end = archive.length - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw new ArchiveError('the archive has no central directory')

  const decoder = new TextDecoder()
  let offset = view.getUint32(end + 16, true)
  for (let count = view.getUint16(end + 10, true); count > 0; count--) {
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new ArchiveError('the central directory is malformed')
    const nameLength = view.getUint16(offset + 28, true)
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    const entry = {
      checksum: view.getUint32(offset + 16, true),
      flags: view.getUint16(offset + 8, true),
      local: view.getUint32(offset + 42, true),
      method: view.getUint16(offset + 10, true),
      packed: view.getUint32(offset + 20, true),
      time: view.getUint16(offset + 12, true),
    }
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    if (name !== input.member) continue

    if (view.getUint32(entry.local, true) !== 0x04034b50)
      throw new ArchiveError(name + ' has no local header')
    const start =
      entry.local +
      30 +
      view.getUint16(entry.local + 26, true) +
      view.getUint16(entry.local + 28, true)
    let data = archive.subarray(start, start + entry.packed)
    if (entry.flags & 1) {
      if (input.password === undefined) throw new ArchiveError(name + ' is encrypted')
      const plain = decrypt(data, input.password)
      const check = entry.flags & 8 ? entry.time >>> 8 : entry.checksum >>> 24
      if (plain[11] !== check) throw new ArchiveError('the password does not open ' + name)
      data = plain.subarray(12)
    }
    if (entry.method !== 0 && entry.method !== 8)
      throw new ArchiveError(name + ' uses the unsupported compression method ' + entry.method)
    const contents = entry.method === 8 ? Zlib.inflateRawSync(data) : data
    if (Zlib.crc32(contents) !== entry.checksum)
      throw new ArchiveError(name + ' does not match its checksum')
    return new Uint8Array(contents)
  }
  throw new ArchiveError('the archive has no member ' + input.member)
}
