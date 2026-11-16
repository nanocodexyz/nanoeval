import * as Branch from './Branch.ts'
import type * as Ledger from './Ledger.ts'
import type * as Result from './Result.ts'

export const gone = 'the attempt is not claimed by this runner any more'

export const refusedPrefix = 'the result of the attempt is refused: '

export function unowned(input: unowned.Input): string | undefined {
  const { row, session } = input
  if (!row.claim || !row.session) return 'no claim holds its row'
  const timing = JSON.parse(row.timing) as Result.Attempt['timing']
  if (!timing.agentExecution) return 'its claim started no agent execution'
  if (!session) return undefined

  const turns = (session.turns ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { request_id: string; session: string })
  const foreign = turns.find(
    (turn) => turn.session !== row.session && !turn.session.startsWith(row.session + '-'),
  )
  if (foreign) return 'its row keeps a turn of the session ' + foreign.session + ' of another claim'
  if (!turns.some((turn) => turn.session === row.session && turn.request_id === session.requestId))
    return 'its claim sent no turn to the session ' + row.session

  const { record } = session
  if (record?.session !== undefined && record.session !== row.session)
    return 'its branches were decided for the session ' + record.session + ' of another claim'
  if (row.failure) return undefined
  if (session.branches > 1 && !record) return 'its claim decided no branch'
  const chosen = record?.chosen ?? 0
  if (record && record.branches[chosen]?.state !== 'completed') return undefined
  if (session.turn && session.turn.status !== 'completed')
    return (
      'the verifier graded its sandbox, and the turn of the session ' +
      Branch.session(row.session, chosen) +
      ' is ' +
      session.turn.status
    )
  return undefined
}

export declare namespace unowned {
  type Input = {
    row: Pick<Ledger.Attempt, 'claim' | 'failure' | 'session' | 'timing'>
    session?: {
      branches: number
      record: Branch.Record | undefined
      requestId: string
      turn: { status: string } | undefined
      turns: string | undefined
    }
  }
}
