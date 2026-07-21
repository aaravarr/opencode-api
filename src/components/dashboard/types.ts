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
  endpoint?: string | null;
  createdAt?: string | null;
  model?: string | null;
  stream?: boolean;
  status?: string | number | null;
  outcome?: string | null;
  ok?: boolean;
  apiKeyPrefix?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  attemptCount?: number | null;
  attempts?: RouteAttempt[] | null;
  latencyMs?: number | null;
  firstTokenMs?: number | null;
  promptTokens?: number | null;
  inputTokens?: number | null;
  completionTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  textTokens?: number | null;
  imageTokens?: number | null;
  audioTokens?: number | null;
  hasRequest?: boolean;
  hasResponse?: boolean;
  client?: string | null;
  error?: string | null;
}

export interface AttemptDetail {
  id: string;
  attemptNumber: number;
  accountId?: string | null;
  accountName?: string | null;
  status?: number | null;
  decision?: string;
  errorType?: string | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface RequestDetail {
  request: RequestRecord & {
    request?: unknown;
    requestTruncated?: boolean;
    response?: unknown;
    responseTruncated?: boolean;
    headers?: Record<string, string>;
    userAgent?: string | null;
    error?: string | null;
    localPrepMs?: number | null;
    requestSizeBytes?: number | null;
    responseSizeBytes?: number | null;
  };
  attempts: AttemptDetail[];
}

export interface RequestListResponse {
  items: RequestRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Bucket {
  key: string;
  label: string;
  requests: number;
  ok: number;
  fail: number;
  latencySum: number;
  firstTokenSum: number;
  firstTokenCount: number;
  tpsSampleCount: number;
  genLatencySum: number;
  genTokensForTps: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface UsageSummary {
  requests: number;
  ok: number;
  fail: number;
  avgLatencyMs: number;
  avgFirstTokenMs: number | null;
  avgTps: number;
  tpsSampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface UsageStats {
  summary: UsageSummary;
  byTime: Bucket[];
  byModel: Bucket[];
  byAccount: Bucket[];
  byKey: Bucket[];
}

export interface LogSettings {
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
}

export interface LogsCleanupResponse {
  deletedRequests?: number;
  deletedBodies?: number;
  stripped?: number;
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
  loggingEnabled?: boolean;
  logBodies?: boolean;
  logBodiesOnError?: boolean;
  logRetentionDays?: number;
  maxBodyCaptureBytes?: number;
}

export interface OverviewPayload {
  counts?: {
    totalAccounts?: number;
    readyAccounts?: number;
    quotaBlocked?: number;
    inactiveAccounts?: number;
    apiKeys?: number;
  };
  stats?: {
    totalAccounts?: number;
    availableAccounts?: number;
    coolingAccounts?: number;
    unavailableAccounts?: number;
  };
  routing?: {
    currentAccountName?: string | null;
    currentAccountId?: string | null;
    preferredAccountName?: string | null;
    preferredAccountId?: string | null;
    nextRecoveryAt?: string | null;
  };
  recentRequests?: RequestRecord[];
  recentEvents?: EventRecord[];
  recentAttempts?: Record<string, AttemptDetail[]>;
}
