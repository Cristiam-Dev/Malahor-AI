import { invalidInput } from "./errors";
import type { MemoryRecord, MemoryType } from "./model";
import { classifyScope, type ScopeClass } from "./scopes";
import type { StoreSearchCandidate, StoreSearchRequest } from "./store";
import { HORIEL_LIMITS, normalizeTags, validateMemoryType } from "./validation";

export const HORIEL_RANKING_VERSION = 1;

export interface SearchRank {
  scopeClass: ScopeClass;
  scopeDistance: number;
  pinned: boolean;
  textScore: number;
  updatedAt: string;
  relationCount: number;
}

export interface RankedMemory {
  memory: MemoryRecord;
  rank: SearchRank;
}

export interface SearchMemoryInput {
  scope: string;
  query: string;
  includeAncestors?: boolean;
  rollup?: boolean;
  includeGlobal?: boolean;
  types?: readonly MemoryType[];
  tags?: readonly string[];
  limit?: number;
  cursor?: string;
}

export function tokenizeSearchQuery(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > HORIEL_LIMITS.queryBytes) {
    return invalidInput("Search query is empty or too large.");
  }
  const matches = value.normalize("NFC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of matches) {
    if (Buffer.byteLength(term, "utf8") > HORIEL_LIMITS.queryTermBytes) {
      return invalidInput("Search term exceeds the supported limit.");
    }
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  if (terms.length === 0 || terms.length > HORIEL_LIMITS.queryTerms) {
    return invalidInput("Search query has an invalid number of literal terms.");
  }
  return terms;
}

export function normalizeSearchRequest(input: SearchMemoryInput): StoreSearchRequest {
  if (!input || typeof input !== "object") return invalidInput("Search input is required.");
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HORIEL_LIMITS.pageSize) {
    return invalidInput("Search limit is invalid.");
  }
  let types: MemoryType[] | undefined;
  if (input.types !== undefined) {
    if (!Array.isArray(input.types) || input.types.length === 0) return invalidInput("Search types are invalid.");
    types = [...new Set(input.types.map(validateMemoryType))].sort();
  }
  const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 1024
    || /[\u0000-\u001f\u007f]/.test(input.cursor))) {
    return invalidInput("Search cursor is invalid.");
  }
  return {
    scope: input.scope,
    terms: tokenizeSearchQuery(input.query),
    includeAncestors: input.includeAncestors === true,
    rollup: input.rollup === true,
    includeGlobal: input.includeGlobal === true,
    ...(types ? { types } : {}),
    ...(tags ? { tags } : {}),
    limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

export function rankSearchCandidates(
  candidates: readonly StoreSearchCandidate[],
  request: StoreSearchRequest,
): RankedMemory[] {
  const selected = new Map<string, RankedMemory>();
  for (const candidate of candidates) {
    if (!candidate || !candidate.memory || !Number.isFinite(candidate.textScore)
      || candidate.textScore < 1 || candidate.textScore > 1000) continue;
    const scope = classifyScope(candidate.memory.scope, request.scope, request);
    if (!scope) continue;
    if (request.types?.length && !request.types.includes(candidate.memory.type)) continue;
    if (request.tags?.length && !request.tags.every((tag) => candidate.memory.tags.includes(tag))) continue;
    const ranked: RankedMemory = {
      memory: candidate.memory,
      rank: {
        ...scope,
        pinned: candidate.pinned === true,
        textScore: Math.trunc(candidate.textScore),
        updatedAt: candidate.memory.updatedAt,
        relationCount: Math.max(0, Math.min(100, Math.trunc(candidate.relationCount || 0))),
      },
    };
    const previous = selected.get(candidate.memory.id);
    if (!previous || compareRanked(ranked, previous) < 0) selected.set(candidate.memory.id, ranked);
  }
  return [...selected.values()].sort(compareRanked).slice(0, request.limit);
}

function compareRanked(left: RankedMemory, right: RankedMemory): number {
  const classOrder: Record<ScopeClass, number> = { exact: 4, ancestor: 3, descendant: 2, global: 1 };
  const classDifference = classOrder[right.rank.scopeClass] - classOrder[left.rank.scopeClass];
  if (classDifference !== 0) return classDifference;
  if (left.rank.scopeDistance !== right.rank.scopeDistance) return left.rank.scopeDistance - right.rank.scopeDistance;
  if (left.rank.pinned !== right.rank.pinned) return left.rank.pinned ? -1 : 1;
  if (left.rank.textScore !== right.rank.textScore) return right.rank.textScore - left.rank.textScore;
  const timeDifference = Date.parse(right.rank.updatedAt) - Date.parse(left.rank.updatedAt);
  if (timeDifference !== 0) return timeDifference;
  if (left.rank.relationCount !== right.rank.relationCount) return right.rank.relationCount - left.rank.relationCount;
  return left.memory.id.localeCompare(right.memory.id);
}

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function newestMemoryFirst(left: MemoryRecord, right: MemoryRecord): number {
  const difference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return difference || left.id.localeCompare(right.id);
}
