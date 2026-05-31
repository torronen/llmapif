import type { Request, Response, NextFunction } from 'express';

// Per-IP brute-force protection for the admin login. In-memory and dependency-
// free, in the spirit of the cooldown maps in services/ratelimit.ts. Keyed by
// the real socket peer (like middleware/localOnly.ts) — never X-Forwarded-For,
// which is client-controlled and spoofable.

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

const attempts = new Map<string, { count: number; windowStartMs: number }>();

function ipOf(req: Request): string {
  return req.socket.remoteAddress ?? 'unknown';
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = ipOf(req);
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || now - entry.windowStartMs > WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStartMs: now });
    next();
    return;
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((entry.windowStartMs + WINDOW_MS - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: {
        message: `Too many login attempts. Try again in ${retryAfter}s.`,
        type: 'rate_limit_error',
      },
    });
    return;
  }

  entry.count++;
  next();
}

/** Clear an IP's counter after a non-failed login (success or auth disabled). */
export function resetLoginAttempts(req: Request): void {
  attempts.delete(ipOf(req));
}

/** Test helper: wipe all recorded attempts. */
export function clearAllLoginAttempts(): void {
  attempts.clear();
}
