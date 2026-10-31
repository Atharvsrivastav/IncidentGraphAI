import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import net from 'net';

/**
 * Computes SHA-256 hash of a file if it exists.
 */
function computeFileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

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
 * Checks if a process with given PID is still alive.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // If EPERM, process exists; if ESRCH, process is dead
  }
}

/**
 * Cross-platform process tree termination and verification.
 */
async function killProcessTree(pid, port) {
  if (!pid) return true;
  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // May already be stopped
      }
    } else {
      // On POSIX, terminate the dedicated process group (-pid), fallback to direct kill
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Process group already dead
        }
      }
      try {
        execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`, { stdio: 'ignore' });
      } catch {
        // Ignored
      }
    }
  } catch {
    // Signal errors ignored
  }

  // Verify process has actually stopped
  let stopped = false;
  for (let i = 0; i < 20; i++) {
    let alive = false;
    try {
      alive = isProcessAlive(pid);
    } catch {
      alive = false;
    }

    if (!alive) {
      stopped = true;
      break;
    }

    // Escalate to SIGKILL if still alive after initial wait
    if (i >= 5) {
      if (isWindows) {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        try { execSync(`pkill -KILL -P ${pid} 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
      }
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  // Also verify port is released
  let portReleased = false;
  if (port) {
    for (let i = 0; i < 15; i++) {
      if (await isPortAvailable(port)) {
        portReleased = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } else {
    portReleased = true;
  }

  return stopped && portReleased;
}

/**
 * Clean up disposable database files with retry for file locks.
 * Returns an array of any files that could NOT be deleted.
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
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          fs.unlinkSync(file);
          break;
        } catch {
          const end = Date.now() + 150;
          while (Date.now() < end) { /* busy wait */ }
        }
      }
    }
  }

  // Return any surviving artifacts
  return patterns.filter((f) => fs.existsSync(f));
}

async function main() {
  console.log('================================================================');
  console.log('  IncidentGraph AI: Isolated Browser E2E Environment Runner     ');
  console.log('================================================================');

  const cwd = process.cwd();
  const prismaDir = path.resolve(cwd, 'prisma');
  const devDbPath = path.resolve(prismaDir, 'dev.db');

  // 1. Record developer DB baseline stats and SHA-256 hash if present
  let devDbBefore = null;
  if (fs.existsSync(devDbPath)) {
    const stat = fs.statSync(devDbPath);
    const hash = computeFileHash(devDbPath);
    devDbBefore = { size: stat.size, mtime: stat.mtimeMs, hash };
    console.log(`[Developer DB Guard] Recorded baseline: size=${stat.size} bytes, modified=${stat.mtime.toISOString()}`);
    console.log(`  SHA-256: ${hash}`);
  }

  // 2. If BASE_URL is externally supplied, strictly verify or reject
  if (process.env.BASE_URL) {
    let healthData = null;
    try {
      const res = await fetch(`${process.env.BASE_URL}/api/health`);
      if (res.ok) {
        healthData = await res.json();
      }
    } catch (err) {
      console.error(`❌ [External Server Rejection] Cannot connect to supplied BASE_URL at ${process.env.BASE_URL}/api/health: ${err.message}`);
      process.exit(1);
    }

    if (!healthData || healthData.status !== 'healthy' || !healthData.database?.isIsolated) {
      console.error(
        `❌ [External Server Rejection] Target BASE_URL (${process.env.BASE_URL}) is not a verified isolated server.\n` +
        `  Reported status: ${healthData?.status || 'unreachable'}\n` +
        `  isIsolated:      ${Boolean(healthData?.database?.isIsolated)}\n` +
        `  Services count:  ${healthData?.database?.servicesCount ?? 'unknown'}\n` +
        `Destructive automated browser testing against unverified or non-isolated servers is prohibited.`
      );
      process.exit(1);
    }

    console.log(`[Runner] Detected verified isolated server at ${process.env.BASE_URL}`);
    console.log(`  Database Provider: ${healthData.database.provider}, Services: ${healthData.database.servicesCount}, isIsolated: true`);
    console.log('[Runner] Executing browser E2E test suite against existing isolated server...');

    const testProc = spawn('node', ['tests/browser-e2e.mjs'], {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, E2E_ISOLATED: '1' },
    });

    const code = await new Promise((resolve) => testProc.on('exit', resolve));
    process.exit(code ?? 1);
  }

  // 3. Generate unique disposable SQLite database adhering to strict naming convention: e2e-isolated-*
  const uniqueId = `e2e-isolated-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const dbFileName = `${uniqueId}.db`;
  const dbFilePath = path.join(prismaDir, dbFileName);
  const databaseUrl = `file:./${dbFileName}`;

  console.log(`[Isolated DB] Creating temporary database: ${dbFileName}`);
  console.log(`  Target path: ${dbFilePath}`);
  console.log(`  Prisma URL:  ${databaseUrl}`);

  let serverProcess = null;
  let targetPort = null;
  let testExitCode = 1;

  // Setup signal handlers for interrupted execution
  const handleSignal = async (signal) => {
    console.log(`\n[Runner] Received ${signal}. Forcing graceful cleanup...`);
    if (serverProcess?.pid) {
      await killProcessTree(serverProcess.pid, targetPort);
    }
    cleanupDisposableDb(dbFilePath);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  try {
    // 4. Push schema to isolated database
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

    // 5. Seed isolated database with 7 services and dependencies
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

    // 6. Select port and start production Next.js server
    const preferredPort = parseInt(process.env.PORT || '3000', 10);
    targetPort = await findAvailablePort(preferredPort);
    const targetBaseUrl = `http://localhost:${targetPort}`;

    const isWindows = process.platform === 'win32';
    console.log(`[Next.js Server] Starting production server on port ${targetPort}...`);
    serverProcess = spawn('npx', ['next', 'start', '-p', String(targetPort)], {
      cwd,
      shell: true,
      detached: !isWindows, // Creates dedicated process group on POSIX
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

    serverProcess.on('error', (err) => {
      console.error('❌ [Next.js Server Process Error]:', err);
    });

    serverProcess.stdout?.on('data', (d) => {
      const msg = d.toString();
      if (process.env.DEBUG_SERVER) console.log(`[server stdout] ${msg.trim()}`);
    });
    serverProcess.stderr?.on('data', (d) => {
      const msg = d.toString();
      if (process.env.DEBUG_SERVER) console.error(`[server stderr] ${msg.trim()}`);
    });

    // 7. Wait for health check confirmation with strict isolation verification
    console.log(`[Health Polling] Waiting for server at ${targetBaseUrl}/api/health...`);
    let isHealthy = false;
    let lastError = null;

    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        const res = await fetch(`${targetBaseUrl}/api/health`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'healthy' && data.database?.servicesCount === 7 && data.database?.isIsolated) {
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
      throw new Error(`Production server failed to become healthy and isolated within 30s: ${lastError || 'Unknown timeout'}`);
    }

    // 8. Execute Browser E2E Test Suite
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
    // 9. Stop the server and verify process termination and port release
    if (serverProcess && serverProcess.pid) {
      console.log(`\n[Cleanup] Shutting down Next.js server (PID: ${serverProcess.pid}, Port: ${targetPort})...`);
      const killedCleanly = await killProcessTree(serverProcess.pid, targetPort);
      if (killedCleanly) {
        console.log(`  ✓ Next.js server process tree (PID: ${serverProcess.pid}) and port ${targetPort} verified cleanly stopped.`);
      } else {
        console.error(`❌ [Server Cleanup Failure] Next.js server or child processes may still be running (PID: ${serverProcess.pid})!`);
        if (testExitCode === 0) testExitCode = 1;
      }
    }

    // 10. Clean up temporary database files and make any remaining file fatal
    console.log(`[Cleanup] Removing disposable database: ${dbFileName}`);
    const remainingFiles = cleanupDisposableDb(dbFilePath);

    if (remainingFiles.length === 0) {
      console.log(`  ✓ Disposable database ${dbFileName} and all journal/WAL/SHM artifacts successfully deleted.`);
    } else {
      console.error(
        `❌ [Fatal Cleanup Failure] Disposable database artifacts remain after cleanup retries:\n` +
        `  ${remainingFiles.join('\n  ')}\n` +
        `Failing test runner due to database cleanup invariant violation.`
      );
      if (testExitCode === 0) {
        testExitCode = 1;
      }
    }

    // 11. Verify developer database remained 100% untouched (hash, size, mtime)
    if (devDbBefore) {
      if (!fs.existsSync(devDbPath)) {
        console.error('❌ [Developer DB Integrity Violation] dev.db was deleted during test execution!');
        if (testExitCode === 0) testExitCode = 1;
      } else {
        const statAfter = fs.statSync(devDbPath);
        const hashAfter = computeFileHash(devDbPath);
        let violation = false;

        if (hashAfter !== devDbBefore.hash) {
          console.error(`❌ [Developer DB Integrity Violation] dev.db SHA-256 hash changed!\n  Before: ${devDbBefore.hash}\n  After:  ${hashAfter}`);
          violation = true;
        }
        if (statAfter.size !== devDbBefore.size) {
          console.error(`❌ [Developer DB Integrity Violation] dev.db file size changed!\n  Before: ${devDbBefore.size} bytes\n  After:  ${statAfter.size} bytes`);
          violation = true;
        }
        if (statAfter.mtimeMs !== devDbBefore.mtime) {
          console.error(`❌ [Developer DB Integrity Violation] dev.db modification timestamp changed!\n  Before: ${devDbBefore.mtime}\n  After:  ${statAfter.mtimeMs}`);
          violation = true;
        }

        if (violation) {
          console.error('❌ Developer database was modified during testing. Failing runner.');
          if (testExitCode === 0) testExitCode = 1;
        } else {
          console.log(`  ✓ Developer database (prisma/dev.db) verified 100% UNTOUCHED (hash: ${hashAfter})`);
        }
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
