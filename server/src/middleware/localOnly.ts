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

function isTailscaleAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let ip = addr;
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  // Tailscale IPv4 CGNAT (100.64.0.0/10)
  const parts = ip.split('.');
  if (parts.length === 4 && parts[0] === '100') {
    const second = parseInt(parts[1], 10);
    if (!isNaN(second) && second >= 64 && second <= 127) {
      return true;
    }
  }
  // Tailscale IPv6 ULA (fd7a:115c:a1e0::/48)
  if (ip.toLowerCase().startsWith('fd7a:115c:a1e0:')) {
    return true;
  }
  return false;
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

  if (process.env.ADMIN_ALLOW_TAILSCALE === 'true' && isTailscaleAddress(req.socket.remoteAddress)) {
    next();
    return;
  }

  res.status(403).json({
    error: {
      message:
        'The admin API is restricted to local (loopback) access. ' +
        'Set ADMIN_ALLOW_REMOTE=true or ADMIN_ALLOW_TAILSCALE=true if you wish to expose it over the network (requires ADMIN_PASSWORD).',
      type: 'forbidden',
    },
  });
}
