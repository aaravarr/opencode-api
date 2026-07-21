export type QuotaState = "available" | "blocked" | "unknown";

export interface QuotaWindow {
  kind?: string;
  status?: QuotaState;
  blockedAt?: string | null;
  resetAt?: string | null;
  nextProbeAt?: string | null;
  retryAfterSeconds?: number | null;
  lastObservedAt?: string | null;
  resetInSec?: number | null;
  usagePercent?: number | null;
  source?: string | null;
}

export interface Account {
  id: string;
  name?: string | null;
  email?: string | null;
  status?: string | null;
  enabled?: boolean;
  isCurrent?: boolean;
  isPreferred?: boolean;
  routingEligible?: boolean;
  billingGuard?: string | null;
  adminState?: string | null;
  authState?: string | null;
  subscriptionState?: string | null;
  goSubscriptionId?: string | null;
  isZenSubscribed?: boolean;
  zenSubscriptionId?: string | null;
  hasManageSubscriptionButton?: boolean;
  useBalance?: boolean | null;
  workspaceId?: string | null;
  goKeyId?: string | null;
  credentialSource?: string | null;
  extensionVersion?: string | null;
  lastSyncedAt?: string | null;
  lastUsageCheckAt?: string | null;
  nextUsageCheckAt?: string | null;
  credentialVersion?: number | null;
  fiveHour?: QuotaWindow | null;
  weekly?: QuotaWindow | null;
  monthly?: QuotaWindow | null;
  quotas?: {
    fiveHour?: QuotaWindow | null;
    weekly?: QuotaWindow | null;
    monthly?: QuotaWindow | null;
  } | null;
  quotaWindows?: Array<QuotaWindow> | {
    fiveHour?: QuotaWindow | null;
    weekly?: QuotaWindow | null;
    monthly?: QuotaWindow | null;
  } | null;
  lastUsedAt?: string | null;
  lastRequestAt?: string | null;
  lastCheckedAt?: string | null;
  nextEligibleAt?: string | null;
  lastError?: string | null;
}

export interface ApiKeyRecord {
  id: string;
  name?: string | null;
  alias?: string | null;
  prefix?: string | null;
  keyPrefix?: string | null;
  status?: string | null;
  enabled?: boolean;
  createdAt?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  requestCount?: number | null;
  useCount?: number | null;
}

export interface RouteAttempt {
  id?: string;
  accountId?: string | null;
  accountName?: string | null;
  outcome?: string | null;
  reason?: string | null;
  limitName?: string | null;
  startedAt?: string | null;
  durationMs?: number | null;
}

export interface RequestRecord {
  id: string;
  createdAt?: string | null;
  model?: string | null;
  apiKeyPrefix?: string | null;
  status?: string | number | null;
  accountId?: string | null;
  accountName?: string | null;
  attempts?: RouteAttempt[] | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
}

export interface EventRecord {
  id: string;
  createdAt?: string | null;
  type?: string | null;
  level?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  message?: string | null;
  detail?: string | null;
}

export interface RoutingConfig {
  mode?: string;
  preferredAccountId?: string | null;
  currentAccountId?: string | null;
  candidates?: Account[];
}

export interface AdminSettings {
  refreshIntervalMinutes?: number | null;
  activeQuotaCheckSeconds?: number | null;
  idleQuotaCheckMinutes?: number | null;
  requestLogRetentionDays?: number | null;
}
