import { Challenge } from 'mppx'
import { createJsonChannelStore, Mppx, tempo, type ChannelStore } from 'mppx/client'
import type * as Budget from './Budget.ts'
import type * as Sql from './Sql.ts'

export type Charge = {
  amount: string
  currency: string
  description: string
  intent: string
  method: string
  realm: string
  usd: number
}

export type Account = Parameters<typeof tempo.charge>[0] extends infer P
  ? P extends { account?: infer A }
    ? NonNullable<A>
    : never
  : never

export type Closed = { amount: string; channelId: string; url: string }

export type Kv = {
  delete(key: string): void
  get(key: string): string | undefined
  keys(prefix: string): readonly string[]
  set(key: string, value: string): void
}

export type Probe = { body?: string; headers: Record<string, string>; method: string; url: string }

export type Unclosed = { channelId: string; error: string }

export type Wallet = { channels: ChannelStore; kv: Kv }

const channelPrefix = 'channel:'

export const decimals = 6

const probePrefix = 'probe:'

export const tables = [
  `CREATE TABLE IF NOT EXISTS payment_channels (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
]

export function pause(input: pause.Input): number | undefined {
  if (input.kind === 'passing')
    return input.tries < input.stepRetries ? input.pollMs * 2 ** input.tries : undefined
  const left = input.refusedAt + input.waitSec * 1000 - input.now
  if (left <= 0) return undefined
  return Math.min(input.pollMs * 2 ** input.tries, input.leaseSec * 1000, left)
}

export declare namespace pause {
  type Input = {
    kind: 'passing' | 'spent'
    leaseSec: number
    now: number
    pollMs: number
    refusedAt: number
    stepRetries: number
    tries: number
    waitSec: number
  }
}

export function usd(amount: string): number {
  if (!/^\d+$/.test(amount))
    throw new Error('a charge amount is a base-unit integer, not ' + amount)
  return Number(BigInt(amount)) / 10 ** decimals
}

export function memory(): Kv {
  const map = new Map<string, string>()
  return {
    delete: (key) => void map.delete(key),
    get: (key) => map.get(key),
    keys: (prefix) => [...map.keys()].filter((key) => key.startsWith(prefix)).sort(),
    set: (key, value) => void map.set(key, value),
  }
}

export function stored(sql: Sql.Sql): Kv {
  return {
    delete: (key) => sql.run('DELETE FROM payment_channels WHERE key = ?', key),
    get: (key) => {
      const row = sql.all('SELECT value FROM payment_channels WHERE key = ?', key)[0]
      return row ? String(row['value']) : undefined
    },
    keys: (prefix) =>
      sql
        .all('SELECT key FROM payment_channels ORDER BY key')
        .map((row) => String(row['key']))
        .filter((key) => key.startsWith(prefix)),
    set: (key, value) =>
      sql.run(
        'INSERT INTO payment_channels (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        value,
      ),
  }
}

export function wallet(kv: Kv = memory()): Wallet {
  return {
    channels: createJsonChannelStore({
      delete: (key) => kv.delete(channelPrefix + key),
      get: (key) => kv.get(channelPrefix + key),
      set: (key, value) => kv.set(channelPrefix + key, value),
    }),
    kv,
  }
}

export function prefer<const T extends { challenge: { intent: string } }>(
  candidates: readonly T[],
): T[] {
  return [
    ...candidates.filter((candidate) => candidate.challenge.intent === 'session'),
    ...candidates.filter((candidate) => candidate.challenge.intent !== 'session'),
  ]
}

export function payer(
  options: payer.Options,
): (input: string, init?: RequestInit) => Promise<Response> {
  const held = options.wallet ?? wallet()
  const send =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const recording: typeof fetch = async (input, init) => {
    const response = await send(input, init)
    if (response.status === 402) {
      const probe = unpaid(input, init)
      if (probe?.method === 'POST' && offersSession(response.headers.get('www-authenticate')))
        held.kv.set(probePrefix + probe.method + ' ' + probe.url, JSON.stringify(probe))
    }
    return response
  }
  const mppx = Mppx.create({
    fetch: recording,
    methods: [
      tempo.session({
        account: options.account,
        channelStore: held.channels,
        ...(options.maxDepositUsd === undefined
          ? {}
          : { maxDeposit: options.maxDepositUsd.toFixed(decimals) }),
      }),
      tempo.charge({ account: options.account }),
    ],
    onChallenge: async (challenge, helpers) => {
      const request = challenge.request as { amount?: unknown; currency?: unknown }
      const charge: Charge = {
        amount: String(request.amount),
        currency: String(request.currency),
        description: challenge.description ?? '',
        intent: challenge.intent,
        method: challenge.method,
        realm: challenge.realm,
        usd: usd(String(request.amount)),
      }
      options.budget.charge(charge.usd, charge.description || challenge.realm)
      const credential = await helpers.createCredential()
      await options.onCharge(charge)
      return credential
    },
    orderChallenges: prefer,
    polyfill: false,
  })
  return (input, init) => mppx.fetch(input, init)
}

export declare namespace payer {
  type Options = {
    account: Account
    budget: Budget.Budget
    fetch?: typeof fetch
    maxDepositUsd?: number
    onCharge(charge: Charge): void | Promise<void>
    wallet?: Wallet
  }
}

export function open(held: Wallet): number {
  return held.kv.keys(channelPrefix).length
}

export async function close(options: close.Options): Promise<close.ReturnType> {
  const send =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const method = tempo.session({ account: options.account, channelStore: options.wallet.channels })
  const probes = options.wallet.kv
    .keys(probePrefix)
    .map((key) => JSON.parse(options.wallet.kv.get(key)!) as Probe)
  const closed: Closed[] = []
  const unclosed: Unclosed[] = []
  for (const key of options.wallet.kv.keys(channelPrefix)) {
    const value = options.wallet.kv.get(key)
    const entry = value === undefined ? undefined : restored(JSON.parse(value) as StoredEntry)
    if (!entry?.opened) {
      options.wallet.kv.delete(key)
      continue
    }
    try {
      closed.push(await closeOne({ entry, method, probes, send }))
      options.wallet.kv.delete(key)
    } catch (error) {
      options.wallet.kv.set(key, value!)
      unclosed.push({
        channelId: entry.channelId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { closed, unclosed }
}

export declare namespace close {
  type Options = { account: Account; fetch?: typeof fetch; wallet: Wallet }
  type ReturnType = { closed: Closed[]; unclosed: Unclosed[] }
}

type Entry = NonNullable<Awaited<ReturnType<ChannelStore['get']>>>

type Session = ReturnType<typeof tempo.session>

async function closeOne(input: {
  entry: Entry
  method: Session
  probes: readonly Probe[]
  send: typeof fetch
}): Promise<Closed> {
  const entry = input.entry
  const same = (left: unknown, right: string) =>
    typeof left === 'string' && left.toLowerCase() === right.toLowerCase()
  for (const probe of input.probes) {
    const asked = await input.send(probe.url, {
      ...(probe.body === undefined ? {} : { body: probe.body }),
      headers: { ...probe.headers, 'payment-session': entry.channelId },
      method: probe.method,
    })
    await asked.body?.cancel()
    if (asked.status !== 402) continue
    const challenge = Challenge.fromResponseList(asked).find((offer) => {
      const request = offer.request as {
        currency?: unknown
        methodDetails?: { chainId?: unknown; escrowContract?: unknown }
        recipient?: unknown
      }
      return (
        offer.method === 'tempo' &&
        offer.intent === 'session' &&
        same(request.recipient, entry.descriptor.payee) &&
        same(request.currency, entry.descriptor.token) &&
        (request.methodDetails?.escrowContract === undefined ||
          same(request.methodDetails.escrowContract, entry.escrow)) &&
        request.methodDetails?.chainId === entry.chainId
      )
    })
    if (!challenge) continue
    const snapshot = (
      challenge.request as {
        methodDetails?: { sessionSnapshot?: { acceptedCumulative?: unknown; channelId?: unknown } }
      }
    ).methodDetails?.sessionSnapshot
    const accepted =
      same(snapshot?.channelId, entry.channelId) &&
      typeof snapshot?.acceptedCumulative === 'string' &&
      /^\d+$/.test(snapshot.acceptedCumulative) &&
      BigInt(snapshot.acceptedCumulative) <= entry.cumulativeAmount
        ? snapshot.acceptedCumulative
        : String(entry.cumulativeAmount)
    const credential = await input.method.createCredential({
      challenge: challenge as Parameters<Session['createCredential']>[0]['challenge'],
      context: {
        action: 'close',
        channelId: entry.channelId,
        cumulativeAmountRaw: accepted,
        descriptor: entry.descriptor,
      },
    })
    const answer = await input.send(probe.url, {
      ...(probe.body === undefined ? {} : { body: probe.body }),
      headers: { ...probe.headers, authorization: credential },
      method: probe.method,
    })
    const text = await answer.text()
    if (!answer.ok)
      throw new Error(
        'the close of channel ' +
          entry.channelId +
          ' was refused with ' +
          answer.status +
          ': ' +
          text.slice(0, 300),
      )
    return { amount: accepted, channelId: entry.channelId, url: probe.url }
  }
  throw new Error(
    'no recorded request offered a session for channel ' + entry.channelId + ' to close it on',
  )
}

type StoredEntry = Omit<Entry, 'cumulativeAmount' | 'deposit'> & {
  cumulativeAmount: string
  deposit: string
}

function restored(entry: StoredEntry): Entry {
  return {
    ...entry,
    cumulativeAmount: BigInt(entry.cumulativeAmount),
    deposit: BigInt(entry.deposit),
  }
}

function offersSession(header: string | null): boolean {
  return /intent="session"/.test(header ?? '')
}

function unpaid(input: RequestInfo | URL, init: RequestInit | undefined): Probe | undefined {
  if (input instanceof Request) return undefined
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  if (headers['authorization'] !== undefined) return undefined
  if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string')
    return undefined
  const url = new URL(String(input))
  return {
    ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    headers,
    method: (init?.method ?? 'GET').toUpperCase(),
    url: url.origin + url.pathname + url.search,
  }
}
