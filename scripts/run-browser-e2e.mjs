import { spawn, execSync } from 'child_process';
import {
  findAvailablePort,
  recordDevDbBaseline,
  createExclusiveDatabase,
  RunnerLifecycle,
} from './runner-core.mjs';

const runner = new RunnerLifecycle();

// Bind signal handlers to the runner's teardown orchestration
process.on('SIGINT', async () => {
  const code = await runner.performTeardown({ signal: 'SIGINT' });
  process.exit(code);
});

process.on('SIGTERM', async () => {
  const code = await runner.performTeardown({ signal: 'SIGTERM' });
  process.exit(code);
});

async function main() {
  console.log('================================================================');
  console.log('  IncidentGraph AI: Isolated Browser E2E Environment Runner     ');
  console.log('================================================================');

  // 1. External BASE_URL rejection: fail closed. The runner must own its database and server.
  if (process.env.BASE_URL) {
    console.error(
      '❌ [External Server Rejection] Automated browser runner requires an owned, disposable database and server.\n' +
      'External BASE_URL server reuse is not permitted. Please unset BASE_URL to let the runner manage its environment.'
    );
    process.exit(1);
  }

  // 2. Record developer DB baseline stats and SHA-256 hash for dev.db and all sidecars
  runner.devDbBaseline = recordDevDbBaseline(runner.prismaDir, 'dev.db');
  console.log('[Developer DB Guard] Recorded baseline for dev.db and sidecars:');
  for (const [name, rec] of Object.entries(runner.devDbBaseline)) {
    if (rec.exists) {
      console.log(`  - ${name}: size=${rec.size} bytes, modified=${new Date(rec.mtimeMs).toISOString()}, sha256=${rec.hash}`);
    } else {
      console.log(`  - ${name}: (absent)`);
    }
  }

  // 3. Exclusively create temporary database (ownership is granted ONLY upon success)
  const dbInfo = createExclusiveDatabase(runner.prismaDir);
  runner.dbFileName = dbInfo.dbFileName;
  runner.dbFilePath = dbInfo.dbFilePath;
  runner.databaseUrl = dbInfo.databaseUrl;
  runner.dbFileOwned = dbInfo.dbFileOwned;

  console.log(`[Isolated DB] Creating temporary database exclusively: ${runner.dbFileName}`);
  console.log(`  Target path: ${runner.dbFilePath}`);
  console.log(`  Prisma URL:  ${runner.databaseUrl}`);

  runner.state = 'STARTING';

  // 4. Apply Prisma schema to isolated database
  console.log('[Isolated DB] Applying Prisma schema (db push)...');
  execSync('npx prisma db push --skip-generate', {
    cwd: runner.cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      DATABASE_URL: runner.databaseUrl,
    },
  });
  console.log('  ✓ Prisma schema successfully applied to disposable database');

  // 5. Seed isolated database with 7 services and dependencies
  console.log('[Isolated DB] Seeding base topology and dependencies...');
  execSync('npx tsx src/lib/db/seed.ts', {
    cwd: runner.cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      DATABASE_URL: runner.databaseUrl,
    },
  });
  console.log('  ✓ Disposable database seeded (7 services, 8 dependencies, IDLE simulation state)');

  // 6. Select port and start production Next.js server
  const preferredPort = parseInt(process.env.PORT || '3000', 10);
  runner.targetPort = await findAvailablePort(preferredPort);
  const targetBaseUrl = `http://localhost:${runner.targetPort}`;

  const isWindows = process.platform === 'win32';
  console.log(`[Next.js Server] Starting production server on port ${runner.targetPort}...`);
  runner.serverProcess = spawn('npx', ['next', 'start', '-p', String(runner.targetPort)], {
    cwd: runner.cwd,
    shell: true,
    detached: !isWindows, // Creates dedicated process group on POSIX
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(runner.targetPort),
      DATABASE_URL: runner.databaseUrl,
      NODE_ENV: 'production',
      E2E_ISOLATED: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });

  runner.serverProcess.on('error', (err) => {
    console.error('❌ [Next.js Server Process Error]:', err);
  });

  runner.serverProcess.stdout?.on('data', (d) => {
    const msg = d.toString();
    if (process.env.DEBUG_SERVER) console.log(`[server stdout] ${msg.trim()}`);
  });
  runner.serverProcess.stderr?.on('data', (d) => {
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

  // 8. Execute Browser E2E Test Suite and track browser child process globally
  runner.state = 'TESTING';
  console.log(`\n[Browser E2E] Launching browser test runner against ${targetBaseUrl}...`);
  runner.browserTestProcess = spawn('node', ['tests/browser-e2e.mjs'], {
    cwd: runner.cwd,
    shell: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      BASE_URL: targetBaseUrl,
      PORT: String(runner.targetPort),
      E2E_ISOLATED: '1',
    },
  });

  const testCode = await new Promise((resolve) => {
    runner.browserTestProcess.on('exit', (code) => resolve(code ?? 1));
    runner.browserTestProcess.on('error', (err) => {
      console.error('Failed to spawn browser-e2e.mjs:', err);
      resolve(1);
    });
  });

  runner.testExitCode = testCode;
  runner.browserTestProcess = null;
  runner.state = testCode === 0 ? 'COMPLETED' : 'FAILED';
}

main()
  .catch(async (err) => {
    const code = await runner.performTeardown({ error: err });
    console.log(`[Runner Completed] Exit code: ${code}\n`);
    process.exit(code);
  })
  .then(async () => {
    const code = await runner.performTeardown();
    console.log(`[Runner Completed] Exit code: ${code}\n`);
    process.exit(code);
  });
