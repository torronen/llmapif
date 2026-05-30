import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

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

describe('Analytics API', () => {
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
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_usage').run();

    const res = await req(app, 'POST', '/api/auth/login', { password: 'test-password' });
    adminToken = res.body.token;
  });

  function insertMockRequests(db: ReturnType<typeof getDb>) {
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'))
    `);
    insert.run('openai', 'gpt-4o', 1, 'success', 10, 20, 500, (now - 1000) / 1000);
    insert.run('openai', 'gpt-4o', 1, 'success', 5, 10, 300, (now - 2000) / 1000);
    insert.run('google', 'gemini-2.5-pro', 2, 'success', 50, 100, 1500, (now - 3000) / 1000);
    insert.run('openai', 'gpt-4o', 1, 'error', 0, 0, 100, (now - 4000) / 1000);
  }

  it('should return analytics summary', async () => {
    insertMockRequests(getDb());

    const res = await req(app, 'GET', '/api/analytics/summary', undefined, {
      Authorization: `Bearer ${adminToken}`
    });

    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBe(4);
    expect(res.body.successRate).toBe(75);
    expect(res.body.totalInputTokens).toBe(65);
    expect(res.body.totalOutputTokens).toBe(130);
  });

  it('should group analytics by model', async () => {
    insertMockRequests(getDb());

    const res = await req(app, 'GET', '/api/analytics/by-model', undefined, {
      Authorization: `Bearer ${adminToken}`
    });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    
    const openai = res.body.find((r: any) => r.platform === 'openai');
    expect(openai).toBeDefined();
    expect(openai.requests).toBe(3);
    expect(openai.successRate).toBeCloseTo(66.7, 1);
  });

  it('should get error distribution', async () => {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, datetime(?, 'unixepoch'))
    `).run('openai', 'gpt-4o', 1, 'error', 'api error 429: rate limit exceeded', (now - 1000) / 1000);

    const res = await req(app, 'GET', '/api/analytics/error-distribution', undefined, {
      Authorization: `Bearer ${adminToken}`
    });

    expect(res.status).toBe(200);
    expect(res.body.byCategory.length).toBe(1);
    expect(res.body.byCategory[0].category).toContain('429');
  });

  it('should group analytics by platform', async () => {
    insertMockRequests(getDb());
    const res = await req(app, 'GET', '/api/analytics/by-platform', undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    const openai = res.body.find((r: any) => r.platform === 'openai');
    expect(openai.requests).toBe(3);
    const google = res.body.find((r: any) => r.platform === 'google');
    expect(google.requests).toBe(1);
  });

  it('should return timeline data', async () => {
    insertMockRequests(getDb());
    const res = await req(app, 'GET', '/api/analytics/timeline?range=7d&interval=day', undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('timestamp');
    expect(res.body[0]).toHaveProperty('requests');
  });

  it('should return recent errors', async () => {
    insertMockRequests(getDb());
    const res = await req(app, 'GET', '/api/analytics/errors', undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1); // One error request inserted
    expect(res.body[0].platform).toBe('openai');
    expect(res.body[0].error).toBeNull(); // The mock error was null, actually I didn't provide error string in mock
  });

  it('should require admin authentication', async () => {
    const res = await req(app, 'GET', '/api/analytics/summary');
    expect(res.status).toBe(401);
  });
});
