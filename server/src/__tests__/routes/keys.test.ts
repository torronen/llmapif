import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

let baseUrl = '';

async function request(_app: Express, method: string, path: string, body?: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, body: data };
}

describe('Keys API', () => {
  let app: Express;
  let server: Server;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'My Groq Key',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'invalid_platform',
      key: 'test',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'DELETE', `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/99999');
    expect(status).toBe(404);
  });

  it('should toggle all keys for a platform', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'openrouter', key: 'sk-or-123' });
    await request(app, 'POST', '/api/keys', { platform: 'openrouter', key: 'sk-or-456' });

    const toggleRes = await request(app, 'PATCH', '/api/keys/platform/openrouter', { enabled: false });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.enabled).toBe(false);

    const keysRes = await request(app, 'GET', '/api/keys');
    const openrouterKeys = keysRes.body.filter((k: any) => k.platform === 'openrouter');
    expect(openrouterKeys.every((k: any) => k.enabled === false)).toBe(true);
  });

  it('should reject toggling invalid platform', async () => {
    const res = await request(app, 'PATCH', '/api/keys/platform/invalid_plat', { enabled: false });
    expect(res.status).toBe(400);
  });

  it('should reject toggling platform with invalid payload', async () => {
    const res = await request(app, 'PATCH', '/api/keys/platform/openrouter', { enabled: 'not boolean' });
    expect(res.status).toBe(400);
  });

  it('should reject deleting key with invalid ID', async () => {
    const res = await request(app, 'DELETE', '/api/keys/invalid');
    expect(res.status).toBe(400);
  });

  it('should handle toggling non-existent key', async () => {
    const res = await request(app, 'PATCH', '/api/keys/99999', { enabled: false });
    expect(res.status).toBe(404);
  });

  it('should reject toggling key with invalid ID', async () => {
    const res = await request(app, 'PATCH', '/api/keys/invalid', { enabled: false });
    expect(res.status).toBe(400);
  });

  it('should reject toggling key with invalid payload', async () => {
    const res = await request(app, 'PATCH', '/api/keys/1', { enabled: 'not boolean' });
    expect(res.status).toBe(400);
  });

  it('should handle decrypt failure in listing', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('openrouter', 'broken', 'bad_data', 'bad_iv', 'bad_tag', 'unknown', 1)
    `).run();

    const res = await request(app, 'GET', '/api/keys');
    expect(res.status).toBe(200);
    const brokenKey = res.body.find((k: any) => k.label === 'broken');
    expect(brokenKey.maskedKey).toBe('[decrypt failed]');
  });
});
