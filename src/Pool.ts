import type * as Config from './Config.ts'
import type * as Sandbox from './Sandbox.ts'
import type * as Slot from './Slot.ts'
import type * as Sql from './Sql.ts'

export type Kind = 'machine' | 'sandbox'

export type Spec = {
  backend: Slot.Backend
  kind: Kind
  network: Slot.Network
  provider: Config.Config['sandbox']['provider'] | null
  runtime: string | null
  template: string | null
}

export type Wanted = Omit<Spec, 'backend'> & { backend: Config.Backend }

export type State = 'assigned' | 'closed' | 'failed' | 'idle'

export type Member = {
  assignment: string | null
  capabilities: string | null
  created_at: number
  error: string | null
  expires_at: number | null
  handle: string | null
  id: number
  idle_sec: number
  idle_until: number | null
  lease_sec: number | null
  notice_sec: number
  paid_until: number | null
  run: string | null
  runs: number
  seen_at: number
  spec: string
  state: State
  token: string
  unrenewed: number
  usd: number
}

export type Taken = {
  capabilities: Sandbox.Capabilities | null
  expiresAt: number | null
  handle: Sandbox.Handle | null
  id: number
  paidUntil: number | null
}

export type Due = { action: 'close' | 'renew'; member: Member; reason: string }

export const tables = [
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL,
    spec TEXT NOT NULL,
    token TEXT NOT NULL,
    handle TEXT,
    capabilities TEXT,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    expires_at INTEGER,
    paid_until INTEGER,
    idle_sec INTEGER NOT NULL,
    idle_until INTEGER,
    lease_sec INTEGER,
    notice_sec INTEGER NOT NULL,
    usd REAL NOT NULL,
    unrenewed INTEGER NOT NULL DEFAULT 0,
    run TEXT,
    runs INTEGER NOT NULL DEFAULT 0,
    assignment TEXT,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    member INTEGER NOT NULL,
    usd REAL NOT NULL,
    detail TEXT NOT NULL
  )`,
]

export function wanted(sandbox: Config.Config['sandbox']): Wanted {
  const machine = sandbox.max === 0
  return {
    backend: sandbox.backend,
    kind: machine ? 'machine' : 'sandbox',
    network: sandbox.network,
    provider: machine ? null : sandbox.provider,
    runtime: machine ? null : (sandbox.runtime?.digest ?? null),
    template: machine ? null : (sandbox.template ?? null),
  }
}

export function fits(spec: Spec, asked: Wanted): boolean {
  return (
    spec.kind === asked.kind &&
    spec.network === asked.network &&
    spec.provider === asked.provider &&
    spec.runtime === asked.runtime &&
    spec.template === asked.template &&
    (asked.backend === 'auto' ? spec.backend !== 'dir' : spec.backend === asked.backend)
  )
}

function update(sql: Sql.Sql, id: number, fields: Record<string, Sql.Value>): void {
  const names = Object.keys(fields)
  sql.run(
    'UPDATE members SET ' + names.map((name) => name + ' = ?').join(', ') + ' WHERE id = ?',
    ...names.map((name) => fields[name]!),
    id,
  )
}

export function all(sql: Sql.Sql): Member[] {
  return sql.all('SELECT * FROM members ORDER BY id') as unknown as Member[]
}

export function get(sql: Sql.Sql, id: number): Member | undefined {
  return sql.all('SELECT * FROM members WHERE id = ?', id)[0] as unknown as Member | undefined
}

export function enroll(sql: Sql.Sql, input: enroll.Input): Member {
  sql.run(
    `INSERT INTO members (state, spec, token, handle, capabilities, created_at, seen_at, expires_at,
      paid_until, idle_sec, lease_sec, notice_sec, usd, run, runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.run === undefined ? 'idle' : 'assigned',
    JSON.stringify(input.spec),
    input.token,
    input.handle ? JSON.stringify(input.handle) : null,
    input.capabilities ? JSON.stringify(input.capabilities) : null,
    input.now,
    input.now,
    input.expiresAt ?? null,
    input.paidUntil ?? null,
    input.idleSec,
    input.leaseSec ?? null,
    input.noticeSec,
    input.usd,
    input.run ?? null,
    input.run === undefined ? 0 : 1,
  )
  return get(sql, sql.all('SELECT MAX(id) AS id FROM members')[0]!['id'] as number)!
}

export declare namespace enroll {
  type Input = {
    capabilities?: Sandbox.Capabilities
    expiresAt?: number | null
    handle?: Sandbox.Handle
    idleSec: number
    leaseSec?: number
    noticeSec: number
    now: number
    paidUntil?: number | null
    run?: string
    spec: Spec
    token: string
    usd: number
  }
}

export function take(sql: Sql.Sql, input: take.Input): Taken | undefined {
  const standing = (candidate: Member) =>
    input.holding(candidate.id) || input.now - candidate.seen_at <= candidate.notice_sec * 1000
  const fitting = all(sql).filter(
    (candidate) =>
      candidate.state === 'idle' &&
      candidate.capabilities !== null &&
      standing(candidate) &&
      fits(JSON.parse(candidate.spec) as Spec, input.wanted) &&
      (candidate.handle === null ||
        ((candidate.idle_until ?? 0) > input.now &&
          (candidate.paid_until === null ||
            candidate.paid_until - input.now > candidate.notice_sec * 1000) &&
          (candidate.expires_at === null ||
            candidate.expires_at - input.now >= input.lifetimeSec * 1000))),
  )
  const member = fitting.find((candidate) => input.holding(candidate.id)) ?? fitting[0]
  if (!member) return undefined
  update(sql, member.id, {
    assignment: null,
    idle_until: null,
    run: input.run,
    runs: member.runs + 1,
    state: 'assigned',
  })
  return {
    capabilities: JSON.parse(member.capabilities!) as Sandbox.Capabilities,
    expiresAt: member.expires_at,
    handle: member.handle ? (JSON.parse(member.handle) as Sandbox.Handle) : null,
    id: member.id,
    paidUntil: member.paid_until,
  }
}

export declare namespace take {
  type Input = {
    holding(id: number): boolean
    lifetimeSec: number
    now: number
    run: string
    wanted: Wanted
  }
}

export function assign(
  sql: Sql.Sql,
  input: { assignment: string; id: number; run: string },
): boolean {
  const member = get(sql, input.id)
  if (!member || member.state !== 'assigned' || member.run !== input.run) return false
  update(sql, member.id, { assignment: input.assignment })
  return true
}

export function served(sql: Sql.Sql, input: { id: number; now: number; run: string }): void {
  const member = get(sql, input.id)
  if (!member || member.state !== 'assigned' || member.run !== input.run) return
  if (member.handle === null)
    update(sql, member.id, { assignment: null, run: null, seen_at: input.now, state: 'idle' })
  else update(sql, member.id, { assignment: null })
}

export function settle(sql: Sql.Sql, input: settle.Input): boolean {
  const member = get(sql, input.id)
  if (!member || member.state !== 'assigned' || member.run !== input.run) return false
  const idleSec = input.idleSec ?? member.idle_sec
  update(sql, member.id, {
    assignment: null,
    ...(input.capabilities ? { capabilities: JSON.stringify(input.capabilities) } : {}),
    idle_sec: idleSec,
    idle_until: input.now + idleSec * 1000,
    ...(input.paidUntil === undefined ? {} : { paid_until: input.paidUntil }),
    run: null,
    seen_at: input.now,
    state: 'idle',
    unrenewed: 0,
    ...(input.usd === undefined ? {} : { usd: input.usd }),
  })
  return true
}

export declare namespace settle {
  type Input = {
    capabilities?: Sandbox.Capabilities
    id: number
    idleSec?: number
    now: number
    paidUntil?: number | null
    run: string
    usd?: number
  }
}

export function end(sql: Sql.Sql, input: end.Input): boolean {
  const member = get(sql, input.id)
  if (!member || member.state === 'closed' || member.state === 'failed') return false
  if (input.run !== undefined && member.run !== input.run) return false
  update(sql, member.id, {
    assignment: null,
    error: input.error ?? null,
    idle_until: null,
    state: input.error === undefined ? 'closed' : 'failed',
  })
  return true
}

export declare namespace end {
  type Input = { error?: string; id: number; run?: string }
}

export function seen(sql: Sql.Sql, input: seen.Input): void {
  update(sql, input.id, {
    ...(input.capabilities ? { capabilities: JSON.stringify(input.capabilities) } : {}),
    seen_at: input.now,
  })
}

export declare namespace seen {
  type Input = { capabilities?: Sandbox.Capabilities; id: number; now: number }
}

export function renewed(sql: Sql.Sql, input: { id: number; paidUntil: number }): void {
  update(sql, input.id, { paid_until: input.paidUntil })
}

export function unrenewed(sql: Sql.Sql, input: { error: string; id: number }): void {
  update(sql, input.id, { error: input.error, unrenewed: 1 })
}

function horizon(member: Member): number {
  return Math.min(member.idle_until ?? 0, member.expires_at ?? Infinity)
}

export function renewal(member: Member, defaultLeaseSec: number): number {
  if (member.paid_until === null) return 0
  return Math.max(
    0,
    Math.min(
      member.lease_sec ?? defaultLeaseSec,
      Math.ceil((horizon(member) - member.paid_until) / 1000),
    ),
  )
}

export function due(sql: Sql.Sql, input: due.Input): Due[] {
  const found: Due[] = []
  for (const member of all(sql)) {
    if (member.state !== 'idle') continue
    if (member.handle === null) {
      if (!input.holding(member.id) && input.now - member.seen_at > member.notice_sec * 1000)
        found.push({ action: 'close', member, reason: 'the runner stopped asking for a run' })
      continue
    }
    if (input.now >= horizon(member))
      found.push({ action: 'close', member, reason: 'the idle time ended' })
    else if (member.paid_until !== null && input.now >= member.paid_until)
      found.push({ action: 'close', member, reason: 'the lease ended' })
    else if (
      member.paid_until !== null &&
      !member.unrenewed &&
      member.paid_until - input.now <= member.notice_sec * 1000 &&
      horizon(member) > member.paid_until
    )
      found.push({ action: 'renew', member, reason: 'the lease ends inside the idle time' })
  }
  return found
}

export declare namespace due {
  type Input = { holding(id: number): boolean; now: number }
}

export function wakeAt(sql: Sql.Sql): number | undefined {
  let least: number | undefined
  const sooner = (at: number) => {
    if (least === undefined || at < least) least = at
  }
  for (const member of all(sql)) {
    if (member.state !== 'idle') continue
    if (member.handle === null) {
      sooner(member.seen_at + member.notice_sec * 1000 + 1)
      continue
    }
    sooner(horizon(member))
    if (member.paid_until !== null)
      sooner(
        member.unrenewed || horizon(member) <= member.paid_until
          ? member.paid_until
          : member.paid_until - member.notice_sec * 1000,
      )
  }
  return least
}

export function pay(
  sql: Sql.Sql,
  input: { at: number; detail: string; member: number; usd: number },
): void {
  sql.run(
    'INSERT INTO payments (at, member, usd, detail) VALUES (?, ?, ?, ?)',
    input.at,
    input.member,
    input.usd,
    input.detail,
  )
}

export function spent(sql: Sql.Sql, member?: number): number {
  const row =
    member === undefined
      ? sql.all('SELECT COALESCE(SUM(usd), 0) AS usd FROM payments')[0]
      : sql.all('SELECT COALESCE(SUM(usd), 0) AS usd FROM payments WHERE member = ?', member)[0]
  return (row?.['usd'] as number) ?? 0
}

export function payments(sql: Sql.Sql): Sql.Row[] {
  return sql.all('SELECT at, member, usd, detail FROM payments ORDER BY id')
}
