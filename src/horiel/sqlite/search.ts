import type { DatabaseSync } from "node:sqlite";

import { HorielError } from "../core/errors";
import type { MemoryRecord } from "../core/model";
import { classifyScope } from "../core/scopes";
import type {
  StoreInfo,
  StoreSearchCandidate,
  StoreSearchPage,
  StoreSearchRequest,
} from "../core/store";
import {
  compareRankTuples,
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchRankTuple,
} from "./cursor";
import { normalizeSqliteError } from "./database";

interface SearchRow extends Record<string, unknown> {
  raw_score: number;
  pinned: number;
  relation_count: number;
}

interface RankedCandidate {
  candidate: StoreSearchCandidate;
  tuple: SearchRankTuple;
}

const SCOPE_PRIORITY = {
  exact: 4,
  ancestor: 3,
  descendant: 2,
  global: 1,
} as const;

export function searchSqliteCandidates(input: {
  database: DatabaseSync;
  request: StoreSearchRequest;
  info: StoreInfo;
  mapMemory(row: Record<string, unknown>): MemoryRecord;
}): StoreSearchPage {
  const { database, request, info } = input;
  const after = request.cursor
    ? decodeSearchCursor({
      cursor: request.cursor,
      storeId: info.storeId,
      sequence: info.sequence,
      request,
    })
    : undefined;
  const expression = literalFtsExpression(request.terms);

  let rows: SearchRow[];
  try {
    rows = database.prepare(`
      SELECT m.*,
             bm25(memory_fts, 8.0, 4.0, 2.0) AS raw_score,
             EXISTS(SELECT 1 FROM pins AS p WHERE p.memory_id = m.id) AS pinned,
             (
               SELECT count(*)
                 FROM relations AS r
                WHERE r.source_id = m.id OR r.target_id = m.id
             ) AS relation_count
        FROM memory_fts
        JOIN memories AS m ON m.rowid = memory_fts.rowid
       WHERE memory_fts MATCH ?
    `).all(expression) as SearchRow[];
  } catch (error) {
    throw normalizeSqliteError(error, "integrity_failed");
  }

  const eligible = rows.flatMap((row) => {
    const memory = input.mapMemory(row);
    const scope = classifyScope(memory.scope, request.scope, request);
    if (!scope) return [];
    if (request.types?.length && !request.types.includes(memory.type)) return [];
    if (request.tags?.length && !request.tags.every((tag) => memory.tags.includes(tag))) return [];
    const rawScore = Number(row.raw_score);
    if (!Number.isFinite(rawScore)) return [];
    return [{ row, memory, scope, rawScore }];
  });

  const scoreByRaw = normalizedScores(eligible.map(({ rawScore }) => rawScore));
  const ranked: RankedCandidate[] = eligible.map(({ row, memory, scope, rawScore }) => {
    const textScore = scoreByRaw.get(rawScore) ?? 1;
    const pinned = Number(row.pinned) === 1;
    const relationCount = Math.max(0, Math.min(100, Math.trunc(Number(row.relation_count) || 0)));
    const candidate: StoreSearchCandidate = { memory, textScore, pinned, relationCount };
    const tuple: SearchRankTuple = [
      SCOPE_PRIORITY[scope.scopeClass],
      scope.scopeDistance,
      pinned ? 1 : 0,
      textScore,
      memory.updatedAt,
      relationCount,
      memory.id,
    ];
    return { candidate, tuple };
  }).sort((left, right) => compareRankTuples(left.tuple, right.tuple));

  const remaining = after
    ? ranked.filter(({ tuple }) => compareRankTuples(tuple, after) > 0)
    : ranked;
  const selected = remaining.slice(0, request.limit);
  const hasMore = remaining.length > selected.length;
  const finalTuple = selected.at(-1)?.tuple;
  return {
    items: selected.map(({ candidate }) => candidate),
    sequence: info.sequence,
    ...(hasMore && finalTuple
      ? { nextCursor: encodeSearchCursor({
        storeId: info.storeId,
        sequence: info.sequence,
        request,
        after: finalTuple,
      }) }
      : {}),
  };
}

function literalFtsExpression(terms: readonly string[]): string {
  if (!Array.isArray(terms) || terms.length === 0 || terms.length > 24) {
    throw new HorielError("invalid_input", "Horiel FTS5 terms are invalid.");
  }
  return terms.map((term) => {
    if (typeof term !== "string" || !term || Buffer.byteLength(term, "utf8") > 64
      || !/^[\p{L}\p{N}]+$/u.test(term)) {
      throw new HorielError("invalid_input", "Horiel FTS5 term is invalid.");
    }
    return `"${term}"`;
  }).join(" AND ");
}

function normalizedScores(rawScores: readonly number[]): Map<number, number> {
  const unique = [...new Set(rawScores)].sort((left, right) => left - right);
  const result = new Map<number, number>();
  unique.forEach((raw, index) => result.set(raw, Math.max(1, 1000 - index)));
  return result;
}
