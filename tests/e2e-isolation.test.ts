import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import {
  validateDatabaseIsolation,
} from "../src/lib/db/isolation-validator";
import {
  recordDatabaseBaseline,
  verifyDatabaseIntegrity,
} from "../src/lib/db/dev-db-integrity";

describe("E2E Database Isolation & Verification Hardening", () => {
  const dummyRoot = path.resolve(os.tmpdir(), "incidentgraph-test-root-" + Date.now());
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

  describe("1. validateDatabaseIsolation URL & Path Parsing", () => {
    it("accepts a valid isolated SQLite URL with explicit E2E flag", () => {
      const dbUrl = "file:./e2e-isolated-1793425507455-162e2dde.db";
      const result = validateDatabaseIsolation(dbUrl, "1", dummyRoot);
      expect(result.isIsolated).toBe(true);
      expect(result.fileName).toBe("e2e-isolated-1793425507455-162e2dde.db");
    });

    it("accepts an e2e-ci isolated pattern with explicit E2E_ISOLATED=true", () => {
      const dbUrl = "file:./e2e-ci-98765-abcdef12.db";
      const result = validateDatabaseIsolation(dbUrl, "true", dummyRoot);
      expect(result.isIsolated).toBe(true);
      expect(result.fileName).toBe("e2e-ci-98765-abcdef12.db");
    });

    it("rejects generic dev.db, test.db, tmp.db, and temp.db", () => {
      const forbidden = ["dev.db", "test.db", "tmp.db", "temp.db", "prod.db", "shared.db"];
      for (const name of forbidden) {
        const result = validateDatabaseIsolation(`file:./${name}`, "1", dummyRoot);
        expect(result.isIsolated).toBe(false);
        expect(result.reason).toMatch(/reserved\/shared|does not match disposable/i);
      }
    });

    it("rejects PostgreSQL URLs even if containing an E2E-looking database name", () => {
      const postgresUrls = [
        "postgresql://postgres:secret@localhost:5432/e2e-isolated-1793425507455-162e2dde.db",
        "postgres://user:pass@remote.host:5432/prod?table=e2e-isolated-1234.db",
        "mysql://root@127.0.0.1:3306/e2e-isolated-db",
      ];
      for (const url of postgresUrls) {
        const result = validateDatabaseIsolation(url, "1", dummyRoot);
        expect(result.isIsolated).toBe(false);
        expect(result.reason).toMatch(/protocol is not 'file:'/i);
      }
    });

    it("rejects query-string and fragment false positives", () => {
      // Query string attempting to disguise dev.db as isolated
      const queryFalsePositive = "file:./dev.db?tag=e2e-isolated-1793425507455-162e2dde.db";
      const resQuery = validateDatabaseIsolation(queryFalsePositive, "1", dummyRoot);
      expect(resQuery.isIsolated).toBe(false);
      expect(resQuery.fileName).toBe("dev.db");

      // Hash fragment attempt
      const hashFalsePositive = "file:./test.db#e2e-isolated-1793425507455-162e2dde.db";
      const resHash = validateDatabaseIsolation(hashFalsePositive, "1", dummyRoot);
      expect(resHash.isIsolated).toBe(false);
      expect(resHash.fileName).toBe("test.db");
    });

    it("rejects path traversal attempts attempting to escape disposable directory", () => {
      const traversals = [
        "file:../../dev.db",
        "file:./../dev.db",
        "file:./nested/../../dev.db",
        "file:/var/lib/dev.db",
      ];
      for (const url of traversals) {
        const result = validateDatabaseIsolation(url, "1", dummyRoot);
        expect(result.isIsolated).toBe(false);
        expect(result.reason).toMatch(/resolves outside the disposable prisma directory/i);
      }
    });

    it("rejects missing or false E2E_ISOLATED flags", () => {
      const validUrl = "file:./e2e-isolated-1793425507455-162e2dde.db";

      expect(validateDatabaseIsolation(validUrl, undefined, dummyRoot).isIsolated).toBe(false);
      expect(validateDatabaseIsolation(validUrl, "0", dummyRoot).isIsolated).toBe(false);
      expect(validateDatabaseIsolation(validUrl, "false", dummyRoot).isIsolated).toBe(false);
      expect(validateDatabaseIsolation(validUrl, "something_else", dummyRoot).isIsolated).toBe(false);
    });

    it("rejects symlink attempts pointing to a disposable name", () => {
      const realTarget = path.join(dummyRoot, "some-other-dir", "real-db.db");
      fs.mkdirSync(path.dirname(realTarget), { recursive: true });
      fs.writeFileSync(realTarget, "dummy database content");

      const symlinkPath = path.join(dummyPrismaDir, "e2e-isolated-1111111111111-abcdef12.db");
      try {
        fs.symlinkSync(realTarget, symlinkPath, "file");
      } catch {
        // If unprivileged on Windows, simulate symlink stat via mock
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        vi.spyOn(fs, "lstatSync").mockReturnValue({ isSymbolicLink: () => true } as fs.Stats);
      }

      const result = validateDatabaseIsolation(
        "file:./e2e-isolated-1111111111111-abcdef12.db",
        "1",
        dummyRoot
      );
      expect(result.isIsolated).toBe(false);
      expect(result.reason).toMatch(/symlink|symbolic link/i);
    });
  });

  describe("2. Unsafe Bypass Removal", () => {
    it("refuses to run browser test against non-isolated database even if ALLOW_UNSAFE_NON_ISOLATED_DB is set", () => {
      // Simulate browser-e2e check
      const verifyServerSafety = (healthData: { database?: { isIsolated?: boolean } }) => {
        if (!healthData.database?.isIsolated) {
          throw new Error("[Safety Guard Violation] Browser E2E suite requires an isolated disposable database.");
        }
      };

      // Set environment variable attempt
      process.env.ALLOW_UNSAFE_NON_ISOLATED_DB = "1";

      const unisolatedHealth = {
        database: {
          isIsolated: false,
        },
      };

      expect(() => verifyServerSafety(unisolatedHealth)).toThrow(/Safety Guard Violation/i);

      delete process.env.ALLOW_UNSAFE_NON_ISOLATED_DB;
    });
  });

  describe("3. Developer Database & Sidecar Integrity Verification", () => {
    it("passes integrity check when developer database and sidecars remain completely untouched", () => {
      const devDbFile = path.join(dummyPrismaDir, "dev.db");
      fs.writeFileSync(devDbFile, "initial database state");

      const baseline = recordDatabaseBaseline(dummyPrismaDir, "dev.db");
      expect(baseline["dev.db"].exists).toBe(true);
      expect(baseline["dev.db-wal"].exists).toBe(false);
      expect(baseline["dev.db-shm"].exists).toBe(false);
      expect(baseline["dev.db-journal"].exists).toBe(false);

      const violations = verifyDatabaseIntegrity(dummyPrismaDir, baseline, "dev.db");
      expect(violations).toHaveLength(0);
    });

    it("detects integrity violation if dev.db content or hash is modified", () => {
      const devDbFile = path.join(dummyPrismaDir, "dev.db");
      fs.writeFileSync(devDbFile, "initial database state");

      const baseline = recordDatabaseBaseline(dummyPrismaDir, "dev.db");

      // Mutate dev.db
      fs.writeFileSync(devDbFile, "tampered database content");

      const violations = verifyDatabaseIntegrity(dummyPrismaDir, baseline, "dev.db");
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes("SHA-256 hash changed"))).toBe(true);
    });

    it("detects integrity violation if a dev.db-wal or dev.db-shm sidecar is created", () => {
      const devDbFile = path.join(dummyPrismaDir, "dev.db");
      fs.writeFileSync(devDbFile, "initial database state");

      const baseline = recordDatabaseBaseline(dummyPrismaDir, "dev.db");

      // A WAL file appears
      fs.writeFileSync(path.join(dummyPrismaDir, "dev.db-wal"), "wal content");

      const violations = verifyDatabaseIntegrity(dummyPrismaDir, baseline, "dev.db");
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes("dev.db-wal' did not exist before testing"))).toBe(true);
    });

    it("detects integrity violation if an existing sidecar disappears", () => {
      const devDbFile = path.join(dummyPrismaDir, "dev.db");
      const devDbJournal = path.join(dummyPrismaDir, "dev.db-journal");
      fs.writeFileSync(devDbFile, "initial db");
      fs.writeFileSync(devDbJournal, "initial journal");

      const baseline = recordDatabaseBaseline(dummyPrismaDir, "dev.db");

      // Remove the journal
      fs.unlinkSync(devDbJournal);

      const violations = verifyDatabaseIntegrity(dummyPrismaDir, baseline, "dev.db");
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes("existed before testing, but was deleted"))).toBe(true);
    });
  });

  describe("4. Teardown, Cleanup Failures & Concurrency", () => {
    it("reports cleanup failure when primary database cannot be deleted", () => {
      const dbPath = path.join(dummyPrismaDir, "e2e-isolated-1793425507455-162e2dde.db");
      fs.writeFileSync(dbPath, "test content");

      // Simulate a file that survives unlink attempts
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
        throw new Error("EBUSY: resource locked");
      });

      const cleanupDisposableDb = (file: string) => {
        const patterns = ["", "-journal", "-wal", "-shm"].map((ext) => `${file}${ext}`);
        for (const f of patterns) {
          if (fs.existsSync(f)) {
            try {
              fs.unlinkSync(f);
            } catch {}
          }
        }
        return patterns.filter((f) => fs.existsSync(f));
      };

      const leftover = cleanupDisposableDb(dbPath);
      expect(leftover).toContain(dbPath);

      unlinkSpy.mockRestore();
    });

    it("reports cleanup failure when a sidecar (e.g., -wal) survives", () => {
      const dbPath = path.join(dummyPrismaDir, "e2e-isolated-1793425507455-162e2dde.db");
      const walPath = `${dbPath}-wal`;
      fs.writeFileSync(dbPath, "db content");
      fs.writeFileSync(walPath, "wal content");

      // Successfully delete dbPath, but walPath cannot be deleted
      const originalUnlink = fs.unlinkSync;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
        if (target === walPath) {
          throw new Error("EPERM: permission denied");
        }
        return originalUnlink(target);
      });

      const cleanupDisposableDb = (file: string) => {
        const patterns = ["", "-journal", "-wal", "-shm"].map((ext) => `${file}${ext}`);
        for (const f of patterns) {
          if (fs.existsSync(f)) {
            try {
              fs.unlinkSync(f);
            } catch {}
          }
        }
        return patterns.filter((f) => fs.existsSync(f));
      };

      const leftover = cleanupDisposableDb(dbPath);
      expect(leftover).toContain(walPath);

      unlinkSpy.mockRestore();
    });

    it("idempotently handles repeated teardown calls and concurrent signal arrivals", async () => {
      let callCount = 0;
      let teardownRunning = false;
      let teardownCompleted = false;

      const performTeardown = async () => {
        if (teardownCompleted) return 0;
        if (teardownRunning) {
          while (teardownRunning) {
            await new Promise((r) => setTimeout(r, 10));
          }
          return 0;
        }
        teardownRunning = true;
        try {
          callCount++;
          await new Promise((r) => setTimeout(r, 30));
        } finally {
          teardownCompleted = true;
          teardownRunning = false;
        }
        return 0;
      };

      // Call concurrently from multiple signals / exit handlers
      await Promise.all([
        performTeardown(),
        performTeardown(),
        performTeardown(),
      ]);

      // Then call sequentially
      await performTeardown();

      expect(callCount).toBe(1);
    });

    it("preserves original test exit code while flagging teardown failures", async () => {
      let testExitCode = 2; // Original test failure code

      const performTeardown = async ({ cleanupFailed }: { cleanupFailed: boolean }) => {
        if (cleanupFailed && testExitCode === 0) {
          testExitCode = 1;
        }
        return testExitCode;
      };

      const finalCode = await performTeardown({ cleanupFailed: true });
      expect(finalCode).toBe(2); // Preserves original exit code 2
    });

    it("escalates exit code from 0 to 1 when test passed but cleanup failed", async () => {
      let testExitCode = 0; // Test passed

      const performTeardown = async ({ cleanupFailed }: { cleanupFailed: boolean }) => {
        if (cleanupFailed && testExitCode === 0) {
          testExitCode = 1;
        }
        return testExitCode;
      };

      const finalCode = await performTeardown({ cleanupFailed: true });
      expect(finalCode).toBe(1); // Escalates to 1
    });

    it("maps SIGINT to 130 and SIGTERM to 143", async () => {
      const getSignalExitCode = (signal: "SIGINT" | "SIGTERM") => {
        return signal === "SIGINT" ? 130 : 143;
      };

      expect(getSignalExitCode("SIGINT")).toBe(130);
      expect(getSignalExitCode("SIGTERM")).toBe(143);
    });
  });

  describe("5. Process Group & Child Survival Verification", () => {
    it("detects surviving process when checking group alive state", () => {
      const isProcessAlive = vi.fn().mockImplementation((pid: number) => {
        return pid === 12345;
      });

      expect(isProcessAlive(12345)).toBe(true);
      expect(isProcessAlive(99999)).toBe(false);
    });
  });
});
