import crypto from 'crypto';

// Single-user admin authentication. The password is read from the ADMIN_PASSWORD
// env var; when it is unset/empty, admin auth is disabled and the loopback guard
// (middleware/localOnly.ts) is the only protection — preserving the original
// local-first behaviour for users who don't opt in.
//
// Sessions are stateless: a token is "<iat>.<HMAC-SHA256(iat)>" signed with the
// admin password as the key. This means tokens survive a server restart (no
// in-memory session store) and changing ADMIN_PASSWORD invalidates every
// existing token at once — a built-in "log out everywhere".

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function adminPassword(): string | undefined {
  const pw = process.env.ADMIN_PASSWORD;
  return pw && pw.length > 0 ? pw : undefined;
}

export function isAdminAuthEnabled(): boolean {
  return adminPassword() !== undefined;
}

/** Constant-time password comparison (hash both, then compare fixed-length digests). */
export function verifyPassword(provided: string): boolean {
  const expected = adminPassword();
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueToken(nowMs: number = Date.now()): string {
  const secret = adminPassword();
  if (!secret) throw new Error('Admin auth is not enabled');
  const iat = String(nowMs);
  return `${iat}.${sign(iat, secret)}`;
}

/**
 * Refuse the one unsafe combination: opening the admin API to the network
 * (ADMIN_ALLOW_REMOTE=true, which disables the loopback guard) while no admin
 * password is set, which would leave key management fully unprotected. Throws
 * with an actionable message; callers should let it abort startup.
 */
export function assertRemoteAccessIsSafe(): void {
  if (process.env.ADMIN_ALLOW_REMOTE === 'true' && !isAdminAuthEnabled()) {
    throw new Error(
      'ADMIN_ALLOW_REMOTE=true exposes the admin API to the network, but ADMIN_PASSWORD is not set. ' +
      'Set ADMIN_PASSWORD to a strong value, or remove ADMIN_ALLOW_REMOTE to keep the admin API loopback-only.',
    );
  }
  if (process.env.ADMIN_ALLOW_TAILSCALE === 'true' && !isAdminAuthEnabled()) {
    throw new Error(
      'ADMIN_ALLOW_TAILSCALE=true exposes the admin API to Tailscale users, but ADMIN_PASSWORD is not set. ' +
      'Set ADMIN_PASSWORD to a strong value, or remove ADMIN_ALLOW_TAILSCALE.',
    );
  }
}

export function verifyToken(token: string | undefined, nowMs: number = Date.now()): boolean {
  const secret = adminPassword();
  if (!secret || !token) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const iat = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(iat, secret);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  const iatNum = Number(iat);
  if (!Number.isFinite(iatNum)) return false;
  if (nowMs - iatNum > TOKEN_TTL_MS) return false; // expired
  if (iatNum - nowMs > 60_000) return false;        // issued implausibly far in the future
  return true;
}
