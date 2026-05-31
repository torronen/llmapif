import type { Request, Response, NextFunction } from 'express';

// The admin API (/api/*) is unauthenticated by design (single-user, local-first
// — see README). The primary protection is binding to loopback (BIND_HOST,
// default 127.0.0.1). This middleware is a second, code-level lock: it rejects
// any admin request whose TCP peer is not the local machine, so even an
// accidental BIND_HOST=0.0.0.0 (or being placed on a shared interface) does not
// expose key management to the network.
//
// We deliberately read the real socket peer (req.socket.remoteAddress), NOT
// X-Forwarded-For — that header is client-controlled and trivially spoofed.
// If you intentionally run behind a trusted reverse proxy that adds real auth,
// opt out with ADMIN_ALLOW_REMOTE=true.

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  // IPv4 loopback (127.0.0.0/8), IPv6 loopback (::1), and IPv4-mapped IPv6.
  return (
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.') ||
    addr.startsWith('::ffff:127.')
  );
}

export function localOnly(req: Request, res: Response, next: NextFunction): void {
  if (process.env.ADMIN_ALLOW_REMOTE === 'true') {
    next();
    return;
  }

  if (isLoopbackAddress(req.socket.remoteAddress)) {
    next();
    return;
  }

  res.status(403).json({
    error: {
      message:
        'The admin API is restricted to local (loopback) access. ' +
        'Set ADMIN_ALLOW_REMOTE=true only if you have placed your own authentication in front of the server.',
      type: 'forbidden',
    },
  });
}
