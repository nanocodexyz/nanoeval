import type { App } from 'nanocode-ts/cloudflare'

export type Env = App.Env & {
  ACCESS_TOKEN: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_BASE_URL?: string
  BLOBS?: R2Bucket
  CHATGPT_ACCESS_TOKEN?: string
  CHATGPT_ACCOUNT_ID?: string
  CHATGPT_RELAY_SECRET?: string
  CHATGPT_RELAY_URL?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
  EVALS: DurableObjectNamespace
  LOCAL_SANDBOX_TOKEN?: string
  LOCAL_SANDBOX_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  PUBLIC_URL?: string
  RUNS: DurableObjectNamespace
  TEMPO_GATEWAY_URL?: string
  TEMPO_KEY?: string
  TEMPO_PRIVATE_KEY?: string
  TICK_MS: string
}

export const account = 'nanoeval'
