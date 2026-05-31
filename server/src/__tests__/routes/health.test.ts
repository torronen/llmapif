import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { issueToken } from '../../lib/adminAuth.js';
import * as healthService from '../../services/health.js';

let baseUrl = '';

async function request(_app: Express, method: string, path: string, body?: any) {
  process.env.ADMIN_PASSWORD = 'test';
  const token = issueToken();

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'Authorization': `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, body: data };
}

describe('Health API', () => {
  let app: Express;
  let server: Server;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    app = createApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

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
