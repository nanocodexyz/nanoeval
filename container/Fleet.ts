// A fleet of standing nanoeval runners on Cloudflare Containers: a run gets N runners
// without a box. Each RunnerHost Durable Object owns one container instance, which
// enrols as a standing runner of NANOEVAL_URL (container/start.sh) and claims rows
// like any other runner. Its own Worker, apart from worker/, so deploying it is a
// deliberate, separately billed step. See container/README.md.
import { DurableObject } from 'cloudflare:workers'

type Instance = 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4'

type Env = {
  RUNNER_HOST: DurableObjectNamespace<RunnerHost>
  // Secrets (wrangler secret put): never in the image, never in this file.
  FLEET_TOKEN: string // who may scale the fleet
  NANOEVAL_URL: string // the nanoeval Worker the runners enrol in
  NANOEVAL_TOKEN: string // its token, passed to each instance as env
}

type Start = { instance: Instance; slots?: number; network?: 'host' | 'private'; probe?: boolean }

const IDLE_MS = 6 * 60 * 60 * 1000 // the most setInactivityTimeout takes

export class RunnerHost extends DurableObject<Env> {
  async start(input: Start): Promise<{ running: boolean }> {
    const container = this.ctx.container!
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: input.instance,
        enableInternet: true, // models, the nanoeval Worker and task image registries
        env: {
          NANOEVAL_URL: this.env.NANOEVAL_URL,
          NANOEVAL_TOKEN: this.env.NANOEVAL_TOKEN,
          NANOEVAL_NETWORK: input.network ?? 'host',
          ...(input.slots ? { NANOEVAL_SLOTS: String(input.slots) } : {}),
          ...(input.probe ? { NANOEVAL_PROBE: '1' } : {}),
        },
      })
      this.ctx.waitUntil(container.monitor().catch((error: unknown) => console.error('runner exited:', error)))
    }
    await container.setInactivityTimeout(IDLE_MS)
    return { running: container.running }
  }

  async stop(): Promise<void> {
    const container = this.ctx.container!
    if (container.running) await container.signal(15) // the runner finishes the rows it holds
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('authorization') !== 'Bearer ' + env.FLEET_TOKEN) return new Response('unauthorized', { status: 401 })
    const url = new URL(request.url)
    // POST /fleet {"count": 75, "instance": "standard-4", "slots": 4}
    // DELETE /fleet {"count": 75}
    if (url.pathname !== '/fleet') return new Response('not found', { status: 404 })
    const body = (await request.json()) as Partial<Start> & { count?: number }
    const count = Math.max(0, Math.min(Number(body.count ?? 1), 1000))
    const hosts = Array.from({ length: count }, (_, i) => env.RUNNER_HOST.getByName('runner-' + i))
    if (request.method === 'POST') {
      const instance = body.instance ?? 'standard-4'
      const results = await Promise.allSettled(hosts.map((host) => host.start({ instance, slots: body.slots, network: body.network, probe: body.probe })))
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ host: i, error: String(r.reason) }] : []))
      return Response.json({ started: count - failed.length, failed })
    }
    if (request.method === 'DELETE') {
      await Promise.allSettled(hosts.map((host) => host.stop()))
      return Response.json({ stopping: count })
    }
    return new Response('method not allowed', { status: 405 })
  },
}
