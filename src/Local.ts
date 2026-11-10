import type * as Sandbox from './Sandbox.ts'

export class RequestError extends Error {
  override name = 'Local.RequestError'
}

export function create(options: create.Options): Sandbox.Provider {
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const base = options.url.replace(/\/+$/, '')
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await send(base + path, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + options.token },
    })
    if (!response.ok)
      throw new RequestError(
        'the local sandbox answered ' +
          response.status +
          ': ' +
          (await response.text()).slice(0, 500),
      )
    return response
  }

  return {
    name: 'local',
    connect(handle) {
      const root = '/sandboxes/' + encodeURIComponent(handle.id)
      return {
        async exec(command) {
          const response = await request(root + '/exec', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command }),
          })
          return (await response.json()) as Sandbox.Output
        },
        async write(path, data) {
          const response = await request(root + '/files?path=' + encodeURIComponent(path), {
            method: 'PUT',
            body: data as Uint8Array<ArrayBuffer>,
          })
          await response.body?.cancel()
        },
      }
    },
    async create(input) {
      const response = await request('/sandboxes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: input.metadata }),
      })
      const created = (await response.json()) as { home: string; id: string }
      return { expiresAt: null, handle: { home: created.home, id: created.id } }
    },
    async kill(handle) {
      const response = await request('/sandboxes/' + encodeURIComponent(handle.id), {
        method: 'DELETE',
      })
      await response.body?.cancel()
    },
  }
}

export declare namespace create {
  type Options = {
    fetch?(input: string, init?: RequestInit): Promise<Response>
    token: string
    url: string
  }
}
