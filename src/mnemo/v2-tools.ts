import type { BackupResult } from "../cli/core/backup";
import { loadConfig } from "../cli/core/config";
import { assertHooksAllowed } from "../cli/core/hooks/engine";
import { resolveCanonicalProjectScope } from "../cli/core/project";
import type { Observation } from "./db";
import { backupMemory } from "./admin-backup";
import { MemoryError, type ScopeEntry } from "./engine";
import { mcpHookContext } from "./hook-context";
import { dbPath, loadDb as loadJsonDb } from "./json-store";
import { withMemoryStorage, withSqliteMemory } from "./storage";

export interface MemoryPinResult { id: number; pinned: boolean; }
export interface MemoryPromotePreview {
  id: number;
  fromProject: string;
  toProject: string;
  type: Observation["type"];
  title: string;
  tags: string;
  requiresConfirmation: string;
  canPromote: boolean;
}
export interface MemoryPromoteResult extends MemoryPromotePreview { promoted: true; backup: BackupResult; }

export function memoryTree(prefix = ""): ScopeEntry[] {
  return withMemoryStorage(dbPath(), "read", {
    json: (file) => {
      const db = loadJsonDb(file);
      const scopes = new Map<string, ScopeEntry>([["global", { path: "global", parent: null, depth: 0, observations: 0, sessions: 0 }]]);
      for (const item of [...db.observations, ...db.sessions]) {
        const parts = item.project.split("/");
        for (let depth = 0; depth < parts.length; depth += 1) {
          const current = parts.slice(0, depth + 1).join("/");
          scopes.set(current, scopes.get(current) ?? { path: current, parent: depth ? parts.slice(0, depth).join("/") : null,
            depth, observations: 0, sessions: 0 });
        }
        const entry = scopes.get(item.project)!;
        if ("id" in item) entry.observations += 1; else entry.sessions += 1;
      }
      const normalized = prefix ? normalize(prefix) : "";
      return [...scopes.values()].filter((entry) => !normalized || entry.path === normalized || entry.path.startsWith(`${normalized}/`))
        .sort((left, right) => left.path.localeCompare(right.path));
    },
    sqlite: (engine) => engine.tree(prefix || undefined),
  });
}

export function pinMemory(id: number): MemoryPinResult {
  return withSqliteMemory("write", (engine) => { engine.pin(id); return { id, pinned: true }; });
}

export function unpinMemory(id: number): MemoryPinResult {
  return withSqliteMemory("write", (engine) => { engine.unpin(id); return { id, pinned: false }; });
}

export function previewMemoryPromotion(id: number, ancestor: string): MemoryPromotePreview {
  return withSqliteMemory("read", (engine) => {
    const observation = engine.get(id);
    if (!observation) throw new MemoryError("MEMORY_INPUT", `No existe observacion con id ${id}`);
    const toProject = normalize(ancestor);
    const canPromote = observation.project.startsWith(`${toProject}/`);
    return {
      id, fromProject: observation.project, toProject, type: observation.type, title: observation.title, tags: observation.tags,
      requiresConfirmation: `PROMOTE ${id}:${observation.project}->${toProject}`, canPromote,
    };
  });
}

export function promoteMemory(id: number, ancestor: string, confirm: string): MemoryPromoteResult {
  const preview = previewMemoryPromotion(id, ancestor);
  if (!preview.canPromote) throw new MemoryError("MEMORY_INPUT", `${preview.toProject} no es ancestro estricto de ${preview.fromProject}.`);
  if (confirm !== preview.requiresConfirmation) {
    throw new MemoryError("MEMORY_INPUT", `Confirmacion invalida. Para promover #${id}, confirm debe ser: ${preview.requiresConfirmation}`);
  }
  assertHooksAllowed(mcpHookContext("memory.move.apply", {
    memoryScope: preview.fromProject,
    confirmation: confirm,
    destructive: true,
    metadata: {
      operation: "promote",
      previewToken: `promote:${preview.id}:${preview.fromProject}:${preview.toProject}`,
      requiresConfirmation: preview.requiresConfirmation,
    },
  }));
  const backup = backupMemory();
  withSqliteMemory("write", (engine) => {
    const current = engine.get(id);
    if (!current || current.project !== preview.fromProject) {
      throw new MemoryError("MEMORY_INPUT", "La observacion cambio desde el preview; solicita uno nuevo.");
    }
    return engine.promote(id, preview.toProject);
  });
  return { ...preview, promoted: true, backup };
}

function normalize(scope: string): string {
  return resolveCanonicalProjectScope(scope, loadConfig().projects.aliases);
}
