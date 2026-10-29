import fs from "node:fs";
import path from "node:path";
import { backupFile, type BackupResult } from "../cli/core/backup";
import { assertHooksAllowed } from "../cli/core/hooks/engine";
import { mcpHookContext } from "./hook-context";
import { dbPath, loadDb, saveDb, type MnemoDb } from "./db";
import { randomUUID } from "node:crypto";
import { assertJsonMemory, withMemoryStorage } from "./storage";

export interface MemoryRestorePreview {
  backup: string;
  observations: number;
  sessions: number;
  maxObservationId: number;
  requiresConfirmation: "RESTORE";
  valid: boolean;
}

export interface MemoryRestoreResult extends MemoryRestorePreview {
  currentBackup: BackupResult;
  restored: true;
}

export function backupMemory(filePath = dbPath(), dryRun = false, backupsDir = backupsDirForDb(filePath)): BackupResult {
  return withMemoryStorage(filePath, "read", {
    json: (file) => backupFile(file, backupsDir, dryRun),
    sqlite: (engine) => {
      const source = path.join(path.dirname(path.dirname(filePath)), "memory", "db.sqlite");
      const destination = path.join(backupsDir, `memory-${Date.now()}-${randomUUID()}.sqlite`);
      if (!dryRun) engine.backup(destination);
      return { source, destination, created: true };
    },
  });
}

export function previewMemoryRestore(backupPath: string, filePath = dbPath()): MemoryRestorePreview {
  assertJsonMemory(filePath);
  const sourcePath = resolveBackupPath(backupPath, filePath);
  const db = loadRestoreDbStrict(sourcePath);
  const maxObservationId = db.observations.reduce((max, observation) => Math.max(max, observation.id), 0);

  return {
    backup: sourcePath,
    observations: db.observations.length,
    sessions: db.sessions.length,
    maxObservationId,
    requiresConfirmation: "RESTORE",
    valid: true,
  };
}

export function restoreMemoryBackup(backupPath: string, confirm: string, filePath = dbPath()): MemoryRestoreResult {
  assertJsonMemory(filePath);
  const preview = previewMemoryRestore(backupPath, filePath);

  if (confirm !== preview.requiresConfirmation) {
    throw new Error("Confirmacion invalida. Para restaurar, confirm debe ser: RESTORE");
  }

  assertHooksAllowed(mcpHookContext("memory.restore.apply", {
    confirmation: confirm,
    destructive: true,
    metadata: {
      previewToken: `restore:${preview.backup}:${preview.observations}:${preview.sessions}`,
      requiresConfirmation: preview.requiresConfirmation,
    },
  }));

  const restored = loadRestoreDbStrict(preview.backup);
  const currentBackup = backupFile(filePath, backupsDirForDb(filePath), false);
  saveDb(restored, filePath);

  return { ...preview, currentBackup, restored: true };
}

export function backupsDirForDb(filePath: string): string {
  return path.join(path.dirname(path.dirname(filePath)), "backups");
}

function resolveBackupPath(backupPath: string, filePath: string): string {
  const backupsDir = backupsDirForDb(filePath);
  const sourcePath = path.isAbsolute(backupPath) ? backupPath : path.join(backupsDir, backupPath);
  const backupsRealPath = path.resolve(backupsDir);
  const sourceRealPath = path.resolve(sourcePath);
  const relative = path.relative(backupsRealPath, sourceRealPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Restore solo acepta backups dentro de ${backupsRealPath}`);
  }
  if (!fs.existsSync(sourceRealPath)) {
    throw new Error(`Backup no encontrado: ${sourceRealPath}`);
  }

  return sourceRealPath;
}

function loadRestoreDbStrict(sourcePath: string): MnemoDb {
  const db = loadDb(sourcePath);
  const maxId = db.observations.reduce((max, observation) => Math.max(max, observation.id), 0);
  if (db.nextId <= maxId) {
    throw new Error("Backup invalido: nextId debe ser mayor que el mayor id de observacion.");
  }

  return db;
}
