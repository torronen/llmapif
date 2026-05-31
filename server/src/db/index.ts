import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import pg from 'pg';
import { initEncryptionKey } from '../lib/crypto.js';
import { MODEL_SEEDS } from './model-seeds.js';

const { Pool } = pg;
type PoolClient = pg.PoolClient;
type QueryResult = pg.QueryResult;

pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1700, (value) => Number(value));

export interface RunResult {
  changes: number;
  lastInsertRowid?: number;
}

export class PostgresDatabase {
  constructor(private readonly pool: pg.Pool) {}

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const client = transactionClient.getStore();
    return client
      ? client.query(sql, params)
      : this.pool.query(sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  async one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.query(toPostgresSql(sql), params);
    return result.rows[0] as T | undefined;
  }

  async many<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query(toPostgresSql(sql), params);
    return result.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.query(toPostgresSql(sql), params);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows[0]?.id,
    };
  }

  prepare(sql: string) {
    return {
      get: <T = any>(...params: unknown[]) => this.one<T>(sql, params),
      all: <T = any>(...params: unknown[]) => this.many<T>(sql, params),
      run: (...params: unknown[]) => this.run(sql, params),
    };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = transactionClient.getStore();
    if (existing) return fn();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionClient.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const transactionClient = new AsyncLocalStorage<PoolClient>();

let db: PostgresDatabase | null = null;
let unifiedApiKey: string | null = null;
let currentTestSchema: { baseUrl: string; schema: string } | null = null;

export function getDb(): PostgresDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function initDb(databaseUrl = process.env.DATABASE_URL): Promise<PostgresDatabase> {
  await closeDb();

  if (databaseUrl === ':memory:') {
    databaseUrl = await createIsolatedTestDatabaseUrl();
  }

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required; local file database paths are not supported.');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: parsePositiveInt(process.env.DATABASE_POOL_MAX, 10),
  });

  db = new PostgresDatabase(pool);
  await db.transaction(async () => {
    await createTables(db!);
    await initEncryptionKey(db!);
    await seedModels(db!);
    await ensureUnifiedKey(db!);
  });
  console.log('Postgres database initialized.');
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
  }
  db = null;
  unifiedApiKey = null;

  if (currentTestSchema) {
    const { baseUrl, schema } = currentTestSchema;
    currentTestSchema = null;
    const admin = new Pool({ connectionString: baseUrl });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function createIsolatedTestDatabaseUrl(): Promise<string> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error('TEST_DATABASE_URL is required for Postgres tests.');
  }

  const schema = `llmapif_test_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new Pool({ connectionString: baseUrl });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  currentTestSchema = { baseUrl, schema };
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toPostgresSql(sql: string): string {
  let index = 0;
  return sql
    .replace(/\?/g, () => `$${++index}`)
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/datetime\('now', 'start of month'\)/gi, "date_trunc('month', CURRENT_TIMESTAMP)")
    .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
}

async function createTables(db: PostgresDatabase) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_checked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS requests (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rate_limit_usage (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at_ms BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (platform, model_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id SERIAL PRIMARY KEY,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_requests_key_id ON requests(key_id);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_created_at_ms ON rate_limit_usage(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
  `);
}

async function seedModels(db: PostgresDatabase) {
  for (const model of MODEL_SEEDS) {
    const row = await db.one<{ id: number }>(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
        monthly_token_budget, context_window, enabled
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, model_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        intelligence_rank = EXCLUDED.intelligence_rank,
        speed_rank = EXCLUDED.speed_rank,
        size_label = EXCLUDED.size_label,
        rpm_limit = EXCLUDED.rpm_limit,
        rpd_limit = EXCLUDED.rpd_limit,
        tpm_limit = EXCLUDED.tpm_limit,
        tpd_limit = EXCLUDED.tpd_limit,
        monthly_token_budget = EXCLUDED.monthly_token_budget,
        context_window = EXCLUDED.context_window,
        enabled = EXCLUDED.enabled
      RETURNING id
    `, [
      model.platform,
      model.model_id,
      model.display_name,
      model.intelligence_rank,
      model.speed_rank,
      model.size_label,
      model.rpm_limit,
      model.rpd_limit,
      model.tpm_limit,
      model.tpd_limit,
      model.monthly_token_budget,
      model.context_window,
      model.enabled,
    ]);

    if (row && model.fallback_priority !== null) {
      await db.run(`
        INSERT INTO fallback_config (model_db_id, priority, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT(model_db_id) DO UPDATE SET
          priority = EXCLUDED.priority,
          enabled = EXCLUDED.enabled
      `, [row.id, model.fallback_priority, model.fallback_enabled]);
    }
  }
}

async function ensureUnifiedKey(db: PostgresDatabase) {
  const existing = await db.one<{ value: string }>("SELECT value FROM settings WHERE key = 'unified_api_key'");
  if (existing?.value) {
    unifiedApiKey = existing.value;
    return;
  }

  unifiedApiKey = process.env.UNIFIED_API_KEY || `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await db.run(
    "INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)",
    [unifiedApiKey],
  );
  console.log(process.env.UNIFIED_API_KEY ? 'Loaded configured unified API key.' : 'Generated unified API key.');
}

export function getUnifiedApiKey(): string {
  if (!unifiedApiKey) {
    throw new Error('Unified API key not initialized. Call initDb() first.');
  }
  return unifiedApiKey;
}

export async function regenerateUnifiedKey(): Promise<string> {
  const nextKey = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await getDb().run(
    "UPDATE settings SET value = ? WHERE key = 'unified_api_key'",
    [nextKey],
  );
  unifiedApiKey = nextKey;
  return nextKey;
}
