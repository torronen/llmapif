import './env.js';
import { createApp } from './app.js';
import { initDb, getDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { assertRemoteAccessIsSafe, isAdminAuthEnabled } from './lib/adminAuth.js';
import http from 'http';

const PORT = process.env.PORT ?? 3001;
// Bind to loopback by default. The admin API (/api/*) is unauthenticated by
// design (single-user, local-first — see README), so exposing it on all
// interfaces would let anyone on the network read/regenerate the unified key
// and manage provider keys. Set BIND_HOST=0.0.0.0 only behind a trusted
// reverse proxy or network isolation.
const HOST = process.env.BIND_HOST ?? '127.0.0.1';

async function main() {
  // Fail fast on an unsafe network/auth combination before doing any work.
  assertRemoteAccessIsSafe();

  initDb();
  const app = createApp();

  const server = http.createServer(app);

  server.listen(Number(PORT), HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`Proxy endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
    if (isAdminAuthEnabled()) {
      console.log('Admin API: password authentication enabled (ADMIN_PASSWORD set).');
    } else if (HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost') {
      console.log('Admin API: loopback-only (no ADMIN_PASSWORD set). Local access is unauthenticated.');
    } else {
      console.warn(`Admin API: bound to ${HOST} with no ADMIN_PASSWORD — protected only by the loopback guard. Set ADMIN_PASSWORD before allowing remote access.`);
    }
    startHealthChecker();
  });

  const shutdown = () => {
    console.log('Shutting down server...');
    server.close(() => {
      console.log('HTTP server closed.');
      try {
        getDb().close();
        console.log('Database connection closed.');
      } catch (err) {
        console.error('Error closing database:', err);
      }
      process.exit(0);
    });

    // Force close after 10s if connections are hanging
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
