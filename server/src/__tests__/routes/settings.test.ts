import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { issueToken } from '../../lib/adminAuth.js';

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

describe('Settings API', () => {
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

  it('GET /api/settings/api-key returns current key', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/api-key');
    expect(status).toBe(200);
    expect(body.apiKey).toBe(getUnifiedApiKey());
  });

  it('POST /api/settings/api-key/regenerate generates new key', async () => {
    const oldKey = getUnifiedApiKey();
    const { status, body } = await request(app, 'POST', '/api/settings/api-key/regenerate');
    expect(status).toBe(200);
    expect(body.apiKey).not.toBe(oldKey);
    expect(body.apiKey).toBe(getUnifiedApiKey());
  });
});
