import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import net from 'net';

export const DISPOSABLE_DB_REGEX = /^e2e-(?:isolated|ci)-[a-zA-Z0-9_\-]+-[a-f0-9]{4,32}\.db$/i;
export const DB_SIDECAR_EXTENSIONS = ['', '-journal', '-wal', '-shm'];

/**
 * Computes SHA-256 hash of a file if it exists.
 */
export function computeFileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Checks whether a given TCP port is available on localhost.
 */
export function isPortAvailable(port) {
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
export async function findAvailablePort(preferredPort = 3000) {
  for (let port = preferredPort; port < preferredPort + 50; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find an available port starting from ${preferredPort}`);
}

/**
 * Checks if a process with given PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // If EPERM, process exists and is alive
  }
}

/**
 * Returns all descendant PIDs of a process on Windows.
 * @param {number} pid
 * @returns {number[]}
 */
export function getDescendantPidsWindows(pid) {
  if (process.platform !== 'win32' || !pid || typeof pid !== 'number' || pid <= 0) return [];
  try {
    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress"`;
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (!out) return [];
    const procs = JSON.parse(out);
    const procList = Array.isArray(procs) ? procs : [procs];
    /** @type {Map<number, number[]>} */
    const childrenMap = new Map();
    for (const p of procList) {
      const parent = p.ParentProcessId;
      if (!childrenMap.has(parent)) childrenMap.set(parent, []);
      childrenMap.get(parent).push(p.ProcessId);
    }
    const descendants = [];
    const queue = [pid];
    while (queue.length > 0) {
      const curr = queue.shift();
      const children = childrenMap.get(curr) || [];
      for (const ch of children) {
        descendants.push(ch);
        queue.push(ch);
      }
    }
    return descendants;
  } catch {
    return [];
  }
}

/**
 * Checks if any process in the process group or process tree is alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessGroupAlive(pid) {
  if (!pid || typeof pid !== 'number' || isNaN(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    if (isProcessAlive(pid)) return true;
    const descendants = getDescendantPidsWindows(pid);
    return descendants.some((dPid) => isProcessAlive(dPid));
  }

  // POSIX: verify dedicated process group (-pid)
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return true;
  }
  try {
    const out = execSync(`pgrep -g ${pid} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (out.length > 0) return true;
  } catch {}
  return isProcessAlive(pid);
}

/**
 * Cross-platform process tree termination and verification.
 * A missing or invalid PID must not count as proof of successful process termination.
 * @param {number | null} pid
 * @param {number | null} [port=null]
 * @returns {Promise<boolean>}
 */
export async function killProcessTree(pid, port = null) {
  if (pid === null || pid === undefined || typeof pid !== 'number' || isNaN(pid) || pid <= 0) {
    console.error(`[killProcessTree] Invalid or missing PID: ${pid}`);
    return false;
  }
  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      // Gather descendant PIDs before attempting termination
      const descendants = getDescendantPidsWindows(pid);
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Leader may already be stopped
      }
      for (const dPid of descendants) {
        if (isProcessAlive(dPid)) {
          try { execSync(`taskkill /pid ${dPid} /F`, { stdio: 'ignore' }); } catch {}
        }
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

    // Escalate to SIGKILL / taskkill after bounded grace period (500ms)
    if (i >= 5) {
      if (isWindows) {
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
        const descendants = getDescendantPidsWindows(pid);
        for (const dPid of descendants) {
          if (isProcessAlive(dPid)) {
            try { execSync(`taskkill /pid ${dPid} /F`, { stdio: 'ignore' }); } catch {}
          }
        }
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        try { execSync(`pkill -KILL -P ${pid} 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  // Also verify port is released independently
  let portReleased = false;
  if (port) {
    for (let i = 0; i < 20; i++) {
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
 * Creates a unique disposable SQLite database exclusively.
 * Ownership is granted only if exclusive creation succeeds.
 * Handles close failures safely without leaving untracked orphans.
 * @param {string} prismaDir
 * @param {string | null} [requestedName=null]
 * @param {{ closeSync?: (fd: number) => void }} [options={}]
 * @returns {{ dbFileName: string, dbFilePath: string, databaseUrl: string, dbFileOwned: boolean }}
 */
export function createExclusiveDatabase(prismaDir, requestedName = null, options = {}) {
  const uniqueName = requestedName || `e2e-isolated-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`;
  const dbFileName = uniqueName.endsWith('.db') ? uniqueName : `${uniqueName}.db`;
  const dbFilePath = path.join(prismaDir, dbFileName);
  const databaseUrl = `file:./${dbFileName}`;

  if (!DISPOSABLE_DB_REGEX.test(dbFileName)) {
    throw new Error(`Database name '${dbFileName}' failed format check against ${DISPOSABLE_DB_REGEX}`);
  }

  // Exclusive creation: flag 'wx' throws EEXIST if file already exists
  let fd;
  try {
    fd = fs.openSync(dbFilePath, 'wx');
  } catch (err) {
    const error = new Error(`Failed to exclusively create disposable database at ${dbFilePath}: ${err.message}`);
    error.code = err.code;
    // NEVER delete an existing database on EEXIST!
    throw error;
  }

  // The file was created by this runner process (owned).
  // Handle close failures safely without leaving an untracked orphan.
  const closeFn = options.closeSync || fs.closeSync;
  try {
    closeFn(fd);
  } catch (closeErr) {
    // Attempt safe cleanup of that owned file
    const remaining = cleanupDisposableDb(dbFilePath, true);
    const cleanupFailed = remaining.length > 0;
    const cleanupReport = cleanupFailed
      ? `Failed to clean up owned file; remaining artifacts: ${remaining.join(', ')}`
      : `Owned file was safely cleaned up.`;

    const error = new Error(`Failed to close database file descriptor: ${closeErr.message}. ${cleanupReport}`);
    error.code = closeErr.code;
    error.dbFilePath = dbFilePath;
    error.dbFileOwned = true;
    error.cleanupFailed = cleanupFailed;
    error.remainingArtifacts = remaining;
    throw error;
  }

  return {
    dbFileName,
    dbFilePath,
    databaseUrl,
    dbFileOwned: true,
  };
}

/**
 * Clean up disposable database files with retry for file locks.
 * Strictly respects dbFileOwned: refuses deletion if not owned!
 * Returns an array of any files that could NOT be deleted.
 */
export function cleanupDisposableDb(dbPath, dbFileOwned = false) {
  if (!dbFileOwned) {
    console.warn(`[Cleanup Guard] Refusing deletion: database '${dbPath}' is not owned by runner (dbFileOwned=false).`);
    return [];
  }

  if (!dbPath) return [];

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
 * @param {string} prismaDir
 * @param {string} [baseDbName='dev.db']
 * @returns {Record<string, { exists: boolean, size: number, mtimeMs: number, hash: string | null }>}
 */
export function recordDevDbBaseline(prismaDir, baseDbName = 'dev.db') {
  /** @type {Record<string, { exists: boolean, size: number, mtimeMs: number, hash: string | null }>} */
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
export function verifyDevDbIntegrity(prismaDir, baseline, baseDbName = 'dev.db') {
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

/**
 * Manages the complete lifecycle, process tracking, database ownership,
 * and teardown orchestration of the E2E test runner.
 */
export class RunnerLifecycle {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.prismaDir = options.prismaDir || path.resolve(this.cwd, 'prisma');
    this.serverProcess = null;
    this.browserTestProcess = null;
    this.targetPort = null;
    this.dbFilePath = null;
    this.dbFileName = null;
    this.databaseUrl = null;
    this.dbFileOwned = false;
    this.devDbBaseline = null;
    this.state = 'IDLE'; // 'IDLE' | 'STARTING' | 'TESTING' | 'COMPLETED' | 'FAILED' | 'TEARDOWN'
    this.testExitCode = null;
    this.testExitSignal = null;
    this.browserTestTerminating = false;
    this.signalReceived = null;
    this.teardownFailed = false;
    this.teardownRunning = false;
    this.teardownCompleted = false;
    this.cleanupExecutionCount = 0;
    this.onCleanup = options.onCleanup || null;
  }

  recordTeardownFailure() {
    this.teardownFailed = true;
  }

  /**
   * Records exit status from the browser test child process.
   * Distinguishes natural failures from teardown-induced termination.
   * @param {number | null} code
   * @param {string | null} signal
   */
  recordBrowserTestExit(code, signal) {
    this.testExitSignal = signal;

    // If runner teardown intentionally initiated termination of the browser process tree,
    // do not classify the signal kill or null exit code as a natural test failure.
    if (this.browserTestTerminating || this.teardownRunning || this.teardownCompleted) {
      return;
    }

    // Preserve an already-established genuine non-zero browser test failure
    if (this.testExitCode !== null && this.testExitCode !== 0) {
      return;
    }

    if (code !== null && code !== undefined) {
      this.testExitCode = code;
    } else if (signal) {
      // Child terminated by unexpected external signal during active run
      this.testExitCode = 1;
    } else {
      this.testExitCode = 0;
    }
  }

  resolveFinalExitCode() {
    // 1. Preserve an already-established genuine non-zero browser test exit code
    if (this.testExitCode !== null && this.testExitCode !== 0) {
      return this.testExitCode;
    }

    // 2. SIGINT during active execution must return 130 after teardown
    if (this.signalReceived === 'SIGINT') return 130;
    // SIGTERM during active execution must return 143 after teardown
    if (this.signalReceived === 'SIGTERM') return 143;

    // 3. A successful browser run with cleanup failure must return non-zero
    if (this.teardownFailed) return 1;

    // 4. Successful test and successful teardown
    if (this.testExitCode === 0) return 0;

    // Default failure
    return 1;
  }

  /**
   * @param {{ signal?: string | null, error?: Error | null, testCode?: number | null }} [options={}]
   * @returns {Promise<number>}
   */
  async performTeardown({ signal = null, error = null, testCode = null } = {}) {
    if (this.teardownCompleted) {
      return this.resolveFinalExitCode();
    }
    if (this.teardownRunning) {
      while (this.teardownRunning) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return this.resolveFinalExitCode();
    }
    this.teardownRunning = true;
    this.state = 'TEARDOWN';

    try {
      if (signal && !this.signalReceived) {
        this.signalReceived = signal;
        console.log(`\n[Runner] Handling signal ${signal}...`);
      }

      if (testCode !== null && testCode !== undefined && this.testExitCode === null) {
        this.testExitCode = testCode;
      }

      if (error) {
        console.error('\n❌ Error encountered during runner execution:', error);
        if (this.testExitCode === null || this.testExitCode === 0) {
          this.testExitCode = 1;
        }
      }

      // 1. Terminate Browser Test process tree first (record termination intent before sending signals)
      if (this.browserTestProcess && this.browserTestProcess.pid) {
        this.browserTestTerminating = true;
        console.log(`\n[Cleanup] Terminating Browser Test process tree (PID: ${this.browserTestProcess.pid})...`);
        const browserKilled = await killProcessTree(this.browserTestProcess.pid);
        if (browserKilled) {
          console.log(`  ✓ Browser Test process tree (PID: ${this.browserTestProcess.pid}) cleanly stopped.`);
        } else {
          console.error(`❌ [Browser Cleanup Failure] Browser Test process tree (PID: ${this.browserTestProcess.pid}) could not be fully stopped!`);
          this.recordTeardownFailure();
        }
        this.browserTestProcess = null;
      }

      // 2. Terminate Server process tree and release port
      if (this.serverProcess && this.serverProcess.pid) {
        console.log(`[Cleanup] Shutting down Next.js server (PID: ${this.serverProcess.pid}, Port: ${this.targetPort})...`);
        const serverKilled = await killProcessTree(this.serverProcess.pid, this.targetPort);
        if (serverKilled) {
          console.log(`  ✓ Next.js server process tree (PID: ${this.serverProcess.pid}) and port ${this.targetPort} verified cleanly stopped.`);
        } else {
          console.error(`❌ [Server Cleanup Failure] Next.js server process or port still active (PID: ${this.serverProcess.pid})!`);
          this.recordTeardownFailure();
        }
        this.serverProcess = null;
      }

      // 3. Disposable database cleanup (strictly checks dbFileOwned!)
      if (this.dbFilePath) {
        if (!this.dbFileOwned) {
          console.log(`[Cleanup Guard] Skipping deletion of '${this.dbFileName}': database was not owned by runner (dbFileOwned=false).`);
        } else {
          console.log(`[Cleanup] Removing disposable database: ${this.dbFileName}`);
          this.cleanupExecutionCount++;
          if (typeof this.onCleanup === 'function') {
            try { this.onCleanup(); } catch {}
          }
          const remainingFiles = cleanupDisposableDb(this.dbFilePath, this.dbFileOwned);
          if (remainingFiles.length === 0) {
            console.log(`  ✓ Disposable database ${this.dbFileName} and all journal/WAL/SHM artifacts successfully deleted.`);
            this.dbFileOwned = false;
          } else {
            console.error(
              `❌ [Fatal Cleanup Failure] Disposable database artifacts remain after cleanup retries:\n` +
              `  ${remainingFiles.join('\n  ')}\n` +
              `Failing test runner due to database cleanup invariant violation.`
            );
            this.recordTeardownFailure();
          }
        }
      }

      // 4. Developer database and sidecars integrity check
      if (this.devDbBaseline && this.prismaDir) {
        const violations = verifyDevDbIntegrity(this.prismaDir, this.devDbBaseline, 'dev.db');
        if (violations.length > 0) {
          console.error(`❌ [Developer DB Integrity Violation] Integrity checks failed:\n  ${violations.join('\n  ')}`);
          this.recordTeardownFailure();
        } else {
          console.log(`  ✓ Developer database and all sidecars (prisma/dev.db*) verified 100% UNTOUCHED`);
        }
      }
    } finally {
      this.teardownCompleted = true;
      this.teardownRunning = false;
    }

    return this.resolveFinalExitCode();
  }
}
