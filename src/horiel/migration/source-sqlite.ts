import { DatabaseSync } from "node:sqlite";

import { assertSafeSourceFile } from "./boundary";
import { migrationFailure, normalizeMigrationFailure } from "./errors";
import type {
  MigrationSourceSnapshot,
  SourceObservation,
  SourceRelation,
} from "./model";

const MNEMO_APPLICATION_ID = 0x4D414C32;
const MNEMO_SCHEMA_VERSION = 1;
const REQUIRED_TABLES = ["memory_state", "observations", "pins", "relations", "scopes", "sessions"];

export function readSqliteMigrationSource(filePath: string): MigrationSourceSnapshot {
  assertSafeSourceFile(filePath);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      readBigInts: false,
      returnArrays: false,
    });
    database.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF");
    assertMnemoSchema(database);
    database.exec("BEGIN");
    const state = database.prepare(`
      SELECT next_observation_id, next_observation_position, next_session_position
        FROM memory_state WHERE singleton = 1
    `).get() as {
      next_observation_id: number;
      next_observation_position: number;
      next_session_position: number;
    } | undefined;
    if (!state) return migrationFailure("source_invalid", "Mnemo SQLite state is invalid.");

    const observations = database.prepare(`
      SELECT id, scope_path, type, title, content, tags, created_at, position
        FROM observations ORDER BY position, id
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        stableKey: `sqlite:observation:${Number(value.id)}`,
        id: Number(value.id),
        scope: String(value.scope_path),
        type: String(value.type) as SourceObservation["type"],
        title: String(value.title),
        content: String(value.content),
        tags: String(value.tags),
        createdAt: String(value.created_at),
        position: Number(value.position),
      } satisfies SourceObservation;
    });
    const sessions = database.prepare(`
      SELECT id, scope_path, summary, created_at, position
        FROM sessions ORDER BY position, id
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      const sourceId = String(value.id);
      return {
        stableKey: `sqlite:session:${sourceId}`,
        sourceId,
        scope: String(value.scope_path),
        summary: String(value.summary),
        createdAt: String(value.created_at),
        position: Number(value.position),
      };
    });
    const pins = database.prepare(`
      SELECT observation_id, created_at FROM pins ORDER BY observation_id
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      const observationId = Number(value.observation_id);
      return {
        stableKey: `sqlite:pin:${observationId}`,
        observationId,
        createdAt: String(value.created_at),
      };
    });
    const relations = database.prepare(`
      SELECT source_id, target_id, kind, created_at
        FROM relations ORDER BY source_id, target_id, kind
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      const sourceObservationId = Number(value.source_id);
      const targetObservationId = Number(value.target_id);
      const kind = String(value.kind) as SourceRelation["kind"];
      return {
        stableKey: `sqlite:relation:${kind}:${sourceObservationId}:${targetObservationId}`,
        sourceObservationId,
        targetObservationId,
        kind,
        createdAt: String(value.created_at),
      } satisfies SourceRelation;
    });
    const scopes = database.prepare(`
      SELECT path, parent_path, depth FROM scopes ORDER BY depth, path
    `).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        path: String(value.path),
        parentPath: value.parent_path === null ? null : String(value.parent_path),
        depth: Number(value.depth),
      };
    });
    database.exec("COMMIT");
    database.close();
    database = undefined;
    return {
      backend: "sqlite",
      state: {
        nextObservationId: Number(state.next_observation_id),
        nextObservationPosition: Number(state.next_observation_position),
        nextSessionPosition: Number(state.next_session_position),
      },
      scopes,
      observations,
      sessions,
      pins,
      relations,
    };
  } catch (error) {
    try {
      if (database?.isTransaction) database.exec("ROLLBACK");
      database?.close();
    } catch {
      // The closed, sanitized source error remains authoritative.
    }
    throw normalizeMigrationFailure(error, "source_invalid", "Mnemo SQLite source is invalid.");
  }
}

function assertMnemoSchema(database: DatabaseSync): void {
  const applicationId = Number((database.prepare("PRAGMA application_id").get() as { application_id: number }).application_id);
  const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (applicationId !== MNEMO_APPLICATION_ID || version !== MNEMO_SCHEMA_VERSION) {
    return migrationFailure("source_invalid", "Mnemo SQLite schema is unsupported.");
  }
  const tables = new Set((database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
  `).all() as Array<{ name: string }>).map(({ name }) => name));
  if (REQUIRED_TABLES.some((table) => !tables.has(table))) {
    return migrationFailure("source_invalid", "Mnemo SQLite schema is incomplete.");
  }
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok"
    || database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    return migrationFailure("source_invalid", "Mnemo SQLite integrity check failed.");
  }
}
