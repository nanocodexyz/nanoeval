import type * as Peers from './Peers.ts'

export function count(cpus: number, threads: number): number {
  return Math.min(Math.ceil(cpus), threads)
}

export function free(threads: readonly number[], held: readonly (readonly number[])[]): number[] {
  const taken = new Set(held.flat())
  return threads.filter((thread) => !taken.has(thread))
}

export function grant(input: grant.Input): number[] | undefined {
  const open = free(input.threads, input.held)
  return open.length - input.count >= input.others ? open.slice(0, input.count) : undefined
}

export declare namespace grant {
  type Input = {
    count: number
    held: readonly (readonly number[])[]
    others: number
    threads: readonly number[]
  }
}

export function needed(vcpus: readonly number[], perThread: number): number {
  return Math.ceil(vcpus.reduce((total, declared) => total + declared, 0) / perThread)
}

export function refusal(input: refusal.Input): string | undefined {
  const shared = input.peers.filter(
    (peer) =>
      !input.own ||
      !peer.threads?.length ||
      peer.threads.some((thread) => input.own!.includes(thread)),
  )
  if (!input.reserves)
    return shared.some((peer) => peer.verifyCores)
      ? 'another runner of this machine reserves hardware threads for its verifiers (--verify-cores) and this runner would use them: pin this runner to other threads, or stop that one'
      : undefined
  if (input.perThread === null)
    return '--verify-cores reserves the hardware threads that the vCPUs of rows stand for, and --slots-only counts none: name one'
  if (!input.own?.length)
    return '--verify-cores reserves hardware threads, and this machine does not say which ones this runner may use'
  if (shared.length)
    return (
      '--verify-cores reserves hardware threads of this runner, and ' +
      shared.length +
      ' other ' +
      (shared.length === 1 ? 'runner' : 'runners') +
      ' of this machine use them too: pin each runner to threads of its own, or run one'
    )
  return undefined
}

export declare namespace refusal {
  type Input = {
    own: readonly number[] | undefined
    peers: readonly Peers.Peer[]
    perThread: number | null
    reserves: boolean
  }
}

export function weight(input: weight.Input): number {
  return Math.max(input.declared, input.count * input.perThread)
}

export declare namespace weight {
  type Input = { count: number; declared: number; perThread: number }
}
