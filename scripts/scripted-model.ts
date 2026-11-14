import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Path from 'node:path'
import { parseArgs } from 'node:util'

export type Task = { instruction: string; name: string; solution: string }

export type Plan = Record<string, string>

export type Answer =
  | { command: string; kind: 'call'; planned: 'f' | 'p'; session: number; task: string }
  | { kind: 'done' }

export class UnknownError extends Error {
  override name = 'Scripted.UnknownError'
}

export const usage = `scripted-model --task DIR... [--plan TASK=LETTERS]... [--port 8790] [--host 127.0.0.1]

Serve a model that needs no credential, to try nanoeval or a change to it: an Anthropic
Messages endpoint that answers the instruction of each task directory with one tool call
that runs the task's own solution, and ends the turn after it. --plan names what the
sessions of a task get, in the order they arrive: p for the solution and f for a command
that does nothing, so extract-todos=pfp fails the second attempt. Sessions past the plan
get the solution. Point a Worker at it with ANTHROPIC_API_KEY=scripted and
ANTHROPIC_BASE_URL=http://HOST:PORT, and name a claude model that nanocode knows, which
nothing then reaches: --agent scripted=claude:claude-haiku-4-5.`

export async function read(directory: string): Promise<Task> {
  const [instruction, solution] = await Promise.all([
    Fs.readFile(Path.join(directory, 'instruction.md'), 'utf8'),
    Fs.readFile(Path.join(directory, 'solution', 'solve.sh'), 'utf8'),
  ])
  return {
    instruction: instruction.trim(),
    name: Path.basename(Path.resolve(directory)),
    solution: solution
      .split('\n')
      .filter((line) => !line.startsWith('#!'))
      .join('\n')
      .trim(),
  }
}

export function plan(given: readonly string[], tasks: readonly Task[]): Plan {
  const plans: Plan = {}
  for (const entry of given) {
    const [name, letters] = entry.split('=')
    if (!name || !letters || !/^[fp]+$/.test(letters))
      throw new UnknownError(
        'a plan is TASK=LETTERS with p and f, such as extract-todos=pfp, not ' + entry,
      )
    if (!tasks.some((task) => task.name === name))
      throw new UnknownError(
        'the plan names ' +
          name +
          ', and the tasks are ' +
          tasks.map((task) => task.name).join(', '),
      )
    plans[name] = letters
  }
  return plans
}

export function create(options: { plan?: Plan; tasks: readonly Task[] }) {
  const sessions = new Map<string, number>()
  return {
    answer(body: { messages?: unknown }): Answer {
      const text = JSON.stringify(body.messages ?? [])
      if (text.includes('"tool_result"')) return { kind: 'done' }
      const task = options.tasks.find((candidate) =>
        text.includes(JSON.stringify(candidate.instruction).slice(1, -1)),
      )
      if (!task)
        throw new UnknownError(
          'the scripted model was given no task with this instruction: its tasks are ' +
            options.tasks.map((candidate) => candidate.name).join(', '),
        )
      const session = (sessions.get(task.name) ?? 0) + 1
      sessions.set(task.name, session)
      const planned = options.plan?.[task.name]?.[session - 1] === 'f' ? 'f' : 'p'
      return {
        command: planned === 'p' ? task.solution : 'true',
        kind: 'call',
        planned,
        session,
        task: task.name,
      }
    },
  }
}

function sse(events: readonly [name: string, data: unknown][]): string {
  return events
    .map(([name, data]) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n')
    .join('')
}

export function stream(answer: Answer, input: { id: number; model: string | undefined }): string {
  const block =
    answer.kind === 'call'
      ? [
          { id: 'toolu_' + input.id, input: {}, name: 'exec', type: 'tool_use' },
          {
            partial_json: JSON.stringify({
              code:
                'await tools.exec_command({ cmd: ' +
                JSON.stringify(answer.command) +
                ' }); text("done")',
            }),
            type: 'input_json_delta',
          },
        ]
      : [
          { text: '', type: 'text' },
          { text: 'The task is complete.', type: 'text_delta' },
        ]
  return sse([
    [
      'message_start',
      {
        message: {
          content: [],
          id: 'msg_' + input.id,
          model: input.model,
          role: 'assistant',
          stop_reason: null,
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 8, output_tokens: 0 },
        },
        type: 'message_start',
      },
    ],
    ['content_block_start', { content_block: block[0], index: 0, type: 'content_block_start' }],
    ['content_block_delta', { delta: block[1], index: 0, type: 'content_block_delta' }],
    ['content_block_stop', { index: 0, type: 'content_block_stop' }],
    [
      'message_delta',
      {
        delta: {
          stop_reason: answer.kind === 'call' ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        type: 'message_delta',
        usage: { output_tokens: 4 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

export async function serve(options: {
  host: string
  log?(line: string): void
  plan?: Plan
  port: number
  tasks: readonly Task[]
}): Promise<{ close(): Promise<void>; url: string }> {
  const model = create(options)
  let requests = 0
  const server = Http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const refuse = (status: number, message: string) =>
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message, type: 'invalid_request_error' }, type: 'error' }))
      if (request.method !== 'POST' || request.url?.split('?')[0] !== '/v1/messages')
        return refuse(404, 'the scripted model answers POST /v1/messages only')
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages?: unknown
          model?: string
        }
        const answer = model.answer(body)
        if (answer.kind === 'call')
          options.log?.(
            answer.task +
              ' session ' +
              answer.session +
              ': ' +
              (answer.planned === 'p' ? 'its solution' : 'a command that does nothing'),
          )
        response
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(stream(answer, { id: ++requests, model: body.model }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.log?.('refused: ' + message)
        refuse(400, message)
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolve)
  })
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: 'http://' + options.host + ':' + (server.address() as AddressInfo).port,
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { default: false, short: 'h', type: 'boolean' },
      host: { default: '127.0.0.1', type: 'string' },
      plan: { multiple: true, type: 'string' },
      port: { default: '8790', type: 'string' },
      task: { multiple: true, type: 'string' },
    },
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (!values.task?.length) throw new UnknownError('--task DIR is required, once for each task')
  const tasks = await Promise.all(values.task.map(read))
  const served = await serve({
    host: values.host,
    log: (line) => console.log(new Date().toISOString() + ' ' + line),
    plan: plan(values.plan ?? [], tasks),
    port: Number(values.port),
    tasks,
  })
  console.log(
    'the scripted model answers for ' +
      tasks.map((task) => task.name).join(', ') +
      ' at ' +
      served.url +
      '\nexport ANTHROPIC_API_KEY=scripted ANTHROPIC_BASE_URL=' +
      served.url,
  )
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => void served.close().then(() => process.exit(0)))
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error('scripted-model: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  })
