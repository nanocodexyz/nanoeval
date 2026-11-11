import { DatabaseSync } from 'node:sqlite'
import type * as Eval from '../src/Eval.ts'
import type * as Sql from '../src/Sql.ts'
import type * as Task from '../src/Task.ts'

const blob = (seed: string): Eval.Blob => ({
  bytes: seed.length,
  digest: seed.repeat(64).slice(0, 64),
})

export function row(task: Task.Task, kind: 'dir' | 'disk' = 'disk'): Eval.Task {
  return {
    agent: task.agent,
    checksum: task.checksum,
    description: task.description,
    env: task.environment.env,
    environment:
      kind === 'dir'
        ? { files: blob('e'), kind: 'dir' }
        : {
            disk: blob('d'),
            format: 'tar-sparse-zstd',
            kind: 'disk',
            meta: {
              architecture: 'amd64',
              cmd: [],
              digest: 'sha256:' + blob('c').digest,
              entrypoint: [],
              env: ['PATH=/usr/bin:/bin'],
              user: '',
              workdir: '/app',
            },
            source: task.environment.dockerImage ?? 'dockerfile:fixture',
          },
    id: task.name.replaceAll('/', '-'),
    instruction: blob('a'),
    name: task.name,
    network: { allowInternet: task.environment.allowInternet },
    resources: {
      cpus: task.environment.cpus,
      memoryMb: task.environment.memoryMb,
      storageMb: task.environment.storageMb,
    },
    ...(task.solution
      ? {
          solution: {
            archive: blob('5'),
            env: task.solution.env,
            ...(task.verifier.finalMessage ? { finalMessage: true as const } : {}),
          },
        }
      : {}),
    tests: blob('7'),
    verifier: {
      ...(task.verifier.ctrf ? { ctrf: true as const } : {}),
      env: task.verifier.env,
      ...(task.verifier.finalMessage ? { finalMessage: true as const } : {}),
      ...(task.verifier.judge ? { judge: true as const } : {}),
      timeoutSec: task.verifier.timeoutSec,
    },
  }
}

export function database(): Sql.Sql {
  const database = new DatabaseSync(':memory:')
  return {
    all: (query, ...bindings) => database.prepare(query).all(...bindings) as Sql.Row[],
    run: (query, ...bindings) => {
      database.prepare(query).run(...bindings)
    },
    transaction: (work) => {
      database.exec('BEGIN')
      try {
        const result = work()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}
