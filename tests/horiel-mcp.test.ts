import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { HorielError } from "../src/horiel/core";
import {
  HORIEL_P4_REPOSITORY_ROOT,
  HORIEL_TOOL_NAMES,
  SYNTHETIC_MEMORY_ID,
  SYNTHETIC_PREVIEW_ID,
  SYNTHETIC_SECRET,
  SYNTHETIC_SECOND_MEMORY_ID,
  SYNTHETIC_SNAPSHOT_ID,
  SYNTHETIC_STORE_ID,
  buildNodeBundle,
  cleanupHorielP4Suite,
  createExistingHorielSqliteStore,
  createGuardSpy,
  createHorielCoreSpy,
  createHorielP4Sandbox,
  dispatchHorielTool,
  horielRuntimeEnvironment,
  importP4Module,
  jsonRpcLines,
  jsonRpcResponse,
  mcpToolPayload,
  runNodeProcess,
  sanitizedChildEnvironment,
} from "./fixtures/horiel-integration";

const SUITE = "mcp";
const MEMORY_TYPES = ["architecture", "bug", "decision", "general", "learning", "pattern"];
const RELATION_TYPES = ["conflicts_with", "related", "supersedes"];

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
}

interface ToolDefinitionsModule extends Record<string, unknown> {
  horielToolDefinitions: ToolDefinition[];
}

interface DispatchModule extends Record<string, unknown> {
  createHorielToolDispatcher(input: { core: unknown; guard?: unknown }): unknown;
}

const saveArgs = {
  scope: "malahor/p4",
  type: "decision",
  title: "Synthetic P4 decision",
  content: "Synthetic integration content.",
  tags: ["horiel", "p4"],
  idempotencyKey: "horiel-p4-save-0001",
  provenance: { source: "horiel-p4-test" },
};

const checkpointArgs = {
  scope: "malahor/p4",
  sessionRef: "session-p4-0001",
  idempotencyKey: "horiel-p4-checkpoint-0001",
  objective: "Verify the integration boundary",
  implemented: ["synthetic adapter"],
  verified: ["focused tests"],
  pending: ["production implementation"],
  decisions: ["keep Horiel dormant"],
  blockers: [],
  validations: ["bun test"],
  nextStep: "Implement P4 without activation",
};

afterAll(() => {
  cleanupHorielP4Suite(SUITE);
});

function schemaFor(definitions: ToolDefinition[], name: string): JsonSchema {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing Horiel tool definition: ${name}`);
  return definition.inputSchema;
}

function assertClosedSchema(schema: JsonSchema, location: string): void {
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${location} must be closed`).toBe(false);
    expect(schema.properties, `${location} must declare properties`).toBeDefined();
    expect(Array.isArray(schema.required), `${location} must declare required explicitly`).toBe(true);
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      expect(properties[required], `${location}.${required} must exist`).toBeDefined();
    }
    expect(new Set(schema.required).size, `${location} required entries must be unique`).toBe(schema.required?.length ?? 0);
    for (const [name, child] of Object.entries(properties)) {
      expect(name, `${location} exposes a forbidden infrastructure property`).not.toMatch(/path|sql|provider/i);
      assertClosedSchema(child, `${location}.${name}`);
    }
  }
  if (schema.type === "array" && schema.items) assertClosedSchema(schema.items, `${location}[]`);
  if (schema.enum) expect(new Set(schema.enum.map(String)).size).toBe(schema.enum.length);
}

async function rejected(operation: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await operation;
  } catch (error) {
    if (error && typeof error === "object") return error as Record<string, unknown>;
    return { message: String(error) };
  }
  throw new Error("Expected Horiel operation to reject.");
}

function errorPublicText(error: Record<string, unknown>): string {
  return JSON.stringify({
    name: error.name,
    code: error.code,
    message: error.message,
  });
}

function without(environment: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result[name];
  return result;
}

describe("Horiel MCP P4", () => {
  test("publica exactamente las 23 memory_* con schemas cerrados, enums y limites P2", async () => {
    const module = await importP4Module<ToolDefinitionsModule>("src/horiel/mcp/tool-definitions.ts");
    const definitions = module.horielToolDefinitions;

    expect(Array.isArray(definitions)).toBe(true);
    expect(definitions).toHaveLength(23);
    const names = definitions.map(({ name }) => name);
    expect([...names].sort()).toEqual([...HORIEL_TOOL_NAMES]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^memory_[a-z_]+$/);
      expect(name).not.toMatch(/^(?:mem|mnemo)_/);
    }

    for (const definition of definitions) {
      expect(definition.description?.trim().length).toBeGreaterThan(0);
      expect(definition.inputSchema.type).toBe("object");
      assertClosedSchema(definition.inputSchema, definition.name);
    }

    const save = schemaFor(definitions, "memory_save");
    expect(save.required).toEqual(expect.arrayContaining([
      "scope", "type", "title", "content", "idempotencyKey",
    ]));
    expect([...(save.properties?.type.enum ?? [])].sort()).toEqual(MEMORY_TYPES);
    expect(save.properties?.title.maxLength).toBe(160);
    expect(save.properties?.content.maxLength).toBe(65_536);
    expect(save.properties?.idempotencyKey.minLength).toBe(8);
    expect(save.properties?.idempotencyKey.maxLength).toBe(128);
    expect(save.properties?.tags.maxItems).toBe(20);
    expect(save.properties?.tags.items?.maxLength).toBe(64);

    const search = schemaFor(definitions, "memory_search");
    expect(search.required).toEqual(expect.arrayContaining(["scope", "query"]));
    expect(search.properties?.query.maxLength).toBe(1_024);
    expect(search.properties?.limit.minimum).toBe(1);
    expect(search.properties?.limit.maximum).toBe(50);
    expect(search.properties?.types.maxItems).toBe(6);
    expect([...(search.properties?.types.items?.enum ?? [])].sort()).toEqual(MEMORY_TYPES);

    const context = schemaFor(definitions, "memory_context");
    expect(context.properties?.budgetBytes.maximum).toBe(262_144);
    expect(context.properties?.limit.maximum).toBe(50);

    const relation = schemaFor(definitions, "memory_link");
    expect([...(relation.properties?.type.enum ?? [])].sort()).toEqual(RELATION_TYPES);

    const checkpoint = schemaFor(definitions, "memory_session_summary");
    for (const property of ["implemented", "verified", "pending", "decisions", "blockers", "validations"]) {
      expect(checkpoint.properties?.[property]?.maxItems).toBe(50);
      expect(checkpoint.properties?.[property]?.items?.maxLength).toBe(2_048);
    }
  });

  test("mapea las 23 tools a la fachada Core, valida argumentos y conserva metadata", async () => {
    const module = await importP4Module<DispatchModule>("src/horiel/mcp/dispatch.ts");
    const { core, calls } = createHorielCoreSpy();
    const dispatcher = module.createHorielToolDispatcher({ core });
    const cases: Array<{
      tool: string;
      method: string;
      args: Record<string, unknown>;
      expected: unknown;
    }> = [
      { tool: "memory_save", method: "saveMemory", args: saveArgs, expected: saveArgs },
      {
        tool: "memory_update",
        method: "updateMemory",
        args: { id: SYNTHETIC_MEMORY_ID, expectedVersion: 1, title: "Updated" },
        expected: { id: SYNTHETIC_MEMORY_ID, expectedVersion: 1, title: "Updated" },
      },
      { tool: "memory_get", method: "getMemory", args: { id: SYNTHETIC_MEMORY_ID, version: 1 }, expected: { id: SYNTHETIC_MEMORY_ID, version: 1 } },
      {
        tool: "memory_search",
        method: "searchMemory",
        args: { scope: "malahor/p4", query: "synthetic", includeAncestors: true, limit: 5 },
        expected: { scope: "malahor/p4", query: "synthetic", includeAncestors: true, limit: 5 },
      },
      { tool: "memory_context", method: "getContext", args: { scope: "malahor/p4", budgetBytes: 8_000 }, expected: { scope: "malahor/p4", budgetBytes: 8_000 } },
      { tool: "memory_brief", method: "getBrief", args: { scope: "malahor/p4", query: "synthetic", relatedLimit: 3 }, expected: { scope: "malahor/p4", query: "synthetic", relatedLimit: 3 } },
      { tool: "memory_session_summary", method: "saveSessionCheckpoint", args: checkpointArgs, expected: checkpointArgs },
      { tool: "memory_tree", method: "listTree", args: { prefix: "malahor" }, expected: { prefix: "malahor" } },
      { tool: "memory_inspect_project", method: "inspectScope", args: { project: "malahor/p4" }, expected: { scope: "malahor/p4" } },
      { tool: "memory_pin", method: "pinMemory", args: { id: SYNTHETIC_MEMORY_ID }, expected: { id: SYNTHETIC_MEMORY_ID } },
      { tool: "memory_unpin", method: "unpinMemory", args: { id: SYNTHETIC_MEMORY_ID }, expected: { id: SYNTHETIC_MEMORY_ID } },
      {
        tool: "memory_link",
        method: "linkMemory",
        args: { sourceId: SYNTHETIC_MEMORY_ID, targetId: SYNTHETIC_SECOND_MEMORY_ID, type: "related" },
        expected: { sourceId: SYNTHETIC_MEMORY_ID, targetId: SYNTHETIC_SECOND_MEMORY_ID, type: "related" },
      },
      {
        tool: "memory_unlink",
        method: "unlinkMemory",
        args: { sourceId: SYNTHETIC_MEMORY_ID, targetId: SYNTHETIC_SECOND_MEMORY_ID, type: "related" },
        expected: { sourceId: SYNTHETIC_MEMORY_ID, targetId: SYNTHETIC_SECOND_MEMORY_ID, type: "related" },
      },
      { tool: "memory_move_preview", method: "previewMove", args: { id: SYNTHETIC_MEMORY_ID, destinationScope: "malahor/other" }, expected: { id: SYNTHETIC_MEMORY_ID, destinationScope: "malahor/other" } },
      { tool: "memory_move", method: "moveMemory", args: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "MOVE synthetic" }, expected: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "MOVE synthetic" } },
      { tool: "memory_promote_preview", method: "previewPromote", args: { id: SYNTHETIC_MEMORY_ID, ancestor: "malahor" }, expected: { id: SYNTHETIC_MEMORY_ID, ancestor: "malahor" } },
      { tool: "memory_promote", method: "promoteMemory", args: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "PROMOTE synthetic" }, expected: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "PROMOTE synthetic" } },
      { tool: "memory_backup", method: "createBackup", args: {}, expected: undefined },
      { tool: "memory_delete_project_preview", method: "previewDeleteScope", args: { project: "malahor/p4" }, expected: { scope: "malahor/p4" } },
      { tool: "memory_delete_project", method: "deleteScope", args: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "DELETE synthetic" }, expected: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "DELETE synthetic" } },
      { tool: "memory_restore_preview", method: "previewRestore", args: { snapshotId: SYNTHETIC_SNAPSHOT_ID }, expected: { snapshotId: SYNTHETIC_SNAPSHOT_ID } },
      { tool: "memory_restore", method: "restore", args: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "RESTORE synthetic" }, expected: { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "RESTORE synthetic" } },
    ];

    for (const scenario of cases) {
      const before = calls.length;
      const result = await dispatchHorielTool(dispatcher, scenario.tool, scenario.args);
      expect(calls).toHaveLength(before + 1);
      expect(calls.at(-1)).toEqual({ method: scenario.method, input: scenario.expected });
      if (scenario.tool === "memory_tree") {
        expect(result).toEqual({
          nodes: [
            { scope: "alpha", memoryCount: 1, checkpointCount: 0 },
            { scope: "alpha/task", memoryCount: 2, checkpointCount: 1 },
            { scope: "beta/feature", memoryCount: 3, checkpointCount: 0 },
            { scope: "@global", memoryCount: 1, checkpointCount: 0 },
          ],
          storeId: SYNTHETIC_STORE_ID,
          sequence: 37,
        });
        continue;
      }
      expect(result).toMatchObject({
        id: SYNTHETIC_MEMORY_ID,
        version: 7,
        storeId: SYNTHETIC_STORE_ID,
        sequence: 37,
      });
    }

    const listResult = await dispatchHorielTool(dispatcher, "memory_list_projects", {}) as Record<string, unknown>;
    expect(calls.at(-1)?.method).toBe("listTree");
    expect(calls.at(-1)?.input === undefined || JSON.stringify(calls.at(-1)?.input) === "{}").toBe(true);
    expect(listResult.storeId).toBe(SYNTHETIC_STORE_ID);
    expect(listResult.sequence).toBe(37);
    const projects = (listResult.projects as Array<string | { project?: string; scope?: string }>)
      .map((entry) => typeof entry === "string" ? entry : entry.project ?? entry.scope);
    expect(projects).toEqual(["alpha", "beta"]);

    const callsBeforeInvalid = calls.length;
    expect((await rejected(dispatchHorielTool(dispatcher, "memory_get", {
      id: SYNTHETIC_MEMORY_ID,
      unexpected: true,
    }))).code).toBe("invalid_input");
    expect((await rejected(dispatchHorielTool(dispatcher, "memory_get", {}))).code).toBe("invalid_input");
    expect((await rejected(dispatchHorielTool(dispatcher, "memory_unknown", {}))).code).toBe("invalid_input");
    expect(calls).toHaveLength(callsBeforeInvalid);
  });

  test("aplica el evento de guard correcto y DENY/ASK detienen Core sin confundir confirm con approval", async () => {
    const module = await importP4Module<DispatchModule>("src/horiel/mcp/dispatch.ts");
    const { core, calls } = createHorielCoreSpy();
    const allowed = createGuardSpy();
    const dispatcher = module.createHorielToolDispatcher({ core, guard: allowed.guard });
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["memory_save", "memory.write.before", saveArgs],
      ["memory_update", "memory.write.before", { id: SYNTHETIC_MEMORY_ID, expectedVersion: 1, title: "updated" }],
      ["memory_session_summary", "memory.write.before", checkpointArgs],
      ["memory_pin", "memory.write.before", { id: SYNTHETIC_MEMORY_ID }],
      ["memory_unpin", "memory.write.before", { id: SYNTHETIC_MEMORY_ID }],
      ["memory_link", "memory.write.before", { sourceId: SYNTHETIC_MEMORY_ID, targetId: SYNTHETIC_SECOND_MEMORY_ID, type: "related" }],
      ["memory_unlink", "memory.write.before", { sourceId: SYNTHETIC_MEMORY_ID, targetId: SYNTHETIC_SECOND_MEMORY_ID, type: "related" }],
      ["memory_backup", "memory.write.before", {}],
      ["memory_delete_project_preview", "memory.delete.preview", { project: "malahor/p4" }],
      ["memory_delete_project", "memory.delete.apply", { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "DELETE synthetic" }],
      ["memory_move_preview", "memory.move.preview", { id: SYNTHETIC_MEMORY_ID, destinationScope: "malahor/other" }],
      ["memory_promote_preview", "memory.move.preview", { id: SYNTHETIC_MEMORY_ID, ancestor: "malahor" }],
      ["memory_move", "memory.move.apply", { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "MOVE synthetic" }],
      ["memory_promote", "memory.move.apply", { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "PROMOTE synthetic" }],
      ["memory_restore_preview", "memory.restore.preview", { snapshotId: SYNTHETIC_SNAPSHOT_ID }],
      ["memory_restore", "memory.restore.apply", { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "RESTORE synthetic" }],
    ];
    for (const [tool, event, args] of cases) {
      await dispatchHorielTool(dispatcher, tool, args);
      expect(allowed.calls.at(-1)?.event).toBe(event);
    }

    const deniedCore = createHorielCoreSpy();
    const denied = createGuardSpy(() => "deny");
    const deniedDispatcher = module.createHorielToolDispatcher({ core: deniedCore.core, guard: denied.guard });
    await rejected(dispatchHorielTool(deniedDispatcher, "memory_save", saveArgs));
    expect(deniedCore.calls).toHaveLength(0);

    const askCore = createHorielCoreSpy();
    const ask = createGuardSpy((call) => call.approval === "human-one-shot" ? "allow" : "ask");
    const askDispatcher = module.createHorielToolDispatcher({ core: askCore.core, guard: ask.guard });
    const applyArgs = { previewId: SYNTHETIC_PREVIEW_ID, confirmation: "DELETE SCOPE malahor/p4" };
    await rejected(dispatchHorielTool(askDispatcher, "memory_delete_project", applyArgs));
    expect(ask.calls.at(-1)?.approval).toBeUndefined();
    expect(JSON.stringify(ask.calls.at(-1)?.raw)).toContain(applyArgs.confirmation);
    expect(askCore.calls).toHaveLength(0);

    await dispatchHorielTool(askDispatcher, "memory_delete_project", applyArgs, { approval: "human-one-shot" });
    expect(ask.calls.at(-1)?.approval).toBe("human-one-shot");
    expect(askCore.calls.at(-1)?.method).toBe("deleteScope");
    expect(calls).toHaveLength(cases.length);
  });

  test("conserva codigos Horiel y reduce errores desconocidos sin filtrar internals", async () => {
    const module = await importP4Module<DispatchModule>("src/horiel/mcp/dispatch.ts");
    const unsafe = `SELECT secret FROM /home/synthetic/private.sqlite; sensitiveValue='${SYNTHETIC_SECRET}'`;
    const knownCore = createHorielCoreSpy({
      getMemory: new HorielError("conflict", unsafe),
    });
    const knownDispatcher = module.createHorielToolDispatcher({ core: knownCore.core });
    const known = await rejected(dispatchHorielTool(knownDispatcher, "memory_get", { id: SYNTHETIC_MEMORY_ID }));
    expect(known.code).toBe("conflict");
    expect(errorPublicText(known)).not.toContain("SELECT");
    expect(errorPublicText(known)).not.toContain("/home/synthetic");
    expect(errorPublicText(known)).not.toContain(SYNTHETIC_SECRET);

    const unknown = new Error(unsafe);
    unknown.stack = `Error: ${unsafe}\n    at /home/synthetic/adapter.ts:10:2`;
    const unknownCore = createHorielCoreSpy({ getMemory: unknown });
    const unknownDispatcher = module.createHorielToolDispatcher({ core: unknownCore.core });
    const normalized = await rejected(dispatchHorielTool(unknownDispatcher, "memory_get", { id: SYNTHETIC_MEMORY_ID }));
    expect(normalized.code).toBe("unavailable");
    expect(errorPublicText(normalized)).not.toContain("SELECT");
    expect(errorPublicText(normalized)).not.toContain("/home/synthetic");
    expect(errorPublicText(normalized)).not.toContain("adapter.ts");
    expect(errorPublicText(normalized)).not.toContain(SYNTHETIC_SECRET);
  });

  test("runtime Node falla cerrado antes de SQLite y nunca crea una base ausente", async () => {
    const sandbox = createHorielP4Sandbox(SUITE, "runtime-gates");
    const entrypoint = path.join(HORIEL_P4_REPOSITORY_ROOT, "src", "horiel", "mcp", "index.ts");
    const bundle = await buildNodeBundle(entrypoint, path.join(sandbox.bundleDirectory, "runtime"), "horiel-mcp");
    const valid = horielRuntimeEnvironment(sandbox);
    const invalidCases: NodeJS.ProcessEnv[] = [
      without(valid, "MALAHOR_HORIEL_ENABLED"),
      { ...valid, MALAHOR_HORIEL_ENABLED: "true" },
      without(valid, "MALAHOR_HORIEL_BOUND"),
      { ...valid, MALAHOR_HORIEL_BOUND: "yes" },
      without(valid, "MALAHOR_HORIEL_PROJECT"),
      { ...valid, MALAHOR_HORIEL_PROJECT: "malahor/other" },
      without(valid, "MALAHOR_HORIEL_DATABASE"),
      { ...valid, MALAHOR_HORIEL_DATABASE: "relative.sqlite" },
      without(valid, "MALAHOR_HORIEL_SNAPSHOT_DIRECTORY"),
      { ...valid, MALAHOR_HORIEL_SNAPSHOT_DIRECTORY: "relative-snapshots" },
    ];

    for (const env of invalidCases) {
      const result = await runNodeProcess({ bundle, cwd: sandbox.root, env });
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(fs.existsSync(sandbox.databasePath)).toBe(false);
      expect(fs.existsSync(path.join(sandbox.root, "relative.sqlite"))).toBe(false);
    }

    const absent = await runNodeProcess({ bundle, cwd: sandbox.root, env: valid });
    expect(absent.code).not.toBe(0);
    expect(absent.signal).toBeNull();
    expect(fs.existsSync(sandbox.databasePath)).toBe(false);
    expect(absent.stderr).not.toContain(sandbox.databasePath);
    expect(absent.stderr).not.toContain(SYNTHETIC_SECRET);
  });

  test("transporte por linea soporta MCP, async calls, 1 MiB y cierre limpio sobre store sintetico", async () => {
    const sandbox = createHorielP4Sandbox(SUITE, "transport-e2e");
    await createExistingHorielSqliteStore(sandbox);
    const entrypoint = path.join(HORIEL_P4_REPOSITORY_ROOT, "src", "horiel", "mcp", "index.ts");
    const bundle = await buildNodeBundle(entrypoint, path.join(sandbox.bundleDirectory, "runtime"), "horiel-mcp");
    const env = horielRuntimeEnvironment(sandbox);
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "ping",
      params: { padding: "x".repeat(1_048_576) },
    });
    const firstRequests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "horiel-p4-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
      { jsonrpc: "2.0", id: 4, method: "resources/list", params: {} },
      { jsonrpc: "2.0", id: 5, method: "resources/templates/list", params: {} },
      { jsonrpc: "2.0", id: 6, method: "prompts/list", params: {} },
      { jsonrpc: "2.0", id: 7, method: 42, params: { payload: SYNTHETIC_SECRET } },
    ].map((request) => JSON.stringify(request));
    firstRequests.push(oversized);
    firstRequests.push(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "memory_save", arguments: saveArgs },
    }));
    const first = await runNodeProcess({
      bundle,
      cwd: sandbox.projectRoot,
      env,
      stdin: `${firstRequests.join("\n")}\n`,
    });
    expect(first.code).toBe(0);
    expect(first.signal).toBeNull();
    const responses = jsonRpcLines(first.stdout);
    expect(responses.every((response) => response.jsonrpc === "2.0")).toBe(true);
    expect(jsonRpcResponse(responses, 1).result).toBeDefined();
    const listed = jsonRpcResponse(responses, 2).result as { tools?: ToolDefinition[] };
    expect(listed.tools?.map(({ name }) => name).sort()).toEqual([...HORIEL_TOOL_NAMES]);
    expect(jsonRpcResponse(responses, 3).result).toBeDefined();
    expect(jsonRpcResponse(responses, 4).result).toMatchObject({ resources: [] });
    expect(jsonRpcResponse(responses, 5).result).toMatchObject({ resourceTemplates: [] });
    expect(jsonRpcResponse(responses, 6).result).toMatchObject({ prompts: [] });
    expect(jsonRpcResponse(responses, 7).error).toBeDefined();
    expect(responses.filter((response) => response.error !== undefined).length).toBeGreaterThanOrEqual(2);
    expect(first.stdout).not.toContain(SYNTHETIC_SECRET);
    const saved = mcpToolPayload(jsonRpcResponse(responses, 10)) as Record<string, unknown>;
    const memory = (saved.memory ?? saved) as Record<string, unknown>;
    expect(memory.id).toMatch(/^mem_[a-f0-9]{32}$/);
    expect(memory.version).toBe(1);

    const secondRequests = [
      { jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "horiel-p4-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "memory_get", arguments: { id: memory.id } } },
      { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "memory_search", arguments: { scope: "malahor/p4", query: "synthetic", limit: 5 } } },
      { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "memory_context", arguments: { scope: "malahor/p4", budgetBytes: 16_000 } } },
      { jsonrpc: "2.0", id: 15, method: "ping", params: {} },
    ];
    const second = await runNodeProcess({
      bundle,
      cwd: sandbox.projectRoot,
      env,
      stdin: `${secondRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    });
    expect(second.code).toBe(0);
    expect(second.signal).toBeNull();
    const reopened = jsonRpcLines(second.stdout);
    const fetched = mcpToolPayload(jsonRpcResponse(reopened, 12)) as Record<string, unknown>;
    expect(fetched.id).toBe(memory.id);
    expect(fetched.version).toBe(1);
    const searched = mcpToolPayload(jsonRpcResponse(reopened, 13)) as Record<string, unknown>;
    expect(searched.sequence).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(searched)).toContain(String(memory.id));
    const context = mcpToolPayload(jsonRpcResponse(reopened, 14)) as Record<string, unknown>;
    expect(context.storeId).toMatch(/^store_[a-f0-9]{32}$/);
    expect(context.sequence).toBeGreaterThanOrEqual(1);
    expect(jsonRpcResponse(reopened, 15).result).toBeDefined();
    expect(second.stdout.split("\n").filter(Boolean).every((line) => {
      try { return JSON.parse(line).jsonrpc === "2.0"; } catch { return false; }
    })).toBe(true);
    expect(second.stderr).not.toContain(SYNTHETIC_SECRET);
  });
});
