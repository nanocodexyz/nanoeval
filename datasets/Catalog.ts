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
  HarborHub.create({
    description:
      'DeepSWE v1.1, 113 long-horizon tasks from open-source repositories, as published to the Harbor registry',
    name: 'deep-swe-1.1',
    package: 'datacurve/deep-swe-1-1',
    proof:
      'task directories written with --out and checked against their digests. Not importable as an eval: its tasks use task schema 1.3, a verifier in an environment of its own, collect hooks and reward.json',
    state: 'unverified',
    tasks: '395be8f15204cc7e48df1a6457978c33f3ee49813241656586977309cd265d56',
    version: '5affcd534fd90ac85d202d4c63f8b35ddc942140afdd5d60014a21365440a2f5',
  }),
  HarborHub.create({
    description:
      'Aider Polyglot, 225 Exercism exercises in C++, Go, Java, JavaScript, Python and Rust, as published to the Harbor registry',
    name: 'aider-polyglot',
    package: 'aider/aider-polyglot',
    proof:
      'all 225 task directories written with --out and checked against their digests. Not a claim as published: every image holds the reference solution in /app/.oracle/solution.enc, encrypted with the password its solve.sh names, and tasks keep the network. Strip .oracle and close the network before scoring',
    state: 'unverified',
    tasks: '01e28d85e46beae5b7e29a29f57cb49d882b5486583d52cec4ee5bf3540a1c84',
    version: '01e28d85e46beae5b7e29a29f57cb49d882b5486583d52cec4ee5bf3540a1c84',
  }),
  HarborHub.create({
    description:
      'Long-Horizon Terminal-Bench 2.0, 77 terminal tasks, as published to the Harbor registry',
    name: 'long-horizon-terminal-bench-2.0',
    package: 'silrlab/long-horizon-terminal-bench-2.0',
    proof:
      'task directories written with --out and checked against their digests (2 of 77 sampled). Not yet run as an eval: its tasks use task schema 1.1 with artifacts and continue_until_timeout',
    state: 'unverified',
    tasks: 'd0613226d692570f65db0c8079c63f2a8c2dfa95ab6417a3435bfc0a9be48ab5',
    version: '7ab245d0ff3c7d0fdf40f8e8387bc3ed596cb23641bfba3746dd2fc30d84d3e6',
  }),
  HarborHub.create({
    description: 'SWE-bench Pro, the 731 public instances, as published to the Harbor registry',
    name: 'swe-bench-pro',
    package: 'scale-ai/swe-bench-pro',
    proof:
      'task directories written with --out and checked against their digests (2 of 731 sampled). Open form: the fix commit is reachable from the image, so a score from it is not a claim; --closed is the form to run',
    state: 'unverified',
    tasks: 'f5402de7aa33a9be0393827d4f7d558f6710fa9b18f4828ee28f027f52dd4649',
    version: '88411d32ff27e53a4c1a7e29f0c2aeba180c8e5d60f221cab5ed56325f33549d',
  }),
  HarborHub.create({
    description:
      'SWE-rebench leaderboard, 860 recent GitHub issues, as published to the Harbor registry',
    name: 'swe-rebench-leaderboard',
    package: 'swe-rebench/swe-rebench-leaderboard',
    proof:
      'task directories written with --out and checked against their digests (2 of 860 sampled). Not importable as an eval yet: its tasks give memory as a string such as 8G, which Task.load refuses',
    state: 'unverified',
    tasks: '79d1d2942d10ec41d1b9ee4e4a22db1a2f7b5d20798a804213bdb11ff90677a5',
    version: 'ebe7444e313a0d8db94fa541139826eaebe2b0abcd4900c6f73e750494910dca',
  }),
  HarborHub.create({
    description:
      'Long-tail SWE, 202 tasks from 2026 pull requests in 13 less common languages, as published to the Harbor registry',
    name: 'longtail-swe',
    package: 'longtail-swe/longtail-swe',
    proof:
      'task directories written with --out and checked against their digests (1 sampled). Not yet run as an eval with its own solutions',
    state: 'unverified',
    tasks: '27d622ee801065c72b217268b579d11812a6b6846ad866e14959a134ced5d909',
    version: 'ae541b836c71a9140dc904ffa5fb0404698c5d39b703d3f77f62e37b1ec72a41',
  }),
  HarborHub.create({
    description:
      'SWE-rebench July 2026, 111 issues from July 2026 in five languages, as published to the Harbor registry',
    name: 'swe-rebench-07-2026',
    package: 'ibragim-badertdinov/swe-rebench-07-2026',
    proof:
      'task directories written with --out and checked against their digests (1 sampled). Not yet run as an eval with its own solutions',
    state: 'unverified',
    tasks: '6e8f6f3701101b55a52c5b2c11b0cf258df3e5f667c576bb3cc18efb94c6d955',
    version: '727f5d0a77a15bb4dc30b9919ff47ec0a99a932aab297bea0727537953554d6d',
  }),
  HarborHub.create({
    description:
      'Terminal-Bench 4.0 without the GPU tasks, 63 tasks, as published to the Harbor registry',
    name: 'terminal-bench-4.0-cpu',
    package: 'terminal-bench/terminal-bench-cpu-only',
    proof:
      'task directories written with --out and checked against their digests (1 sampled). Not yet run as an eval with its own solutions',
    state: 'unverified',
    tasks: '71513d7c0e8dd3b3cc3023c50acc8eeaed1950e3969be0b5d03c979c2ea0ec58',
    version: 'ff571d9450cd190a7c4b3b5e0d53cb287943c3de493a3c443efceeaf2c7a7a73',
  }),
]

export function find(name: string): Dataset.Adapter | undefined {
  return adapters.find((adapter) => adapter.name === name)
}
