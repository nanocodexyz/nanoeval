import worker, * as Index from '../../worker/index.ts'

export { AgentSession, Evals, PlanVault, Run } from '../../worker/index.ts'

export class Pool extends Index.Pool {
  private losing = false

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/lose-assign') {
      this.losing = true
      return Response.json({ losing: true })
    }
    if (path === '/internal/assign' && this.losing) {
      this.losing = false
      return Response.json({ error: 'the lane loses this assign' }, { status: 503 })
    }
    return super.fetch(request)
  }
}

export default worker
