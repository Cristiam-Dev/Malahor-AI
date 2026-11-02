import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { HorielError } from "../core/errors";
import { assertHorielId } from "../core/ids";
import type { HorielSnapshotDescriptor } from "../core/model";
import {
  assertSafeExistingFile,
  assertSafeSnapshotFile,
  ensurePrivateDirectory,
  normalizeSqliteError,
  reopenHorielDatabase,
} from "./database";
import {
  HORIEL_SQLITE_SCHEMA_VERSION,
  assertHorielSchema,
  verifyCanonicalIntegrity,
  verifyFtsIntegrity,
} from "./schema";

interface SnapshotManifest {
  format: "horiel-snapshot-v1";
  descriptor: HorielSnapshotDescriptor;
}

export async function createPhysicalSnapshot(input: {
  database: DatabaseSync;
  snapshotDirectory: string;
  id: string;
  createdAt: string;
}): Promise<HorielSnapshotDescriptor> {
  const id = assertHorielId(input.id, "snp");
  if (!isCanonicalTimestamp(input.createdAt)) {
    throw new HorielError("invalid_input", "Horiel snapshot timestamp is invalid.");
  }
  ensurePrivateDirectory(input.snapshotDirectory);
  const paths = snapshotPaths(input.snapshotDirectory, id);
  if ([paths.database, paths.manifest, paths.databaseTemp, paths.manifestTemp]
    .some((target) => fs.existsSync(target))) {
    throw new HorielError("conflict", "Horiel snapshot identity already exists.");
  }

  try {
    await backup(input.database, paths.databaseTemp, { rate: 100 });
    if (process.platform !== "win32") fs.chmodSync(paths.databaseTemp, 0o600);
    const descriptor = inspectSnapshotDatabase(paths.databaseTemp, id, input.createdAt);
    fs.renameSync(paths.databaseTemp, paths.database);
    writeManifest(paths.manifestTemp, { format: "horiel-snapshot-v1", descriptor });
    fs.renameSync(paths.manifestTemp, paths.manifest);
    return descriptor;
  } catch (error) {
    removeIfExists(paths.databaseTemp);
    removeIfExists(paths.manifestTemp);
    removeIfExists(paths.database);
    removeIfExists(paths.manifest);
    throw normalizeSqliteError(error, "integrity_failed");
  }
}

export function inspectPhysicalSnapshot(
  snapshotDirectory: string,
  snapshotId: string,
): HorielSnapshotDescriptor | undefined {
  const id = assertHorielId(snapshotId, "snp");
  const paths = snapshotPaths(snapshotDirectory, id);
  const databaseExists = fs.existsSync(paths.database);
  const manifestExists = fs.existsSync(paths.manifest);
  if (!databaseExists && !manifestExists) return undefined;
  if (!databaseExists || !manifestExists) {
    throw new HorielError("integrity_failed", "Horiel snapshot is incomplete.");
  }
  assertSafeSnapshotFile(paths.database);
  assertSafeSnapshotFile(paths.manifest);
  const manifest = readManifest(paths.manifest, id);
  const inspected = inspectSnapshotDatabase(
    paths.database,
    id,
    manifest.descriptor.createdAt,
  );
  if (canonicalJson(inspected) !== canonicalJson(manifest.descriptor)) {
    throw new HorielError("integrity_failed", "Horiel snapshot descriptor no longer matches its bytes.");
  }
  return inspected;
}

export function prepareRestoreStaging(input: {
  databasePath: string;
  snapshotDirectory: string;
  snapshotId: string;
  expectedStoreId: string;
  nextSequence: number;
  busyTimeoutMs: number;
}): { stagingPath: string; descriptor: HorielSnapshotDescriptor } {
  const descriptor = inspectPhysicalSnapshot(input.snapshotDirectory, input.snapshotId);
  if (!descriptor) throw new HorielError("not_found", "Horiel snapshot was not found.");
  if (descriptor.storeId !== input.expectedStoreId) {
    throw new HorielError("integrity_failed", "Horiel snapshot belongs to another store.");
  }
  if (!Number.isSafeInteger(input.nextSequence) || input.nextSequence < 1) {
    throw new HorielError("invalid_input", "Horiel restore sequence is invalid.");
  }
  const source = snapshotPaths(input.snapshotDirectory, input.snapshotId).database;
  const stagingPath = path.join(
    path.dirname(input.databasePath),
    `.horiel-restore-${input.snapshotId}.sqlite`,
  );
  removeIfExists(stagingPath);
  try {
    fs.copyFileSync(source, stagingPath, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(stagingPath, 0o600);
    const opened = reopenHorielDatabase({
      databasePath: stagingPath,
      snapshotDirectory: input.snapshotDirectory,
      access: "write",
      busyTimeoutMs: input.busyTimeoutMs,
    });
    try {
      opened.database.prepare(`
        UPDATE horiel_store
           SET sequence = ?, updated_at = ?
         WHERE singleton = 1 AND store_id = ?
      `).run(input.nextSequence, new Date().toISOString(), input.expectedStoreId);
      verifyCanonicalIntegrity(opened.database);
      verifyFtsIntegrity(opened.database);
    } finally {
      opened.database.close();
    }
    assertSafeExistingFile(stagingPath);
    return { stagingPath, descriptor };
  } catch (error) {
    removeIfExists(stagingPath);
    throw normalizeSqliteError(error, "integrity_failed");
  }
}

export function snapshotDatabasePath(snapshotDirectory: string, snapshotId: string): string {
  return snapshotPaths(snapshotDirectory, assertHorielId(snapshotId, "snp")).database;
}

export function sha256File(target: string): string {
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function inspectSnapshotDatabase(
  databasePath: string,
  id: string,
  createdAt: string,
): HorielSnapshotDescriptor {
  assertSafeSnapshotFile(databasePath);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      readBigInts: false,
      returnArrays: false,
    });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA trusted_schema = OFF");
    assertHorielSchema(database);
    verifyCanonicalIntegrity(database);
    const store = database.prepare(`
      SELECT store_id, sequence
        FROM horiel_store
       WHERE singleton = 1
    `).get() as { store_id: string; sequence: number } | undefined;
    if (!store) throw new HorielError("integrity_failed", "Horiel snapshot metadata is missing.");
    const counts = {
      memories: tableCount(database, "memories"),
      checkpoints: tableCount(database, "session_checkpoints"),
      pins: tableCount(database, "pins"),
      relations: tableCount(database, "relations"),
    };
    database.close();
    database = undefined;
    return {
      id,
      storeId: store.store_id,
      schemaVersion: HORIEL_SQLITE_SCHEMA_VERSION,
      sequence: store.sequence,
      createdAt,
      counts,
      fingerprint: sha256File(databasePath),
      verified: true,
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The inspection failure remains authoritative.
    }
    throw normalizeSqliteError(error, "integrity_failed");
  }
}

function tableCount(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function snapshotPaths(snapshotDirectory: string, snapshotId: string): {
  database: string;
  manifest: string;
  databaseTemp: string;
  manifestTemp: string;
} {
  const directory = path.resolve(snapshotDirectory);
  const database = path.join(directory, `${snapshotId}.sqlite`);
  const manifest = path.join(directory, `${snapshotId}.json`);
  return {
    database,
    manifest,
    databaseTemp: `${database}.tmp`,
    manifestTemp: `${manifest}.tmp`,
  };
}

function writeManifest(target: string, manifest: SnapshotManifest): void {
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

function readManifest(target: string, expectedId: string): SnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new HorielError("integrity_failed", "Horiel snapshot manifest is invalid.");
  }
  if (!value || typeof value !== "object") {
    throw new HorielError("integrity_failed", "Horiel snapshot manifest is invalid.");
  }
  const manifest = value as SnapshotManifest;
  if (manifest.format !== "horiel-snapshot-v1" || manifest.descriptor?.id !== expectedId
    || manifest.descriptor.verified !== true) {
    throw new HorielError("integrity_failed", "Horiel snapshot manifest is invalid.");
  }
  return manifest;
}

function isCanonicalTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function removeIfExists(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // Cleanup is best-effort; the primary operation still reports its own failure.
  }
}
