import type { MnemoDb, Observation, SessionSummary } from "./db";
import { buildScopeChain, iterateObservationsAcrossScopes, newest, observationsAcrossScopes, recallFromDb, suggestScopes, type ScopedObservation } from "./scopes";

export interface ContextOptions {
  limit?: number;
  /** Presupuesto de caracteres JSON de recuerdos/sesion; no trunca su contenido. */
  budget?: number;
  /** Incluye los scopes descendientes del scope activo, sin cruzar su frontera. */
  rollup?: boolean;
}

export interface MemoryContext {
  latestSession: SessionSummary | null;
  observations: Observation[];
  scopeChain: string[];
  rollupScopes?: string[];
}

export interface BudgetedContext extends MemoryContext {
  budgetUsed: number;
  omittedPinnedIds: number[];
}

export interface MemoryBriefOptions extends ContextOptions {
  project?: string;
  scope?: string;
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

export function contextFromDb(db: MnemoDb, scope: string, limit = 8, rollup = false): MemoryContext {
  const scopeChain = buildScopeChain(scope);
  const rollupScopes = rollup ? descendantScopes(db, scope) : [];
  const subtreeSession = rollup ? newest(db.sessions.filter((session) => session.project === scope || rollupScopes.includes(session.project))) : null;
  const latestSession = subtreeSession ?? [...scopeChain].reverse()
    .map((candidate) => newest(db.sessions.filter((session) => session.project === candidate)))
    .find((session): session is SessionSummary => session !== null) ?? null;
  const result: MemoryContext = {
    latestSession,
    observations: observationsAcrossScopes(db.observations, [...scopeChain, ...rollupScopes], limit),
    scopeChain,
  };
  if (rollup) result.rollupScopes = rollupScopes;
  return result;
}

export function budgetedContext(db: MnemoDb, scope: string, options: ContextOptions, pins: number[]): BudgetedContext {
  const limit = options.limit ?? 8;
  const context = contextFromDb(db, scope, limit, options.rollup);
  const selectedScopes = [...context.scopeChain, ...(context.rollupScopes ?? [])];
  const pinIds = new Set(pins);
  const pinned = db.observations.filter((item) => pinIds.has(item.id) && selectedScopes.includes(item.project));
  const ordinary = db.observations.filter((item) => !pinIds.has(item.id));
  const budget = options.budget ?? Number.MAX_SAFE_INTEGER;
  const observations: Observation[] = [];
  let budgetUsed = 0;
  // Los pins tienen prioridad de seleccion, nunca autoridad para resolver conflictos.
  for (const pool of [pinned, ordinary]) {
    for (const item of iterateObservationsAcrossScopes(pool, selectedScopes)) {
      const size = JSON.stringify(item).length;
      if (budgetUsed + size > budget) continue;
      if (observations.length >= limit) break;
      observations.push(item);
      budgetUsed += size;
    }
  }
  const sessionSize = context.latestSession ? JSON.stringify(context.latestSession).length : 0;
  const latestSession = budgetUsed + sessionSize <= budget ? context.latestSession : null;
  if (latestSession) budgetUsed += sessionSize;
  return { ...context, observations, latestSession, budgetUsed,
    omittedPinnedIds: pinned.filter((item) => !observations.some((selected) => selected.id === item.id)).map((item) => item.id) };
}

function descendantScopes(db: MnemoDb, scope: string): string[] {
  const scopes = new Set([...db.observations.map((item) => item.project), ...db.sessions.map((item) => item.project)]);
  return [...scopes].filter((candidate) => candidate.startsWith(`${scope}/`))
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}

export function briefFromDb(request: string, db: MnemoDb, options: MemoryBriefOptions,
  normalize: (scope: string) => string, context?: (scope: string) => MemoryContext): MemoryBrief {
  const project = options.project ? normalize(options.project) : "";
  const requestedScope = options.scope ? normalize(options.scope) : "";
  const scopeSuggestions = suggestScopes(request, db, project, options.relatedLimit ?? 5);
  const top = scopeSuggestions[0];
  const suggested = top && top.matches >= 2 && top.matches > (scopeSuggestions[1]?.matches ?? 0) ? top.scope : "";
  const scope = requestedScope || project || suggested || null;
  const scopeSource = requestedScope ? "requested" : project ? "project" : suggested ? "suggested" : "unresolved";
  if (!scope) return { request, scope, scopeSource, scopeSuggestions, scopeChain: [], latestSession: null, observations: [],
    relatedMemories: fitRecords(options.relatedLimit === 0 ? [] : recallFromDb(db, request, "", options.relatedLimit ?? 5), options.budget) };
  const inherited = context ? context(scope) : options.budget === undefined ? contextFromDb(db, scope, options.limit ?? 8)
    : budgetedContext(db, scope, options, []);
  const contextIds = new Set(inherited.observations.map((item) => item.id));
  const relatedMemories = options.relatedLimit === 0 ? [] : recallFromDb(db, request, scope, options.relatedLimit ?? 5)
    .filter((item) => !contextIds.has(item.id));
  const used = inherited.observations.reduce((size, item) => size + JSON.stringify(item).length, 0)
    + (inherited.latestSession ? JSON.stringify(inherited.latestSession).length : 0);
  return { request, scope, scopeSource, scopeSuggestions, ...inherited,
    relatedMemories: fitRecords(relatedMemories, options.budget === undefined ? undefined : Math.max(0, options.budget - used)) };
}

function fitRecords<T>(items: T[], budget = Number.MAX_SAFE_INTEGER): T[] {
  let used = 0;
  return items.filter((item) => {
    const size = JSON.stringify(item).length;
    if (used + size > budget) return false;
    used += size;
    return true;
  });
}
