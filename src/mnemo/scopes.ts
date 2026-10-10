import type { MnemoDb, Observation } from "./db";

export interface ScopedObservation extends Observation {
  relevance: number;
}

const STOP_WORDS = new Set([
  "a", "al", "algo", "con", "como", "de", "del", "desde", "el", "en", "es", "esta", "este", "la", "las", "lo", "los", "mas", "mi", "para", "por", "que", "se", "sin", "sobre", "su", "un", "una", "unas", "unos", "y",
  "and", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with",
]);

export function buildScopeChain(scope: string): string[] {
  if (scope === "global") return ["global"];

  const segments = scope.split("/");
  const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  return ["global", ...ancestors];
}

export function observationsAcrossScopes(observations: Observation[], scopes: string[], limit: number): Observation[] {
  const safeLimit = boundedLimit(limit, 8, 50);
  const byScope = new Map(scopes.map((scope) => [scope, observations
    .filter((observation) => observation.project === scope)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))]));
  const orderedScopes = [...scopes].reverse();
  const result: Observation[] = [];
  let position = 0;

  while (result.length < safeLimit) {
    let added = false;
    for (const scope of orderedScopes) {
      const observation = byScope.get(scope)?.[position];
      if (!observation) continue;
      result.push(observation);
      added = true;
      if (result.length >= safeLimit) break;
    }
    if (!added) break;
    position += 1;
  }

  return result;
}

export function newest<T extends { created_at: string }>(items: T[]): T | null {
  return [...items].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export function suggestScopes(
  request: string,
  db: MnemoDb,
  currentProject: string,
  limit: number,
): Array<{ scope: string; matches: number }> {
  const terms = new Set(searchTerms(request));
  if (terms.size === 0) return [];

  const scopes = new Set([
    ...db.observations.map((observation) => observation.project),
    ...db.sessions.map((session) => session.project),
  ]);

  return [...scopes]
    .map((scope) => {
      const scopeTerms = new Set(searchTerms(scope.replaceAll("/", " ")));
      const sharedTerms = [...terms].filter((term) => scopeTerms.has(term));
      const relationshipBonus = currentProject && isRelatedScope(scope, currentProject) ? 1 : 0;
      return { scope, matches: sharedTerms.length + relationshipBonus };
    })
    .filter((candidate) => candidate.matches > 0)
    .sort((a, b) => b.matches - a.matches || a.scope.localeCompare(b.scope))
    .slice(0, boundedLimit(limit, 5, 20));
}

export function recallFromDb(db: MnemoDb, query: string, scope: string, limit: number): ScopedObservation[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  return db.observations
    .map((observation) => ({ ...observation, relevance: relevanceScore(observation, terms, scope) }))
    .filter((observation) => observation.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.created_at.localeCompare(a.created_at))
    .slice(0, boundedLimit(limit, 5, 20));
}

function relevanceScore(observation: Observation, terms: string[], scope: string): number {
  const titleTerms = new Set(searchTerms(observation.title));
  const contentTerms = new Set(searchTerms(observation.content));
  const tagTerms = new Set(searchTerms(observation.tags));
  const observationScope = observation.project;
  let score = 0;

  for (const term of terms) {
    if (tagTerms.has(term)) score += 5;
    if (titleTerms.has(term)) score += 3;
    if (contentTerms.has(term)) score += 1;
  }

  if (scope && observationScope === scope) score += 4;
  else if (scope && (isAncestorScope(observationScope, scope) || isAncestorScope(scope, observationScope))) score += 2;
  else if (scope && observationScope.split("/")[0] === scope.split("/")[0]) score += 1;

  const ageDays = Math.max(0, (Date.now() - Date.parse(observation.created_at)) / 86_400_000);
  score += Math.max(0, 1 - ageDays / 365);
  return score;
}

function searchTerms(value: string): string[] {
  return [...new Set(normalizedText(value)
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term)))];
}

function normalizedText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isAncestorScope(ancestor: string, scope: string): boolean {
  return scope.startsWith(`${ancestor}/`);
}

function isRelatedScope(left: string, right: string): boolean {
  return left === right || isAncestorScope(left, right) || isAncestorScope(right, left);
}

function boundedLimit(value: number, fallback: number, maximum: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
