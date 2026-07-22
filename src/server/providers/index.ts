import { getProviderRegistry } from "./registry"
import { OpenCodeGoProvider } from "./opencode-go"
import { OpenAICPAProvider } from "./openai-cpa"
import { XAIGrokProvider } from "./xai-grok"

// Register all built-in providers. This runs once on first import.

let initialized = false

export function ensureProvidersRegistered(): void {
  if (initialized) return
  initialized = true
  const registry = getProviderRegistry()
  registry.register(new OpenCodeGoProvider())
  registry.register(new OpenAICPAProvider("openai-cpa"))
  registry.register(new OpenAICPAProvider("openai-oauth"))
  registry.register(new XAIGrokProvider())
}

// Trigger registration on module load
ensureProvidersRegistered()

export { getProviderRegistry, getProvider, tryGetProvider, POOL_TYPE_METADATA } from "./registry"
export { POOL_TYPES } from "./types"
export type { Provider, PoolType, PoolTypeMeta, QuotaWindow, ProviderCredential, UpstreamErrorClassification, ForwardRequestInput, ForwardTarget } from "./types"
