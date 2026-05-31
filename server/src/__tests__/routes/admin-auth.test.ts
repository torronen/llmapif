import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { clearAllLoginAttempts } from '../../middleware/loginRateLimit.js';

let baseUrl = '';

async function request(_app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

describe('Admin authentication', () => {
  let app: Express;
  let server: Server;
  const original = process.env.ADMIN_PASSWORD;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    // Isolate the in-memory login-rate-limit counter between tests.
    clearAllLoginAttempts();
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

    const login = await request(app, 'POST', '/api/auth/login', { password: 'any' });
    expect(login.status).toBe(200);
    expect(login.body.authRequired).toBe(false);
  });

  it('guards admin routes and issues a working token when ADMIN_PASSWORD is set', async () => {
    process.env.ADMIN_PASSWORD = 's3cret-pass';

    expect((await request(app, 'GET', '/api/auth/status')).body.authRequired).toBe(true);

    // No token → 401
    expect((await request(app, 'GET', '/api/keys')).status).toBe(401);

    // Wrong password → 401
    expect((await request(app, 'POST', '/api/auth/login', { password: 'nope' })).status).toBe(401);

    // Missing password payload -> 400
    expect((await request(app, 'POST', '/api/auth/login', {})).status).toBe(400);
    expect((await request(app, 'POST', '/api/auth/login', { password: '' })).status).toBe(400);

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

  it('throttles repeated failed logins (5 allowed, 6th blocked)', async () => {
    process.env.ADMIN_PASSWORD = 's3cret-pass';
    for (let i = 0; i < 5; i++) {
      expect((await request(app, 'POST', '/api/auth/login', { password: 'wrong' })).status).toBe(401);
    }
    const blocked = await request(app, 'POST', '/api/auth/login', { password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.type).toBe('rate_limit_error');
  });

  it('clears the failed-attempt counter after a successful login', async () => {
    process.env.ADMIN_PASSWORD = 's3cret-pass';
    for (let i = 0; i < 4; i++) {
      expect((await request(app, 'POST', '/api/auth/login', { password: 'wrong' })).status).toBe(401);
    }
    // Correct login resets the counter...
    expect((await request(app, 'POST', '/api/auth/login', { password: 's3cret-pass' })).status).toBe(200);
    // ...so five more failures are all 401, never 429.
    for (let i = 0; i < 5; i++) {
      expect((await request(app, 'POST', '/api/auth/login', { password: 'wrong' })).status).toBe(401);
    }
  });
});
