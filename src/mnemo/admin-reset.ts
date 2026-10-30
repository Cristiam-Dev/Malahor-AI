import { backupFile, type BackupResult } from "../cli/core/backup";
import { assertHooksAllowed } from "../cli/core/hooks/engine";
import type { HookContext } from "../cli/core/hooks/types";
import { backupSqliteMemory, backupsDirForDb } from "./admin-backup";
import * as json from "./json-store";
import { MemoryError, type MemoryStatistics } from "./engine";
import { mnemoHookContext } from "./hook-context";
import { digest } from "./migration/snapshot";
import { memoryLocation, withMemoryStorage } from "./storage";

export interface MemoryResetPreview {
  backend: "json" | "sqlite";
  activeFile: string;
  scope: string | null;
  all: boolean;
  observations: number;
  sessions: number;
  pins: number;
  relations: number;
  nextId: number;
  maxObservationId: number;
  latest: string | null;
  childScopes: string[];
  requiresConfirmation: string;
  previewToken: string;
  canReset: boolean;
  note: string;
}

export interface MemoryResetResult extends MemoryResetPreview {
  removedObservations: number;
  removedSessions: number;
  backup: BackupResult;
  reset: boolean;
}

export interface MemoryResetApplyOptions {
  harness?: HookContext["harness"];
  approval?: string;
}

export function previewMemoryReset(scope: string | null, filePath = json.dbPath()): MemoryResetPreview {
  const normalizedScope = scope === null ? null : json.normalizeProject(scope);
  return withMemoryStorage(filePath, "read", {
    json: (file) => previewJsonReset(file, normalizedScope),
    sqlite: (engine) => {
      const statistics = engine.statistics(normalizedScope ?? undefined);
      const childScopes = normalizedScope === null ? [] : engine.tree(normalizedScope)
        .map((entry) => entry.path).filter((path) => path !== normalizedScope);
      return buildPreview("sqlite", engine.file, normalizedScope, statistics, childScopes);
    },
  });
}

export function resetMemory(scope: string | null, confirm: string, filePath = json.dbPath(),
  options: MemoryResetApplyOptions = {}): MemoryResetResult {
  const preview = previewMemoryReset(scope, filePath);
  if (confirm !== preview.requiresConfirmation) {
    throw new MemoryError("MEMORY_INPUT",
      `Confirmacion invalida. Para resetear ${preview.all ? "toda la memoria" : preview.scope}, confirm debe ser: ${preview.requiresConfirmation}`);
  }
  if (!preview.canReset) return noOpResult(preview);

  assertHooksAllowed(mnemoHookContext("memory.delete.apply", options.harness ?? "cli", {
    approval: options.approval,
    memoryScope: preview.scope ?? "global",
    confirmation: confirm,
    destructive: true,
    targetPaths: [preview.activeFile],
    metadata: {
      operation: preview.all ? "reset-all" : "reset-scope",
      previewToken: preview.previewToken,
      requiresConfirmation: preview.requiresConfirmation,
      writesMalahorData: true,
    },
  }));

  const backup = withMemoryStorage(filePath, "write", {
    json: (file) => resetJson(file, preview),
    sqlite: (engine) => {
      if (preview.backend !== "sqlite") throw backendChanged();
      const current = engine.statistics(preview.scope ?? undefined);
      assertSameStatistics(current, preview);
      const result = backupSqliteMemory(engine, backupsDirForDb(filePath), false);
      if (preview.all) engine.resetAll(current);
      else engine.deleteScope(preview.scope!, preview);
      return result;
    },
  });

  return {
    ...preview,
    removedObservations: preview.observations,
    removedSessions: preview.sessions,
    backup,
    reset: true,
  };
}

function previewJsonReset(file: string, scope: string | null): MemoryResetPreview {
  const db = json.loadDb(file);
  const observations = scope === null ? db.observations : db.observations.filter((item) => item.project === scope);
  const sessions = scope === null ? db.sessions : db.sessions.filter((item) => item.project === scope);
  const childScopes = scope === null ? [] : [...new Set([
    ...db.observations.map((item) => item.project),
    ...db.sessions.map((item) => item.project),
  ])].filter((item) => item.startsWith(`${scope}/`)).sort();
  const latest = [...observations, ...sessions].map((item) => item.created_at).sort((a, b) => b.localeCompare(a))[0] ?? null;
  return buildPreview("json", file, scope, {
    observations: observations.length,
    sessions: sessions.length,
    pins: 0,
    relations: 0,
    nextId: db.nextId,
    maxObservationId: observations.reduce((max, observation) => Math.max(max, observation.id), 0),
    latest,
  }, childScopes);
}

function buildPreview(backend: "json" | "sqlite", activeFile: string, scope: string | null,
  statistics: MemoryStatistics, childScopes: string[]): MemoryResetPreview {
  const all = scope === null;
  const requiresConfirmation = all ? "ALL" : scope;
  const canReset = statistics.observations + statistics.sessions > 0;
  const tokenPayload = { backend, activeFile, scope, ...statistics };
  return {
    backend,
    activeFile,
    scope,
    all,
    ...statistics,
    childScopes,
    requiresConfirmation,
    previewToken: `reset:${digest(JSON.stringify(tokenPayload))}`,
    canReset,
    note: all
      ? "El reset total elimina todos los scopes operativos y reinicia los contadores."
      : childScopes.length > 0
        ? "Solo se resetea el scope exacto; los scopes hijos listados no se eliminan."
        : "Solo se resetea el scope exacto.",
  };
}

function resetJson(file: string, expected: MemoryResetPreview): BackupResult {
  if (expected.backend !== "json") throw backendChanged();
  const current = previewJsonReset(file, expected.scope);
  assertSamePreview(current, expected);
  const backup = backupFile(file, backupsDirForDb(file), false);
  const db = json.loadDb(file);
  const next = expected.all
    ? { observations: [], sessions: [], nextId: 1 }
    : {
      ...db,
      observations: db.observations.filter((item) => item.project !== expected.scope),
      sessions: db.sessions.filter((item) => item.project !== expected.scope),
    };
  json.saveDb(next, file);
  return backup;
}

function assertSameStatistics(current: MemoryStatistics, expected: MemoryResetPreview): void {
  if (current.observations !== expected.observations || current.sessions !== expected.sessions
    || current.pins !== expected.pins || current.relations !== expected.relations
    || current.nextId !== expected.nextId || current.maxObservationId !== expected.maxObservationId
    || current.latest !== expected.latest) {
    throw new MemoryError("MEMORY_BUSY", "La memoria cambio desde el preview; solicita uno nuevo.");
  }
}

function assertSamePreview(current: MemoryResetPreview, expected: MemoryResetPreview): void {
  if (current.backend !== expected.backend || current.activeFile !== expected.activeFile
    || current.previewToken !== expected.previewToken) {
    throw new MemoryError("MEMORY_BUSY", "La memoria cambio desde el preview; solicita uno nuevo.");
  }
}

function noOpResult(preview: MemoryResetPreview): MemoryResetResult {
  return {
    ...preview,
    removedObservations: 0,
    removedSessions: 0,
    backup: { source: preview.activeFile, destination: null, created: false },
    reset: false,
  };
}

function backendChanged(): MemoryError {
  return new MemoryError("MEMORY_ACTIVATION", "El almacenamiento activo cambio desde el preview; solicita uno nuevo.");
}
