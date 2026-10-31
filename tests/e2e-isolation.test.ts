import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import { spawn, type ChildProcess, type StdioOptions } from "child_process";
import {
  createExclusiveDatabase,
  cleanupDisposableDb,
  recordDevDbBaseline,
  verifyDevDbIntegrity,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessTree,
  isPortAvailable,
  computeFileHash,
  RunnerLifecycle,
} from "../scripts/runner-core.mjs";
import {
  validateDatabaseIsolation,
} from "../src/lib/db/isolation-validator";
import { verifyServerAvailable } from "../tests/browser-e2e.mjs";

describe("Real Production-Code E2E Isolation, Ownership & Signal Tests", () => {
  const dummyRoot = path.resolve(os.tmpdir(), "incidentgraph-real-test-" + Date.now());
  const dummyPrismaDir = path.join(dummyRoot, "prisma");

  const testProcesses = new Set<ChildProcess>();
  const testPids = new Set<number>();

  function registerTestProcess(proc: ChildProcess) {
    testProcesses.add(proc);
    if (proc.pid) testPids.add(proc.pid);
    proc.on("exit", () => {
      testProcesses.delete(proc);
    });
  }

  function registerTestPid(pid: number) {
    if (pid && pid > 0) testPids.add(pid);
  }

  beforeEach(() => {
    fs.mkdirSync(dummyPrismaDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      fs.rmSync(dummyRoot, { recursive: true, force: true });
    } catch {}

    // Deterministically clean up all test-owned processes
    for (const proc of testProcesses) {
      if (proc.pid && isProcessAlive(proc.pid)) {
        await killProcessTree(proc.pid);
      }
    }
    testProcesses.clear();

    for (const pid of testPids) {
      if (isProcessAlive(pid)) {
        await killProcessTree(pid);
      }
    }
    testPids.clear();

    vi.restoreAllMocks();
  });

  describe("1. Database Ownership & Exclusive Creation Invariants", () => {
    it("1. EEXIST exclusive-create failure preserves the pre-existing database and its sidecars", async () => {
      // 1. Create a pre-existing disposable-looking database containing critical data
      const existingName = "e2e-isolated-9999999999999-abcdef12.db";
      const existingDbPath = path.join(dummyPrismaDir, existingName);
      const criticalContent = "CRITICAL_USER_DATABASE_PAYLOAD_DO_NOT_DELETE";
      fs.writeFileSync(existingDbPath, criticalContent);
      const hashBefore = computeFileHash(existingDbPath);

      // Create pre-existing sidecars
      const walPath = `${existingDbPath}-wal`;
      const shmPath = `${existingDbPath}-shm`;
      fs.writeFileSync(walPath, "CRITICAL_WAL_DATA");
      fs.writeFileSync(shmPath, "CRITICAL_SHM_DATA");

      // 2. Attempt exclusive creation with the same name -> MUST fail with EEXIST
      let creationFailed = false;
      try {
        createExclusiveDatabase(dummyPrismaDir, existingName);
      } catch (err: unknown) {
        creationFailed = true;
        expect((err as { code?: string }).code).toBe("EEXIST");
      }
      expect(creationFailed).toBe(true);

      // 3. Instantiate RunnerLifecycle simulating failed creation (dbFileOwned remains false)
      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner.dbFileName = existingName;
      runner.dbFilePath = existingDbPath;
      runner.dbFileOwned = false; // Not owned because creation failed

      // 4. Trigger performTeardown as the real runner does on error
      const exitCode = await runner.performTeardown({ error: new Error("EEXIST collision") });
      expect(exitCode).toBe(1);

      // 5. Verify the pre-existing database bytes and hash remain 100% untouched
      expect(fs.existsSync(existingDbPath)).toBe(true);
      expect(fs.readFileSync(existingDbPath, "utf8")).toBe(criticalContent);
      expect(computeFileHash(existingDbPath)).toBe(hashBefore);

      // 6. Verify pre-existing sidecars were NOT deleted
      expect(fs.existsSync(walPath)).toBe(true);
      expect(fs.existsSync(shmPath)).toBe(true);
    });

    it("2. Owned database cleanup succeeds and deletes primary and all sidecars", () => {
      const dbInfo = createExclusiveDatabase(dummyPrismaDir);
      expect(dbInfo.dbFileOwned).toBe(true);
      expect(fs.existsSync(dbInfo.dbFilePath)).toBe(true);

      // Create sidecars
      fs.writeFileSync(`${dbInfo.dbFilePath}-wal`, "wal content");
      fs.writeFileSync(`${dbInfo.dbFilePath}-shm`, "shm content");

      const leftover = cleanupDisposableDb(dbInfo.dbFilePath, dbInfo.dbFileOwned);
      expect(leftover).toHaveLength(0);
      expect(fs.existsSync(dbInfo.dbFilePath)).toBe(false);
      expect(fs.existsSync(`${dbInfo.dbFilePath}-wal`)).toBe(false);
      expect(fs.existsSync(`${dbInfo.dbFilePath}-shm`)).toBe(false);
    });

    it("2b. Exclusive-create close failure safely cleans up owned file without leaving orphan, preserves ownership knowledge, and does not delete on EEXIST", () => {
      // 1. When closeSync fails on a newly created file:
      let closeCalled = false;
      let errorThrown: (Error & { dbFileOwned?: boolean; cleanupFailed?: boolean; dbFilePath?: string }) | null = null;
      try {
        createExclusiveDatabase(dummyPrismaDir, "e2e-isolated-close-fail-12345678.db", {
          closeSync: () => {
            closeCalled = true;
            const err = new Error("EBADF: bad file descriptor") as Error & { code?: string };
            err.code = "EBADF";
            throw err;
          },
        });
      } catch (err) {
        errorThrown = err as Error & { dbFileOwned?: boolean; cleanupFailed?: boolean; dbFilePath?: string };
      }

      expect(closeCalled).toBe(true);
      expect(errorThrown).toBeDefined();
      expect(errorThrown?.message).toContain("Failed to close database file descriptor");
      expect(errorThrown?.dbFileOwned).toBe(true);
      expect(errorThrown?.cleanupFailed).toBe(false);
      // Verify the owned file was cleaned up on close failure (no orphan)
      expect(fs.existsSync(errorThrown?.dbFilePath || "")).toBe(false);

      // 2. But EEXIST on a pre-existing file MUST NEVER delete the file!
      const preExisting = path.join(dummyPrismaDir, "e2e-isolated-collision-preexist-9999.db");
      fs.writeFileSync(preExisting, "PREEXISTING_DATA_PRESERVED");
      let eexistError: (Error & { code?: string }) | null = null;
      try {
        createExclusiveDatabase(dummyPrismaDir, "e2e-isolated-collision-preexist-9999.db");
      } catch (err) {
        eexistError = err as Error & { code?: string };
      }
      expect(eexistError).toBeDefined();
      expect(eexistError?.code).toBe("EEXIST");
      expect(fs.existsSync(preExisting)).toBe(true);
      expect(fs.readFileSync(preExisting, "utf8")).toBe("PREEXISTING_DATA_PRESERVED");
    });

    it("3. Failed primary DB deletion fails the runner teardown", async () => {
      const dbInfo = createExclusiveDatabase(dummyPrismaDir);
      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner.dbFileName = dbInfo.dbFileName;
      runner.dbFilePath = dbInfo.dbFilePath;
      runner.dbFileOwned = true;
      runner.testExitCode = 0; // Tests passed

      // Spy on unlinkSync to simulate permission/lock failure on primary file
      const originalUnlink = fs.unlinkSync;
      vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
        if (p === dbInfo.dbFilePath) throw new Error("EBUSY: file locked");
        return originalUnlink(p);
      });

      const exitCode = await runner.performTeardown();
      expect(exitCode).toBe(1); // Escalated from 0 to 1 due to cleanup failure
      expect(runner.teardownFailed).toBe(true);
    });

    it("4. Failed WAL/SHM/journal cleanup fails the runner teardown", async () => {
      const dbInfo = createExclusiveDatabase(dummyPrismaDir);
      const walPath = `${dbInfo.dbFilePath}-wal`;
      fs.writeFileSync(walPath, "wal locked content");

      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner.dbFileName = dbInfo.dbFileName;
      runner.dbFilePath = dbInfo.dbFilePath;
      runner.dbFileOwned = true;
      runner.testExitCode = 0; // Tests passed

      const originalUnlink = fs.unlinkSync;
      vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
        if (p === walPath) throw new Error("EPERM: cannot delete wal");
        return originalUnlink(p);
      });

      const exitCode = await runner.performTeardown();
      expect(exitCode).toBe(1); // Escalated from 0 to 1
      expect(runner.teardownFailed).toBe(true);
    });
  });

  describe("2. Developer Database & Sidecar Integrity Protection", () => {
    it("5. Developer DB content mutation is detected as an integrity violation", () => {
      const devDbPath = path.join(dummyPrismaDir, "dev.db");
      fs.writeFileSync(devDbPath, "initial valid database");

      const baseline = recordDevDbBaseline(dummyPrismaDir, "dev.db");
      expect(baseline["dev.db"].exists).toBe(true);

      // Mutate dev.db
      fs.writeFileSync(devDbPath, "corrupted database content");

      const violations = verifyDevDbIntegrity(dummyPrismaDir, baseline, "dev.db");
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes("SHA-256 hash changed"))).toBe(true);
    });

    it("6. Developer DB sidecar creation during test execution is detected", () => {
      const devDbPath = path.join(dummyPrismaDir, "dev.db");
      fs.writeFileSync(devDbPath, "initial dev db");

      const baseline = recordDevDbBaseline(dummyPrismaDir, "dev.db");

      // Sidecar appears during testing
      fs.writeFileSync(path.join(dummyPrismaDir, "dev.db-wal"), "accidental wal file");

      const violations = verifyDevDbIntegrity(dummyPrismaDir, baseline, "dev.db");
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes("dev.db-wal' did not exist before test"))).toBe(true);
    });

    it("7. Existing developer DB sidecar deletion is detected", () => {
      const devDbPath = path.join(dummyPrismaDir, "dev.db");
      const devDbJournal = path.join(dummyPrismaDir, "dev.db-journal");
      fs.writeFileSync(devDbPath, "initial dev db");
      fs.writeFileSync(devDbJournal, "existing journal");

      const baseline = recordDevDbBaseline(dummyPrismaDir, "dev.db");

      // Delete journal
      fs.unlinkSync(devDbJournal);

      const violations = verifyDevDbIntegrity(dummyPrismaDir, baseline, "dev.db");
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes("existed before test, but was deleted"))).toBe(true);
    });
  });

  describe("3. Real Process Group, Browser Child Termination & Port Release", () => {
    it("8. SIGINT during active test execution returns exit code 130", async () => {
      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner.state = "TESTING";

      const finalCode = await runner.performTeardown({ signal: "SIGINT" });
      expect(finalCode).toBe(130);
    });

    it("9. SIGTERM during active test execution returns exit code 143", async () => {
      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner.state = "TESTING";

      const finalCode = await runner.performTeardown({ signal: "SIGTERM" });
      expect(finalCode).toBe(143);
    });

    it("10. Existing test failure exit code is preserved even when signals or cleanup issues occur", async () => {
      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner.testExitCode = 2; // Established test failure exit code

      const finalCode = await runner.performTeardown({ signal: "SIGINT" });
      expect(finalCode).toBe(2); // Preserves test failure code 2 over signal code 130
    });

    it("11. Cleanup failure changes successful exit code 0 to non-zero 1", async () => {
      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner.testExitCode = 0; // Tests passed
      runner.recordTeardownFailure();

      expect(runner.resolveFinalExitCode()).toBe(1);
    });

    it("11b. Browser test child exit distinguishes natural failures from teardown termination and preserves genuine prior exit codes", () => {
      // 1. Natural successful exit
      const runner1 = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner1.recordBrowserTestExit(0, null);
      expect(runner1.testExitCode).toBe(0);
      expect(runner1.resolveFinalExitCode()).toBe(0);

      // 2. Natural test failure
      const runner2 = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner2.recordBrowserTestExit(2, null);
      expect(runner2.testExitCode).toBe(2);
      expect(runner2.resolveFinalExitCode()).toBe(2);

      // 3. Teardown-induced termination must NOT set testExitCode or overwrite existing exit code
      const runner3 = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner3.browserTestTerminating = true;
      runner3.recordBrowserTestExit(null, "SIGTERM");
      expect(runner3.testExitCode).toBeNull(); // Distinguishes teardown termination from natural test failure

      // 4. Teardown with SIGINT returns 130 when no prior failure occurred
      runner3.signalReceived = "SIGINT";
      expect(runner3.resolveFinalExitCode()).toBe(130);

      // 5. Teardown with SIGTERM returns 143 when no prior failure occurred
      const runner4 = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner4.browserTestTerminating = true;
      runner4.recordBrowserTestExit(null, "SIGTERM");
      runner4.signalReceived = "SIGTERM";
      expect(runner4.resolveFinalExitCode()).toBe(143);

      // 6. Pre-existing genuine failure exit code is preserved even when SIGINT received during teardown
      const runner5 = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      runner5.recordBrowserTestExit(3, null); // Genuine prior failure
      runner5.browserTestTerminating = true;
      runner5.recordBrowserTestExit(null, "SIGTERM"); // Teardown kill event
      runner5.signalReceived = "SIGINT"; // Signal arrived
      expect(runner5.resolveFinalExitCode()).toBe(3); // Real prior test failure preserved!
    });

    it("12. Concurrent performTeardown calls execute actual cleanup exactly once, remove all sidecars, and return 130 to all callers", async () => {
      const dbInfo = createExclusiveDatabase(dummyPrismaDir);
      const walPath = `${dbInfo.dbFilePath}-wal`;
      const shmPath = `${dbInfo.dbFilePath}-shm`;
      fs.writeFileSync(walPath, "wal content");
      fs.writeFileSync(shmPath, "shm content");

      let observableCleanupInvocations = 0;
      const runner = new RunnerLifecycle({
        cwd: dummyRoot,
        prismaDir: dummyPrismaDir,
        onCleanup: () => {
          observableCleanupInvocations++;
        },
      });
      runner.dbFileName = dbInfo.dbFileName;
      runner.dbFilePath = dbInfo.dbFilePath;
      runner.dbFileOwned = true;

      // Invoke performTeardown concurrently through three signal/exit paths
      const [c1, c2, c3] = await Promise.all([
        runner.performTeardown({ signal: "SIGINT" }),
        runner.performTeardown({ signal: "SIGINT" }),
        runner.performTeardown({ signal: "SIGTERM" }),
      ]);

      // Assert the actual cleanup operation executed exactly once
      expect(runner.cleanupExecutionCount).toBe(1);
      expect(observableCleanupInvocations).toBe(1);

      // Assert database and sidecars are absent afterward
      expect(fs.existsSync(dbInfo.dbFilePath)).toBe(false);
      expect(fs.existsSync(walPath)).toBe(false);
      expect(fs.existsSync(shmPath)).toBe(false);

      // Assert all callers receive the correct final exit code (first signal was SIGINT -> 130)
      expect(c1).toBe(130);
      expect(c2).toBe(130);
      expect(c3).toBe(130);

      // Verify teardown state flags
      expect(runner.teardownCompleted).toBe(true);
      expect(runner.dbFileOwned).toBe(false);
    });

    it("13. Real nested child-process termination terminates detached parent, non-detached worker, and grandchild", async () => {
      const isWin = process.platform === "win32";
      const parent = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { spawn } from 'child_process';
            // Nested worker is non-detached so it inherits parent's process group
            const worker = spawn(process.execPath, [
              '--input-type=module',
              '-e',
              \`
                import { spawn } from 'child_process';
                // Grandchild worker is also non-detached
                const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                  stdio: 'ignore',
                  detached: false,
                });
                console.log('WORKER_PIDS:' + process.pid + ':' + grandchild.pid);
                setInterval(() => {}, 1000);
              \`
            ], {
              stdio: ['ignore', 'pipe', 'ignore'],
              detached: false,
            });

            worker.stdout.on('data', (d) => {
              const m = d.toString().match(/WORKER_PIDS:(\\d+):(\\d+)/);
              if (m) {
                console.log('ALL_PIDS:' + process.pid + ':' + m[1] + ':' + m[2]);
              }
            });

            setInterval(() => {}, 1000);
          `
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "ignore"],
          detached: !isWin, // Detached parent process (process group leader on POSIX)
        }
      );

      registerTestProcess(parent);

      let parentPid = 0;
      let workerPid = 0;
      let grandchildPid = 0;

      try {
        [parentPid, workerPid, grandchildPid] = await new Promise<[number, number, number]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timeout waiting for process tree to start")), 10000);
          parent.stdout.on("data", (d) => {
            const match = d.toString().match(/ALL_PIDS:(\d+):(\d+):(\d+)/);
            if (match) {
              clearTimeout(timer);
              resolve([parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]);
            }
          });
          parent.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        registerTestPid(parentPid);
        registerTestPid(workerPid);
        registerTestPid(grandchildPid);

        // Confirm parent, worker and grandchild PIDs are all running
        expect(isProcessAlive(parentPid)).toBe(true);
        expect(isProcessAlive(workerPid)).toBe(true);
        expect(isProcessAlive(grandchildPid)).toBe(true);
        expect(isProcessGroupAlive(parentPid)).toBe(true);

        // Terminate the process tree via parentPid
        const stopped = await killProcessTree(parentPid);
        expect(stopped).toBe(true);

        // Verify parent, worker and grandchild PIDs are all terminated
        expect(isProcessAlive(parentPid)).toBe(false);
        expect(isProcessAlive(workerPid)).toBe(false);
        expect(isProcessAlive(grandchildPid)).toBe(false);

        // Verify process group no longer exists
        expect(isProcessGroupAlive(parentPid)).toBe(false);
      } finally {
        if (parentPid && isProcessAlive(parentPid)) await killProcessTree(parentPid);
        if (workerPid && isProcessAlive(workerPid)) await killProcessTree(workerPid);
        if (grandchildPid && isProcessAlive(grandchildPid)) await killProcessTree(grandchildPid);
      }
    });

    it("14. Real server process and port release terminates process group and releases port", async () => {
      // Start an HTTP server in a separate detached child process
      const isWin = process.platform === "win32";
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
            const http = require('http');
            const server = http.createServer((req, res) => res.end('ok'));
            server.listen(0, '127.0.0.1', () => {
              const port = server.address().port;
              console.log('LISTENING:' + port);
            });
            setInterval(() => {}, 1000);
          `
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "ignore"],
          detached: !isWin,
        }
      );

      registerTestProcess(child);

      let port = 0;
      let childPid = 0;

      try {
        port = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timeout waiting for server port")), 10000);
          child.stdout.on("data", (d) => {
            const match = d.toString().match(/LISTENING:(\d+)/);
            if (match) {
              clearTimeout(timer);
              resolve(parseInt(match[1], 10));
            }
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        childPid = child.pid!;
        registerTestPid(childPid);

        // Confirm server is listening and port is occupied
        expect(isProcessAlive(childPid)).toBe(true);
        expect(await isPortAvailable(port)).toBe(false);

        // Invoke real production killProcessTree(child.pid, port)
        const stopped = await killProcessTree(childPid, port);
        expect(stopped).toBe(true);

        // Verify the process group is terminated
        expect(isProcessAlive(childPid)).toBe(false);
        expect(isProcessGroupAlive(childPid)).toBe(false);

        // Verify the port becomes available
        expect(await isPortAvailable(port)).toBe(true);

        // Assert cleanup fails if PID is missing or invalid
        expect(await killProcessTree(null as unknown as number, port)).toBe(false);
        expect(await killProcessTree(undefined as unknown as number, port)).toBe(false);
        expect(await killProcessTree(-1, port)).toBe(false);
      } finally {
        if (childPid && isProcessAlive(childPid)) await killProcessTree(childPid, port || undefined);
      }
    });

    it("15. Full-runner SIGINT integration test terminates browser process tree, releases port, cleans up DB, and exits 130", async () => {
      const devDbBaseline = recordDevDbBaseline(path.resolve(process.cwd(), "prisma"), "dev.db");
      const isWin = process.platform === "win32";

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "test",
        E2E_FAST_BOOT: "1",
        E2E_TEST_SCRIPT: "tests/fixtures/interruptible-browser-test.mjs",
      };
      delete childEnv.BASE_URL;

      const runnerChild: ChildProcess = spawn(
        process.execPath,
        ["scripts/run-browser-e2e.mjs"],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe", "ipc"] as StdioOptions,
          env: childEnv,
        }
      );

      registerTestProcess(runnerChild);

      let runnerDbPath: string | null = null;
      let runnerPort: number | null = null;
      let browserPid: number | null = null;
      let workerPid: number | null = null;
      let stdoutOutput = "";
      let stderrOutput = "";

      try {
        await new Promise<void>((resolve, reject) => {
          let isReady = false;
          const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for runner ready. Stderr: ${stderrOutput}`));
          }, 15000);

          runnerChild.on("message", (msg: unknown) => {
            const m = msg as {
              type?: string;
              dbFilePath?: string;
              targetPort?: number;
              browserPid?: number;
              workerPid?: number;
            } | null;
            if (m && m.type === "RUNNER_READY") {
              if (m.dbFilePath) runnerDbPath = m.dbFilePath;
              if (m.targetPort) runnerPort = m.targetPort;
            }
            if (m && m.type === "INTERRUPTIBLE_BROWSER_READY") {
              if (m.browserPid) browserPid = m.browserPid;
              if (m.workerPid) workerPid = m.workerPid;
              isReady = true;
              clearTimeout(timeout);
              resolve();
            }
          });

          runnerChild.stdout?.on("data", (data) => {
            const str = data.toString();
            stdoutOutput += str;
            const dbMatch = str.match(/Target path:\s*(.+)/);
            if (dbMatch) runnerDbPath = dbMatch[1].trim();
            const portMatch = str.match(/Starting server on port (\d+)/);
            if (portMatch) runnerPort = parseInt(portMatch[1], 10);
            const browserMatch = str.match(/INTERRUPTIBLE_BROWSER_READY:(\d+):(\d+)/);
            if (browserMatch && !isReady) {
              browserPid = parseInt(browserMatch[1], 10);
              workerPid = parseInt(browserMatch[2], 10);
              isReady = true;
              clearTimeout(timeout);
              resolve();
            }
          });

          runnerChild.stderr?.on("data", (d) => {
            const str = d.toString();
            stderrOutput += str;
          });

          runnerChild.on("exit", (code) => {
            if (!isReady) {
              clearTimeout(timeout);
              reject(new Error(`Runner exited prematurely with code ${code}. Stderr: ${stderrOutput}`));
            }
          });
        });

        if (browserPid) registerTestPid(browserPid);
        if (workerPid) registerTestPid(workerPid);

        expect(browserPid).toBeGreaterThan(0);
        expect(workerPid).toBeGreaterThan(0);
        expect(isProcessAlive(browserPid!)).toBe(true);
        expect(isProcessAlive(workerPid!)).toBe(true);
        expect(runnerDbPath).not.toBeNull();
        expect(fs.existsSync(runnerDbPath!)).toBe(true);

        const exitPromise = new Promise<number | null>((resolve) => {
          runnerChild.on("exit", (code) => resolve(code));
        });

        // Trigger real SIGINT interruption: on Windows use IPC/stdin, on POSIX send SIGINT signal
        if (isWin) {
          runnerChild.send("SIGINT");
        } else {
          runnerChild.kill("SIGINT");
        }

        const exitCode = await exitPromise;
        if (exitCode !== 130) {
          console.error(`[TEST 15 FAILED] exitCode=${exitCode}\nSTDOUT:\n${stdoutOutput}\nSTDERR:\n${stderrOutput}`);
        }

        // Verify exit code 130
        expect(exitCode, `exitCode=${exitCode}\nSTDOUT:\n${stdoutOutput}\nSTDERR:\n${stderrOutput}`).toBe(130);

        // Verify browser Node and worker descendants stopped
        expect(isProcessAlive(browserPid!)).toBe(false);
        expect(isProcessAlive(workerPid!)).toBe(false);

        // Verify server process and port stopped
        if (runnerPort) {
          expect(await isPortAvailable(runnerPort)).toBe(true);
        }

        // Verify owned DB and all sidecars are removed
        expect(fs.existsSync(runnerDbPath!)).toBe(false);
        expect(fs.existsSync(`${runnerDbPath}-wal`)).toBe(false);
        expect(fs.existsSync(`${runnerDbPath}-shm`)).toBe(false);

        // Verify developer DB and its sidecars remain unchanged
        const currentDevBaseline = recordDevDbBaseline(path.resolve(process.cwd(), "prisma"), "dev.db");
        expect(currentDevBaseline["dev.db"].hash).toBe(devDbBaseline["dev.db"].hash);
        expect(currentDevBaseline["dev.db"].size).toBe(devDbBaseline["dev.db"].size);
      } finally {
        if (browserPid && isProcessAlive(browserPid)) await killProcessTree(browserPid);
        if (workerPid && isProcessAlive(workerPid)) await killProcessTree(workerPid);
        if (runnerChild.pid && isProcessAlive(runnerChild.pid)) await killProcessTree(runnerChild.pid, runnerPort || undefined);
      }
    }, 20000);

    it("16. Full-runner SIGTERM integration test terminates browser process tree, releases port, cleans up DB, and exits 143", async () => {
      const devDbBaseline = recordDevDbBaseline(path.resolve(process.cwd(), "prisma"), "dev.db");
      const isWin = process.platform === "win32";

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "test",
        E2E_FAST_BOOT: "1",
        E2E_TEST_SCRIPT: "tests/fixtures/interruptible-browser-test.mjs",
      };
      delete childEnv.BASE_URL;

      const runnerChild: ChildProcess = spawn(
        process.execPath,
        ["scripts/run-browser-e2e.mjs"],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe", "ipc"] as StdioOptions,
          env: childEnv,
        }
      );

      registerTestProcess(runnerChild);

      let runnerDbPath: string | null = null;
      let runnerPort: number | null = null;
      let browserPid: number | null = null;
      let workerPid: number | null = null;
      let stdoutOutput = "";
      let stderrOutput = "";

      try {
        await new Promise<void>((resolve, reject) => {
          let isReady = false;
          const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for runner ready. Stderr: ${stderrOutput}`));
          }, 15000);

          runnerChild.on("message", (msg: unknown) => {
            const m = msg as {
              type?: string;
              dbFilePath?: string;
              targetPort?: number;
              browserPid?: number;
              workerPid?: number;
            } | null;
            if (m && m.type === "RUNNER_READY") {
              if (m.dbFilePath) runnerDbPath = m.dbFilePath;
              if (m.targetPort) runnerPort = m.targetPort;
            }
            if (m && m.type === "INTERRUPTIBLE_BROWSER_READY") {
              if (m.browserPid) browserPid = m.browserPid;
              if (m.workerPid) workerPid = m.workerPid;
              isReady = true;
              clearTimeout(timeout);
              resolve();
            }
          });

          runnerChild.stdout?.on("data", (data) => {
            const str = data.toString();
            stdoutOutput += str;
            const dbMatch = str.match(/Target path:\s*(.+)/);
            if (dbMatch) runnerDbPath = dbMatch[1].trim();
            const portMatch = str.match(/Starting server on port (\d+)/);
            if (portMatch) runnerPort = parseInt(portMatch[1], 10);
            const browserMatch = str.match(/INTERRUPTIBLE_BROWSER_READY:(\d+):(\d+)/);
            if (browserMatch && !isReady) {
              browserPid = parseInt(browserMatch[1], 10);
              workerPid = parseInt(browserMatch[2], 10);
              isReady = true;
              clearTimeout(timeout);
              resolve();
            }
          });

          runnerChild.stderr?.on("data", (d) => {
            const str = d.toString();
            stderrOutput += str;
          });

          runnerChild.on("exit", (code) => {
            if (!isReady) {
              clearTimeout(timeout);
              reject(new Error(`Runner exited prematurely with code ${code}. Stderr: ${stderrOutput}`));
            }
          });
        });

        if (browserPid) registerTestPid(browserPid);
        if (workerPid) registerTestPid(workerPid);

        expect(browserPid).toBeGreaterThan(0);
        expect(workerPid).toBeGreaterThan(0);
        expect(isProcessAlive(browserPid!)).toBe(true);
        expect(isProcessAlive(workerPid!)).toBe(true);
        expect(runnerDbPath).not.toBeNull();
        expect(fs.existsSync(runnerDbPath!)).toBe(true);

        const exitPromise = new Promise<number | null>((resolve) => {
          runnerChild.on("exit", (code) => resolve(code));
        });

        // Trigger SIGTERM
        if (isWin) {
          runnerChild.send("SIGTERM");
        } else {
          runnerChild.kill("SIGTERM");
        }

        const exitCode = await exitPromise;
        if (exitCode !== 143) {
          console.error(`[TEST 16 FAILED] exitCode=${exitCode}\nSTDOUT:\n${stdoutOutput}\nSTDERR:\n${stderrOutput}`);
        }

        // Verify exit code 143
        expect(exitCode, `exitCode=${exitCode}\nSTDOUT:\n${stdoutOutput}\nSTDERR:\n${stderrOutput}`).toBe(143);

        // Verify browser Node and worker descendants stopped
        expect(isProcessAlive(browserPid!)).toBe(false);
        expect(isProcessAlive(workerPid!)).toBe(false);

        // Verify server process and port stopped
        if (runnerPort) {
          expect(await isPortAvailable(runnerPort)).toBe(true);
        }

        // Verify owned DB and all sidecars are removed
        expect(fs.existsSync(runnerDbPath!)).toBe(false);
        expect(fs.existsSync(`${runnerDbPath}-wal`)).toBe(false);

        // Verify developer DB and its sidecars remain unchanged
        const currentDevBaseline = recordDevDbBaseline(path.resolve(process.cwd(), "prisma"), "dev.db");
        expect(currentDevBaseline["dev.db"].hash).toBe(devDbBaseline["dev.db"].hash);
        expect(currentDevBaseline["dev.db"].size).toBe(devDbBaseline["dev.db"].size);
      } finally {
        if (browserPid && isProcessAlive(browserPid)) await killProcessTree(browserPid);
        if (workerPid && isProcessAlive(workerPid)) await killProcessTree(workerPid);
        if (runnerChild.pid && isProcessAlive(runnerChild.pid)) await killProcessTree(runnerChild.pid, runnerPort || undefined);
      }
    }, 20000);
  });

  describe("4. Browser Safety Validation Guard & Isolation Rejection", () => {
    it("17. Unsafe non-isolated browser-test execution is rejected by the actual production guard", async () => {
      // Start a real HTTP server that returns non-isolated health response
      const server = http.createServer((req, res) => {
        if (req.url === "/api/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "healthy",
              database: {
                status: "connected",
                provider: "sqlite",
                servicesCount: 7,
                isIsolated: false, // NOT ISOLATED
              },
            })
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}`;

      // 1. Without any env var, MUST throw safety guard violation
      await expect(verifyServerAvailable(url)).rejects.toThrow(/Safety Guard Violation/i);

      // 2. Even when setting ALLOW_UNSAFE_NON_ISOLATED_DB, MUST STILL THROW!
      process.env.ALLOW_UNSAFE_NON_ISOLATED_DB = "1";
      await expect(verifyServerAvailable(url)).rejects.toThrow(/Safety Guard Violation/i);

      delete process.env.ALLOW_UNSAFE_NON_ISOLATED_DB;
      await new Promise((resolve) => server.close(resolve));
    });

    it("18. Existing symlink and path traversal protections continue passing in production code", () => {
      // Path traversal
      expect(validateDatabaseIsolation("file:../../dev.db", "1", dummyRoot).isIsolated).toBe(false);
      expect(validateDatabaseIsolation("file:./sub/../../dev.db", "1", dummyRoot).isIsolated).toBe(false);

      // Non-file URL
      expect(validateDatabaseIsolation("postgresql://localhost:5432/e2e-isolated-1.db", "1", dummyRoot).isIsolated).toBe(false);

      // Query-string false positive
      expect(validateDatabaseIsolation("file:./dev.db?tag=e2e-isolated-1.db", "1", dummyRoot).isIsolated).toBe(false);

      // Reserved database names
      expect(validateDatabaseIsolation("file:./dev.db", "1", dummyRoot).isIsolated).toBe(false);
      expect(validateDatabaseIsolation("file:./test.db", "1", dummyRoot).isIsolated).toBe(false);
      expect(validateDatabaseIsolation("file:./tmp.db", "1", dummyRoot).isIsolated).toBe(false);

      // Valid URL
      expect(validateDatabaseIsolation("file:./e2e-isolated-1793425507455-162e2dde.db", "1", dummyRoot).isIsolated).toBe(true);
    });
  });
});
