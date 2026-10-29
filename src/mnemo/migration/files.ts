import fs from "node:fs";
import path from "node:path";
import { MemoryError } from "../engine/errors";
import { privateDirectory, privateFile } from "../engine/paths";
import { MEMORY_SCHEMA_VERSION } from "../engine/schema";
import { memoryV2Paths } from "../storage";
import { digest } from "./snapshot";

export interface MemoryMigrationPaths {
  source: string;
  memoryDirectory: string;
  destination: string;
  marker: string;
  manifest: string;
  backupsDirectory: string;
}

export function migrationPaths(source: string): MemoryMigrationPaths {
  const resolved = path.resolve(source);
  const v2 = memoryV2Paths(resolved);
  return {
    source: resolved,
    memoryDirectory: v2.directory,
    destination: v2.database,
    marker: v2.marker,
    manifest: v2.manifest,
    backupsDirectory: path.join(path.dirname(path.dirname(resolved)), "backups"),
  };
}

export function ensureMigrationDirectories(paths: MemoryMigrationPaths): void {
  privateDirectory(path.dirname(paths.source));
  privateDirectory(paths.memoryDirectory, true);
  privateDirectory(paths.backupsDirectory, true);
}

export function writePrivateJson(file: string, value: unknown, expectedHash: string | null): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const currentHash = fs.existsSync(file) ? hashPrivateFile(file) : null;
  if (currentHash !== expectedHash) {
    throw new MemoryError("MEMORY_BUSY", "El estado de migracion cambio; ejecuta un preview nuevo.");
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeExclusive(temporary, Buffer.from(text));
  try {
    if (hashPrivateFile(temporary) !== digest(text)) throw new MemoryError("MEMORY_PATH", "No se verifico el manifiesto provisional.");
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectory(path.dirname(file));
  } finally {
    removeIfPresent(temporary);
  }
  return digest(text);
}

export function copySnapshotBackup(raw: Buffer, destination: string, expectedHash: string): void {
  writeExclusive(destination, raw);
  if (hashPrivateFile(destination) !== expectedHash) {
    throw new MemoryError("MEMORY_PATH", "El backup JSON no coincide con el snapshot de origen.");
  }
  fsyncDirectory(path.dirname(destination));
}

export function publishDatabase(staging: string, destination: string): void {
  try {
    fs.copyFileSync(staging, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MemoryError("MEMORY_ACTIVATION", "El destino SQLite aparecio durante la migracion; no se sobrescribe.");
    }
    throw error;
  }
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
  fsyncDirectory(path.dirname(destination));
}

export function activateMemoryMarker(marker: string): void {
  const content = Buffer.from(JSON.stringify({ version: 1, backend: "sqlite", schemaVersion: MEMORY_SCHEMA_VERSION }));
  const temporary = `${marker}.${process.pid}.${Date.now()}.tmp`;
  writeExclusive(temporary, content);
  try {
    fs.linkSync(temporary, marker);
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(marker));
  } catch (error) {
    removeIfPresent(temporary);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MemoryError("MEMORY_ACTIVATION", "El marcador de activacion ya existe; no se reemplaza.");
    }
    throw error;
  }
}

export function quarantineArtifact(file: string, transactionId: string): string | null {
  const sidecars = ["-wal", "-shm"].filter((suffix) => fs.existsSync(`${file}${suffix}`));
  if (!fs.existsSync(file) && sidecars.length === 0) return null;
  const quarantined = `${file}.failed-${transactionId}`;
  if (fs.existsSync(quarantined)) throw new MemoryError("MEMORY_PATH", `Ya existe el artefacto aislado ${quarantined}.`);
  if (fs.existsSync(file)) fs.renameSync(file, quarantined);
  for (const suffix of sidecars) fs.renameSync(`${file}${suffix}`, `${quarantined}${suffix}`);
  fsyncDirectory(path.dirname(file));
  return quarantined;
}

export function hashPrivateFile(file: string): string {
  return digest(readPrivateFile(file));
}

export function readPrivateFile(file: string, maximumBytes = Number.MAX_SAFE_INTEGER): Buffer {
  privateDirectory(path.dirname(file));
  privateFile(file);
  const before = fs.lstatSync(file);
  if (before.size > maximumBytes) throw new MemoryError("MEMORY_FORMAT", `El archivo excede ${maximumBytes} bytes: ${file}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs
      || opened.size > maximumBytes) {
      throw new MemoryError("MEMORY_BUSY", `El archivo cambio antes de abrirse: ${file}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new MemoryError("MEMORY_BUSY", `El archivo cambio durante la lectura: ${file}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function removeIfPresent(file: string): void {
  try { fs.unlinkSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function assertNoSqliteSidecars(file: string): void {
  const sidecars = ["-wal", "-shm"].filter((suffix) => fs.existsSync(`${file}${suffix}`));
  if (sidecars.length > 0) throw new MemoryError("MEMORY_SQLITE", "SQLite provisional conserva WAL/SHM tras el checkpoint.");
}

function writeExclusive(file: string, bytes: Buffer): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MemoryError("MEMORY_PATH", `El archivo ya existe y no se sobrescribe: ${file}`);
    }
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
}

function fsyncFile(file: string): void {
  const descriptor = fs.openSync(file, "r+");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
