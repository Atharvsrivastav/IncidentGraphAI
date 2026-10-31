import { spawn, execSync } from 'child_process';
import path from 'path';
import {
  findAvailablePort,
  recordDevDbBaseline,
  createExclusiveDatabase,
  RunnerLifecycle,
} from './runner-core.mjs';

const runner = new RunnerLifecycle();

// Bind signal handlers to the runner's teardown orchestration
process.on('SIGINT', async () => {
  try {
    const code = await runner.performTeardown({ signal: 'SIGINT' });
    process.exit(code);
  } catch (err) {
    console.error('Fatal error during SIGINT teardown:', err);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  try {
    const code = await runner.performTeardown({ signal: 'SIGTERM' });
    process.exit(code);
  } catch (err) {
    console.error('Fatal error during SIGTERM teardown:', err);
    process.exit(1);
  }
});

// Support IPC message interruption on Windows where POSIX signals are not natively propagated
if (process.send) {
  process.on('message', async (msg) => {
    if (msg === 'SIGINT' || msg === 'SIGTERM') {
      try {
        const code = await runner.performTeardown({ signal: msg });
        process.exit(code);
      } catch (err) {
        console.error(`Fatal error during ${msg} IPC teardown:`, err);
        process.exit(1);
      }
    }
  });
}

// Support stdin trigger for test suites
if (!process.stdin.isTTY) {
  process.stdin.on('data', async (chunk) => {
    const text = chunk.toString();
    if (text.includes('TRIGGER_SIGINT')) {
      const code = await runner.performTeardown({ signal: 'SIGINT' });
      process.exit(code);
    } else if (text.includes('TRIGGER_SIGTERM')) {
      const code = await runner.performTeardown({ signal: 'SIGTERM' });
      process.exit(code);
    }
  });
}

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

  const isFastBoot = process.env.E2E_FAST_BOOT === '1';

  if (!isFastBoot) {
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
  } else {
    console.log('[Fast Boot Mode] Skipping schema push and seed for disposable signal test harness');
  }

  // 6. Select port and start production Next.js server
  const preferredPort = parseInt(process.env.PORT || '3000', 10);
  runner.targetPort = await findAvailablePort(preferredPort);
  const targetBaseUrl = `http://localhost:${runner.targetPort}`;

  const isWindows = process.platform === 'win32';
  const nextBin = path.join(runner.cwd, 'node_modules', 'next', 'dist', 'bin', 'next');

  let serverExecutable = process.execPath;
  let serverArgs;

  if (isFastBoot) {
    serverArgs = [
      '-e',
      `
        const http = require('http');
        const server = http.createServer((req, res) => {
          if (req.url === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'healthy',
              database: {
                status: 'connected',
                provider: 'sqlite',
                servicesCount: 7,
                isIsolated: true,
              }
            }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(${runner.targetPort}, '127.0.0.1');
        setInterval(() => {}, 1000);
      `
    ];
  } else {
    serverArgs = [nextBin, 'start', '-p', String(runner.targetPort)];
  }

  console.log(`[Next.js Server] Starting server on port ${runner.targetPort}...`);
  runner.serverProcess = spawn(serverExecutable, serverArgs, {
    cwd: runner.cwd,
    shell: false,
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
  runner.serverPgid = !isWindows ? runner.serverProcess.pid : null;

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
  const testScript = process.env.E2E_TEST_SCRIPT || 'tests/browser-e2e.mjs';
  const testScriptPath = path.resolve(runner.cwd, testScript);
  console.log(`\n[Browser E2E] Launching browser test runner (${testScript}) against ${targetBaseUrl}...`);

  runner.browserTestProcess = spawn(process.execPath, [testScriptPath], {
    cwd: runner.cwd,
    shell: false,
    detached: !isWindows, // Creates dedicated process group on POSIX
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      BASE_URL: targetBaseUrl,
      PORT: String(runner.targetPort),
      E2E_ISOLATED: '1',
    },
  });
  runner.browserTestPgid = !isWindows ? runner.browserTestProcess.pid : null;

  runner.browserTestProcess.stdout?.on('data', (d) => {
    process.stdout.write(d);
    if (process.send) {
      process.send({ type: 'BROWSER_OUTPUT', data: d.toString() });
    }
  });

  runner.browserTestProcess.on('message', (msg) => {
    if (process.send) {
      process.send(msg);
    }
  });

  if (process.send) {
    process.send({
      type: 'RUNNER_READY',
      browserPid: runner.browserTestProcess.pid,
      serverPid: runner.serverProcess?.pid,
      targetPort: runner.targetPort,
      dbFilePath: runner.dbFilePath,
    });
  }

  await new Promise((resolve) => {
    runner.browserTestProcess.on('exit', (code, signal) => {
      runner.recordBrowserTestExit(code, signal);
      resolve();
    });
    runner.browserTestProcess.on('error', (err) => {
      console.error('Failed to spawn browser test child process:', err);
      if (!runner.signalReceived && !runner.browserTestTerminating && !runner.teardownRunning && !runner.teardownCompleted) {
        runner.testExitCode = 1;
      }
      resolve();
    });
  });

  runner.browserTestProcess = null;
  runner.state = runner.testExitCode === 0 ? 'COMPLETED' : 'FAILED';
}

main()
  .then(async () => {
    const code = await runner.performTeardown();
    console.log(`[Runner Completed] Exit code: ${code}\n`);
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('\n❌ Unhandled error in main():', err);
    const code = await runner.performTeardown({ error: err });
    console.log(`[Runner Completed] Exit code: ${code}\n`);
    process.exit(code);
  });
