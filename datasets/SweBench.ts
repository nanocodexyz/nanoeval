import { parquetReadObjects } from 'hyparquet'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Dataset from './Dataset.ts'
import * as Source from './Source.ts'

export type Instance = {
  FAIL_TO_PASS: string
  PASS_TO_PASS: string
  base_commit: string
  difficulty: string
  instance_id: string
  patch: string
  problem_statement: string
  repo: string
  test_patch: string
  version: string
}

export const pin = {
  file: 'data/test-00000-of-00001.parquet',
  repository: 'princeton-nlp/SWE-bench_Verified',
  revision: 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a',
  sha256: 'a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd',
}

const required = [
  'FAIL_TO_PASS',
  'PASS_TO_PASS',
  'base_commit',
  'instance_id',
  'patch',
  'problem_statement',
  'repo',
  'test_patch',
  'version',
] as const

export function image(instance: Pick<Instance, 'instance_id'>): string {
  return (
    'swebench/sweb.eval.x86_64.' +
    instance.instance_id.toLowerCase().replaceAll('__', '_1776_') +
    ':latest'
  )
}

export function task(
  instance: Record<string, unknown>,
  assets: Record<string, Uint8Array>,
): Dataset.Case {
  for (const name of required)
    if (typeof instance[name] !== 'string' || !instance[name])
      throw new Dataset.SelectionError('a SWE-bench instance has no ' + name)
  const row = instance as Instance & Record<string, unknown>
  return {
    executable: ['solution/solve.sh', 'tests/test.sh'],
    files: {
      'instruction.md': Bytes.fromText(row.problem_statement),
      'solution/patch.diff': Bytes.fromText(row.patch),
      'solution/solve.sh': assets['solve.sh']!,
      'task.toml': Dataset.toml({
        schema_version: '1.1',
        task: {
          description: 'SWE-bench Verified: resolve the issue in ' + row.repo,
          name: 'swe-bench-verified/' + row.instance_id,
        },
        metadata: {
          base_commit: row.base_commit,
          category: 'debugging',
          ...(typeof row.difficulty === 'string' ? { difficulty: row.difficulty } : {}),
          repo: row.repo,
          version: row.version,
        },
        agent: { timeout_sec: 3000 },
        verifier: { timeout_sec: 3000 },
        environment: {
          build_timeout_sec: 1800,
          cpus: 1,
          docker_image: image(row),
          memory_mb: 4096,
          storage_mb: 10240,
        },
      }),
      'tests/grade.py': assets['grade.py']!,
      'tests/instance.json': Dataset.json(row),
      'tests/test.sh': assets['test.sh']!,
    },
    id: Dataset.taskId(row.instance_id),
  }
}

export const adapter: Dataset.Adapter = {
  async *cases(context) {
    const parquet = await Source.download(context.store, {
      sha256: pin.sha256,
      url:
        'https://huggingface.co/datasets/' +
        pin.repository +
        '/resolve/' +
        pin.revision +
        '/' +
        pin.file,
    })
    const rows = (await parquetReadObjects({
      file: parquet.buffer.slice(
        parquet.byteOffset,
        parquet.byteOffset + parquet.byteLength,
      ) as ArrayBuffer,
    })) as Record<string, unknown>[]
    const assets = await Dataset.assets('swe-bench')
    const byId = new Map(rows.map((row) => [String(row['instance_id']), row]))
    for (const id of Dataset.select([...byId.keys()], context)) yield task(byId.get(id)!, assets)
  },
  description:
    'SWE-bench Verified, 500 instances, each in its official prebuilt image and graded by the official harness',
  name: 'swe-bench-verified',
  proof:
    '1 instance on Docker slots: its gold patch passes and an empty patch fails. Not run on krun slots',
  source: {
    file: pin.file,
    kind: 'huggingface',
    repository: pin.repository,
    revision: pin.revision,
    sha256: pin.sha256,
  },
  state: 'verified',
}
