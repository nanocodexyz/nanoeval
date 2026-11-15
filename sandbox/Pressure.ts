import * as Fs from 'node:fs/promises'
import type * as Admission from '../src/Admission.ts'
import type * as Config from '../src/Config.ts'

export type Policy = Required<Config.Pressure>

export type Reading = { avg10: number; avg60: number }

export type Regime = 'ceiling' | 'hold' | 'pressure' | 'wait'

export const shortWindowSec = 10

export const defaults: Policy = { admit: 10, ceiling: 2, hold: 25, intervalSec: shortWindowSec }

export const host = '/proc/pressure/cpu'

export function decide(input: decide.Input): decide.ReturnType {
  if (input.cpus < input.bound) return { over: false }
  const { policy, reading } = input
  const regime: Regime =
    reading.avg10 > policy.hold
      ? 'hold'
      : reading.avg60 >= policy.admit
        ? 'wait'
        : input.cpus >= input.ceiling
          ? 'ceiling'
          : 'pressure'
  return {
    over:
      regime === 'pressure' &&
      (input.lastAt === undefined || input.now - input.lastAt >= policy.intervalSec * 1000),
    regime,
  }
}

export declare namespace decide {
  type Input = {
    bound: number
    ceiling: number
    cpus: number
    lastAt: number | undefined
    now: number
    policy: Policy
    reading: Reading
  }
  type ReturnType = { over: boolean; regime?: Regime }
}

export function line(regime: Regime, input: line.Input): string {
  const { policy, reading } = input
  const percent = (value: number) => value.toFixed(2) + ' %'
  return (
    'admission above the vCPU bound: ' +
    {
      ceiling: 'at the ceiling of ' + input.ceiling + ' declared vCPUs',
      hold: 'held, some avg10 is over ' + policy.hold + ' %',
      pressure: 'CPU pressure admits a row every ' + policy.intervalSec + ' s',
      wait: 'waits, some avg60 is not under ' + policy.admit + ' %',
    }[regime] +
    ' (' +
    input.cpus +
    ' declared vCPUs in flight, bound ' +
    input.bound +
    ', ceiling ' +
    input.ceiling +
    ', some avg10 ' +
    percent(reading.avg10) +
    ' avg60 ' +
    percent(reading.avg60) +
    ')'
  )
}

export declare namespace line {
  type Input = Pick<decide.Input, 'bound' | 'ceiling' | 'cpus' | 'policy' | 'reading'>
}

export function marks(input: marks.Input): { at: number; name: string }[] {
  return [
    ...(input.over ? ['over'] : []),
    ...(input.reading
      ? ['some10.' + input.reading.avg10.toFixed(2), 'some60.' + input.reading.avg60.toFixed(2)]
      : []),
    ...(input.cpus === undefined ? [] : ['vcpus.' + input.cpus]),
  ].map((name) => ({ at: input.at, name: 'attempt.claim.' + name }))
}

export declare namespace marks {
  type Input = { at: number; cpus: number | undefined; over: boolean; reading: Reading | undefined }
}

export function offer(wide: Admission.Offer, bound: number): Admission.Offer {
  return {
    ...wide,
    ...(wide.cpus ? { cpus: { capacity: bound, free: wide.cpus.free } } : {}),
    slots: Math.min(wide.slots, 1),
  }
}

export function parse(text: string): Reading | undefined {
  const found = /^some avg10=([0-9.]+) avg60=([0-9.]+) /m.exec(text)
  return found ? { avg10: Number(found[1]), avg60: Number(found[2]) } : undefined
}

export function policy(named: Config.Pressure | undefined): Policy {
  return { ...defaults, ...named }
}

export async function read(file: string): Promise<Reading | undefined> {
  return parse(await Fs.readFile(file, 'utf8').catch(() => ''))
}
