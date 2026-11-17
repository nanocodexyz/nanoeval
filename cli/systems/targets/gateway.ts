import * as Target from '../Target.ts'
import * as Hosted from './Hosted.ts'

// A gateway's agents API: POST /v1/agents creates an agent (a nanocode-ts session the gateway runs and pays
// for), POST /v1/agents/<id>/turns streams one turn's events, GET /v1/agents/<id>/turns/<turn> reports what
// it spent and DELETE /v1/agents/<id> removes it. Everything comes from the environment:
//
//   NANOEVAL_SYSTEMS_GATEWAY_URL         the gateway's base URL (a build's url overrides it)
//   NANOEVAL_SYSTEMS_GATEWAY_KEY         an API key the gateway accepts as Authorization: Bearer
//   NANOEVAL_SYSTEMS_GATEWAY_APP         the app agents are created in (Gateway-App, default nanoeval-systems)
//   NANOEVAL_SYSTEMS_GATEWAY_PAYER       who pays, when not the key's own wallet
//   NANOEVAL_SYSTEMS_GATEWAY_HARNESS     claude or codex, when the model alone doesn't settle it
//   NANOEVAL_SYSTEMS_GATEWAY_NANOCODE_TS the nanocode-ts build the gateway runs, for describe()
//
// The model is the suite's, else NANOEVAL_SYSTEMS_MODEL, else the gateway's default.

export type Options = {
  app?: string
  fetch?: Hosted.Fetch
  harness?: string
  key?: string
  nanocodeTs?: string
  payer?: string
  release?: typeof Hosted.release
  url?: string
}

const env = (name: string) => process.env['NANOEVAL_SYSTEMS_GATEWAY_' + name] || undefined

export function base(build: Target.Build, options: Options = {}): string {
  if (build.binary !== undefined)
    throw new Target.InvalidError(
      'gateway serves a deployed build: give its URL, not ' + build.binary,
    )
  const found = build.url ?? options.url ?? env('URL')
  if (!found)
    throw new Target.InvalidError('gateway needs NANOEVAL_SYSTEMS_GATEWAY_URL or a build URL')
  return found.replace(/\/+$/, '')
}

export function headers(options: Options = {}): Record<string, string> {
  const key = options.key ?? env('KEY')
  if (!key)
    throw new Target.InvalidError('gateway needs an API key in NANOEVAL_SYSTEMS_GATEWAY_KEY')
  return {
    authorization: 'Bearer ' + key,
    'gateway-app': options.app ?? env('APP') ?? 'nanoeval-systems',
  }
}

export function target(options: Options = {}): Target.Target {
  const get = options.fetch ?? fetch
  const session = (
    build: Target.Build,
    id: string,
    context?: Target.Context,
    createMs?: number,
  ): Target.Session => {
    const root = base(build, options) + '/v1/agents/' + encodeURIComponent(id)
    const auth = headers(options)
    let first = createMs
    return {
      async close() {
        await get(root, { headers: auth, method: 'DELETE', signal: AbortSignal.timeout(15_000) })
          .then((answer) => answer.body?.cancel())
          .catch(() => {})
      },
      id,
      async turn(prompt) {
        const turn = crypto.randomUUID()
        const sample = await Hosted.turn({
          body: { id: turn, prompt },
          context,
          fetch: get,
          headers: auth,
          url: root + '/turns',
        })
        const metrics: Record<string, number> = { ...sample.metrics }
        if (first !== undefined) metrics['createMs'] = first
        first = undefined
        // What the turn spent, read after the turn so it costs the timing nothing.
        try {
          const answer = await get(root + '/turns/' + turn, {
            headers: auth,
            signal: AbortSignal.timeout(10_000),
          })
          const spent = answer.ok
            ? Number(((await answer.json()) as { spent_usd?: unknown }).spent_usd)
            : NaN
          if (Number.isFinite(spent)) metrics['spentUsd'] = spent
        } catch {}
        return { ...sample, ...(Object.keys(metrics).length ? { metrics } : {}) }
      },
    }
  }
  return {
    async describe(build) {
      const root = base(build, options)
      let health: any
      try {
        const answer = await get(root + '/v1/agents/health', {
          headers: headers(options),
          signal: AbortSignal.timeout(15_000),
        })
        health = answer.ok ? await answer.json() : { status: answer.status }
      } catch (error) {
        health = { error: error instanceof Error ? error.message : String(error) }
      }
      const sha = options.nanocodeTs ?? env('NANOCODE_TS')
      const built = sha ? await (options.release ?? Hosted.release)(sha, { fetch: get }) : undefined
      const model = process.env['NANOEVAL_SYSTEMS_MODEL']
      return {
        ...(built?.nanocodeRev ? { nanocodeRev: built.nanocodeRev } : {}),
        ...(built ? { nanocodeTs: built.nanocodeTs } : {}),
        overrides: {
          app: options.app ?? env('APP') ?? 'nanoeval-systems',
          defaultModel: health?.model ?? 'unknown',
          ...(health?.ok === true ? {} : { health }),
          harness: options.harness ?? env('HARNESS') ?? 'by model',
          model: model ?? 'the gateway default',
          payer: options.payer ?? env('PAYER') ?? 'the key',
          ...(built?.wasmFingerprint ? { wasmFingerprint: built.wasmFingerprint } : {}),
        },
        url: root,
        ...(built?.wasmSha256 ? { wasmSha256: built.wasmSha256 } : {}),
      }
    },
    name: 'gateway',
    async open(build, context) {
      const root = base(build, options)
      const model = context?.model ?? process.env['NANOEVAL_SYSTEMS_MODEL']
      const harness = options.harness ?? env('HARNESS')
      const payer = options.payer ?? env('PAYER')
      const started = Target.now()
      const answer = await get(root + '/v1/agents', {
        body: JSON.stringify({
          name:
            'systems-' +
            build.label.replace(/[^A-Za-z0-9-]/g, '-') +
            '-' +
            crypto.randomUUID().slice(0, 8),
          ...(model ? { model } : {}),
          ...(harness ? { harness } : {}),

          ...(payer ? { payer } : {}),
        }),
        headers: { ...headers(options), 'content-type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
      })
      if (answer.status !== 201 && answer.status !== 200) {
        const text = await answer.text().catch(() => '')
        throw new Error(
          'gateway: creating an agent answered ' +
            answer.status +
            (text ? ': ' + text.slice(0, 300) : ''),
        )
      }
      const created = (await answer.json()) as { id?: string }
      if (!created.id) throw new Error('gateway: creating an agent returned no id')
      return session(build, created.id, context, Target.now() - started)
    },
    async resume(build, id, context) {
      return session(build, id, context)
    },
  }
}

export default target()
