import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import {
  registerReadOnlyCodeModeTools,
  type CodeModeRegistration,
  type CodeModeRegistrationOptions,
  type CodeModeToolCall,
  type CodeModeToolDomain,
} from "../src/plugin/code-mode";
import { CODE_MODE_LIMITS, type CodeModeLogicalTool } from "../src/plugin/code-mode-worker";

type SandboxRunner = NonNullable<CodeModeRegistrationOptions["runSandbox"]>;
type SandboxInvocation = Parameters<SandboxRunner>[0];

type ToolDefinition = Record<string, unknown> & {
  id: string;
  name: string;
  description: string;
  input: unknown;
  output: unknown;
  options: Record<string, unknown>;
  execute: (input: Record<string, unknown>, call: Record<string, unknown>) => unknown;
};

type GatewayDefinition = Record<string, unknown> & {
  execute: (input: unknown, call: CodeModeToolCall) => Promise<unknown>;
};

type SandboxPlan = (options: SandboxInvocation) => Promise<Record<string, unknown>>;

interface BrokerHarness {
  definitions: Map<string, ToolDefinition>;
  added: Map<string, GatewayDefinition>;
  permissions: Array<Record<string, unknown>>;
  state: { projectRoot: string; permissionAllowed: boolean };
  hostCalls: number;
  setPlan(plan: SandboxPlan): void;
  register(): Promise<CodeModeRegistration>;
}

const BASE_CALL: CodeModeToolCall = {
  sessionID: "ses_broker",
  agent: "malahor",
  messageID: "msg_broker",
  id: "call_broker",
};

let root: string;
let repo: string;
let otherRepo: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-code-mode-broker-"));
  repo = path.join(root, "repo");
  otherRepo = path.join(root, "other-repo");
  home = path.join(root, "home");
  for (const directory of [repo, otherRepo, home]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const alpha = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const beta = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, ".env"), "SYNTHETIC_ONLY=true\n", "utf8");
  fs.writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "name: synthetic\n", "utf8");
  fs.writeFileSync(path.join(repo, "package.json"), "{\"name\":\"broker-fixture\"}\n", "utf8");
  fs.writeFileSync(path.join(otherRepo, "package.json"), "{\"name\":\"other-fixture\"}\n", "utf8");
  fs.symlinkSync(path.join(repo, "src", "a.ts"), path.join(repo, "linked.ts"));
  fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
    demo: { context: "memory", roots: [repo], defaultRoot: repo },
    other: { context: "memory", roots: [otherRepo], defaultRoot: otherRepo },
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

describe("AUTH-01 A4: broker por llamada y adapters host cerrados", () => {
  const compatibleOutputs: Array<{
    name: string;
    tool: CodeModeLogicalTool;
    output: unknown;
    hostValue: (repo: string) => unknown;
    input: Record<string, unknown>;
    expected: unknown;
  }> = [
    {
      name: "string directo",
      tool: "read",
      output: { type: "string" },
      hostValue: () => "alpha\nbeta",
      input: { path: "src/a.ts", limit: 10 },
      expected: "alpha\nbeta",
    },
    {
      name: "campo output con metadata segura",
      tool: "read",
      output: wrappedOutput("output", { type: "string" }),
      hostValue: () => ({
        output: "wrapped output",
        title: "Synthetic read",
        metadata: { truncated: false, lineCount: 1, offset: 0, limit: 10, loaded: 1, size: 14 },
        attachments: [],
      }),
      input: { path: "src/a.ts", limit: 10 },
      expected: "wrapped output",
    },
    {
      name: "campo content con partes textuales",
      tool: "read",
      output: wrappedOutput("content", textPartsSchema()),
      hostValue: () => ({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }),
      input: { path: "src/a.ts", limit: 10 },
      expected: "first\nsecond",
    },
    {
      name: "paths estructurados de glob",
      tool: "glob",
      output: { type: "array", items: { type: "string" } },
      hostValue: (workspace) => [path.join(workspace, "src", "a.ts"), "src/b.ts"],
      input: { pattern: "src/*.ts", path: ".", limit: 10 },
      expected: ["src/a.ts", "src/b.ts"],
    },
    {
      name: "matches estructurados de grep",
      tool: "grep",
      output: grepMatchesSchema(),
      hostValue: (workspace) => [{ path: path.join(workspace, "src", "a.ts"), line: 1, preview: "alpha" }],
      input: { pattern: "alpha", path: "src", literal: true, limit: 10 },
      expected: [{ path: "src/a.ts", line: 1, preview: "alpha" }],
    },
    {
      name: "variante textual Effect real de read",
      tool: "read",
      output: effectV2Output("read"),
      hostValue: () => ({
        type: "text",
        content: "alpha\nbeta",
        mime: "text/plain; charset=utf-8",
        next: null,
        offset: 0,
        truncated: false,
      }),
      input: { path: "src/a.ts" },
      expected: "alpha\nbeta",
    },
    {
      name: "entry file Effect real de glob",
      tool: "glob",
      output: effectV2Output("glob"),
      hostValue: (workspace) => [{ path: path.join(workspace, "src", "a.ts"), type: "file" }],
      input: { pattern: "src/*.ts", path: "." },
      expected: ["src/a.ts"],
    },
    {
      name: "entry file Effect real de grep",
      tool: "grep",
      output: effectV2Output("grep"),
      hostValue: (workspace) => [{
        entry: { path: path.join(workspace, "src", "a.ts"), type: "file" },
        line: 1,
        offset: 13,
        submatches: [{ start: 13, end: 18, text: "alpha" }],
        text: "export const alpha = 1;",
      }],
      input: { pattern: "alpha", path: "src", literal: true },
      expected: [{ path: "src/a.ts", line: 1, preview: "export const alpha = 1;" }],
    },
  ];

  for (const fixture of compatibleOutputs) {
    test(`normaliza ${fixture.name}`, async () => {
      const harness = createBrokerHarness({
        [fixture.tool]: {
          output: fixture.output,
          execute: () => fixture.hostValue(repo),
        },
      });
      const registration = await harness.register();
      try {
        const result = await executeSingleCall(harness, fixture.tool, fixture.input);
        expect(result.ok).toBe(true);
        expect(result.value).toEqual(fixture.expected);
        expect(result.calls).toEqual([{ tool: `repo.${fixture.tool}`, status: "completed" }]);
        expect(harness.permissions).toHaveLength(1);
        expect(harness.permissions[0]).toMatchObject({
          action: fixture.tool,
          save: [],
          source: { type: "tool", messageID: BASE_CALL.messageID },
        });
      } finally {
        await registration.dispose?.();
      }
    });
  }

  const rejectedOutputs: Array<{
    name: string;
    tool: CodeModeLogicalTool;
    output: unknown;
    hostValue: (repo: string) => unknown;
    input: Record<string, unknown>;
    expected: string;
  }> = [
    {
      name: "attachments no vacíos",
      tool: "read",
      output: wrappedOutput("output", { type: "string" }),
      hostValue: () => ({ output: "text", attachments: [{ name: "synthetic.bin" }] }),
      input: { path: "src/a.ts" },
      expected: "R0_ONLY",
    },
    {
      name: "media en content",
      tool: "read",
      output: wrappedOutput("content", textPartsSchema()),
      hostValue: () => ({ content: [{ type: "image", text: "not text" }] }),
      input: { path: "src/a.ts" },
      expected: "R0_ONLY",
    },
    {
      name: "metadata desconocida",
      tool: "read",
      output: wrappedOutput("output", { type: "string" }),
      hostValue: () => ({ output: "text", metadata: { opaqueHostField: 1 } }),
      input: { path: "src/a.ts" },
      expected: "REDACTION_UNSAFE",
    },
    {
      name: "forma ambigua output más content",
      tool: "read",
      output: wrappedOutput("output", { type: "string" }),
      hostValue: () => ({ output: "text", content: "second channel" }),
      input: { path: "src/a.ts" },
      expected: "REDACTION_UNSAFE",
    },
    {
      name: "bytes",
      tool: "read",
      output: { type: "string" },
      hostValue: () => Buffer.from("synthetic"),
      input: { path: "src/a.ts" },
      expected: "REDACTION_UNSAFE",
    },
    {
      name: "directorios devueltos por glob",
      tool: "glob",
      output: { type: "array", items: { type: "string" } },
      hostValue: (workspace) => [path.join(workspace, "src")],
      input: { pattern: "src/*", path: "." },
      expected: "R0_ONLY",
    },
    {
      name: "variante file del output Effect de read",
      tool: "read",
      output: effectV2Output("read"),
      hostValue: () => ({ type: "file", path: "src/a.ts", mime: "text/plain" }),
      input: { path: "src/a.ts" },
      expected: "R0_ONLY",
    },
    {
      name: "variante entries del output Effect de read",
      tool: "read",
      output: effectV2Output("read"),
      hostValue: () => ({ type: "entries", entries: [{ path: "src/a.ts", type: "file" }] }),
      input: { path: "src/a.ts" },
      expected: "R0_ONLY",
    },
    {
      name: "entry directory del output Effect de glob",
      tool: "glob",
      output: effectV2Output("glob"),
      hostValue: (workspace) => [{ path: path.join(workspace, "src"), type: "directory" }],
      input: { pattern: "src/*", path: "." },
      expected: "R0_ONLY",
    },
    {
      name: "entry directory del output Effect de grep",
      tool: "grep",
      output: effectV2Output("grep"),
      hostValue: (workspace) => [{
        entry: { path: path.join(workspace, "src"), type: "directory" },
        line: 1,
        text: "alpha",
      }],
      input: { pattern: "alpha", path: "src" },
      expected: "R0_ONLY",
    },
  ];

  for (const fixture of rejectedOutputs) {
    test(`rechaza ${fixture.name} sin exponer un fallback`, async () => {
      const harness = createBrokerHarness({
        [fixture.tool]: {
          output: fixture.output,
          execute: () => fixture.hostValue(repo),
        },
      });
      const registration = await harness.register();
      try {
        const result = await executeSingleCall(harness, fixture.tool, fixture.input);
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe(fixture.expected);
        expect(JSON.stringify(result)).not.toContain(repo);
      } finally {
        await registration.dispose?.();
      }
    });
  }

  test("consume catalogRef una sola vez y lo liga al mismo request", async () => {
    const harness = createBrokerHarness();
    const registration = await harness.register();
    try {
      const catalogRef = await discover(harness, "read");
      harness.setPlan(async () => successResult({ first: true }));
      const first = await invokeExecute(harness, catalogRef, "return { first: true };");
      const replay = await invokeExecute(harness, catalogRef, "return { replay: true };");
      expect(first.ok).toBe(true);
      expect(replay.error?.kind).toBe("CATALOG_REF_INVALID");

      const requestBoundRef = await discover(harness, "read");
      const wrongRequest = await invokeExecute(
        harness,
        requestBoundRef,
        "return { wrong: true };",
        { ...BASE_CALL, messageID: "msg_other", id: "call_other" },
      );
      const consumed = await invokeExecute(harness, requestBoundRef, "return { original: true };");
      expect(wrongRequest.error?.kind).toBe("CATALOG_REF_INVALID");
      expect(consumed.error?.kind).toBe("CATALOG_REF_INVALID");
    } finally {
      await registration.dispose?.();
    }
  });

  test("falla cerrado ante drift de scope o política después de descubrir", async () => {
    const scopeHarness = createBrokerHarness();
    const scopeRegistration = await scopeHarness.register();
    try {
      const catalogRef = await discover(scopeHarness, "read");
      scopeHarness.state.projectRoot = otherRepo;
      const result = await invokeExecute(scopeHarness, catalogRef, "return { scope: true };");
      expect(result.error?.kind).toBe("SCOPE_DRIFT");
    } finally {
      await scopeRegistration.dispose?.();
    }

    const policyHarness = createBrokerHarness();
    const policyRegistration = await policyHarness.register();
    try {
      const catalogRef = await discover(policyHarness, "read");
      writeProjectPolicy({ files: { enforceRoots: true, allowedReadRoots: [repo] } });
      const result = await invokeExecute(policyHarness, catalogRef, "return { policy: true };");
      expect(result.error?.kind).toBe("POLICY_DRIFT");
    } finally {
      await policyRegistration.dispose?.();
    }
  });

  test("revalida escapes, symlinks, secretos, infraestructura y directorios antes del callback", async () => {
    const vectors: Array<[Record<string, unknown>, string]> = [
      [{ path: "../outside.ts" }, "INVALID_INPUT"],
      [{ path: path.join(repo, "src", "a.ts") }, "INVALID_INPUT"],
      [{ path: "linked.ts" }, "R0_ONLY"],
      [{ path: ".env" }, "R0_ONLY"],
      [{ path: ".github/workflows/ci.yml" }, "R0_ONLY"],
      [{ path: "src" }, "R0_ONLY"],
    ];
    for (const [input, expected] of vectors) {
      const harness = createBrokerHarness();
      const registration = await harness.register();
      try {
        const result = await executeSingleCall(harness, "read", input);
        expect(result.error?.kind, JSON.stringify(input)).toBe(expected);
        expect(harness.hostCalls).toBe(0);
      } finally {
        await registration.dispose?.();
      }
    }
  });

  test("un permiso host denegado no ejecuta el callback ni busca otro canal", async () => {
    const harness = createBrokerHarness();
    harness.state.permissionAllowed = false;
    const registration = await harness.register();
    try {
      const result = await executeSingleCall(harness, "read", { path: "src/a.ts" });
      expect(result.error?.kind).toBe("PERMISSION_DENIED");
      expect(harness.hostCalls).toBe(0);
      expect(harness.permissions).toHaveLength(1);
    } finally {
      await registration.dispose?.();
    }
  });

  test("una tool no descubierta se deniega antes del callback host", async () => {
    const harness = createBrokerHarness();
    const registration = await harness.register();
    try {
      harness.setPlan(async (options) => {
        const response = await options.onCall(
          workerCall(options, 0, "grep", { pattern: "alpha", path: "src", literal: true, limit: 10 }),
          options.signal!,
        );
        return response.ok ? successResult(response.value ?? null) : failureResult(response.error?.code ?? "SANDBOX_FAILURE");
      });
      const catalogRef = await discover(harness, "read");
      const result = await invokeExecute(harness, catalogRef, "return await tools.repo.grep({ pattern: 'alpha' });");

      expect(result.error?.kind).toBe("TOOL_NOT_DISCOVERED");
      expect(harness.hostCalls).toBe(0);
    } finally {
      await registration.dispose?.();
    }
  });

  test("redacta el output antes del sandbox y no devuelve el valor detectado", async () => {
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    const credentialName = ["api", "key"].join("_");
    const harness = createBrokerHarness({
      read: { execute: () => `${credentialName}='${syntheticValue}'` },
    });
    const registration = await harness.register();
    try {
      const result = await executeSingleCall(harness, "read", { path: "src/a.ts" });
      const serialized = JSON.stringify(result);

      expect(result.ok).toBe(true);
      expect(result.redacted).toBe(true);
      expect(serialized).not.toContain(syntheticValue);
      expect(serialized).toMatch(/REDACTED/i);
    } finally {
      await registration.dispose?.();
    }
  });

  test("falla cerrado antes del efecto cuando la auditoría obligatoria no es escribible", async () => {
    const harness = createBrokerHarness();
    const registration = await harness.register();
    try {
      fs.writeFileSync(path.join(home, "audit"), "not-a-directory", "utf8");
      const result = await executeSingleCall(harness, "read", { path: "src/a.ts" });

      expect(result.error?.kind).toBe("AUDIT_UNAVAILABLE");
      expect(harness.hostCalls).toBe(0);
    } finally {
      await registration.dispose?.();
    }
  });

  test("corta la llamada 13 y conserva la cuota dura de 12", async () => {
    const harness = createBrokerHarness();
    const registration = await harness.register();
    try {
      harness.setPlan(async (options) => {
        for (let index = 0; index <= CODE_MODE_LIMITS.maxToolCalls; index += 1) {
          const response = await options.onCall(workerCall(options, index, "read", { path: "src/a.ts" }), options.signal!);
          if (!response.ok) return failureResult(response.error?.code ?? "SANDBOX_FAILURE");
        }
        return successResult("quota-not-enforced");
      });
      const catalogRef = await discover(harness, "read");
      const result = await invokeExecute(harness, catalogRef, "return 'quota';");
      expect(result.error?.kind).toBe("QUOTA_EXCEEDED");
      expect(harness.hostCalls).toBe(CODE_MODE_LIMITS.maxToolCalls);
    } finally {
      await registration.dispose?.();
    }
  });

  test("cancela la quinta llamada concurrente y no supera cuatro callbacks host", async () => {
    const harness = createBrokerHarness();
    const registration = await harness.register();
    try {
      harness.setPlan(async (options) => {
        await Promise.all(Array.from({ length: CODE_MODE_LIMITS.maxConcurrentCalls + 1 }, (_value, index) => (
          options.onCall(workerCall(options, index, "read", { path: "src/a.ts" }), options.signal!)
        )));
        return successResult("concurrency-not-enforced");
      });
      const catalogRef = await discover(harness, "read");
      const result = await invokeExecute(harness, catalogRef, "return 'concurrency';");

      expect(result.error?.kind).toBe("QUOTA_EXCEEDED");
      expect(harness.hostCalls).toBeLessThanOrEqual(CODE_MODE_LIMITS.maxConcurrentCalls);
    } finally {
      await registration.dispose?.();
    }
  });

  test("aborta un callback que excede el timeout por llamada", async () => {
    let childAborted = false;
    const harness = createBrokerHarness({
      read: {
        execute: (_input, call) => new Promise((_resolve, reject) => {
          const signal = call.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            childAborted = true;
            reject(new Error("synthetic callback aborted"));
          }, { once: true });
        }),
      },
    });
    const registration = await harness.register();
    try {
      const result = await executeSingleCall(harness, "read", { path: "src/a.ts" });
      expect(result.error?.kind).toBe("QUOTA_EXCEEDED");
      expect(childAborted).toBe(true);
    } finally {
      await registration.dispose?.();
    }
  }, CODE_MODE_LIMITS.callMs + 4_000);

  test("dispose cancela una ejecución activa y espera su cleanup", async () => {
    const harness = createBrokerHarness();
    const registration = await harness.register();
    let startedResolve: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    harness.setPlan((options) => new Promise((resolve) => {
      startedResolve();
      options.signal!.addEventListener("abort", () => resolve(failureResult("CANCELLED")), { once: true });
    }));
    const catalogRef = await discover(harness, "read");
    const pending = invokeExecute(harness, catalogRef, "return await tools.repo.read({ path: 'src/a.ts' });");
    await started;
    await registration.dispose?.();
    const result = await pending;
    expect(result.error?.kind).toBe("CANCELLED");
  });

  test("audita solo refs y métricas, nunca código, argumentos, contenido ni rutas absolutas", async () => {
    const marker = "synthetic-audit-marker-7c621";
    const program = `const value = await tools.repo.grep({ pattern: "${marker}", path: "src" }); return { count: value.length };`;
    const harness = createBrokerHarness({
      grep: {
        output: grepMatchesSchema(),
        execute: () => [{ path: path.join(repo, "src", "a.ts"), line: 1, preview: "redacted preview" }],
      },
    });
    const registration = await harness.register();
    try {
      const result = await executeSingleCall(
        harness,
        "grep",
        { pattern: marker, path: "src", literal: true },
        program,
      );
      expect(result.ok).toBe(true);
      const auditFile = path.join(home, "audit", "security.jsonl");
      const raw = fs.readFileSync(auditFile, "utf8");
      expect(raw).not.toContain(marker);
      expect(raw).not.toContain(program);
      expect(raw).not.toContain(repo);
      expect(raw).not.toContain("redacted preview");
      const codeMode = raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.kind === "code-mode");
      expect(codeMode.length).toBeGreaterThanOrEqual(4);
      expect(codeMode.every((entry) => String(entry.programRef).startsWith("sha256:"))).toBe(true);
      expect(codeMode.some((entry) => entry.phase === "call.after" && entry.tool === "grep")).toBe(true);
    } finally {
      await registration.dispose?.();
    }
  });
});

function createBrokerHarness(
  overrides: Partial<Record<CodeModeLogicalTool, Partial<Pick<ToolDefinition, "output" | "execute">>>> = {},
): BrokerHarness {
  const definitions = new Map<string, ToolDefinition>();
  let hostCalls = 0;
  for (const tool of ["read", "glob", "grep"] as const) {
    const override = overrides[tool];
    const execute = override?.execute ?? (() => tool === "read" ? "fixture" : "");
    definitions.set(tool, {
      id: tool,
      name: tool,
      description: `Host ${tool} sintético`,
      input: inputSchema(tool),
      output: override?.output ?? { type: "string" },
      options: { permission: tool, codemode: false },
      execute: (input, call) => {
        hostCalls += 1;
        return execute(input, call);
      },
    });
  }
  const added = new Map<string, GatewayDefinition>();
  const permissions: Array<Record<string, unknown>> = [];
  const state = { projectRoot: repo, permissionAllowed: true };
  let ref = 0;
  let plan: SandboxPlan = async () => successResult({ noCalls: true });
  const domain: CodeModeToolDomain = {
    list: async () => [...definitions.values()],
    transform: async (callback) => {
      callback({
        list: () => [...definitions.values()],
        get: (name) => definitions.get(name),
        namespace: () => undefined,
        add: (value) => { added.set(String(value.name), value as GatewayDefinition); },
      });
      return { dispose: () => undefined };
    },
  };
  const runSandbox: SandboxRunner = async (options) => ({
    result: options.code === "return { health: true };"
      ? successResult({ health: true })
      : await plan(options),
    redacted: false,
    redactions: [],
    truncated: false,
  });
  const harness: BrokerHarness = {
    definitions,
    added,
    permissions,
    state,
    get hostCalls() { return hostCalls; },
    setPlan(next) { plan = next; },
    register: () => registerReadOnlyCodeModeTools(
      domain,
      { assert: async (request) => {
        permissions.push(structuredClone(request));
        if (!state.permissionAllowed) throw new Error("synthetic permission denial");
      } },
      {},
      {
        cwd: repo,
        env,
        permissionRegistered: true,
        toolRegistered: true,
        resolveSessionProject: async () => ({
          canonicalKey: state.projectRoot === repo ? "demo" : "other",
          root: state.projectRoot,
        }),
      },
      {
        moduleURL: import.meta.url,
        workerSource: () => "// malahor-code-mode-worker synthetic broker",
        runSandbox,
        randomRef: (prefix) => `${prefix}_${String(++ref).padStart(20, "0")}`,
      },
    ),
  };
  return harness;
}

async function executeSingleCall(
  harness: BrokerHarness,
  tool: CodeModeLogicalTool,
  input: Record<string, unknown>,
  code = `return await tools.repo.${tool}({});`,
): Promise<Record<string, any>> {
  harness.setPlan(async (options) => {
    const response = await options.onCall(workerCall(options, 0, tool, input), options.signal!);
    return response.ok
      ? successResult(response.value ?? null)
      : failureResult(response.error?.code ?? "SANDBOX_FAILURE");
  });
  const catalogRef = await discover(harness, tool);
  return invokeExecute(harness, catalogRef, code);
}

async function discover(harness: BrokerHarness, query: string): Promise<string> {
  const gateway = harness.added.get("code_search");
  expect(gateway).toBeDefined();
  const response = await gateway!.execute({ query }, BASE_CALL) as { content: string };
  const parsed = JSON.parse(response.content) as { catalogRef?: string };
  expect(parsed.catalogRef).toMatch(/^cat_/);
  return parsed.catalogRef!;
}

async function invokeExecute(
  harness: BrokerHarness,
  catalogRef: string,
  code: string,
  call: CodeModeToolCall = { ...BASE_CALL, id: "call_broker_execute" },
): Promise<Record<string, any>> {
  const gateway = harness.added.get("code_execute");
  expect(gateway).toBeDefined();
  const response = await gateway!.execute({ catalogRef, code }, call) as { content: string };
  return JSON.parse(response.content) as Record<string, any>;
}

function workerCall(
  options: SandboxInvocation,
  index: number,
  tool: CodeModeLogicalTool,
  input: Record<string, unknown>,
) {
  return {
    version: 1 as const,
    type: "call" as const,
    executionRef: options.executionRef,
    callID: `call_${index}`,
    index,
    tool,
    input,
  };
}

function successResult(value: unknown): Record<string, unknown> {
  return { ok: true, value, toolCalls: [] };
}

function failureResult(kind: string): Record<string, unknown> {
  return { ok: false, error: { kind, message: "synthetic confined failure" }, toolCalls: [] };
}

function inputSchema(tool: CodeModeLogicalTool): Record<string, unknown> {
  if (tool === "read") return {
    type: "object",
    properties: {
      path: { type: "string" },
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
      hidden: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: CODE_MODE_LIMITS.globResults },
    },
    required: ["pattern"],
    additionalProperties: false,
  };
  return {
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
  };
}

function wrappedOutput(field: "output" | "content", primary: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [field]: primary,
      title: { type: "string" },
      metadata: { type: "object" },
      attachments: { type: "array", items: {} },
    },
    required: [field],
    additionalProperties: false,
  };
}

function textPartsSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        type: { type: "string", const: "text" },
        text: { type: "string" },
      },
      required: ["type", "text"],
      additionalProperties: false,
    },
  };
}

function grepMatchesSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "integer", minimum: 1 },
        preview: { type: "string" },
      },
      required: ["path", "line", "preview"],
      additionalProperties: false,
    },
  };
}

function effectV2Output(tool: CodeModeLogicalTool) {
  const entry = Schema.Struct({
    path: Schema.String,
    type: Schema.Literals(["file", "directory"]),
  });
  if (tool === "read") {
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
      Schema.Struct({ type: Schema.Literal("entries"), entries: Schema.Array(entry) }),
    ]);
  }
  if (tool === "glob") return Schema.Array(entry);
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
  }));
}

function writeProjectPolicy(controls: Record<string, unknown>): void {
  const target = path.join(home, "policies", "projects", "demo.jsonc");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: 1,
    policyVersion: "a4-drift",
    issuer: "synthetic-test",
    issuedAt: "2026-11-02T00:00:00.000Z",
    controls,
  })}\n`, "utf8");
}
