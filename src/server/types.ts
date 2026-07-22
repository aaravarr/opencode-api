export const ADMIN_STATES = ["ENABLED", "DISABLED"] as const
export const AUTH_STATES = ["VALID", "REAUTH_REQUIRED", "AUTH_ERROR"] as const
export const SUBSCRIPTION_STATES = ["ACTIVE", "INACTIVE", "VERIFY_ERROR"] as const
export const BILLING_GUARDS = ["VERIFIED_GO_ONLY", "PAYG_FALLBACK_ENABLED", "UNVERIFIED"] as const
export const QUOTA_KINDS = ["FIVE_HOUR", "WEEKLY", "MONTHLY", "UNKNOWN_GO_LIMIT"] as const

export const POOL_TYPES = ["opencode-go", "openai-cpa", "openai-oauth"] as const
export type PoolType = (typeof POOL_TYPES)[number]

export type AdminState = (typeof ADMIN_STATES)[number]
export type AuthState = (typeof AUTH_STATES)[number]
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number]
export type BillingGuard = (typeof BILLING_GUARDS)[number]
export type QuotaKind = (typeof QUOTA_KINDS)[number]
export type UserRole = "ADMIN" | "USER"
export type UserStatus = "ACTIVE" | "DISABLED"

export interface UserRecord {
  id: string
  username: string
  displayName: string
  role: UserRole
  status: UserStatus
  createdAt: string
  updatedAt: string
  githubId?: string | null
}

export interface AccountRecord {
  id: string
  ownerUserId: string
  name: string
  poolType: PoolType
  workspaceId: string
  email: string | null
  goKeyId: string
  credentialSource: "BROWSER_EXTENSION"
  extensionVersion: string | null
  lastSyncedAt: string
  adminState: AdminState
  authState: AuthState
  subscriptionState: SubscriptionState
  goSubscriptionId: string | null
  isZenSubscribed: boolean
  zenSubscriptionId: string | null
  hasManageSubscriptionButton: boolean
  billingGuard: BillingGuard
  useBalance: boolean | null
  credentialVersion: number
  lastUsageCheckAt: string | null
  nextUsageCheckAt: string
  lastSelectedAt: string | null
  lastRequestAt: string | null
  lastSuccessAt: string | null
  lastLimitAt: string | null
  maxConcurrency: number
  ordinal: number
  createdAt: string
  updatedAt: string
}

export interface AccountCredential extends AccountRecord {
  authCookie: string
  goApiKey: string
}

export interface ProviderAccountData {
  // Generic encrypted credential storage for non-OpenCode providers
  // For openai-cpa (AT token): { token, chatgptAccountId, planType }
  // For openai-oauth (refreshable): { token, refreshToken, expiresAt, clientId, chatgptAccountId, planType }
  token?: string
  refreshToken?: string
  expiresAt?: string
  clientId?: string
  chatgptAccountId?: string
  planType?: string
  extraHeaders?: Record<string, string>
}

export interface ModelRouteRule {
  id: string
  ownerUserId: string
  modelPattern: string
  poolTypePriority: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface UpstreamTarget {
  baseUrl: string
  authStyle: "BEARER"
}

export interface RouteSelection {
  account: AccountRecord
  leaseId: string
  target: UpstreamTarget
}

export interface QuotaSnapshot {
  accountId: string
  kind: QuotaKind
  usagePercent: number
  resetAt: string | null
  lastObservedAt: string
  source: "DASHBOARD" | "UPSTREAM_429"
}
