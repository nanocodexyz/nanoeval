import type { App } from 'nanocode-ts/cloudflare'

export type Env = App.Env & {
  ACCESS_TOKEN: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
  CHATGPT_ACCESS_TOKEN?: string
  CHATGPT_ACCOUNT_ID?: string
  CHATGPT_RELAY_SECRET?: string
  CHATGPT_RELAY_URL?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
  LOCAL_SANDBOX_TOKEN?: string
  LOCAL_SANDBOX_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  PUBLIC_URL?: string
  RUNS: DurableObjectNamespace
  TEMPO_PRIVATE_KEY?: string
  TICK_MS: string
}

export const account = 'nanoeval'
