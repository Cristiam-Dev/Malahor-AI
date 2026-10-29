import { resolveCanonicalProjectScope, type ProjectAliases } from "../../cli/core/project";
import type { Observation, ObservationType } from "../db";
import { rowNumber, rowText, type SqlRow, type SqlValue } from "./driver";
import { MemoryError } from "./errors";
import type { MemoryStore } from "./store";

const types: ObservationType[] = ["decision", "bug", "pattern", "architecture", "learning", "general"];
export type SearchScope = "exact" | "subtree" | "all";
export interface SearchOptions {
  query?: string;
  scope?: string;
  mode?: SearchScope;
  match?: "substring" | "fts";
  type?: ObservationType;
  limit?: number;
}

export function canonicalScope(scope: string, aliases: ProjectAliases): string {
  if (typeof scope !== "string" || !scope.trim() || scope.length > 1024) throw new MemoryError("MEMORY_INPUT", "Scope requerido (maximo 1024 caracteres).");
  const result = resolveCanonicalProjectScope(scope, aliases);
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(result)) throw new MemoryError("MEMORY_INPUT", "Scope canonico invalido.");
  return result;
}

export function observationType(value: string): ObservationType {
  if (!types.includes(value as ObservationType)) throw new MemoryError("MEMORY_INPUT", "Tipo de observacion invalido.");
  return value as ObservationType;
}

export function boundedInteger(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MemoryError("MEMORY_INPUT", `Valor entero requerido entre ${minimum} y ${maximum}.`);
  }
  return value;
}

export function ensureScope(store: MemoryStore, scope: string): void {
  const parts = scope.split("/");
  for (let depth = 0; depth < parts.length; depth += 1) {
    const current = parts.slice(0, depth + 1).join("/");
    const parent = depth === 0 ? null : parts.slice(0, depth).join("/");
    if (!store.get("SELECT path FROM scopes WHERE path = ?", [current])) {
      store.run("INSERT INTO scopes(path, parent_path, depth) VALUES (?, ?, ?)", [current, parent, depth]);
    }
  }
}

export function toObservation(row: SqlRow): Observation {
  return {
    id: rowNumber(row, "id"), project: rowText(row, "scope_path"), type: observationType(rowText(row, "type")),
    title: rowText(row, "title"), content: rowText(row, "content"), tags: rowText(row, "tags"), created_at: rowText(row, "created_at"),
  };
}

export function scopePredicate(scope: string, mode: SearchScope, column = "scope_path"): { sql: string; values: SqlValue[] } {
  if (mode === "all") return { sql: "1 = 1", values: [] };
  if (mode === "exact") return { sql: `${column} = ?`, values: [scope] };
  if (mode !== "subtree") throw new MemoryError("MEMORY_INPUT", "Modo de scope invalido.");
  return { sql: `(${column} = ? OR (${column} >= ? AND ${column} < ?))`, values: [scope, `${scope}/`, `${scope}0`] };
}

export function search(store: MemoryStore, aliases: ProjectAliases, options: SearchOptions = {}): Observation[] {
  const query = options.query ?? "";
  if (typeof query !== "string" || query.length > 4096) throw new MemoryError("MEMORY_INPUT", "Consulta invalida (maximo 4096 caracteres).");
  const limit = boundedInteger(options.limit, 5, 100);
  const mode = options.mode ?? (options.scope ? "exact" : "all");
  const scope = mode === "all" ? "" : canonicalScope(options.scope ?? "", aliases);
  const filter = scopePredicate(scope, mode, "o.scope_path");
  if (options.type) { filter.sql += " AND o.type = ?"; filter.values.push(observationType(options.type)); }
  const match = options.match ?? "substring";
  if (match === "substring") {
    return store.all(`SELECT o.* FROM observations o WHERE ${filter.sql} ORDER BY position`, filter.values)
      .map(toObservation)
      .filter((item) => `${item.title}\n${item.content}\n${item.tags}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }
  if (match !== "fts") throw new MemoryError("MEMORY_INPUT", "Modo de consulta invalido.");
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (terms.length === 0) return [];
  if (terms.length > 32) throw new MemoryError("MEMORY_INPUT", "La consulta FTS admite como maximo 32 terminos literales.");
  const literalQuery = terms.map((term) => `"${term}"`).join(" AND ");
  return store.all(`SELECT o.* FROM observations o JOIN observations_fts ON observations_fts.rowid = o.id
    WHERE ${filter.sql} AND observations_fts MATCH ?
    ORDER BY bm25(observations_fts, 3, 1, 5), o.created_at DESC, o.position LIMIT ?`, [...filter.values, literalQuery, limit]).map(toObservation);
}
