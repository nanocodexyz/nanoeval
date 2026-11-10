import { Challenge } from 'mppx'
import * as E2b from '../src/E2b.ts'
import * as Payment from '../src/Payment.ts'

const template = process.argv[2] ?? 'code-interpreter-v1'
const timeout = Number(process.argv[3] ?? '3600')

const response = await fetch(E2b.api + '/sandboxes', {
  body: JSON.stringify({ templateID: template, timeout }),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
})
if (response.status !== 402) {
  console.error(
    'expected 402 Payment Required, got ' + response.status + ': ' + (await response.text()),
  )
  process.exit(1)
}

for (const challenge of Challenge.fromResponseList(response)) {
  const request = challenge.request as { amount: string; currency: string }
  console.log(
    [
      challenge.method + '/' + challenge.intent,
      '$' + Payment.usd(request.amount),
      request.currency,
      challenge.description,
    ].join('  '),
  )
}
