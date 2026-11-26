import fs from "node:fs";
import path from "node:path";

import type { ProjectAliases } from "../cli/core/project";
import { portablePayloadDigest } from "../cli/core/portable-package";
import { backupMemory, type MemoryAdminApplyOptions } from "./admin-backup";
import { rowNumber, rowText, type SqlRow } from "./engine/driver";
import { MemoryError } from "./engine/errors";
import { privateDirectory } from "./engine/paths";
import { MemoryStore } from "./engine/store";
import type { MnemoDb, ObservationType } from "./json-store";
import {
  activateMemoryMarker,
  assertNoSqliteSidecars,
  publishDatabase,
  removeIfPresent,
} from "./migration/files";
import { legacySessionIds, readLegacyMemorySnapshot } from "./migration/snapshot";
import { memoryLocation, memoryV2Paths, withMemoryStorage } from "./storage";

const MEMORY_FORMAT = "mnemo-portable-v1" as const;
const MEMORY_SCHEMA_VERSION = 1;
const OBSERVATION_TYPES = new Set<ObservationType>([
  "decision", "bug", "pattern", "architecture", "learning", "general",
]);
const RELATION_KINDS = new Set(["supersedes", "conflicts"]);

export interface PortableScope {
  path: string;
  parentPath: string | null;
  depth: number;
}

export interface PortableObservation {
  id: number;
  scopePath: string;
  type: ObservationType;
  title: string;
  content: string;
  tags: string;
  createdAt: string;
  position: number;
}

export interface PortableSession {
  id: string;
  scopePath: string;
  summary: string;
  createdAt: string;
  position: number;
}

export interface PortablePin {
  observationId: number;
  createdAt: string;
}

export interface PortableRelation {
  sourceId: number;
  targetId: number;
  kind: "supersedes" | "conflicts";
  createdAt: string;
}

export interface PortableMemorySnapshot {
  format: typeof MEMORY_FORMAT;
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  sourceBackend: "json" | "sqlite";
  state: {
    nextObservationId: number;
    nextObservationPosition: number;
    nextSessionPosition: number;
  };
  scopes: PortableScope[];
  observations: PortableObservation[];
  sessions: PortableSession[];
  pins: PortablePin[];
  relations: PortableRelation[];
}

export interface CapturedPortableMemory {
  snapshot: PortableMemorySnapshot;
  fingerprint: string;
  activeFile: string;
  marker: string;
  backend: "json" | "sqlite";
}

export interface PortableMemoryApplyResult {
  previousBackend: "json" | "sqlite";
  backup: { created: boolean; destination: string | null };
  newlyActivated: boolean;
  expectedFingerprint: string;
  publishedFingerprint: string;
}

export function capturePortableMemory(
  legacyFile: string,
  aliases: ProjectAliases = {},
): CapturedPortableMemory {
  const location = memoryLocation(legacyFile);
  const snapshot = location.backend === "json"
    ? captureJson(location.file, aliases)
    : captureSqlite(location.file);
  validatePortableMemorySnapshot(snapshot);
  return {
    snapshot,
    fingerprint: portableMemoryFingerprint(snapshot),
    activeFile: location.file,
    marker: location.marker,
    backend: location.backend,
  };
}

export function validatePortableMemorySnapshot(value: unknown): PortableMemorySnapshot {
  const root = exactRecord(value, [
    "format", "observations", "pins", "relations", "schemaVersion", "scopes",
    "sessions", "sourceBackend", "state",
  ], "Snapshot portable de memoria invalido.");
  if (root.format !== MEMORY_FORMAT || root.schemaVersion !== MEMORY_SCHEMA_VERSION
    || (root.sourceBackend !== "json" && root.sourceBackend !== "sqlite")) {
    throw new MemoryError("MEMORY_FORMAT", "Formato portable de memoria no soportado.");
  }
  if (!Array.isArray(root.scopes) || !Array.isArray(root.observations)
    || !Array.isArray(root.sessions) || !Array.isArray(root.pins) || !Array.isArray(root.relations)) {
    throw new MemoryError("MEMORY_INPUT", "Las colecciones del snapshot portable son invalidas.");
  }
  const state = exactRecord(root.state, [
    "nextObservationId", "nextObservationPosition", "nextSessionPosition",
  ], "Estado portable de memoria invalido.");

  const scopes = root.scopes.map((value) => {
    const item = exactRecord(value, ["depth", "parentPath", "path"], "Scope portable invalido.");
    return {
      path: safeText(item.path, "scope.path", 512),
      parentPath: item.parentPath === null ? null : safeText(item.parentPath, "scope.parentPath", 512),
      depth: safeInteger(item.depth, "scope.depth", 0),
    };
  });
  const observations = root.observations.map((value) => {
    const item = exactRecord(value, [
      "content", "createdAt", "id", "position", "scopePath", "tags", "title", "type",
    ], "Observacion portable invalida.");
    const type = safeText(item.type, "observation.type", 32) as ObservationType;
    if (!OBSERVATION_TYPES.has(type)) throw new MemoryError("MEMORY_INPUT", "Tipo de observacion portable invalido.");
    return {
      id: safeInteger(item.id, "observation.id", 1),
      scopePath: safeText(item.scopePath, "observation.scopePath", 512),
      type,
      title: safeText(item.title, "observation.title"),
      content: safeText(item.content, "observation.content"),
      tags: safeText(item.tags, "observation.tags"),
      createdAt: safeText(item.createdAt, "observation.createdAt", 256),
      position: safeInteger(item.position, "observation.position", 0),
    };
  });
  const sessions = root.sessions.map((value) => {
    const item = exactRecord(value, [
      "createdAt", "id", "position", "scopePath", "summary",
    ], "Sesion portable invalida.");
    return {
      id: safeText(item.id, "session.id", 512),
      scopePath: safeText(item.scopePath, "session.scopePath", 512),
      summary: safeText(item.summary, "session.summary"),
      createdAt: safeText(item.createdAt, "session.createdAt", 256),
      position: safeInteger(item.position, "session.position", 0),
    };
  });
  const pins = root.pins.map((value) => {
    const item = exactRecord(value, ["createdAt", "observationId"], "Pin portable invalido.");
    return {
      observationId: safeInteger(item.observationId, "pin.observationId", 1),
      createdAt: safeText(item.createdAt, "pin.createdAt", 256),
    };
  });
  const relations = root.relations.map((value) => {
    const item = exactRecord(value, [
      "createdAt", "kind", "sourceId", "targetId",
    ], "Relacion portable invalida.");
    const kind = safeText(item.kind, "relation.kind", 32);
    if (!RELATION_KINDS.has(kind)) throw new MemoryError("MEMORY_INPUT", "Tipo de relacion portable invalido.");
    return {
      sourceId: safeInteger(item.sourceId, "relation.sourceId", 1),
      targetId: safeInteger(item.targetId, "relation.targetId", 1),
      kind: kind as PortableRelation["kind"],
      createdAt: safeText(item.createdAt, "relation.createdAt", 256),
    };
  });
  const snapshot: PortableMemorySnapshot = {
    format: MEMORY_FORMAT,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceBackend: root.sourceBackend,
    state: {
      nextObservationId: safeInteger(state.nextObservationId, "state.nextObservationId", 1),
      nextObservationPosition: safeInteger(state.nextObservationPosition, "state.nextObservationPosition", 0),
      nextSessionPosition: safeInteger(state.nextSessionPosition, "state.nextSessionPosition", 0),
    },
    scopes,
    observations,
    sessions,
    pins,
    relations,
  };
  assertPortableMemoryInvariants(snapshot);
  return snapshot;
}

export function portableMemoryFingerprint(snapshot: PortableMemorySnapshot): string {
  return portablePayloadDigest(validatePortableMemorySnapshot(snapshot));
}

export function stagePortableMemory(snapshotValue: unknown, stagingFile: string): string {
  const snapshot = validatePortableMemorySnapshot(snapshotValue);
  const resolved = path.resolve(stagingFile);
  if (fs.existsSync(resolved)) throw new MemoryError("MEMORY_PATH", "El staging portable ya existe.");
  privateDirectory(path.dirname(resolved), true);
  let store: MemoryStore | undefined;
  try {
    store = MemoryStore.open(resolved, "create");
    store.transaction(() => {
      for (const scope of snapshot.scopes
        .filter((item) => item.path !== "global")
        .sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path))) {
        store!.run("INSERT INTO scopes(path, parent_path, depth) VALUES (?, ?, ?)", [
          scope.path, scope.parentPath, scope.depth,
        ]);
      }
      for (const item of [...snapshot.observations].sort((left, right) => left.position - right.position)) {
        store!.run("INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
          item.id, item.scopePath, item.type, item.title, item.content, item.tags, item.createdAt, item.position,
        ]);
      }
      for (const item of [...snapshot.sessions].sort((left, right) => left.position - right.position)) {
        store!.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)", [
          item.id, item.scopePath, item.summary, item.createdAt, item.position,
        ]);
      }
      for (const item of snapshot.pins) {
        store!.run("INSERT INTO pins VALUES (?, ?)", [item.observationId, item.createdAt]);
      }
      for (const item of snapshot.relations) {
        store!.run("INSERT INTO relations VALUES (?, ?, ?, ?)", [
          item.sourceId, item.targetId, item.kind, item.createdAt,
        ]);
      }
      store!.run(`UPDATE memory_state SET next_observation_id = ?,
        next_observation_position = ?, next_session_position = ? WHERE singleton = 1`, [
        snapshot.state.nextObservationId,
        snapshot.state.nextObservationPosition,
        snapshot.state.nextSessionPosition,
      ]);
    });
    store.integrity();
    store.seal();
  } catch (error) {
    store?.close();
    store = undefined;
    for (const suffix of ["-wal", "-shm", ""]) removeIfPresent(`${resolved}${suffix}`);
    throw error;
  } finally {
    store?.close();
  }
  assertNoSqliteSidecars(resolved);
  const staged = captureSqlite(resolved);
  if (portableMemoryFingerprint(staged) !== portableMemoryFingerprint(snapshot)) {
    removeIfPresent(resolved);
    throw new MemoryError("MEMORY_FORMAT", "El staging portable no reproduce el snapshot esperado.");
  }
  return resolved;
}

export function applyStagedPortableMemory(
  snapshotValue: unknown,
  stagingFile: string,
  legacyFile: string,
  backupsDirectory: string,
  expectedDestinationFingerprint: string,
): PortableMemoryApplyResult {
  const snapshot = validatePortableMemorySnapshot(snapshotValue);
  const current = capturePortableMemory(legacyFile);
  if (current.fingerprint !== expectedDestinationFingerprint) {
    throw new MemoryError("MEMORY_BUSY", "La memoria destino cambio desde el preview.");
  }
  const staged = captureSqlite(path.resolve(stagingFile));
  if (portableMemoryFingerprint(staged) !== portableMemoryFingerprint(snapshot)) {
    throw new MemoryError("MEMORY_FORMAT", "El staging portable cambio antes de publicarse.");
  }
  const backup = backupMemory(legacyFile, false, backupsDirectory);
  let newlyActivated = false;
  if (current.backend === "sqlite") {
    withMemoryStorage(legacyFile, "write", {
      json: () => { throw new MemoryError("MEMORY_BUSY", "El backend destino cambio durante el import."); },
      sqlite: (engine) => engine.restore(stagingFile),
    });
  } else {
    const paths = memoryV2Paths(legacyFile);
    privateDirectory(paths.directory, true);
    if (fs.existsSync(paths.marker) || fs.existsSync(paths.database)) {
      throw new MemoryError("MEMORY_ACTIVATION", "El destino SQLite aparecio desde el preview.");
    }
    try {
      publishDatabase(stagingFile, paths.database);
      activateMemoryMarker(paths.marker);
      newlyActivated = true;
    } catch (error) {
      removeIfPresent(paths.marker);
      for (const suffix of ["-wal", "-shm", ""]) removeIfPresent(`${paths.database}${suffix}`);
      throw error;
    }
  }
  const published = capturePortableMemory(legacyFile);
  const expected = portableMemoryFingerprint({ ...snapshot, sourceBackend: "sqlite" });
  if (published.fingerprint !== expected) {
    throw new MemoryError("MEMORY_FORMAT", "La memoria publicada no reproduce el snapshot portable.");
  }
  return {
    previousBackend: current.backend,
    backup: { created: backup.created, destination: backup.destination },
    newlyActivated,
    expectedFingerprint,
    publishedFingerprint: published.fingerprint,
  };
}

export function rollbackPortableMemory(
  result: PortableMemoryApplyResult,
  legacyFile: string,
  options: MemoryAdminApplyOptions = {},
): void {
  if (result.previousBackend === "json" && result.newlyActivated) {
    const paths = memoryV2Paths(legacyFile);
    removeIfPresent(paths.marker);
    for (const suffix of ["-wal", "-shm", ""]) removeIfPresent(`${paths.database}${suffix}`);
    return;
  }
  if (result.previousBackend === "sqlite") {
    const backup = result.backup.destination;
    if (!result.backup.created || !backup) {
      throw new MemoryError("MEMORY_FORMAT", "No existe backup SQLite para revertir el import portable.");
    }
    withMemoryStorage(legacyFile, "write", {
      json: () => { throw new MemoryError("MEMORY_BUSY", "El backend cambio antes del rollback portable."); },
      sqlite: (engine) => engine.restore(backup),
    });
    void options;
  }
}

function captureJson(file: string, aliases: ProjectAliases): PortableMemorySnapshot {
  if (!fs.existsSync(file)) return emptyPortableSnapshot("json");
  const source = readLegacyMemorySnapshot(file, aliases);
  const sessionIds = legacySessionIds(source);
  const scopes = scopesForLegacy(source.db);
  return {
    format: MEMORY_FORMAT,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceBackend: "json",
    state: {
      nextObservationId: source.db.nextId,
      nextObservationPosition: source.db.observations.length,
      nextSessionPosition: source.db.sessions.length,
    },
    scopes,
    observations: source.db.observations.map((item, position) => ({
      id: item.id,
      scopePath: item.project,
      type: item.type,
      title: item.title,
      content: item.content,
      tags: item.tags,
      createdAt: item.created_at,
      position,
    })),
    sessions: source.db.sessions.map((item, position) => ({
      id: sessionIds[position]!,
      scopePath: item.project,
      summary: item.summary,
      createdAt: item.created_at,
      position,
    })),
    pins: [],
    relations: [],
  };
}

function captureSqlite(file: string): PortableMemorySnapshot {
  const store = MemoryStore.open(file, "read");
  try {
    store.verifyReadOnly();
    return store.transaction(() => {
      const state = store.get("SELECT * FROM memory_state WHERE singleton = 1");
      return {
        format: MEMORY_FORMAT,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceBackend: "sqlite",
        state: {
          nextObservationId: rowNumber(state, "next_observation_id"),
          nextObservationPosition: rowNumber(state, "next_observation_position"),
          nextSessionPosition: rowNumber(state, "next_session_position"),
        },
        scopes: store.all("SELECT path, parent_path, depth FROM scopes ORDER BY depth, path").map((row) => ({
          path: rowText(row, "path"),
          parentPath: row.parent_path === null ? null : rowText(row, "parent_path"),
          depth: rowNumber(row, "depth"),
        })),
        observations: store.all("SELECT * FROM observations ORDER BY position").map(portableObservation),
        sessions: store.all("SELECT * FROM sessions ORDER BY position").map(portableSession),
        pins: store.all("SELECT * FROM pins ORDER BY observation_id").map((row) => ({
          observationId: rowNumber(row, "observation_id"),
          createdAt: rowText(row, "created_at"),
        })),
        relations: store.all("SELECT * FROM relations ORDER BY source_id, target_id, kind").map((row) => ({
          sourceId: rowNumber(row, "source_id"),
          targetId: rowNumber(row, "target_id"),
          kind: rowText(row, "kind") as PortableRelation["kind"],
          createdAt: rowText(row, "created_at"),
        })),
      };
    }, false);
  } finally {
    store.close();
  }
}

function portableObservation(row: SqlRow): PortableObservation {
  return {
    id: rowNumber(row, "id"),
    scopePath: rowText(row, "scope_path"),
    type: rowText(row, "type") as ObservationType,
    title: rowText(row, "title"),
    content: rowText(row, "content"),
    tags: rowText(row, "tags"),
    createdAt: rowText(row, "created_at"),
    position: rowNumber(row, "position"),
  };
}

function portableSession(row: SqlRow): PortableSession {
  return {
    id: rowText(row, "id"),
    scopePath: rowText(row, "scope_path"),
    summary: rowText(row, "summary"),
    createdAt: rowText(row, "created_at"),
    position: rowNumber(row, "position"),
  };
}

function emptyPortableSnapshot(sourceBackend: "json" | "sqlite"): PortableMemorySnapshot {
  return {
    format: MEMORY_FORMAT,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceBackend,
    state: { nextObservationId: 1, nextObservationPosition: 0, nextSessionPosition: 0 },
    scopes: [{ path: "global", parentPath: null, depth: 0 }],
    observations: [],
    sessions: [],
    pins: [],
    relations: [],
  };
}

function scopesForLegacy(db: MnemoDb): PortableScope[] {
  const scopes = new Set(["global"]);
  for (const scope of [
    ...db.observations.map((item) => item.project),
    ...db.sessions.map((item) => item.project),
  ]) {
    const segments = scope.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      scopes.add(segments.slice(0, index).join("/"));
    }
  }
  return [...scopes]
    .map((scope) => {
      const parts = scope.split("/");
      return {
        path: scope,
        parentPath: parts.length === 1 ? null : parts.slice(0, -1).join("/"),
        depth: parts.length - 1,
      };
    })
    .sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path));
}

function assertPortableMemoryInvariants(snapshot: PortableMemorySnapshot): void {
  const scopePaths = unique(snapshot.scopes.map((item) => item.path), "scopes");
  const global = snapshot.scopes.find((item) => item.path === "global");
  if (!global || global.parentPath !== null || global.depth !== 0) {
    throw new MemoryError("MEMORY_INPUT", "El snapshot portable requiere el scope global canonico.");
  }
  for (const scope of snapshot.scopes) {
    if (scope.path.startsWith("/") || scope.path.endsWith("/") || scope.path.includes("//")
      || !/^[a-z0-9/-]+$/.test(scope.path)) {
      throw new MemoryError("MEMORY_INPUT", "El snapshot contiene un scope no canonico.");
    }
    if (scope.parentPath !== null && (!scopePaths.has(scope.parentPath)
      || scope.depth !== scope.parentPath.split("/").length)) {
      throw new MemoryError("MEMORY_INPUT", "La jerarquia de scopes portable es invalida.");
    }
  }
  const observationIds = unique(snapshot.observations.map((item) => item.id), "observation IDs");
  unique(snapshot.observations.map((item) => item.position), "observation positions");
  unique(snapshot.sessions.map((item) => item.id), "session IDs");
  unique(snapshot.sessions.map((item) => item.position), "session positions");
  unique(snapshot.pins.map((item) => item.observationId), "pins");
  unique(snapshot.relations.map((item) => `${item.sourceId}:${item.targetId}:${item.kind}`), "relations");
  for (const item of [...snapshot.observations, ...snapshot.sessions]) {
    if (!scopePaths.has(item.scopePath)) throw new MemoryError("MEMORY_INPUT", "Una entidad referencia un scope inexistente.");
  }
  for (const pin of snapshot.pins) {
    if (!observationIds.has(pin.observationId)) throw new MemoryError("MEMORY_INPUT", "Un pin referencia una observacion inexistente.");
  }
  for (const relation of snapshot.relations) {
    if (relation.sourceId === relation.targetId || !observationIds.has(relation.sourceId)
      || !observationIds.has(relation.targetId)) {
      throw new MemoryError("MEMORY_INPUT", "Una relacion portable es invalida.");
    }
  }
  const maxId = snapshot.observations.reduce((maximum, item) => Math.max(maximum, item.id), 0);
  const maxObservationPosition = snapshot.observations.reduce((maximum, item) => Math.max(maximum, item.position), -1);
  const maxSessionPosition = snapshot.sessions.reduce((maximum, item) => Math.max(maximum, item.position), -1);
  if (snapshot.state.nextObservationId <= maxId
    || snapshot.state.nextObservationPosition <= maxObservationPosition
    || snapshot.state.nextSessionPosition <= maxSessionPosition) {
    throw new MemoryError("MEMORY_INPUT", "Los contadores del snapshot portable son inconsistentes.");
  }
  if (snapshot.sourceBackend === "json" && (snapshot.pins.length > 0 || snapshot.relations.length > 0)) {
    throw new MemoryError("MEMORY_INPUT", "El formato JSON legado no puede declarar pins ni relaciones.");
  }
}

function exactRecord(value: unknown, keys: string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new MemoryError("MEMORY_INPUT", message);
  }
  return value as Record<string, unknown>;
}

function safeText(value: unknown, label: string, maximum = 16 * 1024 * 1024): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new MemoryError("MEMORY_INPUT", `${label} es invalido.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new MemoryError("MEMORY_INPUT", `${label} es invalido.`);
  }
  return value as number;
}

function unique<T>(values: T[], label: string): Set<T> {
  const result = new Set(values);
  if (result.size !== values.length) throw new MemoryError("MEMORY_INPUT", `El snapshot repite ${label}.`);
  return result;
}
