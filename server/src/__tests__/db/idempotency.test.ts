import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../db/index.js';

async function freshDb() {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  return initDb(':memory:');
}

afterEach(async () => {
  await closeDb();
});

describe('Postgres catalog idempotency', () => {
  it('seeds stable counts when initDb is rerun on the same database', async () => {
    const db = await freshDb();
    const before = {
      models: (await db.one<{ c: number }>('SELECT COUNT(*) AS c FROM models'))?.c,
      fallback: (await db.one<{ c: number }>('SELECT COUNT(*) AS c FROM fallback_config'))?.c,
      enabledModels: (await db.one<{ c: number }>('SELECT COUNT(*) AS c FROM models WHERE enabled = 1'))?.c,
      disabledModels: (await db.one<{ c: number }>('SELECT COUNT(*) AS c FROM models WHERE enabled = 0'))?.c,
      orphanFallbacks: (await db.one<{ c: number }>(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `))?.c,
    };

    await initDb(':memory:');
    const db2 = await freshDb();
    const after = {
      models: (await db2.one<{ c: number }>('SELECT COUNT(*) AS c FROM models'))?.c,
      fallback: (await db2.one<{ c: number }>('SELECT COUNT(*) AS c FROM fallback_config'))?.c,
      enabledModels: (await db2.one<{ c: number }>('SELECT COUNT(*) AS c FROM models WHERE enabled = 1'))?.c,
      disabledModels: (await db2.one<{ c: number }>('SELECT COUNT(*) AS c FROM models WHERE enabled = 0'))?.c,
      orphanFallbacks: (await db2.one<{ c: number }>(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `))?.c,
    };

    expect(after).toEqual(before);
    expect(after.orphanFallbacks).toBe(0);
  });

  it('every catalog row has exactly one fallback_config entry', async () => {
    const db = await freshDb();
    const rows = await db.many<{ id: number; fb_count: number }>(`
      SELECT m.id, COUNT(f.id) AS fb_count
        FROM models m
        LEFT JOIN fallback_config f ON m.id = f.model_db_id
       GROUP BY m.id
      HAVING COUNT(f.id) <> 1
    `);

    expect(rows).toEqual([]);
  });

  it('keeps platform/model_id unique', async () => {
    const db = await freshDb();
    const rows = await db.many(`
      SELECT platform, model_id, COUNT(*) AS c FROM models
       GROUP BY platform, model_id
      HAVING COUNT(*) > 1
    `);

    expect(rows).toEqual([]);
  });

  it('contains the current cross-provider catalog state', async () => {
    const db = await freshDb();

    const disabled = await db.many<{ platform: string; model_id: string; enabled: number }>(`
      SELECT platform, model_id, enabled FROM models
       WHERE (platform = 'google' AND model_id = 'gemini-3.1-pro-preview')
          OR (platform = 'ollama' AND model_id IN ('kimi-k2-thinking', 'mistral-large-3:675b', 'deepseek-v3.2'))
       ORDER BY platform, model_id
    `);
    expect(disabled).toHaveLength(4);
    for (const row of disabled) expect(row.enabled).toBe(0);

    const additions = await db.many(`
      SELECT platform, model_id FROM models
       WHERE (platform, model_id) IN (VALUES
         ('groq',        'openai/gpt-oss-safeguard-20b'),
         ('cloudflare',  '@cf/nvidia/nemotron-3-120b-a12b'),
         ('cloudflare',  '@cf/google/gemma-4-26b-a4b-it'),
         ('google',      'gemini-3.5-flash'),
         ('nvidia',      'deepseek-ai/deepseek-v4-flash'),
         ('nvidia',      'z-ai/glm-5.1'),
         ('nvidia',      'qwen/qwen3-coder-480b-a35b-instruct'),
         ('mistral',     'mistral-small-latest'),
         ('mistral',     'ministral-8b-latest'),
         ('cohere',      'command-a-reasoning-08-2025'),
         ('cohere',      'command-r-08-2024'),
         ('ollama',      'qwen3-coder-next'),
         ('huggingface', 'deepseek-ai/DeepSeek-V4-Flash'),
         ('huggingface', 'moonshotai/Kimi-K2.6'),
         ('huggingface', 'Qwen/Qwen3-Coder-Next')
       )
    `);
    expect(additions).toHaveLength(15);
  });

  it('all enabled catalog platforms have a registered provider', async () => {
    const db = await freshDb();
    const { hasProvider } = await import('../../providers/index.js');
    const platforms = (await db.many<{ platform: any }>(
      'SELECT DISTINCT platform FROM models WHERE enabled = 1',
    )).map(r => r.platform);

    expect(platforms.filter(p => !hasProvider(p))).toEqual([]);
  });
});
