import type { App } from 'nanocode-ts/cloudflare'
import type { PlanVault } from './Vault.ts'

export type Env = App.Env & {
  ACCESS_TOKEN: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_BASE_URL?: string
  BLOBS?: R2Bucket
  CELL_YIELD_MS?: string
  CHATGPT_ACCESS_TOKEN?: string
  CHATGPT_ACCOUNT_ID?: string
  CHATGPT_RELAY_SECRET?: string
  CHATGPT_RELAY_URL?: string
  CLAUDE_PLAN_URL?: string
  CLAUDE_CODE_OAUTH_TOKEN?: string
  COMMIT?: string
  EVALS: DurableObjectNamespace
  HAND_LIST_MS: string
  HOLD_MS: string
  LOCAL_SANDBOX_TOKEN?: string
  LOCAL_SANDBOX_URL?: string
  NANOCODE_TS_REVISION?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  PLAN_SECRET?: string
  PLANS: DurableObjectNamespace<PlanVault>
  POOL: DurableObjectNamespace
  PUBLIC_URL?: string
  RUN_LOCATION_HINT?: string
  RUNS: DurableObjectNamespace
  TEMPO_GATEWAY_URL?: string
  TEMPO_KEY?: string
  TEMPO_PRIVATE_KEY?: string
  TICK_MS: string
}

export const account = 'nanoeval'

export const locations = ['afr', 'apac', 'eeur', 'enam', 'me', 'oc', 'sam', 'weur', 'wnam'] as const
