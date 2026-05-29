import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction) {
  console.error('[Error]', err.stack ?? err.message);

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;

  // 4xx are deliberate (validation / client errors) — their messages are safe
  // to return. 5xx are unexpected server faults; echoing the raw message can
  // leak internals (file paths, query fragments, upstream detail), so send a
  // generic message and keep the detail in the server log above.
  const message = status < 500 ? err.message : 'Internal server error';

  res.status(status).json({
    error: {
      message,
      type: err.name ?? 'server_error',
    },
  });
}
