import * as Target from '../Target.ts'
import * as Hosted from './Hosted.ts'

// nanoeval's own Worker (worker/, deployed as the release Worker): each session is a nanocode-ts session at
// /sessions/<name>, one turn a POST /sessions/<name>/turns?live=1 that streams the session's events, with the
// Worker's bearer token. The build is whatever the Worker serves: GET /v1/version names it (pin-<nanoeval>-
// ncts-<nanocode-ts>); a build's url is another deployment of the same Worker, and a build's version must
// name the deployed nanoeval or nanocode-ts commit (or be "deployed"). A local binary can't run here.
//
// NANOEVAL_SYSTEMS_RELEASE_URL (default the release Worker) and NANOEVAL_SYSTEMS_RELEASE_TOKEN or
// NANOEVAL_TOKEN set where and how; NANOEVAL_SYSTEMS_MODEL or the suite's model picks the model
// (default claude-haiku-4-5). Session names start with systems-, so the Worker meters them under no run.

export const defaultUrl = 'https://nanoeval-release.tempo-dev.workers.dev'

export type Options = {
  fetch?: Hosted.Fetch
  release?: typeof Hosted.release
  token?: string
  url?: string
}

export function base(build: Target.Build, options: Options = {}): string {
  if (build.binary !== undefined)
    throw new Target.InvalidError(
      'release-worker serves a deployed build: give a URL or a version, not ' + build.binary,
    )
  return (
    build.url ??
    options.url ??
    process.env['NANOEVAL_SYSTEMS_RELEASE_URL'] ??
    defaultUrl
  ).replace(/\/+$/, '')
}

function token(options: Options): string {
  const found =
    options.token ?? process.env['NANOEVAL_SYSTEMS_RELEASE_TOKEN'] ?? process.env['NANOEVAL_TOKEN']
  if (!found)
    throw new Target.InvalidError(
      'release-worker needs NANOEVAL_SYSTEMS_RELEASE_TOKEN or NANOEVAL_TOKEN',
    )
  return found
}

async function json(
  get: Hosted.Fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<any> {
  try {
    const answer = await get(url, { headers, signal: AbortSignal.timeout(15_000) })
    return answer.ok ? await answer.json() : undefined
  } catch {
    return undefined
  }
}

// The Worker's version string: pin-<nanoeval sha>-ncts-<nanocode-ts sha>, or a bare nanoeval sha.
export async function version(
  build: Target.Build,
  options: Options = {},
): Promise<string | undefined> {
  const found = await json(options.fetch ?? fetch, base(build, options) + '/v1/version', {
    authorization: 'Bearer ' + token(options),
  })
  return typeof found?.commit === 'string' ? found.commit : undefined
}

// Whether a deployed version string carries the commit a build names.
export function serves(deployed: string, wanted: string): boolean {
  if (wanted === 'deployed' || wanted === 'latest') return true
  const shas = deployed.match(/[0-9a-f]{7,40}/g) ?? []
  return shas.some((sha) => sha.startsWith(wanted) || wanted.startsWith(sha))
}

export function target(options: Options = {}): Target.Target {
  const get = options.fetch ?? fetch
  const session = (build: Target.Build, id: string, context?: Target.Context): Target.Session => {
    const root = base(build, options)
    const auth = { authorization: 'Bearer ' + token(options) }
    const chosen = Hosted.model(context)
    return {
      async close() {},
      id,
      turn: (prompt) =>
        Hosted.turn({
          body: {
            model: chosen,
            prompt,
            provider: Hosted.provider(chosen),
            request_id: crypto.randomUUID(),
          },
          context,
          fetch: get,
          headers: auth,
          url: root + '/sessions/' + encodeURIComponent(id) + '/turns?live=1',
        }),
    }
  }
  return {
    async describe(build) {
      const root = base(build, options)
      const auth = { authorization: 'Bearer ' + token(options) }
      const [health, deployed, routes] = await Promise.all([
        json(get, root + '/health'),
        version(build, options),
        json(get, root + '/v1/routes', auth),
      ])
      const sha = deployed ? Hosted.nanocodeTs(deployed) : undefined
      const built = sha ? await (options.release ?? Hosted.release)(sha, { fetch: get }) : undefined
      return {
        ...(built?.nanocodeRev ? { nanocodeRev: built.nanocodeRev } : {}),
        ...(built ? { nanocodeTs: built.nanocodeTs } : sha ? { nanocodeTs: sha } : {}),
        overrides: {
          // Set by worker/Sessions.ts over the nanocode-ts App defaults.
          cellYield: 'the agent cellYieldMs, else CELL_YIELD_MS, else the nanocode default',
          deployed: deployed ?? 'unknown',
          hands: 'always',
          headless: true,
          healthy: health?.ok === true,
          hedge: 'the nanocode default, unless the agent sets hedgeCapPercent',
          model: Hosted.model(),
          routes: routes ?? 'unknown',
          ...(built?.wasmFingerprint ? { wasmFingerprint: built.wasmFingerprint } : {}),
          workspace: false,
        },
        url: root,
        ...(built?.wasmSha256 ? { wasmSha256: built.wasmSha256 } : {}),
      }
    },
    name: 'release-worker',
    async open(build, context) {
      if (build.version !== undefined) {
        const deployed = await version(build, options)
        if (!deployed)
          throw new Target.InvalidError(
            'release-worker at ' + base(build, options) + ' names no version',
          )
        if (!serves(deployed, build.version))
          throw new Target.InvalidError(
            'release-worker at ' +
              base(build, options) +
              ' serves ' +
              deployed +
              ', not ' +
              build.version,
          )
      }
      return session(
        build,
        'systems-' + build.label.replace(/[^A-Za-z0-9-]/g, '-') + '-' + crypto.randomUUID(),
        context,
      )
    },
    // A session lives in its Durable Object under its name: the next turn on that name resumes it.
    async resume(build, id, context) {
      return session(build, id, context)
    },
  }
}

export default target()
