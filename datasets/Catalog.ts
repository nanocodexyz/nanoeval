import type * as Dataset from './Dataset.ts'
import * as GpqaDiamond from './GpqaDiamond.ts'
import * as HarborHub from './HarborHub.ts'
import * as HealthBench from './HealthBench.ts'
import * as SweBench from './SweBench.ts'

export const adapters: readonly Dataset.Adapter[] = [
  GpqaDiamond.adapter,
  HealthBench.adapter,
  SweBench.adapter,
  HarborHub.create({
    description: 'Terminal-Bench 2.0, 89 tasks, as published to the Harbor registry',
    name: 'terminal-bench-2.0',
    package: 'terminal-bench/terminal-bench-2',
    proof:
      '2 tasks imported as an eval and run with their own solutions on krun slots, both passed. The other 87 were imported with the first version only',
    state: 'verified',
    tasks: 'c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b',
    version: 'c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b',
  }),
  HarborHub.create({
    description: 'Terminal-Bench 2.1, 89 tasks, as published to the Harbor registry',
    name: 'terminal-bench-2.1',
    package: 'terminal-bench/terminal-bench-2-1',
    proof:
      'the 89 imported directories match the ones Harbor downloads byte for byte, and all 89 ran from the imported eval with their own solutions on krun slots',
    state: 'verified',
    tasks: 'a52279506fb02fe3b3daa430a0c8e027ad71e9df582b4bb833f709cb28b9252a',
    version: '7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a',
  }),
]

export function find(name: string): Dataset.Adapter | undefined {
  return adapters.find((adapter) => adapter.name === name)
}
