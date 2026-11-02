import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { assertInsideSandbox, assertPrivateRegularFile } from "./boundary";
import { canonicalHash, fsyncDirectory, fsyncFile, sha256File } from "./canonical";
import { migrationFailure, normalizeMigrationFailure } from "./errors";
import type {
  MigrationBackupDescriptor,
  MigrationSourceSnapshot,
} from "./model";
import { readJsonMigrationSource } from "./source-json";
import { readSqliteMigrationSource } from "./source-sqlite";

export async function createVerifiedSourceBackup(input: {
  sandboxRoot: string;
  sourcePath: string;
  backupPath: string;
  source: MigrationSourceSnapshot;
}): Promise<MigrationBackupDescriptor> {
  assertInsideSandbox(input.sandboxRoot, input.backupPath);
  if (fs.existsSync(input.backupPath)) {
    return migrationFailure("manifest_invalid", "Horiel migration backup already exists unexpectedly.");
  }
  try {
    if (input.source.backend === "json") {
      fs.copyFileSync(input.sourcePath, input.backupPath, fs.constants.COPYFILE_EXCL);
    } else {
      await createSqliteBackup(input.sourcePath, input.backupPath);
    }
    if (process.platform !== "win32") fs.chmodSync(input.backupPath, 0o600);
    fsyncFile(input.backupPath);
    fsyncDirectory(path.dirname(input.backupPath));
    return verifySourceBackup({
      sandboxRoot: input.sandboxRoot,
      backupPath: input.backupPath,
      source: input.source,
    });
  } catch (error) {
    try {
      if (fs.existsSync(input.backupPath)) fs.rmSync(input.backupPath, { force: true });
    } catch {
      // The sanitized backup failure remains authoritative.
    }
    throw normalizeMigrationFailure(error, "integrity_failed", "Horiel migration backup could not be verified.");
  }
}

export function verifySourceBackup(input: {
  sandboxRoot: string;
  backupPath: string;
  source: MigrationSourceSnapshot;
  expected?: MigrationBackupDescriptor;
}): MigrationBackupDescriptor {
  assertPrivateRegularFile(input.sandboxRoot, input.backupPath);
  const inspected = input.source.backend === "json"
    ? readJsonMigrationSource(input.backupPath)
    : readSqliteMigrationSource(input.backupPath);
  if (canonicalHash(inspected) !== canonicalHash(input.source)) {
    return migrationFailure("integrity_failed", "Horiel migration backup differs from the approved source.");
  }
  const stats = fs.statSync(input.backupPath);
  const descriptor: MigrationBackupDescriptor = {
    verified: true,
    hash: sha256File(input.backupPath),
    size: stats.size,
  };
  if (input.expected && canonicalHash(descriptor) !== canonicalHash(input.expected)) {
    return migrationFailure("manifest_invalid", "Horiel migration backup descriptor changed.");
  }
  return descriptor;
}

async function createSqliteBackup(sourcePath: string, backupPath: string): Promise<void> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(sourcePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      readBigInts: false,
      returnArrays: false,
    });
    database.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF");
    await backup(database, backupPath, { rate: 100 });
    database.close();
    database = undefined;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The sanitized backup failure remains authoritative.
    }
    throw normalizeMigrationFailure(error, "integrity_failed", "Mnemo SQLite backup failed.");
  }
}
