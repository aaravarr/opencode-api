import { randomBytes } from "node:crypto";
import { getDatabase, type AppDatabase } from "./db";
import { SecretVault } from "./crypto";

export const SYSTEM_SETTING_KEYS = {
  upstreamBaseUrl: "opencode_upstream_base_url",
  upstreamRequestTimeoutMs: "upstream_request_timeout_ms",
  maintenanceIntervalMs: "maintenance_interval_ms",
  maintenanceEnabled: "maintenance_enabled",
  refreshBatchLimit: "refresh_batch_limit",
  refreshConcurrency: "refresh_concurrency",
} as const;

export const SYSTEM_SECRET_KEYS = {
  apiKeyPepper: "api_key_pepper",
  cronSecret: "cron_secret",
} as const;

export type SystemSecretKey =
  (typeof SYSTEM_SECRET_KEYS)[keyof typeof SYSTEM_SECRET_KEYS];

export interface SystemSettings {
  upstreamBaseUrl: string;
  upstreamRequestTimeoutMs: number;
  maintenanceEnabled: boolean;
  maintenanceIntervalMs: number;
  refreshBatchLimit: number;
  refreshConcurrency: number;
}

export interface UpdateSystemSettingsInput {
  upstreamBaseUrl?: string;
  upstreamRequestTimeoutMs?: number;
  maintenanceEnabled?: boolean;
  maintenanceIntervalMs?: number;
  refreshBatchLimit?: number;
  refreshConcurrency?: number;
}

const defaults: SystemSettings = {
  upstreamBaseUrl: "https://opencode.ai/zen/go/v1",
  upstreamRequestTimeoutMs: 120_000,
  maintenanceEnabled: true,
  maintenanceIntervalMs: 60_000,
  refreshBatchLimit: 25,
  refreshConcurrency: 3,
};

type SettingRow = { value_json: string; is_secret: number };

export function initializeSystemSettings(db: AppDatabase): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO system_settings(key, value_json, is_secret, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  const vault = new SecretVault();
  db.transaction(() => {
    insert.run(
      SYSTEM_SETTING_KEYS.upstreamBaseUrl,
      JSON.stringify(defaults.upstreamBaseUrl),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.upstreamRequestTimeoutMs,
      JSON.stringify(defaults.upstreamRequestTimeoutMs),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.maintenanceIntervalMs,
      JSON.stringify(defaults.maintenanceIntervalMs),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.maintenanceEnabled,
      JSON.stringify(defaults.maintenanceEnabled),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.refreshBatchLimit,
      JSON.stringify(defaults.refreshBatchLimit),
      0,
      now,
    );
    insert.run(
      SYSTEM_SETTING_KEYS.refreshConcurrency,
      JSON.stringify(defaults.refreshConcurrency),
      0,
      now,
    );
    insert.run(
      SYSTEM_SECRET_KEYS.apiKeyPepper,
      JSON.stringify(vault.encrypt(randomBytes(32).toString("base64url"))),
      1,
      now,
    );
    insert.run(
      SYSTEM_SECRET_KEYS.cronSecret,
      JSON.stringify(vault.encrypt(randomBytes(32).toString("base64url"))),
      1,
      now,
    );
  })();
}

export function getSystemSettings(
  db: AppDatabase = getDatabase(),
): SystemSettings {
  return {
    upstreamBaseUrl: readPublic(
      db,
      SYSTEM_SETTING_KEYS.upstreamBaseUrl,
      defaults.upstreamBaseUrl,
    ),
    upstreamRequestTimeoutMs: readPublic(
      db,
      SYSTEM_SETTING_KEYS.upstreamRequestTimeoutMs,
      defaults.upstreamRequestTimeoutMs,
    ),
    maintenanceEnabled: readPublic(
      db,
      SYSTEM_SETTING_KEYS.maintenanceEnabled,
      defaults.maintenanceEnabled,
    ),
    maintenanceIntervalMs: readPublic(
      db,
      SYSTEM_SETTING_KEYS.maintenanceIntervalMs,
      defaults.maintenanceIntervalMs,
    ),
    refreshBatchLimit: readPublic(
      db,
      SYSTEM_SETTING_KEYS.refreshBatchLimit,
      defaults.refreshBatchLimit,
    ),
    refreshConcurrency: readPublic(
      db,
      SYSTEM_SETTING_KEYS.refreshConcurrency,
      defaults.refreshConcurrency,
    ),
  };
}

export function updateSystemSettings(
  input: UpdateSystemSettingsInput,
  updatedByUserId?: string | null,
  db: AppDatabase = getDatabase(),
): SystemSettings {
  const entries: [string, string][] = [];
  if (input.upstreamBaseUrl !== undefined)
    entries.push([
      SYSTEM_SETTING_KEYS.upstreamBaseUrl,
      JSON.stringify(normalizeOfficialOpenCodeUpstreamUrl(input.upstreamBaseUrl)),
    ]);
  if (input.upstreamRequestTimeoutMs !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.upstreamRequestTimeoutMs,
      JSON.stringify(
        integerInRange(
          input.upstreamRequestTimeoutMs,
          1_000,
          600_000,
          "Request timeout",
        ),
      ),
    ]);
  }
  if (input.maintenanceEnabled !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.maintenanceEnabled,
      JSON.stringify(input.maintenanceEnabled),
    ]);
  }
  if (input.maintenanceIntervalMs !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.maintenanceIntervalMs,
      JSON.stringify(
        integerInRange(
          input.maintenanceIntervalMs,
          10_000,
          86_400_000,
          "Maintenance interval",
        ),
      ),
    ]);
  }
  if (input.refreshBatchLimit !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.refreshBatchLimit,
      JSON.stringify(
        integerInRange(input.refreshBatchLimit, 1, 500, "Refresh batch limit"),
      ),
    ]);
  }
  if (input.refreshConcurrency !== undefined) {
    entries.push([
      SYSTEM_SETTING_KEYS.refreshConcurrency,
      JSON.stringify(
        integerInRange(input.refreshConcurrency, 1, 32, "Refresh concurrency"),
      ),
    ]);
  }
  const statement = db.prepare(
    `UPDATE system_settings SET value_json = ?, updated_by_user_id = ?, updated_at = ?
     WHERE key = ? AND is_secret = 0`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const [key, value] of entries)
      statement.run(value, updatedByUserId ?? null, now, key);
  })();
  return getSystemSettings(db);
}

export function getSystemSecret(db: AppDatabase, key: SystemSecretKey): string {
  const row = db
    .prepare("SELECT value_json, is_secret FROM system_settings WHERE key = ?")
    .get(key) as SettingRow | undefined;
  if (!row || row.is_secret !== 1)
    throw new Error(`System secret is not initialized: ${key}`);
  const encrypted = JSON.parse(row.value_json);
  if (typeof encrypted !== "string")
    throw new Error(`System secret has invalid storage: ${key}`);
  return new SecretVault().decrypt(encrypted);
}

export function rotateSystemSecret(
  db: AppDatabase,
  key: SystemSecretKey,
  updatedByUserId?: string | null,
): string {
  const secret = randomBytes(32).toString("base64url");
  const encrypted = new SecretVault().encrypt(secret);
  const result = db
    .prepare(
      `UPDATE system_settings SET value_json = ?, updated_by_user_id = ?, updated_at = ?
       WHERE key = ? AND is_secret = 1`,
    )
    .run(
      JSON.stringify(encrypted),
      updatedByUserId ?? null,
      new Date().toISOString(),
      key,
    );
  if (result.changes !== 1)
    throw new Error(`System secret is not initialized: ${key}`);
  return secret;
}

export function getPublicSecretStatus(db: AppDatabase = getDatabase()) {
  const rows = db
    .prepare("SELECT key, updated_at FROM system_settings WHERE is_secret = 1")
    .all() as { key: string; updated_at: string }[];
  const status = Object.fromEntries(
    rows.map((row) => [
      row.key,
      { configured: true, updatedAt: row.updated_at },
    ]),
  );
  return {
    apiKeyPepper: status[SYSTEM_SECRET_KEYS.apiKeyPepper] ?? {
      configured: false,
      updatedAt: null,
    },
    cronSecret: status[SYSTEM_SECRET_KEYS.cronSecret] ?? {
      configured: false,
      updatedAt: null,
    },
  };
}

export function rotateInternalSecret(
  key: SystemSecretKey,
  updatedByUserId?: string | null,
  db: AppDatabase = getDatabase(),
): string {
  return rotateSystemSecret(db, key, updatedByUserId);
}

/**
 * Pepper rotation is intentionally destructive: old API key hashes can no
 * longer be verified, so every key is disabled atomically with the rotation.
 * The new pepper never leaves this helper.
 */
export function rotateApiKeyPepper(
  updatedByUserId?: string | null,
  db: AppDatabase = getDatabase(),
): number {
  return db
    .transaction(() => {
      rotateSystemSecret(db, SYSTEM_SECRET_KEYS.apiKeyPepper, updatedByUserId);
      const result = db
        .prepare(
          "UPDATE api_keys SET enabled = 0, updated_at = ? WHERE enabled = 1",
        )
        .run(new Date().toISOString());
      return result.changes;
    })
    .immediate();
}

function readPublic<T>(db: AppDatabase, key: string, fallback: T): T {
  const row = db
    .prepare("SELECT value_json, is_secret FROM system_settings WHERE key = ?")
    .get(key) as SettingRow | undefined;
  if (!row || row.is_secret !== 0) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

function parseOfficialOpenCodeUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password)
    throw new Error("URLs containing embedded credentials are not supported");
  const officialHost =
    url.hostname === "opencode.ai" || url.hostname.endsWith(".opencode.ai");
  if (url.protocol !== "https:" || !officialHost || url.port) {
    throw new Error("Only official HTTPS opencode.ai endpoints are allowed");
  }
  if (url.search || url.hash)
    throw new Error("Endpoint URLs cannot contain query strings or fragments");
  return url;
}

export function normalizeOfficialOpenCodeUpstreamUrl(value: string): string {
  const url = parseOfficialOpenCodeUrl(value);
  return url.toString().replace(/\/$/, "");
}

function integerInRange(
  value: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${label} must be an integer between ${min} and ${max} milliseconds`,
    );
  }
  return value;
}
