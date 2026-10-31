import path from "path";
import fs from "fs";
import crypto from "crypto";

export interface FileIntegrityRecord {
  exists: boolean;
  size: number;
  mtimeMs: number;
  hash: string | null;
}

export type DatabaseBaseline = Record<string, FileIntegrityRecord>;

export const DB_SIDECAR_EXTENSIONS = ["", "-journal", "-wal", "-shm"] as const;

/**
 * Computes SHA-256 hash of a file if it exists.
 */
export function computeFileHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Records baseline state (existence, size, mtime, hash) of developer database and its sidecars.
 */
export function recordDatabaseBaseline(
  prismaDir: string,
  baseDbName: string = "dev.db"
): DatabaseBaseline {
  const baseline: DatabaseBaseline = {};
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
 * Verifies developer database and all sidecars against recorded baseline.
 * Returns array of detected integrity violations.
 */
export function verifyDatabaseIntegrity(
  prismaDir: string,
  baseline: DatabaseBaseline,
  baseDbName: string = "dev.db"
): string[] {
  const violations: string[] = [];

  for (const ext of DB_SIDECAR_EXTENSIONS) {
    const fileName = `${baseDbName}${ext}`;
    const fullPath = path.join(prismaDir, fileName);
    const existsNow = fs.existsSync(fullPath);
    const base = baseline[fileName] || { exists: false, size: 0, mtimeMs: 0, hash: null };

    if (!base.exists && existsNow) {
      violations.push(
        `Artifact '${fileName}' did not exist before testing, but was created during test execution.`
      );
      continue;
    }

    if (base.exists && !existsNow) {
      violations.push(
        `Artifact '${fileName}' existed before testing, but was deleted during test execution.`
      );
      continue;
    }

    if (base.exists && existsNow) {
      const statNow = fs.statSync(fullPath);
      const hashNow = computeFileHash(fullPath);

      if (statNow.size !== base.size) {
        violations.push(
          `Artifact '${fileName}' size changed! Before: ${base.size} bytes, After: ${statNow.size} bytes.`
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
