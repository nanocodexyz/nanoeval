import type * as Admission from './Admission.ts'
import type * as Eval from './Eval.ts'
import type * as Installed from './Installed.ts'
import type * as Result from './Result.ts'
import type * as Sandbox from './Sandbox.ts'
import type * as Verdict from './Verdict.ts'

export const handName = 'slot'
export const artifactBytes = 4 * 1024 * 1024
export const logBytes = 65_536

export type Report = {
  freeDiskMb?: number
  offer?: Admission.Offer
  running: number
  starved?: boolean
  unfit?: boolean
}

export type Held = { claim: string; id: string }

export type Hello = { capabilities: Sandbox.Capabilities; held: readonly Held[]; runner: number }

export type ClaimRequest = { offer: Admission.Offer; report: Report; runner: number }

export type Claimed = {
  agent: { cli?: Installed.Agent; id: string; oracle: boolean }
  claim: string
  id: string
  leaseUntil: number
  slot: string
  task: Eval.Task
}

export type ClaimResponse = { finished: boolean; rows: Claimed[] }

export type Heartbeat = { held: readonly Held[]; report: Report; runner: number }

export type HeartbeatResponse = { finished: boolean; lost: string[] }

export type Leave = { held: readonly Held[]; runner: number }

export type Session = { name: string; token: string; url: string }

export type Endpoint = { token: string; url: string }

export type Agent =
  | { state: 'attached'; timeoutSec: number }
  | { message: string; state: 'completed' }
  | { error: string; state: 'failed' }
  | { detached: boolean; state: 'running' }
  | { state: 'timeout' }
  | { state: 'waiting' }

export type Judgement =
  | { response: string; state: 'answered' }
  | { error: string; state: 'failed' }
  | { error: string; state: 'invalid' }
  | { state: 'timeout' }
  | { state: 'waiting' }

export type Finish = {
  failure?: { kind: Result.FailureKind; message: string }
  verifier?: Verdict.Verifier
}

export type Finished = { evict: boolean }
