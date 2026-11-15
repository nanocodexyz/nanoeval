export type Load = {
  busy?: number
  endedAt: number
  own?: number
  pressure?: number
  reserved?: true
  startedAt: number
  steal?: number
  threads: number[]
  waitMs?: number
}

type Snapshot = {
  at: number
  guest?: number[]
  own?: number
  stalled?: number
  threads: number[]
  times: Map<number, number[]>
}

const idleFields = [3, 4]
const stealField = 7
const timeFields = 8

export function list(text: string): number[] | undefined {
  if (!/^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/.test(text)) return undefined
  return text.split(',').flatMap((range) => {
    const [first, last = first] = range.split('-').map(Number)
    return Array.from({ length: last! - first! + 1 }, (_, index) => first! + index)
  })
}

export function ranges(threads: readonly number[]): string {
  const sorted = [...threads].sort((left, right) => left - right)
  const found: string[] = []
  for (let index = 0; index < sorted.length; ) {
    let last = index
    while (sorted[last + 1] === sorted[last]! + 1) last++
    found.push(last === index ? String(sorted[index]) : sorted[index] + '-' + sorted[last])
    index = last + 1
  }
  return found.join(',')
}

function numbers(fields: readonly string[]): number[] | undefined {
  const found = fields.map(Number)
  return found.length && found.every((value) => Number.isFinite(value)) ? found : undefined
}

function snapshot(text: string): Snapshot | undefined {
  let at: number | undefined
  let guest: number[] | undefined
  let own: number | undefined
  let stalled: number | undefined
  let threads: number[] | undefined
  const times = new Map<number, number[]>()
  for (const line of text.split('\n')) {
    const [name, ...fields] = line.trim().split(/\s+/)
    if (name === 'at') at = numbers(fields)?.[0]
    else if (name === 'threads') threads = list(fields[0] ?? '')
    else if (name === 'own') own = numbers(fields)?.[0]
    else if (name === 'guest') guest = numbers(fields.slice(1))
    else if (name === 'some') {
      const total = fields.find((field) => field.startsWith('total='))
      stalled = total ? numbers([total.slice('total='.length)])?.[0] : undefined
    } else if (name && /^cpu[0-9]+$/.test(name)) {
      const found = numbers(fields)
      if (found) times.set(Number(name.slice('cpu'.length)), found)
    }
  }
  if (at === undefined || !threads?.length) return undefined
  return {
    at,
    ...(guest ? { guest } : {}),
    ...(own === undefined ? {} : { own }),
    ...(stalled === undefined ? {} : { stalled }),
    threads,
    times,
  }
}

function share(part: number, whole: number): number | undefined {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : undefined
}

function spent(before: readonly number[], after: readonly number[], fields: readonly number[]) {
  return fields.reduce((total, field) => total + (after[field] ?? 0) - (before[field] ?? 0), 0)
}

const every = Array.from({ length: timeFields }, (_, index) => index)

export function load(input: load.Input): Load | undefined {
  const before = snapshot(input.before)
  const after = snapshot(input.after)
  if (!before || !after || after.at < before.at) return undefined
  let idle = 0
  let whole = 0
  for (const thread of after.threads) {
    const first = before.times.get(thread)
    const last = after.times.get(thread)
    if (!first || !last) continue
    idle += spent(first, last, idleFields)
    whole += spent(first, last, every)
  }
  const busy = share(whole - idle, whole)
  const micros = (after.at - before.at) * 1000
  const own =
    before.own === undefined || after.own === undefined
      ? undefined
      : share(after.own - before.own, micros * after.threads.length)
  const pressure =
    before.stalled === undefined || after.stalled === undefined
      ? undefined
      : share(after.stalled - before.stalled, micros)
  const steal =
    before.guest && after.guest && after.guest.length > stealField
      ? share(
          spent(before.guest, after.guest, [stealField]),
          spent(before.guest, after.guest, every),
        )
      : undefined
  return {
    ...(busy === undefined ? {} : { busy }),
    endedAt: after.at,
    ...(own === undefined ? {} : { own }),
    ...(pressure === undefined ? {} : { pressure }),
    ...(input.reserved ? { reserved: true as const } : {}),
    startedAt: before.at,
    ...(steal === undefined ? {} : { steal }),
    threads: after.threads,
    ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
  }
}

export declare namespace load {
  type Input = { after: string; before: string; reserved?: boolean; waitMs?: number }
}

function percent(value: number): string {
  return (value * 100).toFixed(1) + ' %'
}

export function text(found: Load): string {
  return (
    'verify_cpus=' +
    ranges(found.threads) +
    (found.reserved ? ' reserved' : '') +
    ' (' +
    [
      found.busy === undefined ? '' : 'busy ' + percent(found.busy),
      found.busy === undefined || found.own === undefined
        ? ''
        : 'others ' + percent(found.busy - found.own),
      found.steal === undefined ? '' : 'steal ' + percent(found.steal),
      found.pressure === undefined ? '' : 'pressure ' + percent(found.pressure),
      found.waitMs === undefined ? '' : 'waited ' + (found.waitMs / 1000).toFixed(1) + ' s',
      ((found.endedAt - found.startedAt) / 1000).toFixed(1) + ' s',
    ]
      .filter(Boolean)
      .join(', ') +
    ')'
  )
}
