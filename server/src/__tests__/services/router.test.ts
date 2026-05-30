import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    // Reset fallback order to intelligence ranking
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip keys that cannot be decrypted and use a valid fallback key', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'corrupt', 'not-hex', 'not-hex', 'not-hex', 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    const corruptKey = db.prepare("SELECT status FROM api_keys WHERE label = 'corrupt'").get() as { status: string };

    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
    expect(corruptKey.status).toBe('error');
  });

  it('sticky sessions (preferredModelDbId) boosts model to front of chain', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-key');
    
    // Have keys for both
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', encrypted, iv, authTag, 'healthy', 1);
    
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    // Google naturally wins due to higher intelligence rank in initDb
    const resultNormal = routeRequest();
    expect(resultNormal.platform).toBe('google');

    // But if we pass groq's model_db_id as preferred, it should win.
    const groqModelDbId = db.prepare("SELECT id FROM models WHERE platform = 'groq' ORDER BY intelligence_rank ASC LIMIT 1").get() as any;
    
    const resultSticky = routeRequest(1000, undefined, groqModelDbId.id);
    expect(resultSticky.platform).toBe('groq');
  });

  it('getAllPenalties and skipped fallback config', async () => {
    // They share state because vitest loads them once.
    const { recordRateLimitHit, getAllPenalties, routeRequest } = await import('../../services/router.js');
    recordRateLimitHit(1);
    recordRateLimitHit(1); // count=2 => high penalty
    recordRateLimitHit(2); // count=1 => low penalty

    const penalties = getAllPenalties();
    expect(penalties.length).toBeGreaterThan(0);
    expect(penalties[0].modelDbId).toBe(1); // highest penalty first
    expect(penalties[0].count).toBe(2);

    // Also test that disabled fallback entries are skipped
    const db = getDb();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  describe('routing strategies', () => {
    it('sorts by intelligence_rank when strategy is smart', async () => {
      const db = getDb();
      const { encrypted, iv, authTag } = encrypt('test-key');
      
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('google', 'test', encrypted, iv, authTag, 'healthy', 1);
      
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

      // We make groq smarter than google for this test
      db.prepare(`UPDATE fallback_config SET enabled = 1`).run();
      db.prepare(`UPDATE models SET intelligence_rank = 1 WHERE platform = 'groq'`).run();
      db.prepare(`UPDATE models SET intelligence_rank = 100 WHERE platform = 'google'`).run();
      
      const resultSmart = routeRequest(1000, undefined, undefined, 'smart');
      expect(resultSmart.platform).toBe('groq');

      // But if strategy is 'fast', we can make google faster
      db.prepare(`UPDATE models SET speed_rank = 1 WHERE platform = 'google'`).run();
      db.prepare(`UPDATE models SET speed_rank = 100 WHERE platform = 'groq'`).run();
      
      const resultFast = routeRequest(1000, undefined, undefined, 'fast');
      expect(resultFast.platform).toBe('google');

      // And if strategy is 'cheap', we can make groq cheaper (higher monthly_token_budget)
      db.prepare(`UPDATE models SET monthly_token_budget = 99999999 WHERE platform = 'groq'`).run();
      db.prepare(`UPDATE models SET monthly_token_budget = 1 WHERE platform = 'google'`).run();

      const resultCheap = routeRequest(1000, undefined, undefined, 'cheap');
      expect(resultCheap.platform).toBe('groq');
    });
  });
});
