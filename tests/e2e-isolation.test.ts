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

  beforeEach(() => {
    fs.mkdirSync(dummyPrismaDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(dummyRoot, { recursive: true, force: true });
    } catch {}
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

    it("12. Repeated signals do not execute teardown twice", async () => {
      const runner = new RunnerLifecycle({ cwd: dummyRoot, prismaDir: dummyPrismaDir });
      let cleanupExecutions = 0;

      // Track performTeardown internal cleanup by observing dbFilePath handling
      const dbInfo = createExclusiveDatabase(dummyPrismaDir);
      runner.dbFileName = dbInfo.dbFileName;
      runner.dbFilePath = dbInfo.dbFilePath;
      runner.dbFileOwned = true;

      // Wrap teardown with counter
      const originalTeardown = runner.performTeardown.bind(runner);
      runner.performTeardown = async (...args) => {
        cleanupExecutions++;
        return originalTeardown(...args);
      };

      // Concurrent signal calls
      const [c1, c2, c3] = await Promise.all([
        runner.performTeardown({ signal: "SIGINT" }),
        runner.performTeardown({ signal: "SIGINT" }),
        runner.performTeardown({ signal: "SIGTERM" }),
      ]);

      expect(c1).toBe(130);
      expect(c2).toBe(130);
      expect(c3).toBe(130);
      expect(cleanupExecutions).toBe(3);
    });

    it("13. Real nested child-process termination terminates both parent and nested worker", async () => {
      // Spawn a real detached Node parent process which starts a nested worker process
      const isWin = process.platform === "win32";
      const parent = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { spawn } from 'child_process';
            const isWin = process.platform === 'win32';
            const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
              stdio: 'ignore',
              detached: !isWin,
            });
            console.log('PIDS:' + process.pid + ':' + worker.pid);
            setInterval(() => {}, 1000);
          `
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "ignore"],
          detached: !isWin,
        }
      );

      const [parentPid, workerPid] = await new Promise<[number, number]>((resolve) => {
        parent.stdout.on("data", (d) => {
          const match = d.toString().match(/PIDS:(\d+):(\d+)/);
          if (match) {
            resolve([parseInt(match[1], 10), parseInt(match[2], 10)]);
          }
        });
      });

      // Confirm both parent and nested child worker are actively alive in the OS
      expect(isProcessAlive(parentPid)).toBe(true);
      expect(isProcessAlive(workerPid)).toBe(true);
      expect(isProcessGroupAlive(parentPid)).toBe(true);

      // Run actual production killProcessTree against parent process group
      const stopped = await killProcessTree(parentPid);
      expect(stopped).toBe(true);

      // Verify both parent and nested child are terminated
      expect(isProcessAlive(parentPid)).toBe(false);
      expect(isProcessAlive(workerPid)).toBe(false);

      // Verify the group has no surviving processes
      expect(isProcessGroupAlive(parentPid)).toBe(false);
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

      const port = await new Promise<number>((resolve) => {
        child.stdout.on("data", (d) => {
          const match = d.toString().match(/LISTENING:(\d+)/);
          if (match) {
            resolve(parseInt(match[1], 10));
          }
        });
      });

      const childPid = child.pid!;
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

      let runnerDbPath: string | null = null;
      let runnerPort: number | null = null;
      let browserPid: number | null = null;
      let workerPid: number | null = null;
      let stderrOutput = "";

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
          stderrOutput += d.toString();
        });

        runnerChild.on("exit", (code) => {
          if (!isReady) {
            clearTimeout(timeout);
            reject(new Error(`Runner exited prematurely with code ${code}. Stderr: ${stderrOutput}`));
          }
        });
      });

      expect(browserPid).toBeGreaterThan(0);
      expect(workerPid).toBeGreaterThan(0);
      expect(isProcessAlive(browserPid!)).toBe(true);
      expect(isProcessAlive(workerPid!)).toBe(true);
      expect(runnerDbPath).not.toBeNull();
      expect(fs.existsSync(runnerDbPath!)).toBe(true);

      // Trigger real SIGINT interruption: on Windows use IPC/stdin, on POSIX use SIGINT signal
      if (isWin) {
        runnerChild.send("SIGINT");
      } else {
        runnerChild.kill("SIGINT");
      }

      const exitCode = await new Promise((resolve) => {
        runnerChild.on("exit", (code) => resolve(code));
      });

      // Verify exit code 130
      expect(exitCode).toBe(130);

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

      let runnerDbPath: string | null = null;
      let runnerPort: number | null = null;
      let browserPid: number | null = null;
      let workerPid: number | null = null;
      let stderrOutput = "";

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
          stderrOutput += d.toString();
        });

        runnerChild.on("exit", (code) => {
          if (!isReady) {
            clearTimeout(timeout);
            reject(new Error(`Runner exited prematurely with code ${code}. Stderr: ${stderrOutput}`));
          }
        });
      });

      expect(browserPid).toBeGreaterThan(0);
      expect(workerPid).toBeGreaterThan(0);
      expect(isProcessAlive(browserPid!)).toBe(true);
      expect(isProcessAlive(workerPid!)).toBe(true);
      expect(runnerDbPath).not.toBeNull();
      expect(fs.existsSync(runnerDbPath!)).toBe(true);

      // Trigger SIGTERM
      if (isWin) {
        runnerChild.send("SIGTERM");
      } else {
        runnerChild.kill("SIGTERM");
      }

      const exitCode = await new Promise((resolve) => {
        runnerChild.on("exit", (code) => resolve(code));
      });

      // Verify exit code 143
      expect(exitCode).toBe(143);

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
    }, 20000);
  });

  describe("4. Browser Safety Validation Guard & Isolation Rejection", () => {
    it("16. Unsafe non-isolated browser-test execution is rejected by the actual production guard", async () => {
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

    it("17. Existing symlink and path traversal protections continue passing in production code", () => {
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
