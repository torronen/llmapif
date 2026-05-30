import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function req(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json };
}

describe('Models API', () => {
  let app: ReturnType<typeof createApp>;
  let adminToken: string;

  beforeAll(() => {
    process.env.DEV_MODE = 'true';
    initDb(':memory:');
    app = createApp();
    process.env.ADMIN_PASSWORD = 'test-password';
  });

  afterAll(() => {
    delete process.env.ADMIN_PASSWORD;
  });

  beforeEach(async () => {
    const res = await req(app, 'POST', '/api/auth/login', { password: 'test-password' });
    adminToken = res.body.token;
  });

  it('should list models with fallback statuses via admin API', async () => {
    const res = await req(app, 'GET', '/api/models', undefined, {
      Authorization: `Bearer ${adminToken}`
    });

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('id');
    expect(res.body[0]).toHaveProperty('platform');
    expect(res.body[0]).toHaveProperty('enabled');
  });

  it('should require admin authentication', async () => {
    const res = await req(app, 'GET', '/api/models');
    expect(res.status).toBe(401);
  });
});
