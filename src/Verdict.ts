import type * as Result from './Result.ts'
import type * as Window from './Window.ts'

export const report = 'ctrf.json'
export const reward = 'reward.txt'
export const timeoutCodes: readonly number[] = [124, 137]
export const killedCode = 137

export const fullPrefix = 'the slot ran out of disk while the verifier ran'
export const emptyRewardPrefix = 'the verifier left reward.txt without a reward'
export const brokenPrefix = 'the disk of the slot failed while the verifier ran'
export const unfetchedPrefix = 'the verifier could not download what its test.sh installs'
export const withdrawnPrefix =
  'the verifier could not install what its test.sh installs: its package archive answered 404 Not Found'

export const full = /No\s+space\s+left\s+on\s+device/

const unreachable: readonly RegExp[] = [
  /\bnetwork timeout\b/,
  /\bcurl: \((6|7|28|35|52|56)\)/,
  /\bTemporary failure resolving\b/,
  /\bCould not resolve host\b/,
  /\bConnection timed out\b/,
  /\bConnection reset by peer\b/,
  /\bRead timed out\b/,
  /\bFailed to fetch: `[^`]+`\n(\s+Caused by: .*\n)*\s+Caused by: operation timed out\b/,
]

export function agent(input: agent.Input): agent.ReturnType {
  if (input.code !== killedCode || input.sec >= input.timeoutSec) return undefined
  const ran = ' after ' + Math.floor(input.sec) + ' s of its ' + input.timeoutSec + ' s'
  if (!input.oom)
    return {
      kind: 'agent',
      message:
        'the agent was killed' +
        ran +
        ', so its time limit did not end it, and no OOM kill was counted in its slot',
    }
  if (input.memoryMb < input.taskMemoryMb)
    return {
      kind: 'environment',
      message:
        'the slot had ' +
        input.memoryMb +
        ' MB of the ' +
        input.taskMemoryMb +
        ' MB the task asks for, and that limit killed the agent' +
        ran +
        ', with ' +
        input.oom +
        ' OOM kills in its slot',
      oom: input.oom,
    }
  return {
    kind: 'agent_out_of_memory',
    message:
      'the memory limit of the slot, ' +
      input.memoryMb +
      ' MB, killed the agent' +
      ran +
      ', with ' +
      input.oom +
      ' OOM kills in its slot',
    oom: input.oom,
  }
}

export declare namespace agent {
  type Input = {
    code: number
    memoryMb: number
    oom: number
    sec: number
    taskMemoryMb: number
    timeoutSec: number
  }
  type ReturnType = (Pick<Result.Failure, 'kind' | 'message'> & { oom?: number }) | undefined
}

export type Verifier = {
  code: number
  diskMb?: number
  files: readonly string[]
  memoryMb?: number
  oom?: number
  reward: number | null
  window?: Window.Load
}

export const limitPrefix = 'the limit of the run ended the verifier'

export function bounded(failure: Result.Failure, ownSec: number | undefined): Result.Failure {
  return ownSec === undefined || failure.kind !== 'verifier_timeout'
    ? failure
    : {
        at: failure.at,
        kind: 'verifier_limit',
        message: limitPrefix + ', which its task allows ' + ownSec + ' s: ' + failure.message,
      }
}

export function verifier(input: verifier.Input): {
  failure?: Result.Failure
  reward: number | null
} {
  const { facts, now } = input
  const tail = input.log.slice(-2000)
  const short =
    facts.memoryMb !== undefined &&
    input.memoryMb !== undefined &&
    facts.memoryMb < input.memoryMb &&
    Boolean(facts.oom) &&
    facts.reward !== 1
  const found: Result.Failure | undefined = short
    ? {
        at: now,
        kind: 'environment',
        message:
          'the slot had ' +
          facts.memoryMb +
          ' MB of the ' +
          input.memoryMb +
          ' MB the task asks for, and that limit killed ' +
          facts.oom +
          ' of its processes',
      }
    : timeoutCodes.includes(facts.code)
      ? {
          at: now,
          kind: 'verifier_timeout',
          message: 'the verifier did not finish within ' + input.timeoutSec + ' s',
        }
      : facts.reward === null
        ? {
            at: now,
            ...(untested({ diskMb: facts.diskMb, tail }) ??
              (facts.files.includes(reward)
                ? {
                    kind: 'environment',
                    message:
                      emptyRewardPrefix + ' after it exited with ' + facts.code + ': ' + tail,
                  }
                : {
                    kind: 'verifier',
                    message:
                      'the verifier exited with ' + facts.code + ' and wrote no reward: ' + tail,
                  })),
          }
        : facts.reward !== 1 && input.ctrf && !facts.files.includes(report)
          ? {
              at: now,
              ...(untested({ diskMb: facts.diskMb, tail }) ?? {
                kind: 'verifier',
                message:
                  'the verifier wrote reward ' +
                  facts.reward +
                  ' without the test report its test.sh names, ' +
                  report +
                  ', so its tests did not run: ' +
                  tail,
              }),
            }
          : input.earlier
  const failure = found && bounded(found, input.ownSec)
  return {
    ...(failure ? { failure } : {}),
    reward: failure && failure.kind !== 'agent_timeout' ? null : facts.reward,
  }
}

function untested(input: {
  diskMb: number | undefined
  tail: string
}): Pick<Result.Failure, 'kind' | 'message'> | undefined {
  const { tail } = input
  const because = ', so its tests did not run: ' + tail
  if (input.diskMb === 0)
    return {
      kind: 'environment',
      message: fullPrefix + ': the machine had less than 1 MB of free disk' + because,
    }
  if (full.test(tail)) return { kind: 'environment', message: fullPrefix + because }
  if (tail.includes('Input/output error'))
    return { kind: 'environment', message: brokenPrefix + because }
  if (unreachable.some((pattern) => pattern.test(tail)))
    return { kind: 'environment', message: unfetchedPrefix + because }
  if (/^E: Failed to fetch \S+\s+404\s+Not Found/m.test(tail))
    return { kind: 'verifier', message: withdrawnPrefix + because }
  return undefined
}

export declare namespace verifier {
  type Input = {
    ctrf: boolean
    earlier?: Result.Failure
    facts: Verifier
    log: string
    memoryMb?: number
    now: number
    ownSec?: number
    timeoutSec: number
  }
}
