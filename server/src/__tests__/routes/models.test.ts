import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

let baseUrl = '';

async function req(_app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json };
}

describe('Models API', () => {
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let adminToken: string;

  beforeAll(async () => {
    process.env.DEV_MODE = 'true';
    await initDb(':memory:');
    app = createApp();
    process.env.ADMIN_PASSWORD = 'test-password';
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    delete process.env.ADMIN_PASSWORD;
    return new Promise<void>((resolve) => server.close(() => resolve()));
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
