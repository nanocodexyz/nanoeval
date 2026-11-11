import type * as Eval from '../src/Eval.ts'
import * as TemporaryDockerConverter from './TemporaryDockerConverter.ts'

export class ConvertError extends Error {
  override name = 'Converter.ConvertError'
}

export type Environment = {
  context?: string
  image?: string
  storageMb: number
}

export type Converter = {
  readonly format: string
  readonly name: string
  convert(environment: Environment, disk: string): Promise<Eval.Meta>
  pack(disk: string, file: string): Promise<void>
  unpack(file: string, disk: string): Promise<void>
}

export function create(options: { home: string }): Converter {
  return TemporaryDockerConverter.create(options)
}
