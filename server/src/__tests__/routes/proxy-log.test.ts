import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { flushLogBatch } from '../../routes/proxy.js';
import { encrypt } from '../../lib/crypto.js';

import http from 'http';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  
  return new Promise<any>((resolve) => {
    const req = http.request(url, {
      method,
      headers: { 
        'Authorization': `Bearer ${getUnifiedApiKey()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) 
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        server.close();
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Proxy logging batch', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    app = createApp();
  });

  it('flushLogBatch flushes logs to DB and clears batch', async () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-key-2');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', encrypted, iv, authTag, 'healthy', 1);

    vi.spyOn(global, 'fetch').mockImplementationOnce(async () => ({
      ok: true,
      json: () => Promise.resolve({
        id: 'success',
        object: 'chat.completion',
        created: 1,
        model: 'model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any));

    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'test' }],
    });
    
    if (res.status !== 200) {
      console.log('Error 400 body:', res.body);
    }
    expect(res.status).toBe(200);

    // Manually flush
    flushLogBatch();
    
    // Check DB
    const reqs = db.prepare('SELECT * FROM requests').all() as any[];
    expect(reqs.length).toBeGreaterThan(0);
  });
});
