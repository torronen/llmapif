import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { checkKeyHealth, checkAllKeys, startHealthChecker, stopHealthChecker } from '../../services/health.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import * as providers from '../../providers/index.js';

describe('Health Checker Service', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
  });

  afterEach(async () => {
    stopHealthChecker();
    vi.restoreAllMocks();
  });

  it('should return error for non-existent key', async () => {
    const status = await checkKeyHealth(99999);
    expect(status).toBe('error');
  });

  it('should validate a healthy key', async () => {
    const { encrypted, iv, authTag } = encrypt('sk-test-123');
    const db = getDb();
    const result = await db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openai', 'test', ?, ?, ?, 'unknown', 1)
      RETURNING id
    `).run(encrypted, iv, authTag);
    const keyId = result.lastInsertRowid as number;

    const mockProvider = { validateKey: vi.fn().mockResolvedValue(true) } as any;
    vi.spyOn(providers, 'getProvider').mockReturnValue(mockProvider);

    const status = await checkKeyHealth(keyId);
    expect(status).toBe('healthy');
    expect(mockProvider.validateKey).toHaveBeenCalledWith('sk-test-123');

    const updated = await db.prepare('SELECT status, enabled FROM api_keys WHERE id = ?').get(keyId) as any;
    expect(updated.status).toBe('healthy');
    expect(updated.enabled).toBe(1);
  });

  it('should auto-disable key after 3 consecutive failures', async () => {
    const { encrypted, iv, authTag } = encrypt('sk-test-bad');
    const db = getDb();
    const result = await db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openai', 'bad', ?, ?, ?, 'unknown', 1)
      RETURNING id
    `).run(encrypted, iv, authTag);
    const keyId = result.lastInsertRowid as number;

    const mockProvider = { validateKey: vi.fn().mockResolvedValue(false) } as any;
    vi.spyOn(providers, 'getProvider').mockReturnValue(mockProvider);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // 1st failure
    await checkKeyHealth(keyId);
    let updated = await db.prepare('SELECT status, enabled FROM api_keys WHERE id = ?').get(keyId) as any;
    expect(updated.status).toBe('invalid');
    expect(updated.enabled).toBe(1);

    // 2nd failure
    await checkKeyHealth(keyId);
    updated = await db.prepare('SELECT status, enabled FROM api_keys WHERE id = ?').get(keyId) as any;
    expect(updated.enabled).toBe(1);

    // 3rd failure
    await checkKeyHealth(keyId);
    updated = await db.prepare('SELECT status, enabled FROM api_keys WHERE id = ?').get(keyId) as any;
    expect(updated.enabled).toBe(0); // Disabled!
  });

  it('should handle transport errors without disabling', async () => {
    const { encrypted, iv, authTag } = encrypt('sk-test-transport');
    const db = getDb();
    const result = await db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openai', 'trans', ?, ?, ?, 'unknown', 1)
      RETURNING id
    `).run(encrypted, iv, authTag);
    const keyId = result.lastInsertRowid as number;

    const mockProvider = { validateKey: vi.fn().mockRejectedValue(new Error('Network error')) } as any;
    vi.spyOn(providers, 'getProvider').mockReturnValue(mockProvider);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Try 4 times (more than consecutive failures threshold)
    for (let i = 0; i < 4; i++) {
      const status = await checkKeyHealth(keyId);
      expect(status).toBe('error');
    }

    // Key should still be enabled
    const updated = await db.prepare('SELECT status, enabled FROM api_keys WHERE id = ?').get(keyId) as any;
    expect(updated.status).toBe('error');
    expect(updated.enabled).toBe(1);
    consoleSpy.mockRestore();
  });

  it('checkAllKeys should check all enabled keys', async () => {
    const mockProvider = { validateKey: vi.fn().mockResolvedValue(true) } as any;
    vi.spyOn(providers, 'getProvider').mockReturnValue(mockProvider);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await checkAllKeys();
    // At least one mock key is in DB, so it should have been called
    expect(mockProvider.validateKey).toHaveBeenCalled();
  });

  it('startHealthChecker should run checks and stopHealthChecker should clear interval', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mockProvider = { validateKey: vi.fn().mockResolvedValue(true) } as any;
    vi.spyOn(providers, 'getProvider').mockReturnValue(mockProvider);

    startHealthChecker();
    // should not start again
    startHealthChecker();

    stopHealthChecker();
    // should not crash if stopped twice
    stopHealthChecker();
  });
});
