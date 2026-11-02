import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensurePrivateDirectory, removeKnownArtifact } from "./boundary";
import { fsyncDirectory, fsyncFile } from "./canonical";
import { migrationFailure, normalizeMigrationFailure } from "./errors";
import type { MigrationMapping } from "./model";
import {
  createHorielSchema,
  rebuildFtsIndex,
  verifyCanonicalIntegrity,
} from "../sqlite/schema";

export function resetStagingArtifacts(sandboxRoot: string, databasePath: string): void {
  for (const target of stagingArtifacts(databasePath)) removeKnownArtifact(sandboxRoot, target);
}

export function createStagingDatabase(input: {
  sandboxRoot: string;
  databasePath: string;
  mapping: MigrationMapping;
}): void {
  ensurePrivateDirectory(input.sandboxRoot, path.dirname(input.databasePath));
  if (fs.existsSync(input.databasePath)) {
    return migrationFailure("manifest_invalid", "Horiel migration staging store already exists unexpectedly.");
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(input.databasePath, writableOptions());
    if (process.platform !== "win32") fs.chmodSync(input.databasePath, 0o600);
    configureWritable(database);
    createHorielSchema(database, {
      storeId: input.mapping.targetStoreId,
      createdAt: input.mapping.storeCreatedAt,
    });
    database.close();
    database = undefined;
    fsyncFile(input.databasePath);
    fsyncDirectory(path.dirname(input.databasePath));
    assertNoStagingSidecars(input.databasePath);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The sanitized staging failure remains authoritative.
    }
    resetStagingArtifacts(input.sandboxRoot, input.databasePath);
    throw normalizeMigrationFailure(error, "integrity_failed", "Horiel migration staging store could not be created.");
  }
}

export function populateStagingDatabase(input: {
  sandboxRoot: string;
  databasePath: string;
  mapping: MigrationMapping;
}): void {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(input.databasePath, writableOptions());
    configureWritable(database);
    const store = database.prepare(`
      SELECT store_id, sequence FROM horiel_store WHERE singleton = 1
    `).get() as { store_id: string; sequence: number } | undefined;
    if (!store || store.store_id !== input.mapping.targetStoreId || store.sequence !== 0
      || tableCount(database, "memories") !== 0 || tableCount(database, "session_checkpoints") !== 0
      || tableCount(database, "pins") !== 0 || tableCount(database, "relations") !== 0) {
      return migrationFailure("manifest_invalid", "Horiel migration staging state is inconsistent.");
    }
    database.exec("BEGIN IMMEDIATE");
    for (const memory of input.mapping.memories) insertMemory(database, memory);
    for (const checkpoint of input.mapping.checkpoints) insertCheckpoint(database, checkpoint);
    for (const pin of input.mapping.pins) {
      database.prepare("INSERT INTO pins(memory_id, created_at) VALUES (?, ?)")
        .run(pin.memoryId, pin.createdAt);
    }
    for (const relation of input.mapping.relations) {
      database.prepare(`
        INSERT INTO relations(id, type, source_id, target_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(relation.id, relation.type, relation.sourceId, relation.targetId, relation.createdAt);
    }
    rebuildFtsIndex(database);
    database.prepare(`
      UPDATE horiel_store SET sequence = 1, updated_at = ? WHERE singleton = 1
    `).run(input.mapping.storeCreatedAt);
    database.exec("COMMIT");
    database.exec("PRAGMA trusted_schema = OFF");
    verifyCanonicalIntegrity(database);
    database.close();
    database = undefined;
    fsyncFile(input.databasePath);
    fsyncDirectory(path.dirname(input.databasePath));
    assertNoStagingSidecars(input.databasePath);
  } catch (error) {
    try {
      if (database?.isTransaction) database.exec("ROLLBACK");
      database?.close();
    } catch {
      // The sanitized staging failure remains authoritative.
    }
    throw normalizeMigrationFailure(error, "integrity_failed", "Horiel migration staging transform failed.");
  }
}

export function assertNoStagingSidecars(databasePath: string): void {
  if (stagingArtifacts(databasePath).slice(1).some((target) => fs.existsSync(target))) {
    return migrationFailure("integrity_failed", "Horiel migration staging left an unexpected SQLite sidecar.");
  }
}

function insertMemory(database: DatabaseSync, memory: MigrationMapping["memories"][number]): void {
  const tags = JSON.stringify(memory.tags);
  const provenance = JSON.stringify(memory.provenance);
  const project = projectForScope(memory.scope);
  database.prepare(`
    INSERT INTO memories(
      id, scope, project, type, title, content, tags_json, tags_search,
      provenance_json, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.scope,
    project,
    memory.type,
    memory.title,
    memory.content,
    tags,
    memory.tags.join(" "),
    provenance,
    memory.createdAt,
    memory.updatedAt,
    memory.version,
  );
  database.prepare(`
    INSERT INTO memory_versions(
      memory_id, version, scope, type, title, content, tags_json,
      provenance_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.version,
    memory.scope,
    memory.type,
    memory.title,
    memory.content,
    tags,
    provenance,
    memory.createdAt,
    memory.updatedAt,
  );
}

function insertCheckpoint(
  database: DatabaseSync,
  checkpoint: MigrationMapping["checkpoints"][number],
): void {
  database.prepare(`
    INSERT INTO session_checkpoints(
      id, scope, project, session_ref, objective, implemented_json,
      verified_json, pending_json, decisions_json, blockers_json,
      validations_json, next_step, created_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpoint.id,
    checkpoint.scope,
    projectForScope(checkpoint.scope),
    checkpoint.sessionRef,
    checkpoint.objective,
    JSON.stringify(checkpoint.implemented),
    JSON.stringify(checkpoint.verified),
    JSON.stringify(checkpoint.pending),
    JSON.stringify(checkpoint.decisions),
    JSON.stringify(checkpoint.blockers),
    JSON.stringify(checkpoint.validations),
    checkpoint.nextStep,
    checkpoint.createdAt,
    checkpoint.version,
  );
}

function projectForScope(scope: string): string {
  return scope === "@global" ? "@global" : scope.split("/", 1)[0]!;
}

function configureWritable(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 1000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = ON;
  `);
}

function writableOptions(): ConstructorParameters<typeof DatabaseSync>[1] {
  return {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 1000,
    readBigInts: false,
    returnArrays: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  };
}

function tableCount(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total);
}

function stagingArtifacts(databasePath: string): string[] {
  return [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`];
}
