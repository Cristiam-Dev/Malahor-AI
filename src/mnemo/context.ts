import { loadDb, normalizeProject, type MnemoDb, type Observation, type SessionSummary } from "./db";
import { buildScopeChain, newest, observationsAcrossScopes, recallFromDb, suggestScopes, type ScopedObservation } from "./scopes";

export interface MemoryBriefOptions {
  project?: string;
  scope?: string;
  limit?: number;
  relatedLimit?: number;
}

export interface MemoryBrief {
  request: string;
  scope: string | null;
  scopeSource: "requested" | "project" | "suggested" | "unresolved";
  scopeChain: string[];
  scopeSuggestions: Array<{ scope: string; matches: number }>;
  latestSession: SessionSummary | null;
  observations: Observation[];
  relatedMemories: ScopedObservation[];
}

export function scopeChainForProject(project: string): string[] {
  return buildScopeChain(normalizeProject(project));
}

export function contextForProject(
  project: string,
  limit = 8,
  filePath?: string,
): { latestSession: SessionSummary | null; observations: Observation[]; scopeChain: string[] } {
  const db = loadDb(filePath);
  const scopeChain = scopeChainForProject(project);
  const latestSession = [...scopeChain]
    .reverse()
    .map((scope) => newest(db.sessions.filter((session) => session.project === scope)))
    .find((session): session is SessionSummary => session !== null) ?? null;
  const observations = observationsAcrossScopes(db.observations, scopeChain, limit);

  return { latestSession, observations, scopeChain };
}

export function memoryBrief(request: string, options: MemoryBriefOptions = {}): MemoryBrief {
  const db = loadDb();
  const project = options.project ? normalizeProject(options.project) : "";
  const scopeSuggestions = suggestScopes(request, db, project, options.relatedLimit ?? 5);
  const requestedScope = options.scope ? normalizeProject(options.scope) : "";
  const topSuggestion = scopeSuggestions[0];
  const secondSuggestion = scopeSuggestions[1];
  const suggestedScope = topSuggestion && topSuggestion.matches >= 2 && topSuggestion.matches > (secondSuggestion?.matches ?? 0)
    ? topSuggestion.scope
    : "";
  const scope = requestedScope || project || suggestedScope || null;
  const scopeSource: MemoryBrief["scopeSource"] = requestedScope
    ? "requested"
    : project
      ? "project"
      : suggestedScope
        ? "suggested"
        : "unresolved";

  if (!scope) {
    return {
      request,
      scope: null,
      scopeSource,
      scopeChain: [],
      scopeSuggestions,
      latestSession: null,
      observations: [],
      relatedMemories: recallFromDb(db, request, "", options.relatedLimit ?? 5),
    };
  }

  const scopeChain = buildScopeChain(scope);
  const latestSession = [...scopeChain]
    .reverse()
    .map((candidate) => newest(db.sessions.filter((session) => session.project === candidate)))
    .find((session): session is SessionSummary => session !== null) ?? null;
  const observations = observationsAcrossScopes(db.observations, scopeChain, options.limit ?? 8);
  const contextIds = new Set(observations.map((observation) => observation.id));
  const relatedMemories = recallFromDb(db, request, scope, options.relatedLimit ?? 5)
    .filter((observation) => !contextIds.has(observation.id));

  return { request, scope, scopeSource, scopeChain, scopeSuggestions, latestSession, observations, relatedMemories };
}

export function recallObservations(query: string, scope = "", limit = 5, filePath?: string): ScopedObservation[] {
  const db = loadDb(filePath);
  return recallFromDb(db, query, scope ? normalizeProject(scope) : "", limit);
}
