import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { callTool, toolDefinitions } from "../src/mnemo/tools";
import { contextForProject } from "../src/mnemo/context";
import { dbPath, saveDb, type Observation } from "../src/mnemo/db";
import { MemoryEngine } from "../src/mnemo/engine";
import { cleanupTestEnv, fixtureDb, setupTestEnv, type TestEnvSnapshot } from "./mnemo-fixture";
import { seedEngine, syntheticMarker } from "./memory-engine-fixture";
import type { MemoryPromotePreview, MemoryPromoteResult, MemoryPinResult } from "../src/mnemo/v2-tools";

let env: TestEnvSnapshot;
let file: string;
let legacy: Buffer;

beforeEach(() => {
  env = setupTestEnv();
  saveDb(fixtureDb());
  legacy = fs.readFileSync(dbPath());
  file = path.join(process.env.MALAHOR_HOME!, "memory", "db.sqlite");
});
afterEach(() => cleanupTestEnv(env));

function activate(): void { seedEngine(file).close(); syntheticMarker(process.env.MALAHOR_HOME!); }
function ids(result: unknown): number[] { return (result as Observation[]).map((item) => item.id); }

describe("MCP memoria v2: contrato compatible y herramientas nuevas", () => {
  test("mantiene tools existentes y declara flags/nuevas herramientas", () => {
    const names = toolDefinitions.map((definition) => definition.name);
    for (const name of ["mem_save", "mem_search", "mem_get", "mem_context", "mem_brief", "mem_session_summary",
      "mem_tree", "mem_pin", "mem_unpin", "mem_promote_preview", "mem_promote"]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
    const search = toolDefinitions.find((definition) => definition.name === "mem_search")!;
    const context = toolDefinitions.find((definition) => definition.name === "mem_context")!;
    const brief = toolDefinitions.find((definition) => definition.name === "mem_brief")!;
    expect(search.inputSchema.properties).toHaveProperty("subtree");
    expect(context.inputSchema.properties).toHaveProperty("rollup");
    expect(context.inputSchema.properties).toHaveProperty("budget");
    expect(brief.inputSchema.properties).toHaveProperty("budget");
  });

  test("subtree conserva exact por defecto y funciona igual en JSON/SQLite", () => {
    const call = (subtree: boolean) => callTool({ name: "mem_search", arguments: { query: "", project: "acme/store", subtree, limit: 20 } });
    expect(ids(call(false))).toEqual([3]);
    expect(ids(call(true)).sort()).toEqual([3, 4, 5]);
    expect(() => callTool({ name: "mem_search", arguments: { subtree: true } })).toThrow("requiere project");
    activate();
    expect(ids(call(false))).toEqual([3]);
    expect(ids(call(true)).sort()).toEqual([3, 4, 5]);
  });

  test("rollup agrega descendientes sin confundir vecinos y prioriza su sesion mas nueva", () => {
    const db = fixtureDb();
    db.observations.push({ ...db.observations[4], id: 6, project: "acme/storefront", title: "Vecino" });
    db.sessions.push({ project: "acme/store/checkout/payments", summary: "Sesion hija", created_at: "2026-10-20T10:00:00.000Z" });
    db.nextId = 7;
    saveDb(db);
    const run = (rollup: boolean) => callTool({ name: "mem_context", arguments: { project: "acme/store", limit: 20, rollup } }) as ReturnType<typeof contextForProject>;
    expect(ids(run(false).observations)).toEqual([3, 2, 1]);
    const json = run(true);
    expect(ids(json.observations).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(json.rollupScopes).toEqual(["acme/store/checkout/coupons", "acme/store/checkout/payments"]);
    expect(json.latestSession?.summary).toBe("Sesion hija");
    fs.rmSync(path.join(process.env.MALAHOR_HOME!, "memory"), { recursive: true, force: true });
    seedEngine(file, db).close(); syntheticMarker(process.env.MALAHOR_HOME!);
    const sqlite = run(true);
    expect(ids(sqlite.observations).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(sqlite.rollupScopes).toEqual(json.rollupScopes);
    expect(sqlite.latestSession).toEqual(json.latestSession);
  });

  test("budget se expone en context/brief sin truncar recuerdos", () => {
    activate();
    const target = MemoryEngine.open(file);
    const item = target.get(3)!; target.close();
    const budget = JSON.stringify(item).length;
    const context = callTool({ name: "mem_context", arguments: { project: "acme/store", budget, limit: 8 } }) as ReturnType<typeof contextForProject>;
    expect(context.observations).toEqual([item]);
    expect(context.budgetUsed).toBe(budget);
    expect(context.omittedPinnedIds).toEqual([]);
    callTool({ name: "mem_pin", arguments: { id: 1 } });
    const exhausted = callTool({ name: "mem_context", arguments: { project: "acme/store", budget: 0 } }) as ReturnType<typeof contextForProject>;
    expect(exhausted.observations).toEqual([]);
    expect(exhausted.budgetUsed).toBe(0);
    expect(exhausted.omittedPinnedIds).toEqual([1]);
    const brief = callTool({ name: "mem_brief", arguments: { request: "arquitectura", project: "acme/store", budget: 0 } }) as { observations: unknown[]; relatedMemories: unknown[] };
    expect(brief.observations).toEqual([]); expect(brief.relatedMemories).toEqual([]);
  });

  test("tree funciona sobre JSON y SQLite con prefijo delimitado", () => {
    const run = (prefix?: string) => callTool({ name: "mem_tree", arguments: prefix ? { prefix } : {} }) as Array<{ path: string; observations: number; sessions: number }>;
    expect(run("acme/store").map((item) => item.path)).toEqual([
      "acme/store", "acme/store/checkout", "acme/store/checkout/coupons", "acme/store/checkout/payments",
    ]);
    expect(run("acme/store")[0]).toMatchObject({ observations: 1, sessions: 1 });
    activate();
    expect(run("acme/store").map((item) => item.path)).toEqual([
      "acme/store", "acme/store/checkout", "acme/store/checkout/coupons", "acme/store/checkout/payments",
    ]);
    expect(run("acme/store")[0]).toMatchObject({ observations: 1, sessions: 1 });
  });

  test("pins son idempotentes, v2-only y afectan context incluido rollup", () => {
    expect(() => callTool({ name: "mem_pin", arguments: { id: 5 } })).toThrow("requiere memoria v2");
    activate();
    expect(callTool({ name: "mem_pin", arguments: { id: 5 } }) as MemoryPinResult).toEqual({ id: 5, pinned: true });
    expect(callTool({ name: "mem_pin", arguments: { id: 5 } }) as MemoryPinResult).toEqual({ id: 5, pinned: true });
    const context = callTool({ name: "mem_context", arguments: { project: "acme/store", rollup: true, limit: 1 } }) as ReturnType<typeof contextForProject>;
    expect(ids(context.observations)).toEqual([5]);
    expect(callTool({ name: "mem_unpin", arguments: { id: 5 } }) as MemoryPinResult).toEqual({ id: 5, pinned: false });
    expect(callTool({ name: "mem_unpin", arguments: { id: 5 } }) as MemoryPinResult).toEqual({ id: 5, pinned: false });
    expect(() => callTool({ name: "mem_pin", arguments: { id: 999 } })).toThrow("inexistente");
  });

  test("promote exige preview/confirmacion, hook y backup antes de mover", () => {
    expect(() => callTool({ name: "mem_promote_preview", arguments: { id: 5, ancestor: "acme/store" } })).toThrow("requiere memoria v2");
    activate();
    const preview = callTool({ name: "mem_promote_preview", arguments: { id: 5, ancestor: "acme/store" } }) as MemoryPromotePreview;
    expect(preview).toMatchObject({ id: 5, fromProject: "acme/store/checkout/coupons", toProject: "acme/store", canPromote: true });
    expect(preview.requiresConfirmation).toBe("PROMOTE 5:acme/store/checkout/coupons->acme/store");
    expect(() => callTool({ name: "mem_promote", arguments: { id: 5, ancestor: "acme/store", confirm: "wrong" } })).toThrow("Confirmacion invalida");
    expect(fs.existsSync(path.join(process.env.MALAHOR_HOME!, "backups"))).toBe(false);
    const result = callTool({ name: "mem_promote", arguments: { id: 5, ancestor: "acme/store", confirm: preview.requiresConfirmation } }) as MemoryPromoteResult;
    expect(result.promoted).toBe(true); expect(result.backup.created).toBe(true);
    expect(result.backup.destination && fs.existsSync(result.backup.destination)).toBe(true);
    const engine = MemoryEngine.open(file);
    try { expect(engine.get(5)?.project).toBe("acme/store"); expect(engine.snapshot().observations).toHaveLength(5); }
    finally { engine.close(); }
    expect(fs.readFileSync(dbPath())).toEqual(legacy);
    expect(() => callTool({ name: "mem_promote_preview", arguments: { id: 5, ancestor: "acme/store" } })).not.toThrow();
    const invalid = callTool({ name: "mem_promote_preview", arguments: { id: 5, ancestor: "other" } }) as MemoryPromotePreview;
    expect(invalid.canPromote).toBe(false);
  });

  test("un cambio entre preview y apply bloquea la promocion y conserva datos", () => {
    activate();
    const preview = callTool({ name: "mem_promote_preview", arguments: { id: 5, ancestor: "acme/store" } }) as MemoryPromotePreview;
    const engine = MemoryEngine.open(file, { access: "write" }); engine.promote(5, "acme/store/checkout"); engine.close();
    expect(() => callTool({ name: "mem_promote", arguments: { id: 5, ancestor: "acme/store", confirm: preview.requiresConfirmation } })).toThrow("Confirmacion invalida");
    const reader = MemoryEngine.open(file);
    try { expect(reader.get(5)?.project).toBe("acme/store/checkout"); } finally { reader.close(); }
  });

  test("mem_move y mem_delete conservan nombres/confirmaciones y usan backup SQLite", () => {
    activate();
    const move = callTool({ name: "mem_move_preview", arguments: { id: 4, targetProject: "acme/store/checkout/coupons" } }) as { requiresConfirmation: string };
    expect(move.requiresConfirmation).toBe("4:acme/store/checkout/coupons");
    const moved = callTool({ name: "mem_move", arguments: { id: 4, targetProject: "acme/store/checkout/coupons", confirm: move.requiresConfirmation } }) as { moved: boolean; backup: { destination: string } };
    expect(moved.moved).toBe(true); expect(fs.existsSync(moved.backup.destination)).toBe(true);
    const deletion = callTool({ name: "mem_delete_project_preview", arguments: { project: "acme/store" } }) as { requiresConfirmation: string; childScopes: string[] };
    expect(deletion.childScopes).toContain("acme/store/checkout/coupons");
    const deleted = callTool({ name: "mem_delete_project", arguments: { project: "acme/store", confirm: deletion.requiresConfirmation } }) as { deletedObservations: number; deletedSessions: number; backup: { destination: string } };
    expect(deleted).toMatchObject({ deletedObservations: 1, deletedSessions: 1 });
    expect(fs.existsSync(deleted.backup.destination)).toBe(true);
    const engine = MemoryEngine.open(file, { access: "write" });
    try {
      expect(engine.get(3)).toBeNull();
      expect(engine.get(4)?.project).toBe("acme/store/checkout/coupons");
      expect(engine.tree("acme/store").map((scope) => scope.path)).toContain("acme/store/checkout/coupons");
      engine.integrity();
    } finally { engine.close(); }
    expect(fs.readFileSync(dbPath())).toEqual(legacy);
  });

  test("restore SQLite permanece bloqueado hasta T-5.3.5, sin fallback JSON", () => {
    activate();
    expect(() => callTool({ name: "mem_restore_preview", arguments: { backup: "any.sqlite" } })).toThrow("pendiente de adaptacion SQLite");
    expect(() => callTool({ name: "mem_restore", arguments: { backup: "any.sqlite", confirm: "RESTORE" } })).toThrow("pendiente de adaptacion SQLite");
    expect(fs.readFileSync(dbPath())).toEqual(legacy);
  });
});

describe("servidor JSON-RPC memoria v2", () => {
  test("lista/calla tools nuevas, sobrevive JSON invalido y limita mensajes", () => {
    activate();
    const requests = [
      "{",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mem_tree", arguments: { prefix: "acme/store" } } }),
      `${"x".repeat(1024 * 1024 + 1)}`,
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
    ].join("\n") + "\n";
    const result = spawnSync("bun", [path.resolve(import.meta.dir, "../src/mnemo/index.ts")], {
      input: requests, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, MALAHOR_HOME: process.env.MALAHOR_HOME, MALAHOR_CONFIG: process.env.MALAHOR_CONFIG,
        MALAHOR_OPENCODE_DIR: process.env.MALAHOR_OPENCODE_DIR },
    });
    expect(result.status, result.stderr).toBe(0);
    const messages = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.filter((message) => message.error?.code === -32700)).toHaveLength(2);
    expect(messages.find((message) => message.id === 1)?.result.protocolVersion).toBe("2024-11-05");
    expect(messages.find((message) => message.id === 2)?.result.tools.some((tool: { name: string }) => tool.name === "mem_promote")).toBe(true);
    expect(JSON.parse(messages.find((message) => message.id === 3)?.result.content[0].text)).toHaveLength(4);
    expect(messages.find((message) => message.id === 4)?.result).toEqual({});
  });
});
