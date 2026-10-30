import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import net from 'net';

/**
 * Checks whether a given TCP port is open / available.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Finds an available port starting from preferredPort.
 */
async function findAvailablePort(preferredPort = 3000) {
  for (let port = preferredPort; port < preferredPort + 50; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find an available port starting from ${preferredPort}`);
}

/**
 * Cross-platform process tree termination.
 */
function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      execSync(`pkill -P ${pid} 2>/dev/null || true`, { stdio: 'ignore' });
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Process already terminated
  }
}

/**
 * Clean up disposable database files with retry for Windows file locks.
 */
function cleanupDisposableDb(dbPath) {
  const patterns = [
    dbPath,
    `${dbPath}-journal`,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
  ];

  for (const file of patterns) {
    if (fs.existsSync(file)) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.unlinkSync(file);
          break;
        } catch {
          // Brief backoff to allow OS to release file handle
          const end = Date.now() + 150;
          while (Date.now() < end) { /* busy wait */ }
        }
      }
    }
  }
}

async function main() {
  console.log('================================================================');
  console.log('  IncidentGraph AI: Isolated Browser E2E Environment Runner     ');
  console.log('================================================================');

  const cwd = process.cwd();
  const prismaDir = path.resolve(cwd, 'prisma');
  const devDbPath = path.resolve(prismaDir, 'dev.db');

  // Record dev.db pre-test stats if present
  let devDbBefore = null;
  if (fs.existsSync(devDbPath)) {
    const stat = fs.statSync(devDbPath);
    devDbBefore = { size: stat.size, mtime: stat.mtimeMs };
    console.log(`[Developer DB Guard] Detected dev.db (${stat.size} bytes, modified ${stat.mtime.toISOString()})`);
  }

  // 1. Check if an external server is already provided and isolated
  if (process.env.BASE_URL) {
    try {
      const res = await fetch(`${process.env.BASE_URL}/api/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'healthy' && data.database?.isIsolated) {
          console.log(`[Runner] Detected running isolated server at ${process.env.BASE_URL}`);
          console.log(`  Database Provider: ${data.database.provider}, Services: ${data.database.servicesCount}`);
          console.log('[Runner] Executing browser E2E test suite against existing isolated server...');

          const testProc = spawn('node', ['tests/browser-e2e.mjs'], {
            stdio: 'inherit',
            shell: true,
            env: { ...process.env, E2E_ISOLATED: '1' },
          });

          const code = await new Promise((resolve) => testProc.on('exit', resolve));
          process.exit(code ?? 1);
        }
      }
    } catch {
      // External server not running or not reachable; proceed to spawn dedicated isolated environment
    }
  }

  // 2. Generate unique disposable SQLite database
  const uniqueId = `e2e-isolated-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dbFileName = `${uniqueId}.db`;
  const dbFilePath = path.join(prismaDir, dbFileName);
  const databaseUrl = `file:./${dbFileName}`;

  console.log(`[Isolated DB] Creating temporary database: ${dbFileName}`);
  console.log(`  Target path: ${dbFilePath}`);
  console.log(`  Prisma URL:  ${databaseUrl}`);

  let serverProcess = null;
  let testExitCode = 1;

  try {
    // 3. Push schema to isolated database
    console.log('[Isolated DB] Applying Prisma schema (db push)...');
    execSync('npx prisma db push --skip-generate', {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });
    console.log('  ✓ Prisma schema successfully applied to disposable database');

    // 4. Seed isolated database with 7 services and dependencies
    console.log('[Isolated DB] Seeding base topology and dependencies...');
    execSync('npx tsx src/lib/db/seed.ts', {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });
    console.log('  ✓ Disposable database seeded (7 services, 8 dependencies, IDLE simulation state)');

    // 5. Select port and start production Next.js server
    const preferredPort = parseInt(process.env.PORT || '3000', 10);
    const targetPort = await findAvailablePort(preferredPort);
    const targetBaseUrl = `http://localhost:${targetPort}`;

    console.log(`[Next.js Server] Starting production server on port ${targetPort}...`);
    serverProcess = spawn('npx', ['next', 'start', '-p', String(targetPort)], {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(targetPort),
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'production',
        E2E_ISOLATED: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    });

    serverProcess.stdout?.on('data', (d) => {
      const msg = d.toString();
      if (process.env.DEBUG_SERVER) console.log(`[server stdout] ${msg.trim()}`);
    });
    serverProcess.stderr?.on('data', (d) => {
      const msg = d.toString();
      if (process.env.DEBUG_SERVER) console.error(`[server stderr] ${msg.trim()}`);
    });

    // 6. Wait for health check confirmation
    console.log(`[Health Polling] Waiting for server at ${targetBaseUrl}/api/health...`);
    let isHealthy = false;
    let lastError = null;

    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        const res = await fetch(`${targetBaseUrl}/api/health`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'healthy' && data.database?.servicesCount === 7) {
            console.log(`  ✓ Server is ready and healthy on attempt ${attempt} (${data.database.servicesCount} services, isolated=${data.database.isIsolated})`);
            isHealthy = true;
            break;
          }
        }
      } catch (err) {
        lastError = err.message;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!isHealthy) {
      throw new Error(`Production server failed to become healthy within 30s: ${lastError || 'Unknown timeout'}`);
    }

    // 7. Execute Browser E2E Test Suite
    console.log(`\n[Browser E2E] Launching browser test runner against ${targetBaseUrl}...`);
    const testProc = spawn('node', ['tests/browser-e2e.mjs'], {
      cwd,
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        BASE_URL: targetBaseUrl,
        PORT: String(targetPort),
        E2E_ISOLATED: '1',
      },
    });

    testExitCode = await new Promise((resolve) => {
      testProc.on('exit', (code) => resolve(code ?? 1));
      testProc.on('error', (err) => {
        console.error('Failed to spawn browser-e2e.mjs:', err);
        resolve(1);
      });
    });

  } finally {
    // 8. Stop the server and kill all child processes
    if (serverProcess && serverProcess.pid) {
      console.log(`\n[Cleanup] Shutting down Next.js server (PID: ${serverProcess.pid})...`);
      killProcessTree(serverProcess.pid);
      await new Promise((r) => setTimeout(r, 600));
    }

    // 9. Clean up temporary database files
    console.log(`[Cleanup] Removing disposable database: ${dbFileName}`);
    cleanupDisposableDb(dbFilePath);

    if (!fs.existsSync(dbFilePath)) {
      console.log(`  ✓ Disposable database ${dbFileName} successfully deleted.`);
    } else {
      console.warn(`  ⚠️ Warning: disposable database file still exists at ${dbFilePath}`);
    }

    // 10. Verify developer database remained untouched
    if (devDbBefore && fs.existsSync(devDbPath)) {
      const statAfter = fs.statSync(devDbPath);
      if (statAfter.size === devDbBefore.size && statAfter.mtimeMs === devDbBefore.mtime) {
        console.log('  ✓ Developer database (prisma/dev.db) verified 100% UNTOUCHED (size & timestamp identical)');
      } else {
        console.warn('  ⚠️ Developer database stat changed during test execution!');
      }
    }

    console.log(`[Runner Completed] Exit code: ${testExitCode}\n`);
    process.exit(testExitCode);
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal error in isolated browser runner:', err);
  process.exit(1);
});
