import { MemoryEngine, MemoryError, type ScopeEntry } from "../engine";
import type { LegacyMemorySnapshot } from "./types";
import { legacySessionIds } from "./snapshot";

export interface MigrationDatabaseInspection {
  exact: boolean;
  postMigrationChanges: boolean;
}

export function inspectMigrationDatabase(file: string, snapshot: LegacyMemorySnapshot,
  fullIntegrity = false): MigrationDatabaseInspection {
  const engine = MemoryEngine.open(file, { access: fullIntegrity ? "write" : "read" });
  try {
    const actual = engine.snapshot();
    const state = engine.legacyImportState();
    const exact = JSON.stringify(actual) === JSON.stringify(snapshot.db)
      && JSON.stringify(state.sessionIds) === JSON.stringify(legacySessionIds(snapshot))
      && state.nextObservationPosition === snapshot.db.observations.length
      && state.nextSessionPosition === snapshot.db.sessions.length
      && state.pins === 0
      && state.relations === 0
      && JSON.stringify(engine.tree()) === JSON.stringify(expectedTree(snapshot));
    if (fullIntegrity) {
      engine.integrity();
      if (!exact) throw new MemoryError("MEMORY_FORMAT", "SQLite no coincide campo a campo con el snapshot legado.");
      verifyConsumerQueries(engine, snapshot);
      engine.checkpoint();
    }
    return { exact, postMigrationChanges: !exact };
  } finally {
    engine.close();
  }
}

function verifyConsumerQueries(engine: MemoryEngine, snapshot: LegacyMemorySnapshot): void {
  for (const item of snapshot.db.observations) {
    if (JSON.stringify(engine.get(item.id)) !== JSON.stringify(item)) {
      throw new MemoryError("MEMORY_FORMAT", `La lectura por ID no coincide para la observacion ${item.id}.`);
    }
  }
  const scopes = snapshot.counts.length > 0 ? snapshot.counts.map((entry) => entry.scope) : ["global"];
  for (const scope of scopes) {
    const context = engine.context(scope, { limit: 1, budget: Number.MAX_SAFE_INTEGER });
    if (context.scopeChain.at(-1) !== scope) {
      throw new MemoryError("MEMORY_FORMAT", `La recuperacion de contexto no conserva el scope ${scope}.`);
    }
    engine.search({ query: "", scope, mode: "exact", match: "substring", limit: 1 });
  }
  const token = firstFtsToken(snapshot);
  if (token && engine.search({ query: token, mode: "all", match: "fts", limit: 1 }).length === 0) {
    throw new MemoryError("MEMORY_FORMAT", "FTS5 no recupera contenido importado antes de la activacion.");
  }
}

function firstFtsToken(snapshot: LegacyMemorySnapshot): string | undefined {
  for (const item of snapshot.db.observations) {
    for (const term of `${item.title}\n${item.content}\n${item.tags}`.match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (term.length <= 4096) return term;
    }
  }
  return undefined;
}

function expectedTree(snapshot: LegacyMemorySnapshot): ScopeEntry[] {
  const scopes = new Map<string, ScopeEntry>([["global", {
    path: "global", parent: null, depth: 0, observations: 0, sessions: 0,
  }]]);
  for (const item of [...snapshot.db.observations, ...snapshot.db.sessions]) {
    const parts = item.project.split("/");
    for (let depth = 0; depth < parts.length; depth += 1) {
      const current = parts.slice(0, depth + 1).join("/");
      scopes.set(current, scopes.get(current) ?? {
        path: current,
        parent: depth === 0 ? null : parts.slice(0, depth).join("/"),
        depth,
        observations: 0,
        sessions: 0,
      });
    }
    const scope = scopes.get(item.project)!;
    if ("id" in item) scope.observations += 1;
    else scope.sessions += 1;
  }
  return [...scopes.values()].sort((left, right) => left.path.localeCompare(right.path));
}
