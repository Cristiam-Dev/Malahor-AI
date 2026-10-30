import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backupFile, type BackupResult } from "../cli/core/backup";
import { loadConfig } from "../cli/core/config";
import { assertHooksAllowed } from "../cli/core/hooks/engine";
import type { HookContext } from "../cli/core/hooks/types";
import * as json from "./json-store";
import { MemoryEngine, MemoryError } from "./engine";
import { privateDirectory, privateFile } from "./engine/paths";
import { mnemoHookContext } from "./hook-context";
import { assertNoSqliteSidecars, hashPrivateFile, removeIfPresent } from "./migration/files";
import { readLegacyMemorySnapshot } from "./migration/snapshot";
import { memoryLocation, withMemoryStorage } from "./storage";

export interface MemoryRestorePreview {
  backup: string;
  backend: "json" | "sqlite";
  sha256: string;
  observations: number;
  sessions: number;
  pins: number;
  relations: number;
  nextId: number;
  maxObservationId: number;
  requiresConfirmation: "RESTORE";
  valid: boolean;
}

export interface MemoryRestoreResult extends MemoryRestorePreview {
  currentBackup: BackupResult;
  restored: true;
}

export interface MemoryAdminApplyOptions {
  harness?: HookContext["harness"];
  approval?: string;
}

interface JsonRestoreCandidate {
  preview: MemoryRestorePreview;
  db: json.MnemoDb;
}

interface SqliteRestoreCandidate {
  preview: MemoryRestorePreview;
}

export function backupMemory(filePath = json.dbPath(), dryRun = false,
  backupsDir = backupsDirForDb(filePath)): BackupResult {
  return withMemoryStorage(filePath, "read", {
    json: (file) => backupFile(file, backupsDir, dryRun),
    sqlite: (engine) => backupSqliteMemory(engine, backupsDir, dryRun),
  });
}

export function previewMemoryRestore(backupPath: string, filePath = json.dbPath()): MemoryRestorePreview {
  const sourcePath = resolveBackupPath(backupPath, filePath);
  const location = memoryLocation(filePath);
  return location.backend === "sqlite"
    ? inspectSqliteBackup(sourcePath).preview
    : inspectJsonBackup(sourcePath).preview;
}

export function restoreMemoryBackup(backupPath: string, confirm: string, filePath = json.dbPath(),
  options: MemoryAdminApplyOptions = {}): MemoryRestoreResult {
  const preview = previewMemoryRestore(backupPath, filePath);
  if (confirm !== preview.requiresConfirmation) {
    throw new Error("Confirmacion invalida. Para restaurar, confirm debe ser: RESTORE");
  }

  const activeFile = memoryLocation(filePath).file;
  assertHooksAllowed(mnemoHookContext("memory.restore.apply", options.harness ?? "mcp", {
    approval: options.approval,
    confirmation: confirm,
    destructive: true,
    targetPaths: [activeFile, preview.backup],
    metadata: {
      backend: preview.backend,
      previewToken: `restore:${preview.backend}:${preview.sha256}:${preview.observations}:${preview.sessions}`,
      requiresConfirmation: preview.requiresConfirmation,
      writesMalahorData: true,
    },
  }));

  const currentBackup = withMemoryStorage(filePath, "write", {
    json: (file) => restoreJson(file, preview),
    sqlite: (engine) => restoreSqlite(engine, preview, backupsDirForDb(filePath)),
  });
  return { ...preview, currentBackup, restored: true };
}

export function backupsDirForDb(filePath: string): string {
  return path.join(path.dirname(path.dirname(filePath)), "backups");
}

function restoreJson(file: string, expected: MemoryRestorePreview): BackupResult {
  if (expected.backend !== "json") throw backendChanged();
  const candidate = inspectJsonBackup(expected.backup);
  assertSamePreview(candidate.preview, expected);
  const currentBackup = backupFile(file, backupsDirForDb(file), false);
  json.saveDb(candidate.db, file);
  return currentBackup;
}

function restoreSqlite(engine: MemoryEngine, expected: MemoryRestorePreview, backupsDir: string): BackupResult {
  if (expected.backend !== "sqlite") throw backendChanged();
  const candidate = inspectSqliteBackup(expected.backup);
  assertSamePreview(candidate.preview, expected);
  const staging = stageSqliteBackup(expected.backup, expected.sha256, engine.file);
  try {
    validateSqliteStaging(staging);
    const currentBackup = backupSqliteMemory(engine, backupsDir, false);
    engine.restore(staging);
    return currentBackup;
  } finally {
    for (const suffix of ["-wal", "-shm", ""]) removeIfPresent(`${staging}${suffix}`);
  }
}

function inspectJsonBackup(sourcePath: string): JsonRestoreCandidate {
  const snapshot = readLegacyMemorySnapshot(sourcePath, loadConfig().projects.aliases);
  return {
    db: snapshot.db,
    preview: {
      backup: sourcePath,
      backend: "json",
      sha256: snapshot.hash,
      observations: snapshot.db.observations.length,
      sessions: snapshot.db.sessions.length,
      pins: 0,
      relations: 0,
      nextId: snapshot.db.nextId,
      maxObservationId: snapshot.maxObservationId,
      requiresConfirmation: "RESTORE",
      valid: true,
    },
  };
}

function inspectSqliteBackup(sourcePath: string): SqliteRestoreCandidate {
  assertNoSqliteSidecars(sourcePath);
  assertSealedSqliteBackup(sourcePath);
  const beforeHash = hashPrivateFile(sourcePath);
  const engine = MemoryEngine.open(sourcePath, { access: "read", aliases: loadConfig().projects.aliases });
  let candidate: SqliteRestoreCandidate;
  try {
    engine.verifyReadOnly();
    const statistics = engine.statistics();
    const afterHash = hashPrivateFile(sourcePath);
    if (beforeHash !== afterHash) throw new MemoryError("MEMORY_BUSY", "El backup SQLite cambio durante el preview.");
    candidate = {
      preview: {
        backup: sourcePath,
        backend: "sqlite",
        sha256: beforeHash,
        observations: statistics.observations,
        sessions: statistics.sessions,
        pins: statistics.pins,
        relations: statistics.relations,
        nextId: statistics.nextId,
        maxObservationId: statistics.maxObservationId,
        requiresConfirmation: "RESTORE",
        valid: true,
      },
    };
  } finally {
    engine.close();
  }
  assertNoSqliteSidecars(sourcePath);
  return candidate;
}

function assertSealedSqliteBackup(file: string): void {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(20);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length
      || header[18] !== 1 || header[19] !== 1) {
      throw new MemoryError("MEMORY_FORMAT", "El backup SQLite no esta sellado sin WAL; crea un backup consistente nuevo.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function backupSqliteMemory(engine: MemoryEngine, backupsDir: string, dryRun: boolean): BackupResult {
  const destination = path.join(backupsDir, `memory-${Date.now()}-${randomUUID()}.sqlite`);
  if (!dryRun) engine.backup(destination);
  return { source: engine.file, destination, created: true };
}

function stageSqliteBackup(source: string, expectedHash: string, activeFile: string): string {
  if (hashPrivateFile(source) !== expectedHash) throw new MemoryError("MEMORY_BUSY", "El backup SQLite cambio desde el preview.");
  const staging = path.join(path.dirname(activeFile), `.restore-${randomUUID()}.sqlite`);
  try {
    fs.copyFileSync(source, staging, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(staging, 0o600);
    const descriptor = fs.openSync(staging, "r+");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (hashPrivateFile(source) !== expectedHash || hashPrivateFile(staging) !== expectedHash) {
      throw new MemoryError("MEMORY_BUSY", "El backup SQLite cambio durante la copia provisional.");
    }
    return staging;
  } catch (error) {
    removeIfPresent(staging);
    throw error;
  }
}

function validateSqliteStaging(staging: string): void {
  const engine = MemoryEngine.open(staging, { access: "write", aliases: loadConfig().projects.aliases });
  try {
    engine.integrity();
    engine.seal();
  } finally {
    engine.close();
  }
  assertNoSqliteSidecars(staging);
}

function resolveBackupPath(backupPath: string, filePath: string): string {
  const backupsDir = backupsDirForDb(filePath);
  if (!fs.existsSync(backupsDir)) throw new Error(`Carpeta de backups no encontrada: ${backupsDir}`);
  privateDirectory(backupsDir);
  const requested = path.isAbsolute(backupPath) ? path.resolve(backupPath) : path.resolve(backupsDir, backupPath);
  if (!fs.existsSync(requested)) throw new Error(`Backup no encontrado: ${requested}`);
  privateFile(requested);
  const backupsRealPath = fs.realpathSync(backupsDir);
  const sourceRealPath = fs.realpathSync(requested);
  const relative = path.relative(backupsRealPath, sourceRealPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Restore solo acepta backups dentro de ${backupsRealPath}`);
  }
  return sourceRealPath;
}

function assertSamePreview(current: MemoryRestorePreview, expected: MemoryRestorePreview): void {
  if (current.backend !== expected.backend || current.sha256 !== expected.sha256
    || current.observations !== expected.observations || current.sessions !== expected.sessions
    || current.pins !== expected.pins || current.relations !== expected.relations
    || current.nextId !== expected.nextId || current.maxObservationId !== expected.maxObservationId) {
    throw new MemoryError("MEMORY_BUSY", "El backup cambio desde el preview; solicita uno nuevo.");
  }
}

function backendChanged(): MemoryError {
  return new MemoryError("MEMORY_ACTIVATION", "El almacenamiento activo cambio desde el preview; solicita uno nuevo.");
}
