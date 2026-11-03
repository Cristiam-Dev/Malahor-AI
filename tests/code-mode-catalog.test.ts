import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import {
  registerReadOnlyCodeModeTools,
  type CodeModeRegistrationOptions,
  type CodeModeToolCall,
  type CodeModeToolDomain,
} from "../src/plugin/code-mode";
import { CODE_MODE_LIMITS, type CodeModeLogicalTool } from "../src/plugin/code-mode-worker";

type ToolDefinition = Record<string, unknown> & {
  id: string;
  name: string;
  description: string;
  input: unknown;
  output: unknown;
  options: Record<string, unknown>;
  execute: (input: unknown, call: Record<string, unknown>) => unknown;
};

type GatewayDefinition = Record<string, unknown> & {
  execute: (input: unknown, call: CodeModeToolCall) => Promise<unknown>;
};

type TransformCallback = Parameters<CodeModeToolDomain["transform"]>[0];
type SandboxRunner = NonNullable<CodeModeRegistrationOptions["runSandbox"]>;

interface CatalogHarnessOptions {
  recreateProjections?: boolean;
}

interface CatalogHarness {
  domain: CodeModeToolDomain;
  definitions: Map<string, ToolDefinition>;
  added: Map<string, GatewayDefinition>;
  namespaces: Array<Record<string, unknown>>;
  registrationOptions: CodeModeRegistrationOptions;
  replayTransform(): void;
  adapter: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    permissionRegistered: true;
    toolRegistered: true;
    resolveSessionProject: () => Promise<{ canonicalKey: string; root: string }>;
  };
}

const CALL: CodeModeToolCall = {
  sessionID: "ses_catalog",
  agent: "malahor",
  messageID: "msg_catalog",
  id: "call_catalog",
};

let root: string;
let repo: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-code-mode-catalog-"));
  repo = path.join(root, "repo");
  home = path.join(root, "home");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "fixture.ts"), "export const fixture = true;\n", "utf8");
  fs.writeFileSync(path.join(repo, "package.json"), "{\"name\":\"catalog-fixture\"}\n", "utf8");
  fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
    demo: { context: "memory", roots: [repo], defaultRoot: repo },
  })}\n`, "utf8");
  env = {
    ...process.env,
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: path.join(home, "config.jsonc"),
    MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("AUTH-01 A4: negociación portable del catálogo R0", () => {
  test("acepta objetos y wrappers execute nuevos en cada proyección Promise equivalente", async () => {
    const harness = createCatalogHarness("json", { recreateProjections: true });
    let readCalls = 0;
    harness.definitions.get("read")!.execute = () => {
      readCalls += 1;
      return "read desde la proyección activa";
    };
    harness.registrationOptions.runSandbox = singleReadSandbox;

    const first = await harness.domain.list() as ToolDefinition[];
    const second = await harness.domain.list() as ToolDefinition[];
    for (const tool of ["read", "glob", "grep"] as const) {
      const firstDefinition = first.find((item) => item.id === tool)!;
      const secondDefinition = second.find((item) => item.id === tool)!;
      expect(secondDefinition).not.toBe(firstDefinition);
      expect(secondDefinition.execute).not.toBe(firstDefinition.execute);
      expect({ ...secondDefinition, execute: undefined }).toEqual({ ...firstDefinition, execute: undefined });
    }

    const registration = await register(harness);
    try {
      const discovered = await search(harness, "read");
      const result = await execute(harness, {
        catalogRef: String(discovered.catalogRef),
        code: "return await tools.repo.read({ path: 'src/fixture.ts' });",
      });

      expect(result).toMatchObject({ ok: true, value: "read desde la proyección activa" });
      expect(readCalls).toBe(1);
    } finally {
      await registration.dispose?.();
    }
  });

  test("el transform captura callbacks de una sola proyección list y no de preflight ni get", async () => {
    const harness = createCatalogHarness("json");
    const callbackCalls = { preflight: 0, snapshot: 0, corroboration: 0 };
    let editorListCalls = 0;
    let editorGetCalls = 0;
    const project = (source: keyof typeof callbackCalls, definition: ToolDefinition): ToolDefinition => ({
      ...definition,
      options: { ...definition.options },
      execute: () => {
        callbackCalls[source] += 1;
        return source;
      },
    });
    harness.domain = {
      list: async () => [...harness.definitions.values()].map((definition) => project("preflight", definition)),
      transform: async (callback) => {
        callback({
          list: () => {
            editorListCalls += 1;
            return [...harness.definitions.values()].map((definition) => project("snapshot", definition));
          },
          get: (name) => {
            editorGetCalls += 1;
            const definition = harness.definitions.get(name);
            return definition ? project("corroboration", definition) : undefined;
          },
          namespace: (value) => { harness.namespaces.push(value); },
          add: (value) => { harness.added.set(String(value.name), value as GatewayDefinition); },
        });
        return { dispose: () => undefined };
      },
    };
    harness.registrationOptions.runSandbox = singleReadSandbox;

    const registration = await register(harness);
    try {
      const discovered = await search(harness, "read");
      const result = await execute(harness, {
        catalogRef: String(discovered.catalogRef),
        code: "return await tools.repo.read({ path: 'src/fixture.ts' });",
      });

      expect(editorListCalls).toBe(1);
      expect(editorGetCalls).toBeLessThanOrEqual(3);
      expect(result).toMatchObject({ ok: true, value: "snapshot" });
      expect(callbackCalls).toEqual({ preflight: 0, snapshot: 1, corroboration: 0 });
    } finally {
      await registration.dispose?.();
    }
  });

  test("acepta JSON Schema semánticamente compatible y solo descubre read/glob/grep", async () => {
    const harness = createCatalogHarness("json");
    harness.definitions.set("read_file", {
      ...jsonDefinition("read"),
      id: "read_file",
      name: "read_file",
      description: "Alias deliberado que no debe ampliar autoridad.",
    });

    const registration = await register(harness);
    try {
      expect(registration.catalogHash).toMatch(/^[a-f0-9]{64}$/);
      expect(harness.namespaces).toContainEqual({
        name: "malahor",
        description: "Gateways first-party de Malahor",
      });
      expect([...harness.added.keys()].sort()).toEqual(["code_execute", "code_search"]);

      const discovered = await search(harness, "read glob grep");
      expect(discovered.classification).toBe("read-only");
      expect(discovered.catalogRef).toMatch(/^cat_[A-Za-z0-9_-]{16,128}$/);
      expect((discovered.items as Array<{ path: string }>).map((item) => item.path).sort()).toEqual([
        "tools.repo.glob",
        "tools.repo.grep",
        "tools.repo.read",
      ]);
      expect(JSON.stringify(discovered)).not.toContain("read_file");
      expect(JSON.stringify(discovered)).not.toContain("execute");

      const empty = await search(harness, "zzzzzzzzzzzz");
      expect(empty.items).toEqual([]);
      expect(empty).not.toHaveProperty("catalogRef");
    } finally {
      await registration.dispose?.();
    }
  });

  test("acepta Effect Schema equivalente y tolera anotaciones cosméticas sin drift", async () => {
    const harness = createCatalogHarness("effect");
    const registration = await register(harness);
    try {
      const discovered = await search(harness, "read glob grep");
      for (const tool of ["read", "glob", "grep"] as const) {
        const definition = harness.definitions.get(tool)!;
        definition.description = `Descripción cosmética posterior para ${tool}.`;
        definition.input = effectInput(tool, `Entrada equivalente con otra descripción para ${tool}.`);
        definition.output = effectOutput(tool).annotate({ description: `Salida equivalente con otra descripción para ${tool}.` });
        definition.options = { ...definition.options, pinned: false };
      }

      const result = await execute(harness, {
        catalogRef: String(discovered.catalogRef),
        code: "return { portable: true };",
      });

      expect(result).toMatchObject({
        ok: true,
        value: { portable: true },
        calls: [],
        redacted: false,
        truncated: false,
      });
    } finally {
      await registration.dispose?.();
    }
  });

  test("completa el registro con transform diferido y valida el editor antes de añadir gateways", async () => {
    const compatible = createCatalogHarness("effect");
    let compatibleCallback: TransformCallback | undefined;
    let compatibleDisposed = false;
    compatible.domain = {
      list: compatible.domain.list,
      transform: async (callback) => {
        compatibleCallback = callback;
        return { dispose: () => { compatibleDisposed = true; } };
      },
    };

    const compatibleRegistration = await register(compatible);
    try {
      expect(compatibleRegistration.catalogHash).toMatch(/^[a-f0-9]{64}$/);
      expect(compatibleCallback).toBeDefined();
      expect(compatible.added.size).toBe(0);
      expect(compatible.namespaces).toEqual([]);

      compatibleCallback!({
        list: () => [...compatible.definitions.values()],
        get: (name) => compatible.definitions.get(name),
        namespace: (value) => { compatible.namespaces.push(value); },
        add: (value) => { compatible.added.set(String(value.name), value as GatewayDefinition); },
      });

      expect(compatible.namespaces).toContainEqual({
        name: "malahor",
        description: "Gateways first-party de Malahor",
      });
      expect([...compatible.added.keys()].sort()).toEqual(["code_execute", "code_search"]);
    } finally {
      await compatibleRegistration.dispose?.();
    }
    expect(compatibleDisposed).toBe(true);

    const incompatible = createCatalogHarness("effect");
    let incompatibleCallback: TransformCallback | undefined;
    incompatible.domain = {
      list: incompatible.domain.list,
      transform: async (callback) => {
        incompatibleCallback = callback;
        return { dispose: () => undefined };
      },
    };
    const incompatibleRegistration = await register(incompatible);
    try {
      const driftedRead = {
        ...incompatible.definitions.get("read")!,
        options: { ...incompatible.definitions.get("read")!.options, codemode: true },
      };
      let namespaceCalls = 0;
      const unsafeAdds: unknown[] = [];

      expect(() => incompatibleCallback!({
        list: () => [...incompatible.definitions.values()],
        get: (name) => name === "read" ? driftedRead : incompatible.definitions.get(name),
        namespace: () => { namespaceCalls += 1; },
        add: (value) => { unsafeAdds.push(value); },
      })).not.toThrow();

      expect(namespaceCalls).toBe(0);
      expect(unsafeAdds).toEqual([]);
      expect(incompatible.added.size).toBe(0);
    } finally {
      await incompatibleRegistration.dispose?.();
    }
  });

  test("un replay idéntico invalida refs anteriores y publica refs de la generación nueva", async () => {
    const harness = createCatalogHarness("json");
    const registration = await register(harness);
    try {
      const previous = await search(harness, "read");

      harness.replayTransform();

      const stale = await execute(harness, {
        catalogRef: String(previous.catalogRef),
        code: "return { stale: true };",
      });
      expect(stale.ok).toBe(false);
      expect(stale.error?.kind).toBe("CATALOG_DRIFT");

      const current = await search(harness, "read");
      const fresh = await execute(harness, {
        catalogRef: String(current.catalogRef),
        code: "return { current: true };",
      });
      expect(fresh.ok).toBe(true);
    } finally {
      await registration.dispose?.();
    }
  });

  test("un callback sustituido por replay no cruza generaciones", async () => {
    const harness = createCatalogHarness("json");
    let previousCalls = 0;
    let currentCalls = 0;
    harness.definitions.get("read")!.execute = () => {
      previousCalls += 1;
      return "callback anterior";
    };
    harness.registrationOptions.runSandbox = singleReadSandbox;
    const registration = await register(harness);
    try {
      const previous = await search(harness, "read");
      harness.definitions.get("read")!.execute = () => {
        currentCalls += 1;
        return "callback de la generación nueva";
      };

      harness.replayTransform();

      const stale = await execute(harness, {
        catalogRef: String(previous.catalogRef),
        code: "return await tools.repo.read({ path: 'src/fixture.ts' });",
      });
      expect(stale.error?.kind).toBe("CATALOG_DRIFT");
      expect(previousCalls).toBe(0);
      expect(currentCalls).toBe(0);

      const current = await search(harness, "read");
      const fresh = await execute(harness, {
        catalogRef: String(current.catalogRef),
        code: "return await tools.repo.read({ path: 'src/fixture.ts' });",
      });
      expect(fresh).toMatchObject({ ok: true, value: "callback de la generación nueva" });
      expect(previousCalls).toBe(0);
      expect(currentCalls).toBe(1);
    } finally {
      await registration.dispose?.();
    }
  });

  test("un replay durante una ejecución activa aborta el sandbox con CATALOG_DRIFT", async () => {
    const harness = createCatalogHarness("json");
    let startedResolve: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let release: () => void = () => undefined;
    let aborted = false;
    harness.registrationOptions.runSandbox = async (options) => {
      if (options.code === "return { health: true };") {
        return sandboxResult({ ok: true, value: { health: true }, toolCalls: [] });
      }
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result: Record<string, unknown>) => {
          if (settled) return;
          settled = true;
          resolve(sandboxResult(result));
        };
        release = () => settle({ ok: true, value: { stale: true }, toolCalls: [] });
        const abort = () => {
          aborted = true;
          settle({ ok: false, error: { kind: "CATALOG_DRIFT", message: "synthetic replay" }, toolCalls: [] });
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        startedResolve();
      });
    };
    const registration = await register(harness);
    try {
      const discovered = await search(harness, "read");
      const pending = execute(harness, {
        catalogRef: String(discovered.catalogRef),
        code: "return { waitsForReplay: true };",
      });
      await started;

      harness.replayTransform();
      await Promise.resolve();
      if (!aborted) release();
      const result = await pending;

      expect(aborted).toBe(true);
      expect(result.error?.kind).toBe("CATALOG_DRIFT");
    } finally {
      release();
      await registration.dispose?.();
    }
  });

  test("detecta drift de cada contrato Effect Schema real de output", async () => {
    for (const tool of ["read", "glob", "grep"] as const) {
      const harness = createCatalogHarness("effect");
      const registration = await register(harness);
      try {
        const discovered = await search(harness, tool);
        harness.definitions.get(tool)!.output = effectOutput(tool, true);

        const result = await execute(harness, {
          catalogRef: String(discovered.catalogRef),
          code: "return { shouldNotRun: true };",
        });

        expect(result.ok, `drift no detectado: ${tool}`).toBe(false);
        expect(result.error?.kind, `drift no detectado: ${tool}`).toBe("CATALOG_DRIFT");
      } finally {
        await registration.dispose?.();
      }
    }
  });

  test("detecta drift semántico de opciones, input y output dentro del request", async () => {
    const mutations: Array<[string, (definition: ToolDefinition) => void]> = [
      ["options", (definition) => {
        definition.options = { ...definition.options, codemode: true };
      }],
      ["input", (definition) => {
        const input = structuredClone(definition.input) as {
          properties: Record<string, Record<string, unknown>>;
        };
        input.properties.path = { ...input.properties.path, minLength: 1 };
        definition.input = input;
      }],
      ["output", (definition) => {
        definition.output = wrappedTextOutput("output");
      }],
    ];

    for (const [kind, mutate] of mutations) {
      const harness = createCatalogHarness("json");
      const registration = await register(harness);
      try {
        const discovered = await search(harness, "read");
        mutate(harness.definitions.get("read")!);
        const result = await execute(harness, {
          catalogRef: String(discovered.catalogRef),
          code: "return { shouldNotRun: true };",
        });
        expect(result.error?.kind, `drift no detectado: ${kind}`).toBe("CATALOG_DRIFT");
        expect(result.ok).toBe(false);
      } finally {
        await registration.dispose?.();
      }
    }
  });

  test("desactiva A4 ante APIs, schemas u outputs incompatibles sin fallback", async () => {
    const missingList = createCatalogHarness("json");
    await expect(registerReadOnlyCodeModeTools(
      { transform: missingList.domain.transform } as CodeModeToolDomain,
      { assert: async () => undefined },
      {},
      missingList.adapter,
      missingList.registrationOptions,
    )).rejects.toThrow(/tool\.list/i);

    const missingEditorGet = createCatalogHarness("json");
    const incompleteEditorDomain = {
      list: missingEditorGet.domain.list,
      transform: async (callback: (editor: Record<string, unknown>) => void) => {
        callback({ list: () => [...missingEditorGet.definitions.values()], namespace: () => undefined, add: () => undefined });
      },
    } as unknown as CodeModeToolDomain;
    await expect(registerReadOnlyCodeModeTools(
      incompleteEditorDomain,
      { assert: async () => undefined },
      {},
      missingEditorGet.adapter,
      missingEditorGet.registrationOptions,
    )).rejects.toThrow(/list\/get\/add\/namespace/i);

    const incompatibleInput = createCatalogHarness("json");
    const readInput = structuredClone(incompatibleInput.definitions.get("read")!.input) as {
      properties: Record<string, unknown>;
    };
    readInput.properties.write = { type: "boolean" };
    incompatibleInput.definitions.get("read")!.input = readInput;
    await expect(register(incompatibleInput)).rejects.toThrow(/Tool R0 incompatible: read/);

    const ambiguousOutput = createCatalogHarness("json");
    ambiguousOutput.definitions.get("read")!.output = {
      type: "object",
      properties: { output: { type: "string" }, content: { type: "string" } },
      required: ["output", "content"],
      additionalProperties: false,
    };
    await expect(register(ambiguousOutput)).rejects.toThrow(/Tool R0 incompatible: read/);

    const missingR0 = createCatalogHarness("json");
    missingR0.definitions.delete("grep");
    await expect(register(missingR0)).rejects.toThrow(/Tool R0 ausente: grep/);
    expect(incompatibleInput.added.size).toBe(0);
    expect(ambiguousOutput.added.size).toBe(0);
    expect(missingR0.added.size).toBe(0);
  });

  test("un replay R0 incompatible retira A4 sin propagar el fallo al host ni añadir gateways parciales", async () => {
    const harness = createCatalogHarness("json");
    const registration = await register(harness);
    try {
      harness.definitions.get("read")!.options = {
        ...harness.definitions.get("read")!.options,
        codemode: true,
      };

      expect(() => harness.replayTransform()).not.toThrow();
      expect(harness.namespaces).toEqual([]);
      expect(harness.added.size).toBe(0);
    } finally {
      await registration.dispose?.();
    }
  });

  test("un rechazo de transform posterior al callback retira la generación publicada", async () => {
    const harness = createCatalogHarness("json");
    const availability: boolean[] = [];
    harness.registrationOptions.onAvailability = (available) => { availability.push(available); };
    harness.domain = {
      list: harness.domain.list,
      transform: async (callback) => {
        callback({
          list: () => [...harness.definitions.values()],
          get: (name) => harness.definitions.get(name),
          namespace: (value) => { harness.namespaces.push(value); },
          add: (value) => { harness.added.set(String(value.name), value as GatewayDefinition); },
        });
        throw new Error("synthetic transform registration failure");
      },
    };

    await expect(register(harness)).rejects.toThrow("synthetic transform registration failure");
    expect(availability).toEqual([true, false]);
    const staleSearch = harness.added.get("code_search");
    expect(staleSearch).toBeDefined();
    await expect(staleSearch!.execute({ query: "read" }, CALL)).rejects.toThrow("SANDBOX_FAILURE");
  });
});

function createCatalogHarness(
  dialect: "json" | "effect",
  options: CatalogHarnessOptions = {},
): CatalogHarness {
  const definitions = new Map<string, ToolDefinition>();
  for (const tool of ["read", "glob", "grep"] as const) {
    definitions.set(tool, dialect === "effect" ? effectDefinition(tool) : jsonDefinition(tool));
  }
  const added = new Map<string, GatewayDefinition>();
  const namespaces: Array<Record<string, unknown>> = [];
  let ref = 0;
  const runSandbox: NonNullable<CodeModeRegistrationOptions["runSandbox"]> = async (options) => ({
    result: options.code.includes("health: true")
      ? { ok: true, value: { health: true }, toolCalls: [] }
      : { ok: true, value: { portable: true }, toolCalls: [] },
    redacted: false,
    redactions: [],
    truncated: false,
  });
  let transformCallback: TransformCallback | undefined;
  const project = (definition: ToolDefinition): ToolDefinition => options.recreateProjections
    ? projectDefinition(definition)
    : definition;
  const listDefinitions = (): ToolDefinition[] => [...definitions.values()].map(project);
  const getDefinition = (name: string): ToolDefinition | undefined => {
    const definition = definitions.get(name);
    return definition ? project(definition) : undefined;
  };
  const replayTransform = (): void => {
    if (!transformCallback) throw new Error("tool.transform todavía no registró su callback");
    added.clear();
    namespaces.length = 0;
    transformCallback({
      list: listDefinitions,
      get: getDefinition,
      namespace: (value) => { namespaces.push(value); },
      add: (value) => {
        const name = String(value.name ?? "");
        added.set(name, value as GatewayDefinition);
      },
    });
  };
  const domain: CodeModeToolDomain = {
    list: async () => listDefinitions(),
    transform: async (callback) => {
      transformCallback = callback;
      replayTransform();
      return { dispose: () => undefined };
    },
  };
  return {
    domain,
    definitions,
    added,
    namespaces,
    replayTransform,
    registrationOptions: {
      moduleURL: import.meta.url,
      workerSource: () => "// malahor-code-mode-worker synthetic probe",
      runSandbox,
      randomRef: (prefix) => `${prefix}_${String(++ref).padStart(20, "0")}`,
    },
    adapter: {
      cwd: repo,
      env,
      permissionRegistered: true,
      toolRegistered: true,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
    },
  };
}

function projectDefinition(definition: ToolDefinition): ToolDefinition {
  const execute = definition.execute;
  return {
    ...definition,
    options: { ...definition.options },
    execute: (input, call) => execute(input, call),
  };
}

const singleReadSandbox: SandboxRunner = async (options) => {
  if (options.code === "return { health: true };") {
    return sandboxResult({ ok: true, value: { health: true }, toolCalls: [] });
  }
  const response = await options.onCall({
    version: 1,
    type: "call",
    executionRef: options.executionRef,
    callID: "call_0",
    index: 0,
    tool: "read",
    input: { path: "src/fixture.ts" },
  }, options.signal ?? new AbortController().signal);
  return sandboxResult(response.ok
    ? { ok: true, value: response.value ?? null, toolCalls: [] }
    : { ok: false, error: { kind: response.error?.code ?? "SANDBOX_FAILURE", message: "synthetic broker failure" }, toolCalls: [] });
};

function sandboxResult(result: Record<string, unknown>) {
  return { result, redacted: false, redactions: [], truncated: false };
}

async function register(harness: CatalogHarness) {
  return registerReadOnlyCodeModeTools(
    harness.domain,
    { assert: async () => undefined },
    {},
    harness.adapter,
    harness.registrationOptions,
  );
}

async function search(harness: CatalogHarness, query: string): Promise<Record<string, unknown>> {
  const gateway = harness.added.get("code_search");
  expect(gateway).toBeDefined();
  const response = await gateway!.execute({ query }, CALL) as { content: string };
  return JSON.parse(response.content) as Record<string, unknown>;
}

async function execute(harness: CatalogHarness, input: Record<string, unknown>): Promise<Record<string, any>> {
  const gateway = harness.added.get("code_execute");
  expect(gateway).toBeDefined();
  const response = await gateway!.execute(input, { ...CALL, id: `${CALL.id}_execute` }) as { content: string };
  return JSON.parse(response.content) as Record<string, any>;
}

function jsonDefinition(tool: CodeModeLogicalTool): ToolDefinition {
  const execute = () => `${tool} fixture`;
  return {
    id: tool,
    name: tool,
    description: `Host ${tool} sintético`,
    input: jsonInput(tool),
    output: { type: "string" },
    options: { permission: tool, codemode: false, pinned: true },
    execute,
  };
}

function effectDefinition(tool: CodeModeLogicalTool): ToolDefinition {
  const execute = () => `${tool} fixture`;
  return {
    id: tool,
    name: tool,
    description: `Host ${tool} expresado con Effect Schema`,
    input: effectInput(tool, `Entrada Effect para ${tool}.`),
    output: effectOutput(tool),
    options: { permission: tool, codemode: false, pinned: true },
    execute,
  };
}

function jsonInput(tool: CodeModeLogicalTool): Record<string, unknown> {
  if (tool === "read") return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    title: "Read input",
    properties: {
      path: { type: "string", description: "Ruta relativa" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.readLines },
    },
    required: ["path"],
    additionalProperties: false,
  };
  if (tool === "glob") return {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      hidden: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.globResults },
    },
    required: ["pattern"],
    additionalProperties: false,
  };
  return {
    dialect: "draft-2020-12",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string" },
        literal: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.grepResults },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    definitions: {},
  };
}

function effectInput(tool: CodeModeLogicalTool, description: string) {
  const schema = tool === "read"
    ? Schema.Struct({
      path: Schema.String,
      offset: Schema.optionalKey(Schema.Int),
      limit: Schema.optionalKey(Schema.Int),
    })
    : tool === "glob"
      ? Schema.Struct({
        pattern: Schema.String,
        path: Schema.optionalKey(Schema.String),
        hidden: Schema.optionalKey(Schema.Boolean),
        limit: Schema.optionalKey(Schema.Int),
      })
      : Schema.Struct({
        pattern: Schema.String,
        path: Schema.optionalKey(Schema.String),
        include: Schema.optionalKey(Schema.String),
        literal: Schema.optionalKey(Schema.Boolean),
        caseSensitive: Schema.optionalKey(Schema.Boolean),
        limit: Schema.optionalKey(Schema.Int),
      });
  return schema.annotate({ description });
}

function effectOutput(tool: CodeModeLogicalTool, drift = false) {
  const entryType = drift
    ? Schema.Literals(["file", "dir"])
    : Schema.Literals(["file", "directory"]);
  const entry = Schema.Struct({ path: Schema.String, type: entryType });

  if (tool === "read") {
    const alternate = drift
      ? Schema.Struct({ type: Schema.Literal("binary"), size: Schema.Int })
      : Schema.Struct({ type: Schema.Literal("entries"), entries: Schema.Array(entry) });
    return Schema.Union([
      Schema.Struct({
        type: Schema.Literal("text"),
        content: Schema.String,
        mime: Schema.String,
        next: Schema.optionalKey(Schema.NullOr(Schema.Int)),
        offset: Schema.Int,
        truncated: Schema.Boolean,
      }),
      Schema.Struct({ type: Schema.Literal("file"), path: Schema.String, mime: Schema.String }),
      alternate,
    ]).annotate({ description: "Output read Effect compatible con OpenCode V2." });
  }
  if (tool === "glob") {
    return Schema.Array(entry).annotate({ description: "Output glob Effect compatible con OpenCode V2." });
  }
  return Schema.Array(Schema.Struct({
    entry,
    line: Schema.Int,
    offset: Schema.optionalKey(Schema.Int),
    submatches: Schema.optionalKey(Schema.Array(Schema.Struct({
      start: Schema.Int,
      end: Schema.Int,
      text: Schema.String,
    }))),
    text: Schema.String,
  })).annotate({ description: "Output grep Effect compatible con OpenCode V2." });
}

function wrappedTextOutput(field: "output" | "content"): Record<string, unknown> {
  return {
    type: "object",
    properties: { [field]: { type: "string" } },
    required: [field],
    additionalProperties: false,
  };
}
