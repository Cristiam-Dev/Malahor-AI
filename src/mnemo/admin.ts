import type { BackupResult } from "../cli/core/backup";
import { assertHooksAllowed } from "../cli/core/hooks/engine";
import { mcpHookContext } from "./hook-context";
import { dbPath, loadDb, normalizeProject, saveDb, type Observation, type ObservationType, type SessionSummary } from "./db";
import { backupMemory } from "./admin-backup";
import { memoryLocation, withSqliteMemory } from "./storage";

export interface MemoryDeletePreview {
  project: string;
  observations: number;
  sessions: number;
  latest: string | null;
  childScopes: string[];
  protected: boolean;
  requiresConfirmation: string;
  canDelete: boolean;
  note: string;
}

export interface MemoryDeleteResult extends MemoryDeletePreview {
  deletedObservations: number;
  deletedSessions: number;
  backup: BackupResult;
}

export interface MemoryInspectResult extends MemoryDeletePreview {
  recentObservations: Array<Pick<Observation, "id" | "type" | "title" | "tags" | "created_at">>;
  recentSessions: SessionSummary[];
}

export interface MemoryMovePreview {
  id: number;
  fromProject: string;
  toProject: string;
  type: ObservationType;
  title: string;
  tags: string;
  requiresConfirmation: string;
  canMove: boolean;
}

export interface MemoryMoveResult extends MemoryMovePreview {
  backup: BackupResult;
  moved: true;
}

export function inspectProjectMemory(project: string, filePath = dbPath()): MemoryInspectResult {
  const preview = previewProjectDeletion(project, filePath);
  const db = loadDb(filePath);
  const observations = db.observations
    .filter((observation) => observation.project === preview.project)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const sessions = db.sessions
    .filter((session) => session.project === preview.project)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    ...preview,
    recentObservations: observations.slice(0, 10).map((observation) => ({
      id: observation.id,
      type: observation.type,
      title: observation.title,
      tags: observation.tags,
      created_at: observation.created_at,
    })),
    recentSessions: sessions.slice(0, 5),
  };
}

export function previewProjectDeletion(project: string, filePath = dbPath()): MemoryDeletePreview {
  const db = loadDb(filePath);
  const normalizedProject = normalizeProject(project);
  const observations = db.observations.filter((observation) => observation.project === normalizedProject);
  const sessions = db.sessions.filter((session) => session.project === normalizedProject);
  const childScopes = childScopesForProject(normalizedProject, db);
  const protectedScope = normalizedProject === "global";
  const latest = [...observations, ...sessions]
    .map((item) => item.created_at)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;

  return {
    project: normalizedProject,
    observations: observations.length,
    sessions: sessions.length,
    latest,
    childScopes,
    protected: protectedScope,
    requiresConfirmation: protectedScope ? "DELETE GLOBAL" : normalizedProject,
    canDelete: observations.length + sessions.length > 0,
    note: protectedScope
      ? "global esta protegido: solo se borra con confirmacion exacta DELETE GLOBAL."
      : childScopes.length > 0
        ? "Solo se borra el scope exacto; los scopes hijos listados no se eliminan."
        : "Solo se borra el scope exacto.",
  };
}

export function deleteProjectMemory(project: string, confirm: string, filePath = dbPath()): MemoryDeleteResult {
  const preview = previewProjectDeletion(project, filePath);

  if (confirm !== preview.requiresConfirmation) {
    throw new Error(`Confirmacion invalida. Para borrar ${preview.project}, confirm debe ser: ${preview.requiresConfirmation}`);
  }

  assertHooksAllowed(mcpHookContext("memory.delete.apply", {
    memoryScope: preview.project,
    confirmation: confirm,
    destructive: true,
    metadata: {
      previewToken: `delete:${preview.project}:${preview.observations}:${preview.sessions}`,
      requiresConfirmation: preview.requiresConfirmation,
    },
  }));

  const location = memoryLocation(filePath);
  const backup = backupMemory(filePath);
  let deletedObservations: number;
  let deletedSessions: number;
  if (location.backend === "sqlite") {
    ({ deletedObservations, deletedSessions } = withSqliteMemory("write", (engine) => engine.deleteScope(preview.project, preview), filePath));
  } else {
    const db = loadDb(filePath);
    const next = { ...db,
      observations: db.observations.filter((observation) => observation.project !== preview.project),
      sessions: db.sessions.filter((session) => session.project !== preview.project) };
    deletedObservations = db.observations.length - next.observations.length;
    deletedSessions = db.sessions.length - next.sessions.length;
    if (deletedObservations > 0 || deletedSessions > 0) saveDb(next, filePath);
  }

  return { ...preview, deletedObservations, deletedSessions, backup };
}

export function previewMemoryMove(id: number, targetProject: string, filePath = dbPath()): MemoryMovePreview {
  const db = loadDb(filePath);
  const observation = db.observations.find((item) => item.id === id);
  if (!observation) {
    throw new Error(`No existe observacion con id ${id}`);
  }

  const toProject = normalizeProject(targetProject);
  return {
    id,
    fromProject: observation.project,
    toProject,
    type: observation.type,
    title: observation.title,
    tags: observation.tags,
    requiresConfirmation: `${id}:${toProject}`,
    canMove: observation.project !== toProject,
  };
}

export function moveMemory(id: number, targetProject: string, confirm: string, filePath = dbPath()): MemoryMoveResult {
  const preview = previewMemoryMove(id, targetProject, filePath);

  if (confirm !== preview.requiresConfirmation) {
    throw new Error(`Confirmacion invalida. Para mover #${id}, confirm debe ser: ${preview.requiresConfirmation}`);
  }

  assertHooksAllowed(mcpHookContext("memory.move.apply", {
    memoryScope: preview.fromProject,
    confirmation: confirm,
    destructive: true,
    metadata: {
      previewToken: `move:${preview.id}:${preview.fromProject}:${preview.toProject}`,
      requiresConfirmation: preview.requiresConfirmation,
    },
  }));

  const location = memoryLocation(filePath);
  const backup = backupMemory(filePath);
  if (location.backend === "sqlite") {
    withSqliteMemory("write", (engine) => engine.move(id, preview.toProject, preview.fromProject), filePath);
  } else {
    const db = loadDb(filePath);
    saveDb({ ...db, observations: db.observations.map((observation) => observation.id === id
      ? { ...observation, project: preview.toProject } : observation) }, filePath);
  }

  return { ...preview, backup, moved: true };
}

function childScopesForProject(project: string, db: ReturnType<typeof loadDb>): string[] {
  const scopes = new Set([
    ...db.observations.map((observation) => observation.project),
    ...db.sessions.map((session) => session.project),
  ]);

  return [...scopes]
    .filter((scope) => scope.startsWith(`${project}/`))
    .sort();
}
