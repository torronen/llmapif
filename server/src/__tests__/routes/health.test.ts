import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { issueToken } from '../../lib/adminAuth.js';
import * as healthService from '../../services/health.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  process.env.ADMIN_PASSWORD = 'test';
  const token = issueToken();

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'Authorization': `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Health API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('POST /api/health/check/:keyId checks a specific key', async () => {
    vi.spyOn(healthService, 'checkKeyHealth').mockResolvedValueOnce('healthy');
    const { status, body } = await request(app, 'POST', '/api/health/check/123');
    expect(status).toBe(200);
    expect(body.keyId).toBe(123);
    expect(body.status).toBe('healthy');
  });

  it('POST /api/health/check/:keyId rejects invalid ID', async () => {
    const { status } = await request(app, 'POST', '/api/health/check/invalid');
    expect(status).toBe(400);
  });

  it('POST /api/health/check-all checks all keys', async () => {
    vi.spyOn(healthService, 'checkAllKeys').mockResolvedValueOnce();
    const { status, body } = await request(app, 'POST', '/api/health/check-all');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});
