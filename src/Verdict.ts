import type * as Result from './Result.ts'

export const report = 'ctrf.json'
export const timeoutCodes: readonly number[] = [124, 137]

export const fullPrefix = 'the slot ran out of disk while the verifier ran'
export const brokenPrefix = 'the disk of the slot failed while the verifier ran'
export const unfetchedPrefix = 'the verifier could not download what its test.sh installs'
export const withdrawnPrefix =
  'the verifier could not install what its test.sh installs: its package archive answered 404 Not Found'

const unreachable: readonly RegExp[] = [
  /\bnetwork timeout\b/,
  /\bcurl: \((6|7|28|35|52|56)\)/,
  /\bTemporary failure resolving\b/,
  /\bCould not resolve host\b/,
  /\bConnection timed out\b/,
  /\bConnection reset by peer\b/,
  /\bRead timed out\b/,
]

export type Verifier = {
  code: number
  diskMb?: number
  files: readonly string[]
  memoryMb?: number
  oom?: number
  reward: number | null
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
  const failure: Result.Failure | undefined = short
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
            ...(untested({ diskMb: facts.diskMb, tail }) ?? {
              kind: 'verifier',
              message: 'the verifier exited with ' + facts.code + ' and wrote no reward: ' + tail,
            }),
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
  if (tail.includes('No space left on device'))
    return { kind: 'environment', message: fullPrefix + because }
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
    timeoutSec: number
  }
}
