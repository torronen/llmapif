import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initDb } from '../../db/index.js';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  getRateLimitStatus,
  getNextCooldownDuration,
} from '../../services/ratelimit.js';

describe('Rate Limiter', () => {
  // Use unique identifiers per test to avoid cross-contamination
  let testId: number;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    testId = Math.floor(Math.random() * 1_000_000);
  });

  afterEach(async () => {
    await closeDb();
  });

  describe('canMakeRequest', () => {
    it('should allow request when under RPM limit', async () => {
      expect(await canMakeRequest('groq', 'llama-70b', testId, {
        rpm: 30, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });

    it('should deny request when RPM limit reached', async () => {
      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      await recordRequest('groq', 'llama-70b', testId);
      await recordRequest('groq', 'llama-70b', testId);
      expect(await canMakeRequest('groq', 'llama-70b', testId, limits)).toBe(false);
    });

    it('should deny request when RPD limit reached', async () => {
      const limits = { rpm: null, rpd: 1, tpm: null, tpd: null };
      await recordRequest('google', 'gemini', testId);
      expect(await canMakeRequest('google', 'gemini', testId, limits)).toBe(false);
    });

    it('should allow request when limits are null (unlimited)', async () => {
      expect(await canMakeRequest('nvidia', 'nemotron', testId, {
        rpm: null, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('canUseTokens', () => {
    it('should allow tokens when under TPM limit', async () => {
      expect(await canUseTokens('groq', 'llama-70b', testId, 500, {
        tpm: 6000, tpd: null,
      })).toBe(true);
    });

    it('should deny tokens when TPM limit would be exceeded', async () => {
      await recordTokens('cerebras', 'qwen3', testId, 50000);
      expect(await canUseTokens('cerebras', 'qwen3', testId, 20000, {
        tpm: 60000, tpd: null,
      })).toBe(false);
    });

    it('should allow when limit is null', async () => {
      expect(await canUseTokens('nvidia', 'nemotron', testId, 100000, {
        tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return current usage counts', async () => {
      const limits = { rpm: 30, rpd: 1000, tpm: 6000, tpd: null };
      await recordRequest('groq', 'test-model', testId);
      await recordRequest('groq', 'test-model', testId);
      await recordTokens('groq', 'test-model', testId, 500);

      const status = await getRateLimitStatus('groq', 'test-model', testId, limits);
      expect(status.rpm.used).toBe(2);
      expect(status.rpm.limit).toBe(30);
      expect(status.rpd.used).toBe(2);
      expect(status.tpm.used).toBe(500);
    });
  });

  describe('escalating cooldown', () => {
    it('escalates the 2nd/3rd/4th hit within 24h to 10m / 1h / 24h', async () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const args = ['cerebras', `escalating-model-${id}`, id] as const;
      // 1st: 2 minutes
      expect(getNextCooldownDuration(...args)).toBe(2 * 60 * 1000);
      // 2nd: 10 minutes
      expect(getNextCooldownDuration(...args)).toBe(10 * 60 * 1000);
      // 3rd: 1 hour
      expect(getNextCooldownDuration(...args)).toBe(60 * 60 * 1000);
      // 4th: 24 hours
      expect(getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
      // 5th+ stays at 24h (quarantined until next quota window)
      expect(getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
    });

    it('counts independently per (platform, model, key)', () => {
      const id = Math.floor(Math.random() * 1_000_000);
      // Different keys for the same model should each start at 2m, not share state.
      expect(getNextCooldownDuration('groq', `m-${id}`, id)).toBe(2 * 60 * 1000);
      expect(getNextCooldownDuration('groq', `m-${id}`, id + 1)).toBe(2 * 60 * 1000);
      expect(getNextCooldownDuration('groq', `m-${id}-other`, id)).toBe(2 * 60 * 1000);
    });
  });

  describe('persistent state', () => {
    it('persists per-key usage and cooldowns in Postgres', async () => {
      const keyId = 4242;

      await recordRequest('groq', 'persistent-model', keyId);
      await recordTokens('groq', 'persistent-model', keyId, 950);
      await import('../../services/ratelimit.js').then(m => m.setCooldown('groq', 'persistent-model', keyId, 60_000));

      expect(await canMakeRequest('groq', 'persistent-model', keyId, {
        rpm: null, rpd: 1, tpm: null, tpd: null,
      })).toBe(false);
      expect(await canUseTokens('groq', 'persistent-model', keyId, 100, {
        tpm: null, tpd: 1000,
      })).toBe(false);
      const { isOnCooldown } = await import('../../services/ratelimit.js');
      expect(await isOnCooldown('groq', 'persistent-model', keyId)).toBe(true);
    });
  });
});
