import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { localOnly } from '../../middleware/localOnly.js';

function mockReqRes(remoteAddress: string | undefined) {
  const req = { socket: { remoteAddress } } as unknown as Request;
  const res = {
    statusCode: 200,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
  } as unknown as Response & { statusCode: number; body: any };
  const next = vi.fn();
  return { req, res, next };
}

describe('localOnly middleware', () => {
  const original = process.env.ADMIN_ALLOW_REMOTE;
  beforeEach(async () => { delete process.env.ADMIN_ALLOW_REMOTE; });
  afterEach(async () => {
    if (original === undefined) delete process.env.ADMIN_ALLOW_REMOTE;
    else process.env.ADMIN_ALLOW_REMOTE = original;
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.5'])(
    'allows loopback peer %s',
    (addr) => {
      const { req, res, next } = mockReqRes(addr);
      localOnly(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect((res as any).statusCode).toBe(200);
    },
  );

  it.each(['192.168.1.50', '10.0.0.4', '::ffff:8.8.8.8', undefined])(
    'rejects non-loopback peer %s with 403',
    (addr) => {
      const { req, res, next } = mockReqRes(addr);
      localOnly(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect((res as any).statusCode).toBe(403);
      expect((res as any).body.error.type).toBe('forbidden');
    },
  );

  it('lets remote peers through when ADMIN_ALLOW_REMOTE=true', async () => {
    process.env.ADMIN_ALLOW_REMOTE = 'true';
    const { req, res, next } = mockReqRes('192.168.1.50');
    localOnly(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
