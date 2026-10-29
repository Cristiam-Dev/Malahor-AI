import { dbPath, loadDb, normalizeProject } from "./db";
import * as json from "./json-store";
import { buildScopeChain, recallFromDb, type ScopedObservation } from "./scopes";
import { briefFromDb, budgetedContext, type BudgetedContext, type MemoryBrief, type MemoryBriefOptions } from "./retrieval";
import { withMemoryStorage } from "./storage";

export type { MemoryBrief, MemoryBriefOptions } from "./retrieval";

export function scopeChainForProject(project: string): string[] {
  return buildScopeChain(normalizeProject(project));
}

export function contextForProject(
  project: string,
  limit = 8,
  filePath?: string,
  options: { budget?: number; rollup?: boolean } = {},
): BudgetedContext {
  return withMemoryStorage(filePath ?? dbPath(), "read", {
    json: (file) => budgetedContext(json.loadDb(file), normalizeProject(project), { limit, ...options }, []),
    sqlite: (engine) => engine.context(project, { limit, ...options }),
  });
}

export function memoryBrief(request: string, options: MemoryBriefOptions = {}): MemoryBrief {
  return withMemoryStorage(dbPath(), "read", {
    json: (file) => briefFromDb(request, json.loadDb(file), options, normalizeProject),
    sqlite: (engine) => engine.brief(request, options),
  });
}

export function recallObservations(query: string, scope = "", limit = 5, filePath?: string): ScopedObservation[] {
  return withMemoryStorage(filePath ?? dbPath(), "read", {
    json: (file) => recallFromDb(json.loadDb(file), query, scope ? normalizeProject(scope) : "", limit),
    sqlite: (engine) => engine.recall(query, scope, limit),
  });
}
