import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminServer } from './server.js';
import { getDatabase, runMigrations, ensureDatabaseInitialized } from '@youpi/db';

export function startAdminServer(port = null, options = {}) {
  // 1. Yahan process.env.PORT ko sabse pehle priority dein
  const finalPort = port || Number(process.env.PORT || process.env.MERCHANT_ADMIN_PORT || 6001);
  const db = options.db || getDatabase();
  ensureDatabaseInitialized(db);
  runMigrations(db);

  const adminServer = new AdminServer({ db, ...options });
  const rawServer = adminServer.createServer();

  // 2. Render ke liye '0.0.0.0' bind host use karna zaroori hai taaki external traffic connect ho sake
  const bindHost = process.env.YOUPI_BIND_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

  return new Promise(resolve => {
    const instance = rawServer.listen(finalPort, bindHost, () => {
      console.log(`[Merchant Admin] Server listening on port ${finalPort} on host ${bindHost}`);
      resolve({
        port: finalPort,
        close: () => new Promise(cb => instance.close(cb))
      });
    });
  });
}

// Auto-run if executed directly as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startAdminServer();
}
