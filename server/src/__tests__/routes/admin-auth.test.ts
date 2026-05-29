import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

describe('Admin authentication', () => {
  let app: Express;
  const original = process.env.ADMIN_PASSWORD;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original;
  });

  it('leaves admin routes open when ADMIN_PASSWORD is unset', async () => {
    delete process.env.ADMIN_PASSWORD;
    const status = await request(app, 'GET', '/api/auth/status');
    expect(status.body.authRequired).toBe(false);

    const keys = await request(app, 'GET', '/api/keys');
    expect(keys.status).toBe(200);
  });

  it('guards admin routes and issues a working token when ADMIN_PASSWORD is set', async () => {
    process.env.ADMIN_PASSWORD = 's3cret-pass';

    expect((await request(app, 'GET', '/api/auth/status')).body.authRequired).toBe(true);

    // No token → 401
    expect((await request(app, 'GET', '/api/keys')).status).toBe(401);

    // Wrong password → 401
    expect((await request(app, 'POST', '/api/auth/login', { password: 'nope' })).status).toBe(401);

    // Correct password → token
    const login = await request(app, 'POST', '/api/auth/login', { password: 's3cret-pass' });
    expect(login.status).toBe(200);
    expect(typeof login.body.token).toBe('string');

    // Token grants access
    const ok = await request(app, 'GET', '/api/keys', undefined, { Authorization: `Bearer ${login.body.token}` });
    expect(ok.status).toBe(200);

    // Garbage token still rejected
    const bad = await request(app, 'GET', '/api/keys', undefined, { Authorization: 'Bearer not.a.real.token' });
    expect(bad.status).toBe(401);
  });

  it('keeps the health ping reachable without a token even when auth is on', async () => {
    process.env.ADMIN_PASSWORD = 's3cret-pass';
    expect((await request(app, 'GET', '/api/ping')).status).toBe(200);
  });
});
