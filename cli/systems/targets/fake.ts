import * as Target from '../Target.ts'

function hash(text: string): number {
  let state = 2166136261
  for (const char of text) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0
  return state
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function reply(prompt: string): string {
  const found = /reply with exactly:?\s*(.+?)\s*$/im.exec(prompt)
  return found ? found[1]!.replace(/^["'`]|["'`.]$/g, '') : 'ok'
}

// A deterministic stand-in for tests: the build's version is a speed factor (a=1, b=0.5 halves every
// delay). "sleep N" in a prompt is a cell of N x 100 ms, "fail" errors the turn, model no-such-model
// refuses it, and the deadline and stall window of the suite apply.
export const fake: Target.Target = {
  async describe(build) {
    return { overrides: { factor: factor(build) } }
  },
  name: 'fake',
  async open(build, context) {
    const scale = factor(build)
    const deadlineMs = context?.deadlineMs ?? 60_000
    const stallMs = context?.stallMs ?? 30_000
    let turns = 0
    const id = 'fake-' + build.label + '-' + Math.random().toString(36).slice(2, 10)
    await sleep((context?.cold ? 30 : 5) * scale)
    return {
      async close() {},
      id,
      async turn(prompt) {
        const sendMs = Target.now()
        const jitter = (hash(build.label + prompt + turns++) % 10) / 10
        if (context?.model === 'no-such-model' || /\bfail\b/i.test(prompt)) {
          await sleep(5 * scale)
          return { cells: [], doneMs: Target.now(), error: 'refused', ok: false, sendMs, text: '' }
        }
        const startup = (context?.cold && turns === 1 ? 20 : 4) * scale
        const ttft = startup + (10 + 10 * jitter) * scale
        const sleepFor = Number(/sleep (\d+)/i.exec(prompt)?.[1] ?? 0) * 100
        const stream = 20 * scale
        if (ttft + sleepFor + stream > deadlineMs) {
          await sleep(deadlineMs)
          return {
            cells: [],
            doneMs: Target.now(),
            firstTokenMs: sendMs + ttft,
            ok: false,
            sendMs,
            stalled: sleepFor > stallMs,
            text: '',
            timedOut: true,
          }
        }
        await sleep(ttft)
        const firstTokenMs = Target.now()
        const cells: Target.CellTiming[] = []
        if (sleepFor || /\b(cell|python|code)\b/i.test(prompt)) {
          const startMs = Target.now()
          await sleep(sleepFor || 2 * scale)
          cells.push({
            endMs: Target.now(),
            kind: /python/i.test(prompt) ? 'python' : 'code',
            name: 'exec',
            ok: true,
            startMs,
          })
        }
        await sleep(stream)
        const text = reply(prompt)
        return {
          cells,
          doneMs: Target.now(),
          firstByteMs: sendMs + ttft - 2,
          firstTokenMs,
          metrics: { rssPeakKb: Math.round(50_000 * scale), startupMs: startup },
          ok: true,
          outputTokens: 40,
          sendMs,
          stalled: sleepFor > stallMs,
          text,
        }
      },
    }
  },
}

function factor(build: Target.Build): number {
  const found = Number(build.version ?? '1')
  return Number.isFinite(found) && found > 0 ? found : 1
}

export default fake
