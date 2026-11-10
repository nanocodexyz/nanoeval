import * as Zlib from 'node:zlib'
import * as Bytes from '../src/internal/Bytes.ts'
import * as Tar from '../src/Tar.ts'
import * as Task from '../src/Task.ts'
import * as Dataset from './Dataset.ts'
import * as Source from './Source.ts'

export class DigestError extends Error {
  override name = 'HarborHub.DigestError'
}

export const hub = {
  key: 'sb_publishable_Z-vuQbpvpG-PStjbh4yE0Q_e-d3MTIH',
  url: 'https://ofhuhcpkvzjlejydnvyd.supabase.co',
}

const pageRows = 1000

type Version = {
  archive_path: string
  content_hash: string
  package: { name: string }
}

export function tasksDigest(digests: readonly string[]): string {
  return Source.sha256(Bytes.fromText([...digests].sort().join(',')))
}

export function create(options: create.Options): Dataset.Adapter {
  const [org, name] = options.package.split('/') as [string, string]
  const headers = { apikey: hub.key }

  return {
    async *cases(context) {
      const query = async <T>(table: string, parameters: Record<string, string>): Promise<T[]> =>
        JSON.parse(
          Bytes.toText(
            await Source.get(context.store, {
              headers,
              url: hub.url + '/rest/v1/' + table + '?' + new URLSearchParams(parameters),
            }),
          ),
        ) as T[]

      const [version] = await query<{ id: string }>('dataset_version', {
        content_hash: 'eq.' + options.version,
        limit: '1',
        'package.name': 'eq.' + name,
        'package.org.name': 'eq.' + org,
        'package.type': 'eq.dataset',
        select: 'id,package:package_id!inner(name,type,org:org_id!inner(name))',
      })
      if (!version)
        throw new DigestError(
          'the Harbor registry has no ' + options.package + '@sha256:' + options.version,
        )

      const versions: Version[] = []
      for (let offset = 0; ; offset += pageRows) {
        const page = await query<{ task_version: Version }>('dataset_version_task', {
          dataset_version_id: 'eq.' + version.id,
          limit: String(pageRows),
          offset: String(offset),
          order: 'task_version_id',
          select:
            'task_version:task_version_id(content_hash,archive_path,package:package_id(name))',
        })
        versions.push(...page.map((row) => row.task_version))
        if (page.length < pageRows) break
      }
      const actual = tasksDigest(versions.map((entry) => entry.content_hash))
      if (actual !== options.tasks)
        throw new DigestError(
          options.package +
            ' lists tasks that hash to sha256:' +
            actual +
            ', and sha256:' +
            options.tasks +
            ' is pinned',
        )
      const byId = new Map(versions.map((entry) => [entry.package.name, entry]))
      if (byId.size !== versions.length)
        throw new DigestError(options.package + ' lists one task name more than once')

      for (const id of Dataset.select([...byId.keys()].sort(), context)) {
        const entry = byId.get(id)!
        const archive = await Source.kept(
          context.store,
          'harbor-hub/' + entry.content_hash + '.tar.gz',
          () =>
            Source.get(context.store, {
              headers,
              url: hub.url + '/storage/v1/object/packages/' + entry.archive_path,
            }),
        )
        const unpacked = Tar.unpack(Zlib.gunzipSync(archive))
        const files = Object.fromEntries(unpacked.map((file) => [file.path, file.data]))
        const checksum = await Task.checksum(files)
        if (checksum !== entry.content_hash)
          throw new DigestError(
            id +
              ' unpacks to sha256:' +
              checksum +
              ', and sha256:' +
              entry.content_hash +
              ' is pinned',
          )
        yield {
          executable: unpacked.filter((file) => file.executable).map((file) => file.path),
          files,
          id,
        }
      }
    },
    description: options.description,
    name: options.name,
    proof: options.proof,
    source: {
      kind: 'harbor-hub',
      package: options.package,
      registry: hub.url,
      tasks: 'sha256:' + options.tasks,
      version: 'sha256:' + options.version,
    },
    state: options.state,
  }
}

export declare namespace create {
  type Options = {
    description: string
    name: string
    package: string
    proof: string
    state: Dataset.Adapter['state']
    tasks: string
    version: string
  }
}
