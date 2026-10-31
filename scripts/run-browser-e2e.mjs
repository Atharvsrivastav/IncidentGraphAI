import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import net from 'net';

const DISPOSABLE_DB_REGEX = /^e2e-(?:isolated|ci)-[a-zA-Z0-9_\-]+-[a-f0-9]{4,32}\.db$/i;
const DB_SIDECAR_EXTENSIONS = ['', '-journal', '-wal', '-shm'];

/**
 * Computes SHA-256 hash of a file if it exists.
 */
function computeFileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Checks whether a given TCP port is available on localhost.
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
 * Checks if a process with given PID is alive.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // If EPERM, process exists and is alive
  }
}

/**
 * Checks if any process in the process group is alive (POSIX).
 */
function isProcessGroupAlive(pid) {
  if (process.platform === 'win32') {
    return isProcessAlive(pid);
  }
  try {
    const out = execSync(`pgrep -g ${pid} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (out.length > 0) return true;
  } catch {
    // Fall back to PID check
  }
  return isProcessAlive(pid);
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
      // On POSIX, terminate the process group (-pid), falling back to PID
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      try {
        execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`, { stdio: 'ignore' });
      } catch {}
    }
  } catch {
    // Ignore initial signal failures
  }

  // Verify process group and leader have actually terminated
  let stopped = false;
  for (let i = 0; i < 20; i++) {
    const groupAlive = isProcessGroupAlive(pid);
    if (!groupAlive) {
      stopped = true;
      break;
    }

    // Escalate to SIGKILL after bounded grace period (500ms)
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

    await new Promise((r) => setTimeout(r, 100));
  }

  // Also verify port is released
  let portReleased = false;
  if (port) {
    for (let i = 0; i < 15; i++) {
      if (await isPortAvailable(port)) {
        portReleased = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
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
  const patterns = DB_SIDECAR_EXTENSIONS.map((ext) => `${dbPath}${ext}`);

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

/**
 * Records baseline state of developer database and its sidecars.
 */
function recordDevDbBaseline(prismaDir, baseDbName = 'dev.db') {
  const baseline = {};
  for (const ext of DB_SIDECAR_EXTENSIONS) {
    const fileName = `${baseDbName}${ext}`;
    const fullPath = path.join(prismaDir, fileName);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      const hash = computeFileHash(fullPath);
      baseline[fileName] = {
        exists: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash,
      };
    } else {
      baseline[fileName] = {
        exists: false,
        size: 0,
        mtimeMs: 0,
        hash: null,
      };
    }
  }
  return baseline;
}

/**
 * Verifies developer database and all sidecars against baseline.
 * Returns array of detected integrity violations.
 */
function verifyDevDbIntegrity(prismaDir, baseline, baseDbName = 'dev.db') {
  const violations = [];

  for (const ext of DB_SIDECAR_EXTENSIONS) {
    const fileName = `${baseDbName}${ext}`;
    const fullPath = path.join(prismaDir, fileName);
    const existsNow = fs.existsSync(fullPath);
    const base = baseline[fileName] || { exists: false, size: 0, mtimeMs: 0, hash: null };

    if (!base.exists && existsNow) {
      violations.push(
        `Artifact '${fileName}' did not exist before test, but was created during test execution.`
      );
      continue;
    }

    if (base.exists && !existsNow) {
      violations.push(
        `Artifact '${fileName}' existed before test, but was deleted during test execution.`
      );
      continue;
    }

    if (base.exists && existsNow) {
      const statNow = fs.statSync(fullPath);
      const hashNow = computeFileHash(fullPath);

      if (statNow.size !== base.size) {
        violations.push(
          `Artifact '${fileName}' file size changed! Before: ${base.size} bytes, After: ${statNow.size} bytes.`
        );
      }
      if (statNow.mtimeMs !== base.mtimeMs) {
        violations.push(
          `Artifact '${fileName}' modification time changed! Before: ${base.mtimeMs}, After: ${statNow.mtimeMs}.`
        );
      }
      if (hashNow !== base.hash) {
        violations.push(
          `Artifact '${fileName}' SHA-256 hash changed! Before: ${base.hash}, After: ${hashNow}.`
        );
      }
    }
  }

  return violations;
}

// Global lifecycle references for teardown
let serverProcess = null;
let targetPort = null;
let dbFilePath = null;
let dbFileName = null;
let prismaDir = null;
let devDbBaseline = null;
let testExitCode = 1;

let teardownRunning = false;
let teardownCompleted = false;

/**
 * Idempotent, centralized teardown function executed on all exit paths.
 */
async function performTeardown({ exitCode = 0, signal = null, error = null } = {}) {
  if (teardownCompleted) {
    return testExitCode;
  }
  if (teardownRunning) {
    while (teardownRunning) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return testExitCode;
  }
  teardownRunning = true;

  try {
    if (error) {
      console.error('\n❌ Error encountered during runner execution:', error);
      if (testExitCode === 0) testExitCode = 1;
    }

    if (signal) {
      console.log(`\n[Runner] Handling signal ${signal}...`);
      const signalCode = signal === 'SIGINT' ? 130 : 143;
      if (testExitCode === 0) testExitCode = signalCode;
    } else if (exitCode !== 0 && testExitCode === 0) {
      testExitCode = exitCode;
    }

    // 1. Process tree / group shutdown and port release
    if (serverProcess && serverProcess.pid) {
      console.log(`\n[Cleanup] Shutting down Next.js server (PID: ${serverProcess.pid}, Port: ${targetPort})...`);
      const killedCleanly = await killProcessTree(serverProcess.pid, targetPort);
      if (killedCleanly) {
        console.log(`  ✓ Next.js server process tree (PID: ${serverProcess.pid}) and port ${targetPort} verified cleanly stopped.`);
      } else {
        console.error(`❌ [Server Cleanup Failure] Next.js server or child processes may still be running (PID: ${serverProcess.pid})!`);
        testExitCode = testExitCode !== 0 ? testExitCode : 1;
      }
    }

    // 2. Disposable database and sidecar cleanup (fatal if leftover)
    if (dbFilePath) {
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
        testExitCode = testExitCode !== 0 ? testExitCode : 1;
      }
    }

    // 3. Developer database and sidecar integrity check (fatal if violated)
    if (devDbBaseline && prismaDir) {
      const violations = verifyDevDbIntegrity(prismaDir, devDbBaseline, 'dev.db');
      if (violations.length > 0) {
        console.error(`❌ [Developer DB Integrity Violation] Integrity checks failed:\n  ${violations.join('\n  ')}`);
        testExitCode = testExitCode !== 0 ? testExitCode : 1;
      } else {
        console.log(`  ✓ Developer database and all sidecars (prisma/dev.db*) verified 100% UNTOUCHED`);
      }
    }
  } finally {
    teardownCompleted = true;
    teardownRunning = false;
  }

  return testExitCode;
}

// Bind process signals to the centralized teardown
process.on('SIGINT', async () => {
  await performTeardown({ signal: 'SIGINT' });
  process.exit(testExitCode);
});

process.on('SIGTERM', async () => {
  await performTeardown({ signal: 'SIGTERM' });
  process.exit(testExitCode);
});

async function main() {
  console.log('================================================================');
  console.log('  IncidentGraph AI: Isolated Browser E2E Environment Runner     ');
  console.log('================================================================');

  const cwd = process.cwd();
  prismaDir = path.resolve(cwd, 'prisma');

  // 1. External BASE_URL rejection: fail closed. The runner must own its database and server.
  if (process.env.BASE_URL) {
    console.error(
      '❌ [External Server Rejection] Automated browser runner requires an owned, disposable database and server.\n' +
      'External BASE_URL server reuse is not permitted. Please unset BASE_URL to let the runner manage its environment.'
    );
    process.exit(1);
  }

  // 2. Record developer DB baseline stats and SHA-256 hash for dev.db and all sidecars
  devDbBaseline = recordDevDbBaseline(prismaDir, 'dev.db');
  console.log('[Developer DB Guard] Recorded baseline for dev.db and sidecars:');
  for (const [name, rec] of Object.entries(devDbBaseline)) {
    if (rec.exists) {
      console.log(`  - ${name}: size=${rec.size} bytes, modified=${new Date(rec.mtimeMs).toISOString()}, sha256=${rec.hash}`);
    } else {
      console.log(`  - ${name}: (absent)`);
    }
  }

  // 3. Generate unique disposable SQLite database adhering to strict naming convention: e2e-isolated-<runId>-<nonce>.db
  const uniqueId = `e2e-isolated-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  dbFileName = `${uniqueId}.db`;
  dbFilePath = path.join(prismaDir, dbFileName);
  const databaseUrl = `file:./${dbFileName}`;

  if (!DISPOSABLE_DB_REGEX.test(dbFileName)) {
    throw new Error(`Generated database name '${dbFileName}' failed format check against ${DISPOSABLE_DB_REGEX}`);
  }

  console.log(`[Isolated DB] Creating temporary database exclusively: ${dbFileName}`);
  console.log(`  Target path: ${dbFilePath}`);
  console.log(`  Prisma URL:  ${databaseUrl}`);

  // Create file exclusively to ensure no pre-existing file is reused
  try {
    const fd = fs.openSync(dbFilePath, 'wx');
    fs.closeSync(fd);
  } catch (err) {
    throw new Error(`Failed to exclusively create disposable database file: ${err.message}`);
  }

  try {
    // 4. Apply Prisma schema to isolated database
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

  } catch (err) {
    await performTeardown({ error: err });
    process.exit(testExitCode !== 0 ? testExitCode : 1);
  } finally {
    const finalCode = await performTeardown({ exitCode: testExitCode });
    console.log(`[Runner Completed] Exit code: ${finalCode}\n`);
    process.exit(finalCode);
  }
}

main().catch(async (err) => {
  await performTeardown({ error: err });
  process.exit(testExitCode !== 0 ? testExitCode : 1);
});
