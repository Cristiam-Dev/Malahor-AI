import * as json from "./json-store";
import { observationType } from "./engine/observations";
import { MemoryError } from "./engine";
import { withJsonMemoryWrite, withMemoryStorage } from "./storage";

export type { ObservationType, Observation, SessionSummary, MnemoDb, SaveObservationInput } from "./json-store";
export { dbPath, normalizeProject } from "./json-store";

export function loadDb(filePath = json.dbPath()): json.MnemoDb {
  return withMemoryStorage(filePath, "read", { json: json.loadDb, sqlite: (engine) => engine.snapshot() });
}

export function saveDb(db: json.MnemoDb, filePath = json.dbPath()): void {
  // La sustitucion de snapshots legados no puede descartar pins, relaciones ni
  // escrituras concurrentes en v2. Solo el migrador importa snapshots a SQLite.
  withJsonMemoryWrite(filePath, (file) => json.saveDb(db, file));
}

export function saveObservation(input: json.SaveObservationInput, filePath = json.dbPath()): json.Observation {
  return withMemoryStorage(filePath, "write", {
    json: (file) => json.saveObservation(input, file), sqlite: (engine) => engine.save(input),
  });
}

export function saveSessionSummary(project: string, summary: string, filePath = json.dbPath()): json.SessionSummary {
  return withMemoryStorage(filePath, "write", {
    json: (file) => json.saveSessionSummary(project, summary, file), sqlite: (engine) => engine.sessionSummary(project, summary),
  });
}

export function searchObservations(query: string, project = "", type = "", limit = 5, subtree = false): json.Observation[] {
  if (subtree && !project.trim()) throw new MemoryError("MEMORY_INPUT", "subtree requiere project/scope explicito.");
  return withMemoryStorage(json.dbPath(), "read", {
    json: (file) => json.searchObservations(query, project, type, limit, file, subtree),
    sqlite: (engine) => engine.search({ query, scope: project || undefined, mode: project ? (subtree ? "subtree" : "exact") : "all",
      type: type ? observationType(type) : undefined, limit }),
  });
}

export function getObservation(id: number): json.Observation | null {
  return withMemoryStorage(json.dbPath(), "read", { json: (file) => json.getObservation(id, file), sqlite: (engine) => engine.get(id) });
}

export function listProjects(filePath = json.dbPath()): Array<{ project: string; observations: number; latest: string }> {
  return withMemoryStorage(filePath, "read", {
    json: json.listProjects,
    sqlite: (engine) => {
      const db = engine.snapshot();
      const scopes = new Map<string, { project: string; observations: number; latest: string }>();
      for (const item of [...db.observations, ...db.sessions]) {
        const entry = scopes.get(item.project) ?? { project: item.project, observations: 0, latest: item.created_at };
        if ("id" in item) entry.observations += 1;
        if (item.created_at > entry.latest) entry.latest = item.created_at;
        scopes.set(item.project, entry);
      }
      return [...scopes.values()].sort((a, b) => b.latest.localeCompare(a.latest));
    },
  });
}
