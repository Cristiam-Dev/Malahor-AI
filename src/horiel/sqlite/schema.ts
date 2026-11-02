import type { DatabaseSync } from "node:sqlite";

import { HorielError } from "../core/errors";

export const HORIEL_SQLITE_APPLICATION_ID = 0x484f5249;
export const HORIEL_SQLITE_SCHEMA_VERSION = 1;
export const HORIEL_SQLITE_JOURNAL_MODE = "delete";

const EXPECTED_TABLES = [
  "horiel_store",
  "idempotency_bindings",
  "memories",
  "memory_versions",
  "pins",
  "previews",
  "relations",
  "session_checkpoints",
] as const;

const EXPECTED_TRIGGERS = [
  "memory_fts_after_delete",
  "memory_fts_after_insert",
  "memory_fts_after_update",
] as const;

const EXPECTED_INDEXES = [
  "memories_project_idx",
  "memories_scope_idx",
  "memories_type_idx",
  "memories_updated_at_idx",
  "memory_versions_memory_idx",
  "session_checkpoints_scope_idx",
] as const;

export const HORIEL_SQLITE_SCHEMA_SQL = `
CREATE TABLE horiel_store (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL UNIQUE CHECK (length(store_id) = 38 AND store_id GLOB 'store_[0-9a-f]*'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE memories (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'mem_[0-9a-f]*'),
  scope TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('decision', 'bug', 'pattern', 'architecture', 'learning', 'general')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  tags_search TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

CREATE TABLE memory_versions (
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  scope TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('decision', 'bug', 'pattern', 'architecture', 'learning', 'general')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, version),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE idempotency_bindings (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('memory.create', 'checkpoint.create')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  entity TEXT NOT NULL CHECK (entity IN ('memory', 'checkpoint')),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version >= 1),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE session_checkpoints (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'chk_[0-9a-f]*'),
  scope TEXT NOT NULL,
  project TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  objective TEXT NOT NULL,
  implemented_json TEXT NOT NULL CHECK (json_valid(implemented_json) AND json_type(implemented_json) = 'array'),
  verified_json TEXT NOT NULL CHECK (json_valid(verified_json) AND json_type(verified_json) = 'array'),
  pending_json TEXT NOT NULL CHECK (json_valid(pending_json) AND json_type(pending_json) = 'array'),
  decisions_json TEXT NOT NULL CHECK (json_valid(decisions_json) AND json_type(decisions_json) = 'array'),
  blockers_json TEXT NOT NULL CHECK (json_valid(blockers_json) AND json_type(blockers_json) = 'array'),
  validations_json TEXT NOT NULL CHECK (json_valid(validations_json) AND json_type(validations_json) = 'array'),
  next_step TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1)
) STRICT;

CREATE TABLE pins (
  memory_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE relations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'rel_[0-9a-f]*'),
  type TEXT NOT NULL CHECK (type IN ('related', 'conflicts_with', 'supersedes')),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (source_id <> target_id),
  UNIQUE (type, source_id, target_id),
  FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE previews (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'prv_[0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('move', 'promote', 'delete_scope', 'restore')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  store_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  confirmation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX memories_project_idx ON memories(project);
CREATE INDEX memories_scope_idx ON memories(scope);
CREATE INDEX memories_type_idx ON memories(type);
CREATE INDEX memories_updated_at_idx ON memories(updated_at);
CREATE INDEX memory_versions_memory_idx ON memory_versions(memory_id, version);
CREATE INDEX session_checkpoints_scope_idx ON session_checkpoints(scope);
CREATE INDEX relations_source_idx ON relations(source_id);
CREATE INDEX relations_target_idx ON relations(target_id);
CREATE INDEX previews_store_sequence_idx ON previews(store_id, sequence);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title,
  content,
  tags_search,
  content = 'memories',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER memory_fts_after_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, title, content, tags_search)
  VALUES (new.rowid, new.title, new.content, new.tags_search);
END;

CREATE TRIGGER memory_fts_after_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags_search)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags_search);
END;

CREATE TRIGGER memory_fts_after_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags_search)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags_search);
  INSERT INTO memory_fts(rowid, title, content, tags_search)
  VALUES (new.rowid, new.title, new.content, new.tags_search);
END;
`;

interface ScalarRow {
  value: string | number | bigint | null;
}

function scalar(database: DatabaseSync, sql: string): ScalarRow["value"] | undefined {
  const row = database.prepare(sql).get() as ScalarRow | undefined;
  return row?.value;
}

export function createHorielSchema(
  database: DatabaseSync,
  input: { storeId: string; createdAt: string },
): void {
  database.exec("BEGIN EXCLUSIVE");
  try {
    database.exec(HORIEL_SQLITE_SCHEMA_SQL);
    database.prepare(`
      INSERT INTO horiel_store(
        singleton, store_id, schema_version, sequence, created_at, updated_at
      ) VALUES (1, ?, ?, 0, ?, ?)
    `).run(
      input.storeId,
      HORIEL_SQLITE_SCHEMA_VERSION,
      input.createdAt,
      input.createdAt,
    );
    database.exec(`PRAGMA application_id = ${HORIEL_SQLITE_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${HORIEL_SQLITE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original schema failure.
    }
    throw error;
  }
}

export function assertHorielSchema(database: DatabaseSync): void {
  const applicationId = Number(scalar(database, "SELECT application_id AS value FROM pragma_application_id"));
  const version = Number(scalar(database, "SELECT user_version AS value FROM pragma_user_version"));
  if (applicationId !== HORIEL_SQLITE_APPLICATION_ID) {
    throw new HorielError("integrity_failed", "SQLite file is not a Horiel store.");
  }
  if (version > HORIEL_SQLITE_SCHEMA_VERSION) {
    throw new HorielError("future_schema", "Horiel store uses a newer schema version.");
  }
  if (version !== HORIEL_SQLITE_SCHEMA_VERSION) {
    throw new HorielError("integrity_failed", "Horiel store schema version is not supported.");
  }

  const objects = database.prepare(`
    SELECT type, name
      FROM sqlite_schema
     WHERE type IN ('table', 'index', 'trigger')
  `).all() as Array<{ type: string; name: string }>;
  const names = new Set(objects.map(({ type, name }) => `${type}:${name}`));
  for (const table of EXPECTED_TABLES) {
    if (!names.has(`table:${table}`)) {
      throw new HorielError("integrity_failed", "Horiel store schema is incomplete.");
    }
  }
  if (!names.has("table:memory_fts")) {
    throw new HorielError("capability_missing", "Horiel store requires SQLite FTS5.");
  }
  for (const index of EXPECTED_INDEXES) {
    if (!names.has(`index:${index}`)) {
      throw new HorielError("integrity_failed", "Horiel store indexes are incomplete.");
    }
  }
  for (const trigger of EXPECTED_TRIGGERS) {
    if (!names.has(`trigger:${trigger}`)) {
      throw new HorielError("integrity_failed", "Horiel FTS5 maintenance triggers are incomplete.");
    }
  }

  const metadata = database.prepare(`
    SELECT store_id, schema_version, sequence
      FROM horiel_store
     WHERE singleton = 1
  `).get() as { store_id: string; schema_version: number; sequence: number } | undefined;
  if (!metadata || metadata.schema_version !== HORIEL_SQLITE_SCHEMA_VERSION
    || !/^store_[a-f0-9]{32}$/.test(metadata.store_id)
    || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 0) {
    throw new HorielError("integrity_failed", "Horiel store metadata is invalid.");
  }
}

export function verifyCanonicalIntegrity(database: DatabaseSync): void {
  const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
    throw new HorielError("integrity_failed", "SQLite integrity check failed.");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new HorielError("integrity_failed", "Horiel foreign key integrity check failed.");
  }
  assertHorielSchema(database);

  const missingCurrentHistory = Number(scalar(database, `
    SELECT count(*) AS value
      FROM memories AS m
      LEFT JOIN memory_versions AS v
        ON v.memory_id = m.id AND v.version = m.version
     WHERE v.memory_id IS NULL
        OR v.scope <> m.scope
        OR v.type <> m.type
        OR v.title <> m.title
        OR v.content <> m.content
        OR v.tags_json <> m.tags_json
        OR v.provenance_json <> m.provenance_json
        OR v.created_at <> m.created_at
        OR v.updated_at <> m.updated_at
  `));
  if (missingCurrentHistory !== 0) {
    throw new HorielError("integrity_failed", "Horiel memory history does not match current records.");
  }

  const brokenVersionSeries = Number(scalar(database, `
    SELECT count(*) AS value
      FROM (
        SELECT memory_id, min(version) AS first_version,
               max(version) AS last_version, count(*) AS version_count
          FROM memory_versions
         GROUP BY memory_id
        HAVING first_version <> 1 OR last_version <> version_count
      )
  `));
  if (brokenVersionSeries !== 0) {
    throw new HorielError("integrity_failed", "Horiel memory history is not contiguous.");
  }

  const staleCurrentVersion = Number(scalar(database, `
    SELECT count(*) AS value
      FROM memories AS m
     WHERE m.version <> (
       SELECT max(v.version) FROM memory_versions AS v WHERE v.memory_id = m.id
     )
  `));
  if (staleCurrentVersion !== 0) {
    throw new HorielError("integrity_failed", "Horiel current memory version is not the latest history row.");
  }

  const brokenBindings = Number(scalar(database, `
    SELECT count(*) AS value
      FROM idempotency_bindings AS b
     WHERE (b.entity = 'memory' AND NOT EXISTS (
              SELECT 1 FROM memory_versions AS v
               WHERE v.memory_id = b.entity_id AND v.version = b.entity_version
           ))
        OR (b.entity = 'checkpoint' AND NOT EXISTS (
              SELECT 1 FROM session_checkpoints AS c
               WHERE c.id = b.entity_id AND c.version = b.entity_version
           ))
  `));
  if (brokenBindings !== 0) {
    throw new HorielError("integrity_failed", "Horiel idempotency bindings are orphaned.");
  }

  const metadataMismatch = Number(scalar(database, `
    SELECT
      (SELECT count(*) FROM memories
        WHERE project <> CASE
          WHEN scope = '@global' THEN '@global'
          WHEN instr(scope, '/') = 0 THEN scope
          ELSE substr(scope, 1, instr(scope, '/') - 1)
        END)
      +
      (SELECT count(*) FROM session_checkpoints
        WHERE project <> CASE
          WHEN scope = '@global' THEN '@global'
          WHEN instr(scope, '/') = 0 THEN scope
          ELSE substr(scope, 1, instr(scope, '/') - 1)
        END)
      +
      (SELECT count(*) FROM previews
        WHERE store_id <> (SELECT store_id FROM horiel_store WHERE singleton = 1))
      AS value
  `));
  if (metadataMismatch !== 0) {
    throw new HorielError("integrity_failed", "Horiel derived metadata is inconsistent.");
  }
}

export function verifyFtsIntegrity(database: DatabaseSync): void {
  try {
    database.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES('integrity-check', 1)");
  } catch (error) {
    throw new HorielError("integrity_failed", "Horiel FTS5 index integrity check failed.");
  }
}

export function rebuildFtsIndex(database: DatabaseSync): void {
  try {
    database.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
    verifyFtsIntegrity(database);
  } catch (error) {
    if (error instanceof HorielError) throw error;
    throw new HorielError("integrity_failed", "Horiel FTS5 index rebuild failed.");
  }
}
