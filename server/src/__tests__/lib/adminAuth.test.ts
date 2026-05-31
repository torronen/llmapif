import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isAdminAuthEnabled,
  verifyPassword,
  issueToken,
  verifyToken,
  assertRemoteAccessIsSafe,
} from '../../lib/adminAuth.js';

describe('adminAuth', () => {
  const original = process.env.ADMIN_PASSWORD;
  const originalRemote = process.env.ADMIN_ALLOW_REMOTE;
  afterEach(async () => {
    if (original === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original;
    if (originalRemote === undefined) delete process.env.ADMIN_ALLOW_REMOTE;
    else process.env.ADMIN_ALLOW_REMOTE = originalRemote;
  });

  describe('when ADMIN_PASSWORD is unset', () => {
    beforeEach(async () => { delete process.env.ADMIN_PASSWORD; });

    it('reports auth disabled', async () => {
      expect(isAdminAuthEnabled()).toBe(false);
    });
    it('rejects any password and any token', async () => {
      expect(verifyPassword('anything')).toBe(false);
      expect(verifyToken('whatever.sig')).toBe(false);
    });
    it('throws when asked to issue a token', async () => {
      expect(() => issueToken()).toThrow();
    });
  });

  describe('when ADMIN_PASSWORD is set', () => {
    beforeEach(async () => { process.env.ADMIN_PASSWORD = 'correct horse battery staple'; });

    it('reports auth enabled', async () => {
      expect(isAdminAuthEnabled()).toBe(true);
    });
    it('accepts the correct password, rejects wrong ones', () => {
      expect(verifyPassword('correct horse battery staple')).toBe(true);
      expect(verifyPassword('wrong')).toBe(false);
      expect(verifyPassword('correct horse battery stapl')).toBe(false);
    });
    it('issues a token that verifies', async () => {
      const token = issueToken();
      expect(verifyToken(token)).toBe(true);
    });
    it('rejects a tampered token', async () => {
      const token = issueToken();
      expect(verifyToken(token + 'x')).toBe(false);
      expect(verifyToken(token.replace(/.$/, c => (c === 'a' ? 'b' : 'a')))).toBe(false);
    });
    it('rejects malformed tokens', async () => {
      expect(verifyToken('')).toBe(false);
      expect(verifyToken('nodot')).toBe(false);
      expect(verifyToken('.sigonly')).toBe(false);
    });
    it('rejects an expired token', async () => {
      const past = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
      const token = issueToken(past);
      expect(verifyToken(token)).toBe(false);
    });
    it('invalidates tokens when the password changes (logout-everywhere)', async () => {
      const token = issueToken();
      process.env.ADMIN_PASSWORD = 'a different password';
      expect(verifyToken(token)).toBe(false);
    });
  });

  describe('assertRemoteAccessIsSafe', () => {
    it('throws when remote access is on but no password is set', async () => {
      delete process.env.ADMIN_PASSWORD;
      process.env.ADMIN_ALLOW_REMOTE = 'true';
      expect(() => assertRemoteAccessIsSafe()).toThrow(/ADMIN_PASSWORD/);
    });
    it('allows remote access when a password is set', async () => {
      process.env.ADMIN_PASSWORD = 'a strong password';
      process.env.ADMIN_ALLOW_REMOTE = 'true';
      expect(() => assertRemoteAccessIsSafe()).not.toThrow();
    });
    it('allows loopback-only with no password', async () => {
      delete process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_ALLOW_REMOTE;
      expect(() => assertRemoteAccessIsSafe()).not.toThrow();
    });
  });
});
