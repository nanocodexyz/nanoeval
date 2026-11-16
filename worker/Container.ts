import { DurableObject } from 'cloudflare:workers'
import * as Cloudflare from '../src/Cloudflare.ts'
import type * as Sandbox from '../src/Sandbox.ts'

// One sandbox of the cloudflare provider: a Durable Object of a class bound to a container image
// and an instance type in wrangler.jsonc. It ends its Container when the lifetime the run named
// runs out, as an E2B sandbox does, so a run that forgets a sandbox pays for no more than that.
// Not bound yet: see DECISIONS.md, "a sandbox on Cloudflare Containers".
export class SandboxContainer extends DurableObject {
  private served: Cloudflare.Stub | undefined

  private stub(): Cloudflare.Stub {
    if (!this.ctx.container) throw new Cloudflare.StartError('this class has no container bound')
    return (this.served ??= Cloudflare.serve(this.ctx.container))
  }

  async start(input: Cloudflare.Start): Promise<void> {
    await this.ctx.storage.setAlarm(input.expiresAt)
    await this.stub().start(input)
  }

  exec(command: string): Promise<Sandbox.Output> {
    return this.stub().exec(command)
  }

  write(path: string, data: Uint8Array): Promise<void> {
    return this.stub().write(path, data)
  }

  async kill(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.stub().kill()
  }

  override async alarm(): Promise<void> {
    await this.stub().kill()
  }
}
