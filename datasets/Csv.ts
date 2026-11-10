export class FormatError extends Error {
  override name = 'Csv.FormatError'
}

export function parse(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quoted) {
      if (character !== '"') field += character
      else if (text[index + 1] === '"') {
        field += '"'
        index++
      } else quoted = false
    } else if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (quoted) throw new FormatError('a quoted field is not closed')
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }

  const [header, ...records] = rows
  if (!header) throw new FormatError('the file has no header')
  return records.map((record, index) => {
    if (record.length !== header.length)
      throw new FormatError(
        'row ' +
          (index + 2) +
          ' has ' +
          record.length +
          ' fields, and the header has ' +
          header.length,
      )
    return Object.fromEntries(header.map((name, column) => [name, record[column]!]))
  })
}
