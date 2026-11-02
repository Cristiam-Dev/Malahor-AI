import { DatabaseSync } from "node:sqlite";

import { canonicalHash, sha256File } from "./canonical";
import { migrationFailure, normalizeMigrationFailure } from "./errors";
import type { MigrationMapping, MigrationTargetDescriptor } from "./model";
import { assertNoStagingSidecars } from "./staging";
import { verifyCanonicalIntegrity, verifyFtsIntegrity } from "../sqlite/schema";

export function verifyStagingDatabase(input: {
  databasePath: string;
  mapping: MigrationMapping;
}): MigrationTargetDescriptor {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(input.databasePath, {
      readOnly: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 1000,
      readBigInts: false,
      returnArrays: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
    });
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA trusted_schema = OFF;
    `);
    const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (String(journal?.journal_mode ?? "").toLowerCase() !== "delete") {
      return migrationFailure("verification_failed", "Horiel migration staging journal is invalid.");
    }
    verifyCanonicalIntegrity(database);
    verifyFtsIntegrity(database);
    const store = database.prepare(`
      SELECT store_id, sequence FROM horiel_store WHERE singleton = 1
    `).get() as { store_id: string; sequence: number } | undefined;
    if (!store || store.store_id !== input.mapping.targetStoreId || store.sequence !== 1) {
      return migrationFailure("verification_failed", "Horiel migration staging metadata diverged.");
    }

    const memories = database.prepare(`
      SELECT id, scope, project, type, title, content, tags_json, tags_search, provenance_json,
             created_at, updated_at, version
        FROM memories ORDER BY id
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: String(value.id),
        scope: String(value.scope),
        project: String(value.project),
        type: String(value.type),
        title: String(value.title),
        content: String(value.content),
        tags: parseArray(value.tags_json),
        tagsSearch: String(value.tags_search),
        provenance: parseObject(value.provenance_json),
        createdAt: String(value.created_at),
        updatedAt: String(value.updated_at),
        version: Number(value.version),
      };
    });
    const versions = database.prepare(`
      SELECT memory_id, version, scope, type, title, content, tags_json,
             provenance_json, created_at, updated_at
        FROM memory_versions ORDER BY memory_id, version
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        memoryId: String(value.memory_id),
        version: Number(value.version),
        scope: String(value.scope),
        type: String(value.type),
        title: String(value.title),
        content: String(value.content),
        tags: parseArray(value.tags_json),
        provenance: parseObject(value.provenance_json),
        createdAt: String(value.created_at),
        updatedAt: String(value.updated_at),
      };
    });
    const checkpoints = database.prepare(`
      SELECT * FROM session_checkpoints ORDER BY id
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: String(value.id),
        scope: String(value.scope),
        sessionRef: String(value.session_ref),
        objective: String(value.objective),
        implemented: parseArray(value.implemented_json),
        verified: parseArray(value.verified_json),
        pending: parseArray(value.pending_json),
        decisions: parseArray(value.decisions_json),
        blockers: parseArray(value.blockers_json),
        validations: parseArray(value.validations_json),
        nextStep: String(value.next_step),
        createdAt: String(value.created_at),
        version: Number(value.version),
      };
    });
    const pins = database.prepare(`
      SELECT memory_id, created_at FROM pins ORDER BY memory_id
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return { memoryId: String(value.memory_id), createdAt: String(value.created_at) };
    });
    const relations = database.prepare(`
      SELECT id, type, source_id, target_id, created_at FROM relations ORDER BY id
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: String(value.id),
        type: String(value.type),
        sourceId: String(value.source_id),
        targetId: String(value.target_id),
        createdAt: String(value.created_at),
      };
    });
    const expectedMemoryRecords = [...input.mapping.memories].sort(byId);
    const expectedMemories = expectedMemoryRecords.map((memory) => ({
      ...memory,
      project: memory.scope === "@global" ? "@global" : memory.scope.split("/", 1)[0]!,
      tagsSearch: memory.tags.join(" "),
    }));
    const expectedVersions = expectedMemoryRecords.map((memory) => ({
      memoryId: memory.id,
      version: memory.version,
      scope: memory.scope,
      type: memory.type,
      title: memory.title,
      content: memory.content,
      tags: memory.tags,
      provenance: memory.provenance,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    }));
    const expectedCheckpoints = [...input.mapping.checkpoints].sort(byId);
    const expectedPins = [...input.mapping.pins].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
    const expectedRelations = [...input.mapping.relations].sort(byId);
    if (canonicalHash(memories) !== canonicalHash(expectedMemories)
      || canonicalHash(versions) !== canonicalHash(expectedVersions)
      || canonicalHash(checkpoints) !== canonicalHash(expectedCheckpoints)
      || canonicalHash(pins) !== canonicalHash(expectedPins)
      || canonicalHash(relations) !== canonicalHash(expectedRelations)) {
      return migrationFailure("verification_failed", "Horiel migration differential verification failed.");
    }
    const ftsCount = Number((database.prepare("SELECT count(*) AS total FROM memory_fts").get() as {
      total: number;
    }).total);
    if (ftsCount !== expectedMemoryRecords.length) {
      return migrationFailure("verification_failed", "Horiel migration FTS verification failed.");
    }
    database.close();
    database = undefined;
    assertNoStagingSidecars(input.databasePath);
    return {
      storeId: store.store_id,
      sequence: store.sequence,
      fingerprint: sha256File(input.databasePath),
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The sanitized verification failure remains authoritative.
    }
    throw normalizeMigrationFailure(error, "verification_failed", "Horiel migration verification failed.");
  }
}

function parseArray(value: unknown): unknown[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!Array.isArray(parsed)) return migrationFailure("verification_failed", "Horiel migration JSON field is invalid.");
  return parsed;
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return migrationFailure("verification_failed", "Horiel migration JSON field is invalid.");
  }
  return parsed as Record<string, unknown>;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}
