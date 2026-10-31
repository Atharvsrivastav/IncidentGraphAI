import path from "path";
import fs from "fs";

export interface DatabaseIsolationResult {
  isIsolated: boolean;
  reason?: string;
  resolvedPath?: string;
  fileName?: string;
}

export const DISPOSABLE_DB_REGEX = /^e2e-(?:isolated|ci)-[a-zA-Z0-9_\-]+-[a-f0-9]{4,32}\.db$/i;

export const FORBIDDEN_DB_NAMES = [
  "dev.db",
  "test.db",
  "tmp.db",
  "temp.db",
  "prod.db",
  "production.db",
  "shared.db",
];

/**
 * Validates whether a given DATABASE_URL points to an isolated, disposable SQLite database
 * that conforms to project conventions and safety guarantees.
 */
export function validateDatabaseIsolation(
  databaseUrl: string | undefined,
  envFlag: string | undefined = process.env.E2E_ISOLATED,
  projectRoot: string = process.cwd()
): DatabaseIsolationResult {
  // 1. Explicit E2E isolated runtime mode must be enabled
  const isExplicitMode = envFlag === "1" || envFlag === "true";
  if (!isExplicitMode) {
    return {
      isIsolated: false,
      reason: "E2E_ISOLATED environment variable is not explicitly set to '1' or 'true'",
    };
  }

  if (!databaseUrl || typeof databaseUrl !== "string") {
    return {
      isIsolated: false,
      reason: "DATABASE_URL is missing or empty",
    };
  }

  // 2. Reject non-file protocols (PostgreSQL, MySQL, etc.) immediately
  // Even if URL has query parameters with e2e-isolated filenames
  if (!databaseUrl.startsWith("file:")) {
    return {
      isIsolated: false,
      reason: "DATABASE_URL protocol is not 'file:' (SQLite required)",
    };
  }

  // 3. Extract the file path component (strip query params and hash)
  const rawPath = databaseUrl.slice("file:".length);
  const pathWithoutQuery = rawPath.split("?")[0].split("#")[0];

  if (!pathWithoutQuery || pathWithoutQuery.trim() === "") {
    return {
      isIsolated: false,
      reason: "SQLite file URL path component is empty",
    };
  }

  // 4. Resolve the path using Prisma's SQLite path resolution semantics
  // In Prisma, relative paths are resolved relative to the schema directory: <projectRoot>/prisma
  const prismaDir = path.resolve(projectRoot, "prisma");
  const resolvedPath = path.isAbsolute(pathWithoutQuery)
    ? path.resolve(pathWithoutQuery)
    : path.resolve(prismaDir, pathWithoutQuery);

  // 5. Require the resolved file to be inside the intended disposable directory (<projectRoot>/prisma)
  const relToPrisma = path.relative(prismaDir, resolvedPath);
  if (
    relToPrisma.startsWith("..") ||
    path.isAbsolute(relToPrisma) ||
    path.dirname(resolvedPath).toLowerCase() !== prismaDir.toLowerCase()
  ) {
    return {
      isIsolated: false,
      reason: "Database path resolves outside the disposable prisma directory (path traversal detected)",
      resolvedPath,
    };
  }

  const fileName = path.basename(resolvedPath);

  // 6. Reject known shared / persistent database names regardless of path or query
  if (FORBIDDEN_DB_NAMES.includes(fileName.toLowerCase())) {
    return {
      isIsolated: false,
      reason: `Database filename '${fileName}' is a reserved/shared database name`,
      resolvedPath,
      fileName,
    };
  }

  // 7. Enforce strict disposable naming pattern: e2e-isolated-<uniqueId>-<nonce>.db
  if (!DISPOSABLE_DB_REGEX.test(fileName)) {
    return {
      isIsolated: false,
      reason: `Filename '${fileName}' does not match disposable database pattern: ${DISPOSABLE_DB_REGEX}`,
      resolvedPath,
      fileName,
    };
  }

  // 8. Reject symlinks: verify if file exists on disk that it is not a symlink
  try {
    if (fs.existsSync(resolvedPath)) {
      const lstat = fs.lstatSync(resolvedPath);
      if (lstat.isSymbolicLink()) {
        return {
          isIsolated: false,
          reason: "Database file is a symbolic link (symlinks are forbidden)",
          resolvedPath,
          fileName,
        };
      }

      const realPath = fs.realpathSync(resolvedPath);
      if (path.resolve(realPath).toLowerCase() !== path.resolve(resolvedPath).toLowerCase()) {
        return {
          isIsolated: false,
          reason: "Database realpath does not match resolved path (target is aliased or symlinked)",
          resolvedPath,
          fileName,
        };
      }
    }
  } catch (err: unknown) {
    return {
      isIsolated: false,
      reason: `Filesystem check failed: ${err instanceof Error ? err.message : String(err)}`,
      resolvedPath,
      fileName,
    };
  }

  return {
    isIsolated: true,
    resolvedPath,
    fileName,
  };
}
