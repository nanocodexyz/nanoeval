import type * as Result from './Result.ts'

export const report = 'ctrf.json'
export const timeoutCodes: readonly number[] = [124, 137]

export type Verifier = {
  code: number
  files: readonly string[]
  oom?: number
  reward: number | null
}

export function verifier(input: verifier.Input): {
  failure?: Result.Failure
  reward: number | null
} {
  const { facts, now } = input
  const tail = input.log.slice(-2000)
  const failure: Result.Failure | undefined = timeoutCodes.includes(facts.code)
    ? {
        at: now,
        kind: 'verifier_timeout',
        message: 'the verifier did not finish within ' + input.timeoutSec + ' s',
      }
    : facts.reward === null
      ? {
          at: now,
          kind: 'verifier',
          message: 'the verifier exited with ' + facts.code + ' and wrote no reward: ' + tail,
        }
      : facts.reward !== 1 && input.ctrf && !facts.files.includes(report)
        ? {
            at: now,
            kind: 'verifier',
            message:
              'the verifier wrote reward ' +
              facts.reward +
              ' without the test report its test.sh names, ' +
              report +
              ', so its tests did not run: ' +
              tail,
          }
        : input.earlier
  return {
    ...(failure ? { failure } : {}),
    reward: failure && failure.kind !== 'agent_timeout' ? null : facts.reward,
  }
}

export declare namespace verifier {
  type Input = {
    ctrf: boolean
    earlier?: Result.Failure
    facts: Verifier
    log: string
    now: number
    timeoutSec: number
  }
}
