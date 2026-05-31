import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';
import type { PostgresDatabase } from '../../db/index.js';

class MemorySettingsDb {
  settings = new Map<string, string>();

  async one<T = any>(sql: string): Promise<T | undefined> {
    if (!sql.includes("key = 'encryption_key'")) return undefined;
    const value = this.settings.get('encryption_key');
    return value ? ({ value } as T) : undefined;
  }

  async run(sql: string, params: unknown[]): Promise<{ changes: number }> {
    if (!sql.includes('INSERT INTO settings')) return { changes: 0 };
    this.settings.set('encryption_key', String(params[0]));
    return { changes: 1 };
  }
}

function freshDb(): PostgresDatabase {
  return new MemorySettingsDb() as unknown as PostgresDatabase;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.DEV_MODE;
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

describe('initEncryptionKey input validation', () => {
  beforeEach(async () => {
    restoreEnv();
  });

  afterEach(async () => {
    restoreEnv();
  });

  it('accepts a valid 64-char hex env key', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    await expect(initEncryptionKey(freshDb())).resolves.toBeUndefined();

    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key', async () => {
    process.env.ENCRYPTION_KEY = 'abc';
    await expect(initEncryptionKey(freshDb())).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    await expect(initEncryptionKey(freshDb())).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', async () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64);
    await expect(initEncryptionKey(freshDb())).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('requires ENCRYPTION_KEY when dev fallback is not explicitly enabled', async () => {
    const db = freshDb() as unknown as MemorySettingsDb;
    await expect(initEncryptionKey(db as unknown as PostgresDatabase)).rejects.toThrow(/ENCRYPTION_KEY is required/);
    expect(db.settings.get('encryption_key')).toBeUndefined();
  });

  it('does not load a DB-stored fallback key when dev fallback is disabled', async () => {
    const db = freshDb() as unknown as MemorySettingsDb;
    db.settings.set('encryption_key', 'b'.repeat(64));
    await expect(initEncryptionKey(db as unknown as PostgresDatabase)).rejects.toThrow(/ENCRYPTION_KEY is required/);
  });

  it('requires ENCRYPTION_KEY in production even when DEV_MODE is set', async () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'production';
    await expect(initEncryptionKey(freshDb())).rejects.toThrow(/ENCRYPTION_KEY is required/);
  });

  it('allows explicit dev fallback generation', async () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const db = freshDb() as unknown as MemorySettingsDb;
    await expect(initEncryptionKey(db as unknown as PostgresDatabase)).resolves.toBeUndefined();
    expect(db.settings.get('encryption_key')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key', async () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const db = freshDb() as unknown as MemorySettingsDb;
    db.settings.set('encryption_key', 'not-hex');
    await expect(initEncryptionKey(db as unknown as PostgresDatabase)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });
});
