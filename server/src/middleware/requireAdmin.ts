import type { Request, Response, NextFunction } from 'express';
import { isAdminAuthEnabled, verifyToken } from '../lib/adminAuth.js';

// Guards admin (/api/*) routes with the admin session token. When ADMIN_PASSWORD
// is unset this is a no-op, so existing local-first setups are unaffected. The
// auth endpoints (/api/auth/*) and the health ping are mounted before this guard
// so they remain reachable without a token.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminAuthEnabled()) {
    next();
    return;
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (verifyToken(token)) {
    next();
    return;
  }

  res.status(401).json({
    error: {
      message: 'Admin authentication required. Log in with your ADMIN_PASSWORD.',
      type: 'authentication_error',
    },
  });
}
