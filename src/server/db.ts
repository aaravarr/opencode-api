import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { ensureMasterKey, getDatabasePath } from "./bootstrap"
import { initializeSystemSettings } from "./settings"

export type AppDatabase = Database.Database

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN', 'USER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
  password_hash TEXT NOT NULL,
  github_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS bootstrap_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  client_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_lookup_idx ON auth_rate_limits(scope, client_key_hash, created_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pool_type TEXT NOT NULL DEFAULT 'opencode-go',
  workspace_id TEXT NOT NULL UNIQUE,
  email TEXT,
  admin_state TEXT NOT NULL DEFAULT 'ENABLED',
  auth_state TEXT NOT NULL DEFAULT 'VALID',
  subscription_state TEXT NOT NULL DEFAULT 'INACTIVE',
  go_subscription_id TEXT,
  is_zen_subscribed INTEGER NOT NULL DEFAULT 0,
  zen_subscription_id TEXT,
  has_manage_subscription_button INTEGER NOT NULL DEFAULT 0,
  billing_guard TEXT NOT NULL DEFAULT 'UNVERIFIED',
  use_balance INTEGER,
  go_key_id TEXT NOT NULL,
  credential_source TEXT NOT NULL DEFAULT 'BROWSER_EXTENSION',
  extension_version TEXT,
  last_synced_at TEXT NOT NULL,
  auth_cookie_ciphertext TEXT NOT NULL,
  go_api_key_ciphertext TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  last_usage_check_at TEXT,
  next_usage_check_at TEXT NOT NULL,
  last_selected_at TEXT,
  last_request_at TEXT,
  last_success_at TEXT,
  last_limit_at TEXT,
  max_concurrency INTEGER NOT NULL DEFAULT 4,
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_owner_idx ON accounts(owner_user_id, ordinal, created_at);
CREATE INDEX IF NOT EXISTS accounts_usage_idx ON accounts(next_usage_check_at, admin_state, auth_state);

CREATE TABLE IF NOT EXISTS quota_windows (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  usage_percent REAL NOT NULL,
  reset_at TEXT,
  source TEXT NOT NULL DEFAULT 'DASHBOARD',
  observation_version INTEGER NOT NULL DEFAULT 1,
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, account_id, kind)
);

CREATE TABLE IF NOT EXISTS routing_state (
  owner_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferred_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  current_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  cursor_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_leases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_leases_active_idx ON route_leases(owner_user_id, account_id, expires_at, completed_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_models_json TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS gateway_requests (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL,
  model TEXT,
  status INTEGER,
  outcome TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS gateway_requests_owner_idx ON gateway_requests(owner_user_id, started_at);
CREATE INDEX IF NOT EXISTS gateway_requests_time_idx ON gateway_requests(owner_user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS gateway_attempts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES gateway_requests(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  attempt_number INTEGER NOT NULL,
  status INTEGER,
  decision TEXT,
  error_type TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS gateway_attempts_request_idx ON gateway_attempts(request_id);

CREATE TABLE IF NOT EXISTS request_bodies (
  request_id TEXT PRIMARY KEY REFERENCES gateway_requests(id) ON DELETE CASCADE,
  request_body_json TEXT,
  response_body_json TEXT,
  request_headers_json TEXT,
  request_truncated INTEGER NOT NULL DEFAULT 0,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  has_request INTEGER NOT NULL DEFAULT 0,
  has_response INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  request_id TEXT REFERENCES gateway_requests(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_owner_created_idx ON events(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pool_preferences (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pool_type TEXT NOT NULL,
  preferred_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, pool_type)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pool_type TEXT NOT NULL,
  credential_data_ciphertext TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id)
);
CREATE INDEX IF NOT EXISTS provider_credentials_owner_idx ON provider_credentials(owner_user_id);

CREATE TABLE IF NOT EXISTS model_routing (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_pattern TEXT NOT NULL,
  pool_type_priority TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_routing_owner_idx ON model_routing(owner_user_id, enabled);
`

export function createDatabase(filename: string): AppDatabase {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true })
  const db = new Database(filename)
  resetLegacyAccountDomain(db)
  db.exec(schema)
  ensureCurrentAccountColumns(db)
  ensurePoolTypeColumn(db)
  db.exec("CREATE INDEX IF NOT EXISTS accounts_pool_type_idx ON accounts(owner_user_id, pool_type, admin_state)")
  ensureCurrentGatewayRequestColumns(db)
  ensureCurrentApiKeyColumns(db)
  ensureUserColumns(db)
  return db
}

function ensurePoolTypeColumn(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("pool_type")) db.exec("ALTER TABLE accounts ADD COLUMN pool_type TEXT NOT NULL DEFAULT 'opencode-go'")
}

function ensureCurrentAccountColumns(db: AppDatabase): void {
  const existing = new Set((db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]).map((column) => column.name))
  const additions = [
    ["go_subscription_id", "TEXT"],
    ["is_zen_subscribed", "INTEGER NOT NULL DEFAULT 0"],
    ["zen_subscription_id", "TEXT"],
    ["has_manage_subscription_button", "INTEGER NOT NULL DEFAULT 0"],
  ] as const
  for (const [name, definition] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`)
  }
}

function ensureCurrentApiKeyColumns(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("key_ciphertext")) db.exec("ALTER TABLE api_keys ADD COLUMN key_ciphertext TEXT")
}

function ensureUserColumns(db: AppDatabase): void {
  const cols = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((column) => column.name))
  if (!cols.has("github_id")) db.exec("ALTER TABLE users ADD COLUMN github_id TEXT")
}

function ensureCurrentGatewayRequestColumns(db: AppDatabase): void {
  const requestCols = new Set((db.prepare("PRAGMA table_info(gateway_requests)").all() as { name: string }[]).map((column) => column.name))
  const requestAdditions = [
    ["stream", "INTEGER NOT NULL DEFAULT 0"],
    ["api_key_prefix", "TEXT"],
    ["account_id", "TEXT"],
    ["account_name", "TEXT"],
    ["ok", "INTEGER NOT NULL DEFAULT 0"],
    ["latency_ms", "INTEGER"],
    ["local_prep_ms", "INTEGER"],
    ["first_token_ms", "INTEGER"],
    ["error", "TEXT"],
    ["client", "TEXT"],
    ["user_agent", "TEXT"],
    ["origin", "TEXT"],
    ["request_size_bytes", "INTEGER"],
    ["response_size_bytes", "INTEGER"],
    ["prompt_tokens", "INTEGER"],
    ["completion_tokens", "INTEGER"],
    ["total_tokens", "INTEGER"],
    ["cached_tokens", "INTEGER"],
    ["reasoning_tokens", "INTEGER"],
    ["text_tokens", "INTEGER"],
    ["image_tokens", "INTEGER"],
    ["audio_tokens", "INTEGER"],
  ] as const
  for (const [name, definition] of requestAdditions) {
    if (!requestCols.has(name)) db.exec(`ALTER TABLE gateway_requests ADD COLUMN ${name} ${definition}`)
  }
  const attemptCols = new Set((db.prepare("PRAGMA table_info(gateway_attempts)").all() as { name: string }[]).map((column) => column.name))
  const attemptAdditions = [
    ["latency_ms", "INTEGER"],
    ["error_message", "TEXT"],
    ["account_name", "TEXT"],
  ] as const
  for (const [name, definition] of attemptAdditions) {
    if (!attemptCols.has(name)) db.exec(`ALTER TABLE gateway_attempts ADD COLUMN ${name} ${definition}`)
  }
}

function resetLegacyAccountDomain(db: AppDatabase): void {
  const columns = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[]
  if (!columns.length || columns.some((column) => column.name === "auth_cookie_ciphertext")) return
  db.pragma("foreign_keys = OFF")
  try {
    db.transaction(() => {
      for (const table of ["gateway_attempts", "events", "route_leases", "quota_windows", "routing_state", "oauth_attempts", "accounts"]) {
        db.exec(`DROP TABLE IF EXISTS ${table}`)
      }
    }).immediate()
  } finally {
    db.pragma("foreign_keys = ON")
  }
}

const CURRENT_ACCOUNT_SCHEMA_VERSION = 5
const globalDatabase = globalThis as typeof globalThis & {
  __opencodeApiDb?: AppDatabase
  __opencodeApiAccountSchemaVersion?: number
}

export function getDatabase(): AppDatabase {
  if (!globalDatabase.__opencodeApiDb) {
    ensureMasterKey()
    const db = createDatabase(getDatabasePath())
    initializeSystemSettings(db)
    globalDatabase.__opencodeApiDb = db
  }
  // Next.js dev HMR keeps the database connection on globalThis. Re-run additive
  // migrations once per schema version so a code reload cannot leave that live
  // connection on the previous table shape.
  if (globalDatabase.__opencodeApiAccountSchemaVersion !== CURRENT_ACCOUNT_SCHEMA_VERSION) {
    ensureCurrentAccountColumns(globalDatabase.__opencodeApiDb)
    ensurePoolTypeColumn(globalDatabase.__opencodeApiDb)
    ensureCurrentGatewayRequestColumns(globalDatabase.__opencodeApiDb)
    globalDatabase.__opencodeApiAccountSchemaVersion = CURRENT_ACCOUNT_SCHEMA_VERSION
  }
  return globalDatabase.__opencodeApiDb
}
