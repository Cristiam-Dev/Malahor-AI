import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { HorielError, type HorielErrorCode } from "../core/errors";
import {
  HORIEL_SQLITE_JOURNAL_MODE,
  assertHorielSchema,
  createHorielSchema,
} from "./schema";

export type HorielSqliteAccess = "create" | "read" | "write";

export interface OpenHorielSqliteInput {
  databasePath: string;
  snapshotDirectory: string;
  access: HorielSqliteAccess;
  busyTimeoutMs?: number;
}

export interface OpenedHorielDatabase {
  database: DatabaseSync;
  databasePath: string;
  snapshotDirectory: string;
  access: HorielSqliteAccess;
  busyTimeoutMs: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const MAX_BUSY_TIMEOUT_MS = 30_000;

export function normalizeSqliteError(
  error: unknown,
  fallbackCode: HorielErrorCode = "unavailable",
): HorielError {
  if (error instanceof HorielError) return error;
  const record = error && typeof error === "object"
    ? error as { message?: unknown; errcode?: unknown; code?: unknown }
    : undefined;
  const message = String(record?.message ?? "").toLowerCase();
  const errcode = Number(record?.errcode);
  if (errcode === 5 || errcode === 6 || /database is (?:locked|busy)|\bbusy\b/.test(message)) {
    return new HorielError("busy", "Horiel SQLite store is busy.");
  }
  if (/no such module:\s*fts5|fts5 is not available/.test(message)) {
    return new HorielError("capability_missing", "SQLite FTS5 capability is unavailable.");
  }
  if (/readonly|read-only/.test(message)) {
    return new HorielError("unavailable", "Horiel SQLite store is read-only.");
  }
  if (/constraint|unique/.test(message)) {
    return new HorielError("conflict", "Horiel SQLite constraint rejected the operation.");
  }
  if (/malformed|corrupt|disk image/.test(message)) {
    return new HorielError("integrity_failed", "Horiel SQLite integrity check failed.");
  }
  return new HorielError(fallbackCode, "Horiel SQLite operation failed.");
}

export function openHorielDatabase(input: OpenHorielSqliteInput): OpenedHorielDatabase {
  const normalized = normalizeOpenInput(input);
  if (normalized.access === "create") {
    return createDatabase(normalized);
  }
  return openExistingDatabase(normalized);
}

export function reopenHorielDatabase(input: {
  databasePath: string;
  snapshotDirectory: string;
  access: Exclude<HorielSqliteAccess, "create">;
  busyTimeoutMs: number;
}): OpenedHorielDatabase {
  return openExistingDatabase({ ...input });
}

export function assertSafeExistingFile(target: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HorielError("not_found", "Horiel SQLite store was not found.");
    }
    throw new HorielError("unsafe_path", "Horiel SQLite path cannot be inspected safely.");
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new HorielError("unsafe_path", "Horiel SQLite path is not a private regular file.");
  }
}

export function ensurePrivateDirectory(target: string): void {
  const resolved = path.resolve(target);
  assertSafeDirectoryChain(resolved);
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(resolved);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new HorielError("unsafe_path", "Horiel SQLite directory is unsafe.");
    }
    if (process.platform !== "win32") fs.chmodSync(resolved, 0o700);
  } catch (error) {
    if (error instanceof HorielError) throw error;
    throw new HorielError("unsafe_path", "Horiel SQLite directory cannot be prepared safely.");
  }
}

export function assertSafeSnapshotFile(target: string): void {
  assertSafeExistingFile(target);
  if (process.platform !== "win32") {
    const mode = fs.statSync(target).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new HorielError("unsafe_path", "Horiel snapshot permissions are not private.");
    }
  }
}

function normalizeOpenInput(input: OpenHorielSqliteInput): Required<OpenHorielSqliteInput> {
  if (!input || typeof input !== "object") {
    throw new HorielError("invalid_input", "Horiel SQLite open input is required.");
  }
  if (!(["create", "read", "write"] as const).includes(input.access)) {
    throw new HorielError("invalid_input", "Horiel SQLite access mode is invalid.");
  }
  if (typeof input.databasePath !== "string" || !input.databasePath
    || typeof input.snapshotDirectory !== "string" || !input.snapshotDirectory) {
    throw new HorielError("invalid_input", "Horiel SQLite paths are required.");
  }
  const databasePath = path.resolve(input.databasePath);
  const snapshotDirectory = path.resolve(input.snapshotDirectory);
  if (databasePath === snapshotDirectory || path.dirname(databasePath) === databasePath) {
    throw new HorielError("unsafe_path", "Horiel SQLite paths are unsafe.");
  }
  const busyTimeoutMs = input.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new HorielError("invalid_input", "Horiel SQLite busy timeout is invalid.");
  }
  return {
    databasePath,
    snapshotDirectory,
    access: input.access,
    busyTimeoutMs,
  };
}

function createDatabase(input: Required<OpenHorielSqliteInput>): OpenedHorielDatabase {
  if (fs.existsSync(input.databasePath)) {
    const existing = fs.lstatSync(input.databasePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new HorielError("unsafe_path", "Horiel SQLite create target is unsafe.");
    }
    throw new HorielError("conflict", "Horiel SQLite store already exists.");
  }
  ensurePrivateDirectory(path.dirname(input.databasePath));
  ensurePrivateDirectory(input.snapshotDirectory);

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(input.databasePath, databaseOptions(false, input.busyTimeoutMs));
    if (process.platform !== "win32") fs.chmodSync(input.databasePath, 0o600);
    configureWritableConnection(database, input.busyTimeoutMs);
    createHorielSchema(database, {
      storeId: `store_${randomBytes(16).toString("hex")}`,
      createdAt: new Date().toISOString(),
    });
    database.exec("PRAGMA trusted_schema = OFF");
    assertHorielSchema(database);
    return { database, ...input };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The original create failure is authoritative.
    }
    try {
      if (fs.existsSync(input.databasePath)) fs.rmSync(input.databasePath, { force: true });
    } catch {
      // A partial file is still reported by the original safe error.
    }
    throw normalizeSqliteError(error, "integrity_failed");
  }
}

function openExistingDatabase(input: Required<OpenHorielSqliteInput>): OpenedHorielDatabase {
  if (input.access === "create") {
    throw new HorielError("invalid_input", "Existing Horiel store cannot use create access.");
  }
  assertSafeExistingFile(input.databasePath);
  if (input.access === "write") ensurePrivateDirectory(input.snapshotDirectory);
  else if (fs.existsSync(input.snapshotDirectory)) assertExistingDirectory(input.snapshotDirectory);

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(
      input.databasePath,
      databaseOptions(input.access === "read", input.busyTimeoutMs),
    );
    configureExistingConnection(database, input.access, input.busyTimeoutMs);
    assertHorielSchema(database);
    if (input.access === "write") {
      // If an abrupt process left a rollback journal behind, let SQLite replace
      // it with a complete no-op write journal and remove it on commit. This is
      // safer than deleting a potentially hot journal from the filesystem.
      if (fs.existsSync(`${input.databasePath}-journal`)) {
        database.exec(`
          BEGIN IMMEDIATE;
          UPDATE horiel_store SET sequence = sequence + 1 WHERE singleton = 1;
          UPDATE horiel_store SET sequence = sequence - 1 WHERE singleton = 1;
          COMMIT;
        `);
      }
    }
    return { database, ...input };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The validation failure is authoritative.
    }
    throw normalizeSqliteError(error, "integrity_failed");
  }
}

function databaseOptions(readOnly: boolean, timeout: number): ConstructorParameters<typeof DatabaseSync>[1] {
  return {
    readOnly,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout,
    readBigInts: false,
    returnArrays: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  };
}

function configureWritableConnection(database: DatabaseSync, timeout: number): void {
  database.exec(`PRAGMA busy_timeout = ${timeout}`);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA journal_mode = ${HORIEL_SQLITE_JOURNAL_MODE.toUpperCase()}`);
  database.exec("PRAGMA synchronous = FULL");
}

function configureExistingConnection(
  database: DatabaseSync,
  access: Exclude<HorielSqliteAccess, "create">,
  timeout: number,
): void {
  database.exec(`PRAGMA busy_timeout = ${timeout}`);
  database.exec("PRAGMA foreign_keys = ON");
  if (access === "write") {
    database.exec(`PRAGMA journal_mode = ${HORIEL_SQLITE_JOURNAL_MODE.toUpperCase()}`);
  } else {
    const row = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (String(row?.journal_mode ?? "").toLowerCase() !== HORIEL_SQLITE_JOURNAL_MODE) {
      throw new HorielError("integrity_failed", "Horiel SQLite journal mode is incompatible.");
    }
  }
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA trusted_schema = OFF");
}

function assertExistingDirectory(target: string): void {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new HorielError("unsafe_path", "Horiel snapshot directory is unsafe.");
  }
}

function assertSafeDirectoryChain(target: string): void {
  const parsed = path.parse(target);
  const relative = path.relative(parsed.root, target);
  let current = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new HorielError("unsafe_path", "Horiel SQLite path traverses an unsafe directory.");
    }
  }
}
