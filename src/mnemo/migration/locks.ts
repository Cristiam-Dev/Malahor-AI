import fs from "node:fs";
import path from "node:path";
import { MemoryError } from "../engine/errors";
import { privateDirectory } from "../engine/paths";

export interface MigrationLockMetadata {
  sourceHash: string;
  confirmation: string;
  startedAt: string;
}

export function legacyWriteLockPath(source: string): string {
  return `${path.resolve(source)}.write.lock`;
}

export function migrationLockPath(source: string): string {
  return `${path.resolve(source)}.migration.lock`;
}

export function withLegacyWriteLock<T>(source: string, operation: () => T): T {
  const resolved = path.resolve(source);
  privateDirectory(path.dirname(resolved), true);
  const writeLock = legacyWriteLockPath(resolved);
  acquireLock(writeLock, `${process.pid}\n`, "Hay otra escritura de memoria en curso.");
  try {
    if (fs.existsSync(migrationLockPath(resolved))) {
      throw new MemoryError("MEMORY_BUSY", "La memoria JSON esta pausada por una migracion en curso.");
    }
    return operation();
  } finally {
    releaseLock(writeLock);
  }
}

export function withMigrationExclusion<T>(source: string, metadata: MigrationLockMetadata, operation: () => T): T {
  const resolved = path.resolve(source);
  privateDirectory(path.dirname(resolved));
  const migrationLock = migrationLockPath(resolved);
  const writeLock = legacyWriteLockPath(resolved);
  acquireLock(migrationLock, `${JSON.stringify({ version: 1, pid: process.pid, ...metadata })}\n`,
    "Hay otra migracion de memoria en curso o un lock abandonado.");
  let writerExcluded = false;
  try {
    acquireLock(writeLock, `${process.pid}\n`, "Hay un escritor legado activo; repite el preview cuando termine.");
    writerExcluded = true;
    return operation();
  } finally {
    if (writerExcluded) releaseLock(writeLock);
    releaseLock(migrationLock);
  }
}

function acquireLock(file: string, content: string, conflict: string): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MemoryError("MEMORY_BUSY", `${conflict} (${file})`);
    }
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    try { fs.unlinkSync(file); } catch { /* El error original conserva la causa primaria. */ }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

function releaseLock(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
