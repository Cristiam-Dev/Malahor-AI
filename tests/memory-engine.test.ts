import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MemoryEngine, MemoryError } from "../src/mnemo/engine";
import { MemoryStore } from "../src/mnemo/engine/store";
import { openNativeDatabase } from "../src/mnemo/engine/driver";
import { createPrivateFile } from "../src/mnemo/engine/paths";
import { briefFromDb, contextFromDb } from "../src/mnemo/retrieval";
import { fixtureDb } from "./mnemo-fixture";
import { memorySandbox, seedEngine } from "./memory-engine-fixture";
import { supportsMemoryRuntime } from "../src/cli/core/detector";

let root: string;
let file: string;
const connections: Array<{ close(): void }> = [];

beforeEach(() => { ({ root, file } = memorySandbox()); });
afterEach(() => { for (const connection of connections.splice(0).reverse()) connection.close(); });
function track<T extends { close(): void }>(connection: T): T { connections.push(connection); return connection; }
function empty(): MemoryEngine { return track(MemoryEngine.open(file, { access: "create" })); }
function seed(): MemoryEngine { return track(seedEngine(file)); }
const input = (project = "acme/hu-1", title = "Decision SQLite") => ({ project, title, type: "decision" as const, content: "Escritura transaccional", tags: "persistencia" });

describe("memory v2: formato y persistencia segura", () => {
  test("el piso de Node coincide con node:sqlite validado", () => {
    expect(supportsMemoryRuntime("22.17.9")).toBe(false);
    expect(supportsMemoryRuntime("22.18.0")).toBe(true);
    expect(supportsMemoryRuntime("23.0.0")).toBe(true);
    expect(supportsMemoryRuntime("21.99.0")).toBe(false);
  });
  test("abrir no crea una base ausente, create es explicito y no sobrescribe", () => {
    expect(() => MemoryEngine.open(file)).toThrow();
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    const engine = empty();
    expect(engine.snapshot()).toEqual({ observations: [], sessions: [], nextId: 1 });
    expect(() => MemoryEngine.open(file, { access: "create" })).toThrow();
    engine.integrity();
  });

  test("lee el formato producido por el spike aprobado", () => {
    createPrivateFile(file);
    const native = openNativeDatabase(file, false);
    try { native.exec(fs.readFileSync(path.resolve(import.meta.dir, "../scripts/spikes/memory-sqlite/schema.sql"), "utf8")); }
    finally { native.close(); }
    expect(track(MemoryEngine.open(file)).snapshot().nextId).toBe(1);
  });

  test("rechaza archivos vacios, ajenos y futuros sin reinicializarlos", () => {
    createPrivateFile(file);
    expect(() => MemoryEngine.open(file)).toThrow();
    expect(fs.statSync(file).size).toBe(0);
    const native = openNativeDatabase(file, false);
    native.exec("CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('retener')");
    native.close();
    const bytes = fs.readFileSync(file);
    expect(() => MemoryEngine.open(file, { access: "write" })).toThrow("Formato/version");
    expect(fs.readFileSync(file)).toEqual(bytes);
    const other = path.join(root, "future.sqlite");
    track(MemoryEngine.open(other, { access: "create" })).close();
    const changed = track(MemoryStore.open(other, "write"));
    changed.run("PRAGMA user_version = 99"); changed.close();
    expect(() => MemoryEngine.open(other)).toThrow("Formato/version");
  });

  test("rechaza esquema incompleto y contadores corruptos", () => {
    empty().close();
    const store = track(MemoryStore.open(file, "write"));
    store.run("DROP TRIGGER observations_fts_insert"); store.close();
    expect(() => MemoryEngine.open(file)).toThrow("Esquema de memoria incompleto");
    const other = path.join(root, "counters.sqlite");
    track(seedEngine(other)).close();
    const counters = track(MemoryStore.open(other, "write"));
    counters.run("UPDATE memory_state SET next_observation_id = 2"); counters.close();
    expect(() => MemoryEngine.open(other)).toThrow("Contadores");
  });

  test("canonicaliza aliases solo en la raiz y sanitiza todo texto nuevo", () => {
    const engine = track(MemoryEngine.open(file, { access: "create", aliases: { acme: ["ACME Inc"] } }));
    const item = engine.save({ ...input("ACME Inc/Checkout/Frontend"), title: "token=synthetic", content: "mail dev@example.invalid", tags: "password:synthetic" });
    expect(item.project).toBe("acme/checkout/frontend");
    expect(item.title).toBe("[REDACTED]"); expect(item.tags).toBe("[REDACTED]");
    expect(item.content).not.toContain("@");
    expect(engine.tree("acme").map((entry) => entry.path)).toEqual(["acme", "acme/checkout", "acme/checkout/frontend"]);
  });

  test("mantiene nextId y posiciones explicitos, sin reciclar huecos", () => {
    const engine = empty(); engine.save(input());
    const store = track(MemoryStore.open(file, "write"));
    store.run("DELETE FROM observations WHERE id = 1");
    store.run("UPDATE memory_state SET next_observation_id = 100, next_observation_position = 20");
    expect(engine.save(input()).id).toBe(100);
    expect(engine.snapshot().nextId).toBe(101);
    expect(store.get("SELECT position FROM observations WHERE id = 100")?.position).toBe(20);
  });

  test("un fallo revierte registro, scopes, indice y counters juntos", () => {
    const engine = empty();
    const store = track(MemoryStore.open(file, "write"));
    store.run("CREATE TRIGGER injected_failure AFTER INSERT ON observations WHEN NEW.title = 'rollback' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    expect(() => engine.save(input("acme/failing", "rollback"))).toThrow(MemoryError);
    expect(engine.snapshot()).toEqual({ observations: [], sessions: [], nextId: 1 });
    expect(engine.tree("acme")).toEqual([]);
    expect(engine.search({ query: "rollback", match: "fts" })).toEqual([]);
    expect(engine.save(input()).id).toBe(1);
    engine.integrity();
  });

  test("sesiones repetidas mantienen identidad y orden independientes", () => {
    const engine = empty();
    engine.sessionSummary("acme", "Repetida"); engine.sessionSummary("acme", "Repetida");
    const store = track(MemoryStore.open(file));
    const rows = store.all("SELECT id, position FROM sessions ORDER BY position");
    expect(rows).toHaveLength(2); expect(rows[0].id).not.toBe(rows[1].id);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    expect(engine.snapshot().nextId).toBe(1);
  });

  test("rechaza entradas/counters inseguros sin modificar la base", () => {
    const engine = empty();
    expect(() => engine.save(input(""))).toThrow();
    expect(() => engine.save({ ...input(), content: "nul\0byte" })).toThrow();
    const store = track(MemoryStore.open(file, "write"));
    store.run("UPDATE memory_state SET next_observation_id = ?", [Number.MAX_SAFE_INTEGER]);
    expect(() => engine.save(input())).toThrow("agotado");
    expect(engine.tree("acme")).toEqual([]);
    expect(engine.snapshot().observations).toEqual([]);
  });

  test("solo lectura y conexion cerrada rechazan escrituras", () => {
    empty().close();
    const reader = track(MemoryEngine.open(file));
    expect(() => reader.save(input())).toThrow("solo lectura");
    reader.close(); reader.close();
    expect(() => reader.get(1)).toThrow("cerrada");
  });
});

describe("memory v2: consultas y recuperacion", () => {
  test("exact/subtree/all no confunden prefijos ni otros proyectos", () => {
    const engine = empty();
    for (const scope of ["acme/hu-1", "acme/hu-1/front", "acme/hu-10", "other/hu-1"]) engine.save(input(scope));
    expect(engine.search({ scope: "acme/hu-1", mode: "exact" }).map((item) => item.id)).toEqual([1]);
    expect(engine.search({ scope: "acme/hu-1", mode: "subtree", match: "fts", query: "SQLite" }).map((item) => item.id).sort()).toEqual([1, 2]);
    expect(engine.search({ mode: "all", limit: 10 })).toHaveLength(4);
    expect(engine.tree("acme/hu-1").map((scope) => scope.path)).toEqual(["acme/hu-1", "acme/hu-1/front"]);
  });

  test("substring conserva unicode/acentos y FTS es un modo explicito", () => {
    const engine = empty(); engine.save(input("acme", "DECISIÓN SQLite"));
    expect(engine.search({ query: "decisión" })).toHaveLength(1);
    expect(engine.search({ query: "decision" })).toHaveLength(0);
    expect(engine.search({ query: "decision", match: "fts" })).toHaveLength(1);
    expect(engine.search({ query: "persistencia", match: "fts" })).toHaveLength(1);
    expect(engine.search({ query: "transaccional", match: "fts" })).toHaveLength(1);
  });

  test("FTS recibe terminos literales, no sintaxis ni SQL del usuario", () => {
    const engine = empty(); engine.save(input());
    for (const query of ['"', "*", "sqlite OR missing", "sqlite'; DROP TABLE observations;--"]) {
      expect(engine.search({ query, match: "fts" })).toEqual([]);
    }
    expect(() => engine.search({ match: "fts", query: Array.from({ length: 33 }, (_, n) => `word${n}`).join(" ") })).toThrow();
    expect(() => engine.search({ limit: -1 })).toThrow();
    expect(() => engine.search({ query: "x".repeat(4097) })).toThrow();
    expect(() => engine.search({ mode: "exact" })).toThrow();
    expect(engine.snapshot().observations).toHaveLength(1);
  });

  test("sin pins preserva la distribucion jerarquica y sesion mas cercana", () => {
    const engine = seed();
    for (const limit of [1, 3, 8, 50]) {
      const { latestSession, observations, scopeChain } = engine.context("acme/store/checkout/coupons", { limit });
      expect({ latestSession, observations, scopeChain }).toEqual(contextFromDb(fixtureDb(), "acme/store/checkout/coupons", limit));
    }
    expect(engine.context("acme/missing").scopeChain).toEqual(["global", "acme", "acme/missing"]);
    expect(engine.context("global/child").scopeChain).toEqual(["global", "global/child"]);
  });

  test("pins priorizan seleccion, respetan budget y nunca truncan registros", () => {
    const engine = seed(); engine.pin(1); engine.pin(1); engine.pin(3);
    const context = engine.context("acme/store/checkout/coupons", { limit: 1 });
    expect(context.observations.map((item) => item.id)).toEqual([3]);
    expect(context.omittedPinnedIds).toEqual([1]);
    const size = JSON.stringify(engine.get(3)).length;
    const budget = engine.context("acme/store/checkout/coupons", { budget: size, limit: 8 });
    expect(budget.observations).toEqual([engine.get(3)]);
    expect(budget.budgetUsed).toBe(size);
    expect(budget.latestSession).toBeNull();
    expect(engine.context("acme", { budget: 0 }).observations).toEqual([]);
    expect(() => engine.context("acme", { budget: -1 })).toThrow();
    engine.unpin(3); engine.unpin(3);
    expect(engine.context("acme/store").observations[0].id).toBe(1);
    expect(() => engine.pin(999)).toThrow();
  });

  test("brief conserva recall hermano y no filtra recuerdos de otro cliente", () => {
    const engine = seed(); engine.save(input("other/payments", "Validacion de pagos"));
    const options = { project: "acme/store", scope: "acme/store/checkout/coupons", limit: 8, relatedLimit: 5 };
    const request = "Nueva feature cupones, reutilizar validacion pagos";
    const result = engine.brief(request, options);
    const legacy = briefFromDb(request, fixtureDb(), options, (scope) => scope);
    expect(result.observations).toEqual(legacy.observations);
    expect(result.relatedMemories.map((item) => item.id)).toEqual(legacy.relatedMemories.map((item) => item.id));
    expect(result.relatedMemories.some((item) => item.project.endsWith("payments"))).toBe(true);
    expect(result.scopeSuggestions.some((item) => item.scope.startsWith("other"))).toBe(false);
    expect(engine.brief("payments").relatedMemories.some((item) => item.project.startsWith("other"))).toBe(false);
    expect(engine.brief(request, { ...options, relatedLimit: 0 }).relatedMemories).toEqual([]);
    const limited = engine.brief(request, { ...options, budget: 0 });
    expect(limited.observations).toEqual([]); expect(limited.relatedMemories).toEqual([]);
    expect(engine.brief("payments", { budget: 0, relatedLimit: 0 }).relatedMemories).toEqual([]);
    expect(engine.recall("pagos", "acme/store/checkout/coupons").some((item) => item.project.endsWith("payments"))).toBe(true);
    expect(engine.recall("pagos", "acme/store").some((item) => item.project.startsWith("other"))).toBe(false);
    expect(engine.recall("pagos", "")).toEqual([]);
  });

  test("budget no descarta un pin que cabe por estar despues del primer lote de 50", () => {
    const engine = empty();
    for (let position = 0; position < 51; position += 1) {
      const item = engine.save({ ...input("acme"), content: "x".repeat(4096) });
      engine.pin(item.id);
    }
    const small = engine.save({ ...input("acme", "small"), content: "", tags: "" }); engine.pin(small.id);
    const context = engine.context("acme", { budget: JSON.stringify(small).length });
    expect(context.observations).toEqual([small]);
    expect(context.omittedPinnedIds).toHaveLength(51);
  });

  test("promote mueve a ancestro sin copiar ni cambiar campos/fecha/pins/relations", () => {
    const engine = seed(); engine.pin(5);
    const store = track(MemoryStore.open(file, "write"));
    store.run("INSERT INTO relations VALUES (5, 4, 'conflicts', 'synthetic')");
    const before = engine.get(5);
    const promoted = engine.promote(5, "acme/store");
    expect(promoted).toEqual({ ...before, project: "acme/store" });
    expect(engine.snapshot().observations).toHaveLength(5);
    expect(engine.snapshot().nextId).toBe(6);
    expect(engine.context("acme/store").observations[0].id).toBe(5);
    expect(store.all("SELECT * FROM relations")).toHaveLength(1);
    expect(engine.search({ query: "cupones", match: "fts" }).map((item) => item.id)).toEqual([5]);
    for (const target of ["acme/store", "acme/store/other", "other", "global"]) expect(() => engine.promote(5, target)).toThrow("ancestro estricto");
    engine.integrity();
  });
});

describe("memory v2: concurrencia, backups y privacidad", () => {
  test("WAL permite lectores y el segundo escritor falla acotado, sin parcialidad", () => {
    const engine = seed();
    const writer = track(MemoryStore.open(file, "write"));
    const reader = track(MemoryEngine.open(file));
    writer.transaction(() => {
      expect(reader.snapshot().observations).toHaveLength(5);
      try { engine.save(input("acme/locked")); throw new Error("debio fallar"); }
      catch (error) { expect((error as MemoryError).code).toBe("MEMORY_BUSY"); }
    });
    expect(engine.tree("acme/locked")).toEqual([]);
    expect(engine.save(input()).id).toBe(6);
  });

  test("backup consistente con WAL vivo compara tablas completas y no sobrescribe", () => {
    const engine = seed(); engine.pin(5);
    const peer = track(MemoryStore.open(file, "write"));
    peer.run("INSERT INTO relations VALUES (5, 4, 'supersedes', 'synthetic')");
    engine.sessionSummary("acme", "Nueva sesion");
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    const backup = path.join(root, "backups", "copy.sqlite");
    const readonly = track(MemoryEngine.open(file));
    expect(readonly.backup(backup)).toBe(backup);
    const copy = track(MemoryStore.open(backup, "write"));
    copy.integrity();
    for (const table of ["scopes", "observations", "sessions", "memory_state", "pins", "relations"]) {
      expect(copy.all(`SELECT * FROM ${table} ORDER BY 1`)).toEqual(peer.all(`SELECT * FROM ${table} ORDER BY 1`));
    }
    const before = fs.readFileSync(backup);
    expect(() => engine.backup(backup)).toThrow();
    expect(fs.readFileSync(backup)).toEqual(before);
    for (const target of [file, `${file}-wal`, `${file}-shm`, backup]) expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(backup)).mode & 0o777).toBe(0o700);
  });

  test("rechaza permisos amplios y enlaces sin reparar archivos desconocidos", () => {
    empty().close();
    fs.chmodSync(file, 0o644);
    expect(() => MemoryEngine.open(file)).toThrow();
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    fs.chmodSync(file, 0o600);
    const link = path.join(root, "link.sqlite");
    fs.symlinkSync(file, link);
    expect(() => MemoryEngine.open(link)).toThrow();
    const directoryLink = path.join(root, "linked-dir");
    fs.symlinkSync(path.dirname(file), directoryLink);
    expect(() => MemoryEngine.open(path.join(directoryLink, "db.sqlite"))).toThrow();
  });

  test("integrity detecta inconsistencia del contenido FTS", () => {
    const engine = seed();
    const raw = track(MemoryStore.open(file, "write"));
    raw.run("INSERT INTO observations_fts(observations_fts) VALUES ('delete-all')");
    expect(() => engine.integrity()).toThrow();
  });

  test("un backup que no supera integridad retira el provisional", () => {
    const engine = seed();
    const raw = track(MemoryStore.open(file, "write"));
    raw.run("INSERT INTO observations_fts(observations_fts) VALUES ('delete-all')");
    const destination = path.join(root, "backups", "invalid.sqlite");
    expect(() => engine.backup(destination)).toThrow();
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(`${destination}-wal`)).toBe(false);
    expect(fs.existsSync(`${destination}-shm`)).toBe(false);
  });

  test("transacciones anidadas/async no se aceptan como commits parciales", () => {
    empty().close();
    const store = track(MemoryStore.open(file, "write"));
    expect(() => store.transaction(() => store.transaction(() => undefined))).toThrow("anidadas");
    expect(() => store.transaction(() => Promise.resolve())).toThrow("sincronicas");
    expect(store.get("SELECT next_observation_id FROM memory_state")?.next_observation_id).toBe(1);
  });
});
