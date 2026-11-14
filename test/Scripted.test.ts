import assert from 'node:assert/strict'
import * as Path from 'node:path'
import { test } from 'node:test'
import * as Scripted from '../scripts/scripted-model.ts'

const tasks = Path.resolve(import.meta.dirname, '../tasks')

async function samples(): Promise<Scripted.Task[]> {
  return Promise.all(
    ['extract-todos', 'uppercase-message', 'write-greeting'].map((name) =>
      Scripted.read(Path.join(tasks, name)),
    ),
  )
}

const asks = (task: Scripted.Task) => ({
  messages: [
    { content: [{ text: 'Workspace: /app\n\n' + task.instruction, type: 'text' }], role: 'user' },
  ],
})

test('the scripted model reads the instruction and the solution of a task directory', async () => {
  const [todos] = await samples()
  assert.equal(todos!.name, 'extract-todos')
  assert.match(todos!.instruction, /^Read `notes\.md` and create `todos\.txt`\./)
  assert.equal(
    todos!.solution,
    "set -eu\n\ngrep '^- TODO: ' notes.md | sed 's/^- TODO: //' | sort > todos.txt",
  )
})

test('a session gets the solution of its task, or nothing where the plan says f', async () => {
  const all = await samples()
  const [todos, upper, greeting] = all
  const model = Scripted.create({
    plan: Scripted.plan(['uppercase-message=fpf', 'write-greeting=ff'], all),
    tasks: all,
  })
  const outcome = (task: Scripted.Task) => {
    const answer = model.answer(asks(task))
    assert.equal(answer.kind, 'call')
    return answer.kind === 'call' ? answer.planned + answer.session + ' ' + answer.command : ''
  }
  assert.equal(outcome(todos!), 'p1 ' + todos!.solution)
  assert.equal(outcome(upper!), 'f1 true')
  assert.equal(outcome(greeting!), 'f1 true')
  assert.equal(outcome(upper!), 'p2 ' + upper!.solution)
  assert.equal(outcome(upper!), 'f3 true')
  assert.equal(outcome(upper!), 'p4 ' + upper!.solution)
  assert.equal(outcome(greeting!), 'f2 true')
  assert.equal(outcome(greeting!), 'p3 ' + greeting!.solution)
  assert.deepEqual(
    model.answer({
      messages: [...asks(todos!).messages, { content: [{ type: 'tool_result' }], role: 'user' }],
    }),
    { kind: 'done' },
  )
  assert.throws(
    () => model.answer({ messages: [{ content: 'Do something else.', role: 'user' }] }),
    new Scripted.UnknownError(
      'the scripted model was given no task with this instruction: its tasks are extract-todos, uppercase-message, write-greeting',
    ),
  )
})

test('a plan that names no task, or letters other than p and f, is refused', async () => {
  const all = await samples()
  assert.deepEqual(Scripted.plan(['extract-todos=pf'], all), { 'extract-todos': 'pf' })
  assert.throws(
    () => Scripted.plan(['fix-git=ff'], all),
    new Scripted.UnknownError(
      'the plan names fix-git, and the tasks are extract-todos, uppercase-message, write-greeting',
    ),
  )
  assert.throws(
    () => Scripted.plan(['extract-todos=pxp'], all),
    new Scripted.UnknownError(
      'a plan is TASK=LETTERS with p and f, such as extract-todos=pfp, not extract-todos=pxp',
    ),
  )
})

test('the endpoint answers a Messages request with a tool call, then ends the turn', async () => {
  const all = await samples()
  const said: string[] = []
  const served = await Scripted.serve({
    host: '127.0.0.1',
    log: (line) => said.push(line),
    plan: { 'write-greeting': 'f' },
    port: 0,
    tasks: all,
  })
  const post = async (path: string, body: unknown) => {
    const response = await fetch(served.url + path, { body: JSON.stringify(body), method: 'POST' })
    return { status: response.status, text: await response.text() }
  }
  const events = (text: string) =>
    text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
  try {
    const first = await post('/v1/messages', { ...asks(all[0]!), model: 'scripted' })
    assert.equal(first.status, 200)
    const call = events(first.text)
    assert.equal(call[0]!['message'].model, 'scripted')
    assert.equal(call[1]!['content_block'].name, 'exec')
    assert.deepEqual(JSON.parse(call[2]!['delta'].partial_json), {
      code:
        'await tools.exec_command({ cmd: ' + JSON.stringify(all[0]!.solution) + ' }); text("done")',
    })
    assert.equal(call[4]!['delta'].stop_reason, 'tool_use')
    const failed = await post('/v1/messages', asks(all[2]!))
    assert.deepEqual(JSON.parse(events(failed.text)[2]!['delta'].partial_json), {
      code: 'await tools.exec_command({ cmd: "true" }); text("done")',
    })
    const last = await post('/v1/messages', {
      messages: [...asks(all[0]!).messages, { content: [{ type: 'tool_result' }], role: 'user' }],
    })
    assert.equal(events(last.text)[4]!['delta'].stop_reason, 'end_turn')
    const unknown = await post('/v1/messages', {
      messages: [{ content: 'Another task.', role: 'user' }],
    })
    assert.equal(unknown.status, 400)
    assert.equal((await post('/v1/responses', {})).status, 404)
    assert.deepEqual(said, [
      'extract-todos session 1: its solution',
      'write-greeting session 1: a command that does nothing',
      'refused: the scripted model was given no task with this instruction: its tasks are extract-todos, uppercase-message, write-greeting',
    ])
  } finally {
    await served.close()
  }
})
