import { randomUUID } from "node:crypto";
import type { ProjectAliases } from "../../cli/core/project";
import type { MnemoDb, Observation, SaveObservationInput, SessionSummary } from "../db";
import { briefFromDb, budgetedContext, type BudgetedContext, type ContextOptions, type MemoryBrief, type MemoryBriefOptions } from "../retrieval";
import { buildScopeChain, recallFromDb, type ScopedObservation } from "../scopes";
import { sanitizeMemoryContent } from "../sanitizer";
import { rowNumber, rowText } from "./driver";
import { MemoryError } from "./errors";
import { boundedInteger, canonicalScope, ensureScope, observationType, search, scopePredicate, toObservation, type SearchOptions } from "./observations";
import { MemoryStore, type StoreAccess } from "./store";

export { MemoryError } from "./errors";
export type { SearchOptions, SearchScope } from "./observations";
export type { BudgetedContext, ContextOptions, MemoryBrief, MemoryBriefOptions } from "../retrieval";

export interface ScopeEntry { path: string; parent: string | null; depth: number; observations: number; sessions: number; }
export interface EngineOptions { access?: StoreAccess; aliases?: ProjectAliases; }
export interface ScopeDeleteExpectation { observations: number; sessions: number; latest: string | null; }

export class MemoryEngine {
  private constructor(private readonly store: MemoryStore, private readonly aliases: ProjectAliases) {}

  static open(file: string, options: EngineOptions = {}): MemoryEngine {
    return new MemoryEngine(MemoryStore.open(file, options.access), options.aliases ?? {});
  }

  save(input: SaveObservationInput): Observation {
    const project = this.normalize(input.project);
    const type = observationType(input.type);
    const title = this.sanitize(input.title), content = this.sanitize(input.content), tags = this.sanitize(input.tags);
    return this.store.transaction(() => {
      const state = this.store.get("SELECT * FROM memory_state WHERE singleton = 1");
      const id = rowNumber(state, "next_observation_id"), position = rowNumber(state, "next_observation_position");
      this.advanceable(id); this.advanceable(position);
      ensureScope(this.store, project);
      const item = { id, project, type, title, content, tags, created_at: new Date().toISOString() };
      this.store.run("INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, project, type, title, content, tags, item.created_at, position]);
      this.store.run("UPDATE memory_state SET next_observation_id = ?, next_observation_position = ? WHERE singleton = 1", [id + 1, position + 1]);
      return item;
    });
  }

  get(id: number): Observation | null {
    boundedInteger(id, 1, Number.MAX_SAFE_INTEGER);
    const row = this.store.get("SELECT * FROM observations WHERE id = ?", [id]);
    return row ? toObservation(row) : null;
  }

  search(options: SearchOptions = {}): Observation[] { return search(this.store, this.aliases, options); }

  sessionSummary(scope: string, summary: string): SessionSummary {
    const project = this.normalize(scope), sanitized = this.sanitize(summary);
    return this.store.transaction(() => {
      const position = rowNumber(this.store.get("SELECT next_session_position FROM memory_state WHERE singleton = 1"), "next_session_position");
      this.advanceable(position);
      ensureScope(this.store, project);
      const item = { project, summary: sanitized, created_at: new Date().toISOString() };
      this.store.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)", [randomUUID(), project, sanitized, item.created_at, position]);
      this.store.run("UPDATE memory_state SET next_session_position = ? WHERE singleton = 1", [position + 1]);
      return item;
    });
  }

  context(scope: string, options: ContextOptions = {}): BudgetedContext {
    const normalized = this.normalize(scope);
    boundedInteger(options.limit, 8, 50);
    boundedInteger(options.budget, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0);
    return this.store.transaction(() => {
      const pins = this.store.all("SELECT observation_id FROM pins").map((row) => rowNumber(row, "observation_id"));
      const scopes = options.rollup ? this.tree(normalized).map((entry) => entry.path) : [];
      return budgetedContext(this.readScopes([...new Set([...buildScopeChain(normalized), ...scopes])]), normalized, options, pins);
    }, false);
  }

  brief(request: string, options: MemoryBriefOptions = {}): MemoryBrief {
    if (typeof request !== "string" || request.length > 4096) throw new MemoryError("MEMORY_INPUT", "Solicitud de memoria invalida.");
    boundedInteger(options.relatedLimit, 5, 20, 0);
    const anchor = options.scope || options.project;
    // El recall automatico no consulta otras raices/clientes. all es una busqueda explicita.
    const root = anchor ? this.normalize(anchor).split("/")[0] : "global";
    return this.store.transaction(() => {
      const db = this.readProject(root);
      const pins = this.store.all("SELECT observation_id FROM pins").map((row) => rowNumber(row, "observation_id"));
      boundedInteger(options.limit, 8, 50);
      boundedInteger(options.budget, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0);
      return briefFromDb(request, db, options, (scope) => this.normalize(scope),
        (scope) => budgetedContext(db, scope, options, pins));
    }, false);
  }

  recall(request: string, scope: string, limit = 5): ScopedObservation[] {
    if (!scope) return [];
    const normalized = this.normalize(scope);
    boundedInteger(limit, 5, 20);
    if (typeof request !== "string" || request.length > 4096) throw new MemoryError("MEMORY_INPUT", "Solicitud de memoria invalida.");
    return this.store.transaction(() => recallFromDb(this.readProject(normalized.split("/")[0]), request, normalized, limit), false);
  }

  tree(prefix?: string): ScopeEntry[] {
    const filter = scopePredicate(prefix ? this.normalize(prefix) : "", prefix ? "subtree" : "all", "s.path");
    return this.store.all(`SELECT s.*, (SELECT count(*) FROM observations WHERE scope_path = s.path) AS observations,
      (SELECT count(*) FROM sessions WHERE scope_path = s.path) AS sessions FROM scopes s WHERE ${filter.sql} ORDER BY s.path`, filter.values)
      .map((row) => ({ path: rowText(row, "path"), parent: row.parent_path === null ? null : rowText(row, "parent_path"),
        depth: rowNumber(row, "depth"), observations: rowNumber(row, "observations"), sessions: rowNumber(row, "sessions") }));
  }

  deleteScope(scope: string, expected: ScopeDeleteExpectation): { deletedObservations: number; deletedSessions: number } {
    const target = this.normalize(scope);
    return this.store.transaction(() => {
      const observations = rowNumber(this.store.get("SELECT count(*) AS total FROM observations WHERE scope_path = ?", [target]), "total");
      const sessions = rowNumber(this.store.get("SELECT count(*) AS total FROM sessions WHERE scope_path = ?", [target]), "total");
      const latestRow = this.store.get(`SELECT max(created_at) AS latest FROM (
        SELECT created_at FROM observations WHERE scope_path = ? UNION ALL
        SELECT created_at FROM sessions WHERE scope_path = ?
      )`, [target, target]);
      const latest = latestRow?.latest === null ? null : latestRow ? rowText(latestRow, "latest") : null;
      if (observations !== expected.observations || sessions !== expected.sessions || latest !== expected.latest) {
        throw new MemoryError("MEMORY_INPUT", "El scope cambio desde el preview; solicita uno nuevo.");
      }
      this.store.run("DELETE FROM observations WHERE scope_path = ?", [target]);
      this.store.run("DELETE FROM sessions WHERE scope_path = ?", [target]);
      if (target !== "global") {
        this.store.run(`DELETE FROM scopes WHERE path = ? AND NOT EXISTS (
          SELECT 1 FROM scopes child WHERE child.parent_path = ?
        )`, [target, target]);
      }
      return { deletedObservations: observations, deletedSessions: sessions };
    });
  }

  move(id: number, targetScope: string, expectedSource: string): Observation {
    const target = this.normalize(targetScope);
    return this.store.transaction(() => {
      const item = this.get(id);
      if (!item || item.project !== expectedSource) throw new MemoryError("MEMORY_INPUT", "La observacion cambio desde el preview; solicita uno nuevo.");
      ensureScope(this.store, target);
      this.store.run("UPDATE observations SET scope_path = ? WHERE id = ?", [target, id]);
      return { ...item, project: target };
    });
  }

  // Primitiva interna; los adaptadores publicos exigen preview, confirmacion,
  // hook memory.move.apply y backup antes de invocarla.
  promote(id: number, ancestor: string): Observation {
    const target = this.normalize(ancestor);
    return this.store.transaction(() => {
      const item = this.get(id);
      if (!item) throw new MemoryError("MEMORY_INPUT", "Observacion inexistente.");
      if (!item.project.startsWith(`${target}/`)) throw new MemoryError("MEMORY_INPUT", "Promote requiere un ancestro estricto del mismo proyecto.");
      ensureScope(this.store, target);
      this.store.run("UPDATE observations SET scope_path = ? WHERE id = ?", [target, id]);
      return { ...item, project: target };
    });
  }

  pin(id: number): void {
    this.store.transaction(() => {
      if (!this.get(id)) throw new MemoryError("MEMORY_INPUT", "Observacion inexistente.");
      this.store.run("INSERT INTO pins VALUES (?, ?) ON CONFLICT(observation_id) DO NOTHING", [id, new Date().toISOString()]);
    });
  }

  unpin(id: number): void {
    boundedInteger(id, 1, Number.MAX_SAFE_INTEGER);
    this.store.transaction(() => this.store.run("DELETE FROM pins WHERE observation_id = ?", [id]));
  }

  snapshot(): MnemoDb { return this.store.transaction(() => this.readScopes(), false); }
  backup(destination: string): string { return this.store.backup(destination); }
  integrity(): void { this.store.integrity(); }
  close(): void { this.store.close(); }

  private readProject(root: string): MnemoDb {
    const paths = this.tree(root).map((scope) => scope.path);
    return this.readScopes([...new Set(["global", ...paths])]);
  }

  private readScopes(scopes?: string[]): MnemoDb {
    const filter = scopes ? `WHERE scope_path IN (${scopes.map(() => "?").join(",")})` : "";
    const observations = this.store.all(`SELECT * FROM observations ${filter} ORDER BY position`, scopes).map(toObservation);
    const sessions = this.store.all(`SELECT * FROM sessions ${filter} ORDER BY position`, scopes)
      .map((row) => ({ project: rowText(row, "scope_path"), summary: rowText(row, "summary"), created_at: rowText(row, "created_at") }));
    return { observations, sessions, nextId: rowNumber(this.store.get("SELECT next_observation_id FROM memory_state WHERE singleton = 1"), "next_observation_id") };
  }

  private normalize(scope: string): string { return canonicalScope(scope, this.aliases); }
  private advanceable(value: number): void {
    if (value >= Number.MAX_SAFE_INTEGER) throw new MemoryError("MEMORY_FORMAT", "Contador de memoria agotado; no se reciclan IDs/posiciones.");
  }
  private sanitize(value: string): string {
    if (typeof value !== "string" || value.includes("\0")) throw new MemoryError("MEMORY_INPUT", "Texto de memoria invalido.");
    return sanitizeMemoryContent(value);
  }
}
