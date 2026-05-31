// Sliding window rate limit tracker with Postgres persistence.

import { getDb } from '../db/index.js';

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

// Key format: "platform:modelId:keyId:type" where type is rpm|rpd|tpm|tpd
const windows = new Map<string, Window>();
type UsageKind = 'request' | 'tokens';

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function withDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | undefined> {
  try {
    return await fn(getDb());
  } catch {
    return undefined;
  }
}

// Old rows are pruned at most once per PRUNE_INTERVAL_MS rather than on every
// insert: the cleanup DELETE filters on created_at_ms alone, which the composite
// lookup index can't serve, so running it per-request meant a full table scan on
// the hot path. Throttling keeps the table bounded without that cost.
let lastPruneMs = 0;
const PRUNE_INTERVAL_MS = MINUTE;

// Returns true if the usage row was persisted to SQLite. Callers use the result
// to decide whether to maintain the in-memory fallback windows — when the DB is
// healthy we skip them entirely (the read path prefers persisted counts), which
// avoids unbounded growth of the in-memory timestamp arrays.
async function recordUsage(
  platform: string,
  modelId: string,
  keyId: number,
  kind: UsageKind,
  tokens: number,
  now: number,
): Promise<boolean> {
  return await withDb(async db => {
    await db.run(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [platform, modelId, keyId, kind, tokens, now]);
    if (now - lastPruneMs > PRUNE_INTERVAL_MS) {
      await db.run('DELETE FROM rate_limit_usage WHERE created_at_ms <= ?', [now - DAY]);
      lastPruneMs = now;
    }
    return true;
  }) === true;
}

async function countPersistedRequests(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): Promise<number | undefined> {
  return withDb(async db => {
    const row = await db.one<{ used: number }>(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `, [platform, modelId, keyId, now - windowMs]);
    return row?.used ?? 0;
  });
}

async function sumPersistedTokens(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): Promise<number | undefined> {
  return withDb(async db => {
    const row = await db.one<{ used: number }>(`
      SELECT COALESCE(SUM(tokens), 0) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'tokens'
         AND created_at_ms > ?
    `, [platform, modelId, keyId, now - windowMs]);
    return row?.used ?? 0;
  });
}

function memoryRequestCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.timestamps = pruneTimestamps(w.timestamps, windowMs, now);
  return w.timestamps.length;
}

function memoryTokenCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - windowMs);
  return w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
}

async function requestCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): Promise<number> {
  const persisted = await countPersistedRequests(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;
  const type = windowMs === MINUTE ? 'rpm' : 'rpd';
  return memoryRequestCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

async function tokenCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): Promise<number> {
  const persisted = await sumPersistedTokens(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;
  const type = windowMs === MINUTE ? 'tpm' : 'tpd';
  return memoryTokenCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

export async function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): Promise<boolean> {
  const now = Date.now();

  if (limits.rpm !== null) {
    if (await requestCount(platform, modelId, keyId, MINUTE, now) >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    if (await requestCount(platform, modelId, keyId, DAY, now) >= limits.rpd) return false;
  }

  return true;
}

export async function canUseTokens(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): Promise<boolean> {
  const now = Date.now();

  if (limits.tpm !== null) {
    const used = await tokenCount(platform, modelId, keyId, MINUTE, now);
    if (used + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const used = await tokenCount(platform, modelId, keyId, DAY, now);
    if (used + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

export async function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();

  const persisted = await recordUsage(platform, modelId, keyId, 'request', 0, now);
  if (persisted) return;

  // Degraded mode (DB unavailable): track in memory so rate limits still apply.
  getWindow(`${platform}:${modelId}:${keyId}:rpm`).timestamps.push(now);
  getWindow(`${platform}:${modelId}:${keyId}:rpd`).timestamps.push(now);
}

export async function recordTokens(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
) {
  const now = Date.now();

  const persisted = await recordUsage(platform, modelId, keyId, 'tokens', tokens, now);
  if (persisted) return;

  // Degraded mode (DB unavailable): track in memory so token limits still apply.
  getWindow(`${platform}:${modelId}:${keyId}:tpm`).tokenTimestamps.push({ ts: now, tokens });
  getWindow(`${platform}:${modelId}:${keyId}:tpd`).tokenTimestamps.push({ ts: now, tokens });
}

// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map<string, number>(); // key -> expiry timestamp

// Escalating cooldown: track hits per key over a rolling 24h window so a
// daily-quota exhaustion (OpenRouter free: 50/day, Cohere free: 33/day, etc.)
// quarantines the key for the rest of the day instead of looping through
// the 2-minute cooldown 20 times per request and consuming every fallback slot.
// In-memory only — state resets on restart, which is fine (a clean restart
// will re-escalate on the next 429 if the quota is genuinely exhausted).
const cooldownHits = new Map<string, number[]>(); // key -> timestamps of recent cooldown set events
const HOUR = 60 * MINUTE;
const COOLDOWN_DURATIONS = [
  2 * MINUTE,   // 1st hit in 24h
  10 * MINUTE,  // 2nd
  HOUR,         // 3rd
  DAY,          // 4th and beyond
];

export function getNextCooldownDuration(platform: string, modelId: string, keyId: number): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const now = Date.now();
  const hits = (cooldownHits.get(key) ?? []).filter(t => t > now - DAY);
  hits.push(now);
  cooldownHits.set(key, hits);
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1);
  return COOLDOWN_DURATIONS[idx]!;
}

async function persistedCooldownExpiry(
  platform: string,
  modelId: string,
  keyId: number,
): Promise<number | null | undefined> {
  return withDb(async db => {
    const row = await db.one<{ expires_at_ms: number }>(`
      SELECT expires_at_ms
        FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `, [platform, modelId, keyId]);
    return row?.expires_at_ms ?? null;
  });
}

async function persistCooldown(platform: string, modelId: string, keyId: number, expiresAtMs: number) {
  await withDb(async db => {
    await db.run(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id)
      DO UPDATE SET expires_at_ms = excluded.expires_at_ms
    `, [platform, modelId, keyId, expiresAtMs]);
  });
}

async function clearPersistedCooldown(platform: string, modelId: string, keyId: number) {
  await withDb(async db => {
    await db.run(`
      DELETE FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `, [platform, modelId, keyId]);
  });
}

export async function setCooldown(platform: string, modelId: string, keyId: number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);
  await persistCooldown(platform, modelId, keyId, expiresAtMs);
}

export async function isOnCooldown(platform: string, modelId: string, keyId: number): Promise<boolean> {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();
  const persistedExpiry = await persistedCooldownExpiry(platform, modelId, keyId);
  if (persistedExpiry !== undefined && persistedExpiry !== null) {
    if (now > persistedExpiry) {
      cooldowns.delete(key);
      await clearPersistedCooldown(platform, modelId, keyId);
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }

  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export async function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  return {
    rpm: { used: await requestCount(platform, modelId, keyId, MINUTE, now), limit: limits.rpm },
    rpd: { used: await requestCount(platform, modelId, keyId, DAY, now), limit: limits.rpd },
    tpm: { used: await tokenCount(platform, modelId, keyId, MINUTE, now), limit: limits.tpm },
  };
}
