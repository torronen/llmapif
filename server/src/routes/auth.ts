import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isAdminAuthEnabled, verifyPassword, issueToken } from '../lib/adminAuth.js';
import { loginRateLimit, resetLoginAttempts } from '../middleware/loginRateLimit.js';

export const authRouter = Router();

// Lets the dashboard decide whether to show a login screen. Never requires auth.
authRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ authRequired: isAdminAuthEnabled() });
});

const loginSchema = z.object({ password: z.string().min(1) });

authRouter.post('/login', loginRateLimit, (req: Request, res: Response) => {
  if (!isAdminAuthEnabled()) {
    // Auth disabled — nothing to log into. Tell the client so it can proceed.
    resetLoginAttempts(req);
    res.json({ token: null, authRequired: false });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'password is required', type: 'invalid_request_error' } });
    return;
  }

  if (!verifyPassword(parsed.data.password)) {
    res.status(401).json({ error: { message: 'Invalid password', type: 'authentication_error' } });
    return;
  }

  // Successful login — clear this IP's failed-attempt counter.
  resetLoginAttempts(req);
  res.json({ token: issueToken(), authRequired: true });
});
