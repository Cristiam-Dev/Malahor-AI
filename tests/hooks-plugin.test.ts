import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import plugin from "../assets/opencode/plugins/malahor/index";
import {
  evaluatePermission,
  evaluateSessionHook,
  evaluateShellHook,
  evaluateToolHook,
  formatPluginBlock,
} from "../src/cli/core/hooks/plugin-adapter";
import { buildSecretPatchSummary, revalidateSecretPatchSummary } from "../src/cli/core/hooks/secret-scan";
import {
  MALAHOR_COMPACTION_MARKER,
  checkpointBeforeCompaction,
  injectCompactionInstructions,
} from "../src/plugin/compaction";
import {
  MALAHOR_MEMORY_NUDGE_MARKER,
  markMemoryPersisted,
  maybeInjectMemoryNudge,
} from "../src/plugin/memory-nudge";
import { startEventCapture } from "../src/plugin/events";
import { MALAHOR_PROTOCOL_MARKER, injectMalahorProtocol } from "../src/plugin/protocol";
import { createGitIntentRegistry } from "../src/cli/core/git-intent";
import { isMcpToolName, type HookResult, type HookViolation } from "../src/cli/core/hooks/types";
import { evaluatePlanningPermission, evaluatePlanningTool } from "../src/plugin/planning";

let root: string;
let repo: string;
let home: string;
let opencode: string;
let env: NodeJS.ProcessEnv;
const SPEC_REF = "SDD/hooks-plugin-fixture.md";
const SPEC_CONTENT = "# Hooks plugin fixture\n";
const SPEC_HASH = createHash("sha256").update(SPEC_CONTENT).digest("hex");

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-hooks-plugin-"));
  repo = path.join(root, "repo");
  home = path.join(root, "home");
  opencode = path.join(root, "opencode");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(opencode, { recursive: true });
  fs.mkdirSync(path.join(home, "docs"), { recursive: true });
  fs.writeFileSync(path.join(home, "docs", "index.js"), "// docs fixture\n", "utf8");
  const spec = path.join(home, "vault", "projects", "demo", SPEC_REF);
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.writeFileSync(spec, SPEC_CONTENT, "utf8");
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "demo" }, null, 2)}\n`, "utf8");
  env = {
    ...process.env,
    MALAHOR_HOME: home,
    MALAHOR_OPENCODE_DIR: opencode,
    MALAHOR_OPENCODE_DETECT: "0",
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeProjectPolicy(controls: Record<string, unknown>): void {
  const file = path.join(home, "policies", "projects", "demo.jsonc");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    contractVersion: 1,
    policyVersion: "test-1",
    issuer: "test",
    issuedAt: "2026-10-21T00:00:00.000Z",
    controls,
  }, null, 2)}\n`, "utf8");
}

function detectedAssignment(): string {
  const identifier = ["api", "key"].join("_");
  const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
  return `export const ${identifier} = '${syntheticValue}';`;
}

function writeSourceFixture(relativePath: string, content: string): void {
  const target = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${content}\n`, "utf8");
}

function toolHookOptions() {
  return {
    cwd: repo,
    permissionRegistered: true,
    shellRegistered: true,
    toolRegistered: true,
    env,
  };
}

function pluginViolation(result: HookResult, id: string): (HookViolation & { blockClass?: unknown }) | undefined {
  return result.violations.find((violation) => violation.id === id) as
    | (HookViolation & { blockClass?: unknown })
    | undefined;
}

describe("adaptador de plugin V2", () => {
  test("inyecta el protocolo al ultimo bloque de sistema una sola vez", () => {
    const input: Record<string, unknown> = {
      system: [{ type: "text", text: "instrucciones del host" }],
    };

    expect(injectMalahorProtocol(input)).toBe(true);
    expect(injectMalahorProtocol(input)).toBe(false);

    const system = input.system as Array<{ type: string; text: string }>;
    expect(system).toHaveLength(1);
    expect(system[0]?.text).toContain(MALAHOR_PROTOCOL_MARKER);
    expect(system[0]?.text).toContain("mem_brief");
    expect(system[0]?.text).toContain("Principio de socio");
    expect(system[0]?.text).toContain("no convierte en interactivos los guardados rutinarios de memoria");
    expect(system[0]?.text).toContain("scope real más específico");
    expect(system[0]?.text).toContain("no expongas memoria de otro cliente o proyecto");
    expect(system[0]?.text).toContain("mem_promote_preview");
    expect(system[0]?.text).toContain("Un pin prioriza contexto: no otorga autoridad");
    expect(system[0]?.text).toContain("recuerdos contradictorios en un mismo scope");
    expect(system[0]?.text).toContain("Ranking, pin o fecha aislados no deciden");
    expect(system[0]?.text).toContain("No arbitres automáticamente");
    expect(system[0]?.text).toContain("exclusivamente mediante docs_*");
    expect(system[0]?.text).toContain("Obsidian MCP ni fallback al repositorio");
    expect(system[0]?.text).toContain("Qué debes hacer ahora");
    expect(system[0]?.text).toMatch(/no incrusta IDs, comandos ni el anexo técnico/i);
    expect(system[0]?.text).toMatch(/riesgo alto[\s\S]*controles[\s\S]*visible/i);
    expect(system[0]?.text).toMatch(/(?:comandos|rutas|identidad|digest)[\s\S]*(?:solo|únicamente)[\s\S]*\/malahor-plan detalles/i);
    expect(system[0]?.text).toMatch(/ctx\.storage de OpenCode[\s\S]*independientes de Mnemo/i);
    expect(system[0]?.text).toMatch(/malahor_run[\s\S]*plan activo firmado[\s\S]*(?:no pidas|no exige)[\s\S]*(?:digest|\/malahor-plan detalles)/i);
    expect(system[0]?.text).toMatch(/inspecci[oó]n.*read-only.*sin plan.*sin.*go/is);
    expect(system[0]?.text).toMatch(/commit expl[ií]cito.*sin Planning.*aprobaci[oó]n nativa/is);
    expect(system[0]?.text).toMatch(/malahor_commit_prepare.*rutas y comandos exactos/is);
    expect(system[0]?.text).not.toMatch(/commit expl[ií]cito.*plan nivel 0/is);
  });

  test("compaction guarda checkpoint runtime e inyecta persistencia idempotente", async () => {
    let saved: { key: string; value: Record<string, unknown> } | undefined;
    const input: Record<string, unknown> = {
      sessionID: "ses_compact",
      messages: [{ role: "user" }, { role: "assistant" }],
      system: [{ type: "text", text: "contexto base" }],
    };

    const checkpoint = await checkpointBeforeCompaction(input, {
      set: async (key, value) => { saved = { key, value }; },
    }, {
      cwd: home,
      resolveSessionDirectory: async () => home,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
    });
    expect(checkpoint.ok).toBe(true);
    expect(saved?.key).toBe("compaction/ses_compact");
    expect(saved?.value.messageCount).toBe(2);
    expect(saved?.value).toMatchObject({ directory: repo, project: "demo" });

    expect(injectCompactionInstructions(input)).toBe(true);
    expect(injectCompactionInstructions(input)).toBe(false);
    const system = input.system as Array<{ text: string }>;
    expect(system[0]?.text).toContain(MALAHOR_COMPACTION_MARKER);
    expect(system[0]?.text).toContain("mem_session_summary");
  });

  test("nudge de memoria respeta staleness, intervalo y persistencia", async () => {
    const values = new Map<string, unknown>();
    let now = Date.parse("2026-10-22T00:00:00.000Z");
    const storage = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: Record<string, unknown>) => { values.set(key, value); },
    };
    const input: Record<string, unknown> = {
      sessionID: "ses_nudge",
      system: [{ type: "text", text: "base" }],
    };
    const options = {
      cwd: home,
      staleMinutes: 15,
      now: () => now,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
    };

    expect((await maybeInjectMemoryNudge(input, storage, options)).injected).toBe(false);
    now += 16 * 60_000;
    expect((await maybeInjectMemoryNudge(input, storage, options)).injected).toBe(true);
    expect((input.system as Array<{ text: string }>)[0]?.text).toContain(MALAHOR_MEMORY_NUDGE_MARKER);
    now += 1 * 60_000;
    expect((await maybeInjectMemoryNudge(input, storage, options)).injected).toBe(false);

    const persisted = await markMemoryPersisted({
      sessionID: "ses_nudge",
      tool: "mcp_mnemo_mem_session_summary",
      status: "completed",
    }, storage, options);
    expect(persisted.marked).toBe(true);
    now += 1 * 60_000;
    const freshInput: Record<string, unknown> = {
      sessionID: "ses_nudge",
      system: [{ type: "text", text: "fresh context" }],
    };
    expect((await maybeInjectMemoryNudge(freshInput, storage, options)).injected).toBe(false);
  });

  test("eventos de sesion guardan metadatos y capturan subagentes solo con opt-in", async () => {
    const values = new Map<string, Record<string, unknown>>();
    const storage = {
      set: async (key: string, value: Record<string, unknown>) => { values.set(key, value); },
    };
    const primary = {
      id: "evt-primary",
      type: "session.execution.succeeded",
      created: Date.parse("2026-10-22T00:00:00.000Z"),
      data: { sessionID: "ses_primary", location: { directory: home }, agent: "malahor" },
    };
    const child = {
      id: "evt-child",
      type: "session.execution.succeeded",
      created: Date.parse("2026-10-22T00:01:00.000Z"),
      data: { sessionID: "ses_child", parentID: "ses_primary", location: { directory: home }, agent: "malahor-testing" },
    };
    const stream = (events: unknown[]): AsyncIterable<unknown> => (async function* () {
      for (const event of events) yield event;
    })();

    const excluded = startEventCapture({ subscribe: () => stream([primary, child]) }, storage, {
      cwd: repo,
      captureSubagentsOptIn: false,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
    });
    await excluded.done;
    expect(values.has("session/events/demo/evt-primary")).toBe(true);
    expect(values.has("session/events/demo/evt-child")).toBe(false);
    expect(JSON.stringify([...values.values()])).not.toContain("location");

    const included = startEventCapture({ subscribe: () => stream([child]) }, storage, {
      cwd: repo,
      captureSubagentsOptIn: true,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
    });
    await included.done;
    expect(values.has("session/events/demo/evt-child")).toBe(true);
    included.cleanup();
  });
  test("permission.evaluate convierte Git local destructivo en ASK visible", async () => {
    const input: Record<string, unknown> = {
      action: "bash",
      resources: ["git reset --hard"],
      effect: "allow",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("ask");
    expect(input.effect).toBe("ask");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-DESTRUCTIVE")).toBe(true);
  });

  test("propaga y consume una intencion commit sin confirmacion redundante", async () => {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "export {};\n", "utf8");
    const gitIntentRegistry = createGitIntentRegistry();
    const options = {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      env,
      gitIntentRegistry,
    };
    const command = "git add -- src/a.ts";

    const authorized = await evaluateToolHook({
      tool: "mnemo_malahor_hook_check",
      input: {
        event: "file.stage.before",
        command,
        paths: ["src/a.ts"],
        resourceKind: "filesystem",
        intent: "commit",
      },
    }, options);
    const permissionInput: Record<string, unknown> = {
      action: "bash",
      resources: [command],
      metadata: { command },
      effect: "allow",
    };
    const permission = await evaluatePermission(permissionInput, options);
    const firstShell = await evaluateShellHook({ command, cwd: repo, timeout: 30 }, options);
    const secondShell = await evaluateShellHook({ command, cwd: repo, timeout: 30 }, options);

    expect(authorized.violations).toEqual([]);
    expect(authorized.decision).toBe("allow");
    expect(permission.effect).toBe("allow");
    expect(firstShell.result.decision).toBe("allow");
    expect(secondShell.result.decision).toBe("ask");
    expect(secondShell.result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-STAGE-CONSENT")).toBe(true);
  });

  test("consume la intencion en permission cuando no existe shell hook", async () => {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "a.ts"), "export {};\n", "utf8");
    const gitIntentRegistry = createGitIntentRegistry();
    const options = {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: false,
      env,
      gitIntentRegistry,
    };
    const command = "git add -- src/a.ts";
    await evaluateToolHook({
      tool: "mnemo_malahor_hook_check",
      input: {
        event: "file.stage.before",
        command,
        paths: ["src/a.ts"],
        resourceKind: "filesystem",
        intent: "commit",
      },
    }, options);

    const first = await evaluatePermission({
      action: "bash",
      resources: [command],
      metadata: { command },
      effect: "allow",
    }, options);
    const second = await evaluatePermission({
      action: "bash",
      resources: [command],
      metadata: { command },
      effect: "allow",
    }, options);

    expect(first.effect).toBe("allow");
    expect(second.effect).toBe("ask");
  });

  test("metadata gitIntent sin evidencia one-shot no autoriza Git local", async () => {
    const command = "git add -- src/a.ts";
    const permission = await evaluatePermission({
      action: "bash",
      resources: [command],
      metadata: { command, gitIntent: "commit" },
      effect: "allow",
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(permission.effect).toBe("ask");
    expect(permission.result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-STAGE-CONSENT")).toBe(true);
  });

  test("no registra intencion commit para un stage no delimitado", async () => {
    const gitIntentRegistry = createGitIntentRegistry();
    const options = {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      env,
      gitIntentRegistry,
    };
    const command = "git add -A";
    const hook = await evaluateToolHook({
      tool: "mnemo_malahor_hook_check",
      input: {
        event: "file.stage.before",
        command,
        paths: ["src/a.ts"],
        resourceKind: "filesystem",
        intent: "commit",
      },
    }, options);
    const permission = await evaluatePermission({
      action: "bash",
      resources: [command],
      metadata: { command },
      effect: "allow",
    }, options);

    expect(hook.decision).toBe("deny");
    expect(hook.violations.some((violation) => violation.id === "MAL-HOOK-GIT-INTENT-SCOPE")).toBe(true);
    expect(permission.effect).toBe("ask");
  });

  test("remote Git permanece DENY en permission y shell", async () => {
    const options = { cwd: repo, permissionRegistered: true, shellRegistered: true, env };
    const permissionInput: Record<string, unknown> = {
      action: "bash",
      resources: ["git fetch origin"],
      metadata: { command: "git fetch origin", gitIntent: "commit" },
      effect: "allow",
    };
    const permission = await evaluatePermission(permissionInput, options);
    const shell = await evaluateShellHook({ command: "git fetch origin", cwd: repo, timeout: 30 }, options);

    expect(permission.effect).toBe("deny");
    expect(shell.result.decision).toBe("deny");
    expect(shell.result.violations.some((violation) => violation.id === "MAL-HOOK-GIT-REMOTE-DENY")).toBe(true);
  });

  test("la evidencia de commit incluye cambios staged de tipo T", async () => {
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(git(["init", "-q"]).exitCode).toBe(0);
    fs.writeFileSync(path.join(repo, "typed-entry"), "regular\n", "utf8");
    expect(git(["add", "typed-entry"]).exitCode).toBe(0);
    expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0);
    fs.writeFileSync(path.join(repo, "link-target"), "target\n", "utf8");
    const blob = git(["hash-object", "-w", "link-target"]).stdout.toString().trim();
    expect(blob).toMatch(/^[a-f0-9]{40,64}$/);
    expect(git(["update-index", "--cacheinfo", "120000", blob, "typed-entry"]).exitCode).toBe(0);
    expect(git(["diff", "--cached", "--name-status"]).stdout.toString()).toContain("T\ttyped-entry");

    const gitIntentRegistry = createGitIntentRegistry();
    const options = {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      env,
      gitIntentRegistry,
    };
    const command = "git commit -m '✅ test(git): preserva cambios de tipo'";
    const authorized = await evaluateToolHook({
      tool: "mnemo_malahor_hook_check",
      input: {
        event: "git.commit.before",
        command,
        paths: ["typed-entry"],
        resourceKind: "filesystem",
        intent: "commit",
      },
    }, options);
    const shell = await evaluateShellHook({ command, cwd: repo, timeout: 30 }, options);

    expect(authorized.decision).toBe("allow");
    expect(shell.result.decision).toBe("allow");
  });

  test("autorizacion de archivos usa la raiz registrada aunque el cwd sea otro", async () => {
    fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
      demo: { context: "mnemo", roots: [repo], defaultRoot: repo },
    })}\n`, "utf8");

    const result = await evaluateToolHook({
      tool: "read",
      input: { filePath: path.join(repo, "package.json") },
    }, { cwd: home, permissionRegistered: true, shellRegistered: true, env });

    expect(result.decision, JSON.stringify(result.violations)).toBe("allow");
    const audit = fs.readFileSync(path.join(home, "audit", "security.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { project: string; resourceRefs: string[] });
    expect(audit.at(-1)?.project).toBe("demo");
  });

  test("permission.evaluate mantiene un deny del host aunque el motor permita", async () => {
    const input: Record<string, unknown> = {
      action: "read",
      resources: [path.join(repo, "archivo.txt")],
      effect: "deny",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("deny");
    expect(input.effect).toBe("deny");
  });

  test("permission.evaluate conserva defaults del host para acciones no mapeadas", async () => {
    const input: Record<string, unknown> = {
      action: "capacidad.desconocida",
      resources: [],
      effect: "allow",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("allow");
    expect(result.result.decision).toBe("warn");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-PLUGIN-UNMAPPED")).toBe(true);
  });

  test("permission.evaluate trata Mnemo y docs directos como MCP sin pedir permiso adicional", async () => {
    for (const action of ["mnemo_mem_save", "docs_write"]) {
      const result = await evaluatePermission({
        action,
        resources: [],
        effect: "allow",
      }, { cwd: repo, permissionRegistered: true, env });

      expect(result.effect).toBe("allow");
      expect(result.result.violations).toEqual([]);
    }
  });

  test("permission.evaluate mapea MCP y aplica la allowlist de tools", async () => {
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    const blocked = await evaluatePermission({
      action: "mcp_bad_search",
      resources: [],
      effect: "allow",
    }, { cwd: repo, permissionRegistered: true, env });
    const allowed = await evaluatePermission({
      action: "mcp_ok_search",
      resources: [],
      effect: "allow",
    }, { cwd: repo, permissionRegistered: true, env });

    expect(blocked.effect).toBe("deny");
    expect(blocked.result.violations.some((violation) => violation.id === "MAL-HOOK-MCP-ALLOWLIST")).toBe(true);
    expect(allowed.effect).toBe("allow");
  });

  test("reconoce el namespace horiel como MCP exacto en permission y hooks", async () => {
    expect(isMcpToolName("horiel_memory_get")).toBe(true);
    expect(isMcpToolName("horiel.memory_search")).toBe(true);
    expect(isMcpToolName("mcp_horiel_memory_context")).toBe(true);
    expect(isMcpToolName("myhoriel_memory_get")).toBe(false);

    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["horiel_memory_*", "mcp_horiel_memory_*"],
      },
    });
    for (const action of ["horiel_memory_get", "mcp_horiel_memory_search"]) {
      const result = await evaluatePermission({
        action,
        resources: [],
        effect: "allow",
      }, { cwd: repo, permissionRegistered: true, env });
      expect(result.effect).toBe("allow");
      expect(result.result.violations).toEqual([]);
    }
  });

  test("planning trata solo lecturas y previews Horiel como rutina", async () => {
    const readOnly = [
      "memory_get",
      "memory_search",
      "memory_context",
      "memory_brief",
      "memory_tree",
      "memory_list_projects",
      "memory_inspect_project",
      "memory_move_preview",
      "memory_promote_preview",
      "memory_delete_project_preview",
      "memory_restore_preview",
    ];
    const mutating = [
      "memory_save",
      "memory_update",
      "memory_session_summary",
      "memory_pin",
      "memory_unpin",
      "memory_link",
      "memory_unlink",
      "memory_move",
      "memory_promote",
      "memory_backup",
      "memory_delete_project",
      "memory_restore",
    ];
    const options = { cwd: repo, permissionRegistered: true, shellRegistered: true, env };

    for (const tool of readOnly) {
      await expect(evaluatePlanningTool({ tool: `horiel_${tool}`, input: {} }, options)).resolves.toBeUndefined();
      await expect(evaluatePlanningTool({ tool: `mcp_horiel_${tool}`, input: {} }, options)).resolves.toBeUndefined();
    }
    for (const tool of mutating) {
      await expect(evaluatePlanningTool({ tool: `horiel_${tool}`, input: {} }, options)).rejects.toThrow();
      await expect(evaluatePlanningTool({ tool: `mcp_horiel_${tool}`, input: {} }, options)).rejects.toThrow();
    }
  });

  test("Planning trata solo los dos gateways A4 exactos como lectura directa", async () => {
    writeProjectPolicy({ integrations: { blockUnapprovedIntegrations: true } });
    const options = {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      toolRegistered: true,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
      env,
    };

    for (const tool of ["malahor_code_search", "malahor_code_execute"]) {
      await expect(evaluatePlanningTool({ sessionID: "ses_a4", tool, input: {} }, options)).resolves.toBeUndefined();
      const permission: Record<string, unknown> = {
        sessionID: "ses_a4",
        action: tool,
        resources: [],
        effect: "allow",
      };
      await evaluatePlanningPermission(permission, options);
      expect(permission.effect).toBe("allow");

      const hook = await evaluateToolHook({ sessionID: "ses_a4", tool, input: {} }, options);
      expect(hook.decision).toBe("allow");
      expect(hook.violations.some((violation) => violation.id === "MAL-HOOK-CODE-MODE")).toBe(false);
    }

    for (const alias of ["code_search", "code_execute"]) {
      await expect(evaluatePlanningTool({ sessionID: "ses_a4", tool: alias, input: {} }, options)).rejects.toThrow();
      const hook = await evaluateToolHook({ sessionID: "ses_a4", tool: alias, input: {} }, options);
      expect(hook.decision).toBe("deny");
      expect(hook.violations.some((violation) => violation.id === "MAL-HOOK-TOOL-UNKNOWN")).toBe(true);
    }
  });

  test("permission.evaluate no pregunta por tools conocidas sin efecto propio", async () => {
    const input: Record<string, unknown> = {
      action: "todowrite",
      resources: [],
      effect: "allow",
    };

    const result = await evaluatePermission(input, { cwd: repo, permissionRegistered: true, env });

    expect(result.effect).toBe("allow");
    expect(result.result.violations).toEqual([]);
  });

  test("permission edit difiere la operacion solo para una tool realmente mediada", async () => {
    const input = {
      action: "edit",
      resources: ["docs/security/operation-matrix.md"],
      effect: "allow",
      source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" },
    };

    const deferred = await evaluatePermission({ ...input }, {
      cwd: repo,
      permissionRegistered: true,
      toolRegistered: true,
      env,
    });
    expect(deferred.effect).toBe("allow");
    expect(deferred.result.violations).toEqual([]);

    const unmediated = await evaluatePermission({ ...input }, {
      cwd: repo,
      permissionRegistered: true,
      toolRegistered: false,
      env,
    });
    expect(unmediated.effect).toBe("deny");
    expect(unmediated.result.violations.some((violation) => violation.id === "MAL-HOOK-DOCS-EXTERNAL")).toBe(true);

    const unattributed = await evaluatePermission({
      action: input.action,
      resources: input.resources,
      effect: input.effect,
    }, {
      cwd: repo,
      permissionRegistered: true,
      toolRegistered: true,
      env,
    });
    expect(unattributed.effect).toBe("deny");
    expect(unattributed.result.violations.some((violation) => violation.id === "MAL-HOOK-DOCS-EXTERNAL")).toBe(true);
  });

  test("permission conserva targets diferidos y pide aprobacion antes de tocar infraestructura", async () => {
    const options = {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      toolRegistered: true,
      env,
    };
    const protectedInput: Record<string, unknown> = {
      action: "edit",
      resources: [".github/workflows/ci.yml"],
      effect: "allow",
      source: { type: "tool", messageID: "msg_infra", id: "call_infra" },
    };
    const protectedWrite = await evaluatePermission(protectedInput, options);
    const ordinaryWrite = await evaluatePermission({
      action: "edit",
      resources: ["src/app.ts"],
      effect: "allow",
      source: { type: "tool", messageID: "msg_source", id: "call_source" },
    }, options);
    const toolCheck = await evaluateToolHook({
      tool: "edit",
      input: { path: ".github/workflows/ci.yml" },
    }, options);

    expect(protectedWrite.effect).toBe("ask");
    expect(protectedInput.effect).toBe("ask");
    expect(protectedWrite.result.violations.some((violation) => violation.id === "MAL-HOOK-INFRA-APPROVAL")).toBe(true);
    expect(ordinaryWrite.effect).toBe("allow");
    expect(toolCheck.decision).toBe("ask");
  });

  test("permission shell pide aprobacion separada para publicar", async () => {
    const input: Record<string, unknown> = {
      action: "bash",
      resources: ["npm publish"],
      effect: "allow",
    };

    const result = await evaluatePermission(input, {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      env,
    });

    expect(result.effect).toBe("ask");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-INFRA-APPROVAL")).toBe(true);
  });

  test("permission media tools de despliegue sin depender de shell", async () => {
    const mcp = await evaluatePermission({
      action: "mcp_acme_deploy_prod",
      resources: [],
      effect: "allow",
    }, {
      cwd: repo,
      permissionRegistered: true,
      toolRegistered: true,
      env,
    });
    const custom = await evaluatePermission({
      action: "deploy_prod",
      resources: [],
      effect: "allow",
      source: { type: "tool", messageID: "msg_deploy", id: "call_deploy" },
    }, {
      cwd: repo,
      permissionRegistered: true,
      toolRegistered: true,
      env,
    });

    for (const result of [mcp, custom]) {
      expect(result.effect).toBe("ask");
      expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-INFRA-APPROVAL")).toBe(true);
    }
  });

  test("tool patch permite delete documental y bloquea update", async () => {
    writeSourceFixture("docs/security/operation-matrix.md", "# Documento de fixture");
    const options = {
      cwd: repo,
      permissionRegistered: true,
      shellRegistered: true,
      toolRegistered: true,
      env,
    };
    const directEdit = await evaluateToolHook({
      tool: "edit",
      input: { path: "docs/security/operation-matrix.md" },
    }, options);
    expect(directEdit.decision).toBe("deny");
    expect(directEdit.violations.some((violation) => violation.id === "MAL-HOOK-DOCS-EXTERNAL")).toBe(true);

    const deletion = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          "*** Delete File: docs/security/operation-matrix.md",
          "*** End Patch",
        ].join("\n"),
      },
    }, options);
    expect(deletion.decision).toBe("allow");

    const update = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: docs/security/operation-matrix.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
    }, options);
    expect(update.decision).toBe("deny");
    expect(update.violations.some((violation) => violation.id === "MAL-HOOK-DOCS-EXTERNAL")).toBe(true);
  });

  test("tool patch permite eliminar el unico hallazgo y agregar contenido neutral", async () => {
    const relativePath = "src/remediate-secret.ts";
    const assignment = detectedAssignment();
    writeSourceFixture(relativePath, assignment);

    const result = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${relativePath}`,
          "@@",
          `-${assignment}`,
          "+export const ready = true;",
          "*** End Patch",
        ].join("\n"),
      },
    }, toolHookOptions());

    expect(result.decision, JSON.stringify(result.violations)).toBe("allow");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
  });

  test("un hunk mal indentado da diagnóstico de contexto sin afirmar que hay secretos ni filtrar el patch", async () => {
    const relativePath = "src/misaligned.ts";
    const value = ["synthetic", "0123456789abcdef"].join("-");
    writeSourceFixture(relativePath, "  export const ready = true;");
    const result = await evaluateToolHook({
      tool: "patch",
      input: { patchText: [
        "*** Begin Patch", `*** Update File: ${relativePath}`, "@@",
        "- export const ready = true;", `+export const ready = '${value}';`, "*** End Patch",
      ].join("\n"), secretPatchSummary: { evaluable: true, files: [] } },
    }, toolHookOptions());
    const output = formatPluginBlock(result);
    const violation = pluginViolation(result, "MAL-HOOK-PATCH-UNEVALUABLE");

    expect(result.decision).toBe("deny");
    expect(violation?.diagnostic).toMatchObject({
      code: "PATCH_NOT_EVALUABLE", reason: "context-mismatch", operation: "update", path: relativePath,
    });
    expect(output).toMatch(/no se pudo evaluar.*contexto/is);
    expect(output).not.toMatch(/secretos detectados/i);
    expect(output).not.toContain(value);
    expect(fs.readFileSync(path.join(repo, relativePath), "utf8")).toBe("  export const ready = true;\n");
  });

  test("move, add existente, delete ausente y symlink conservan DENY sin revelar rutas externas", async () => {
    writeSourceFixture("src/fixture.ts", "export const ready = true;");
    const linked = path.join(repo, "src", "linked.ts");
    fs.symlinkSync(path.join(repo, "src", "fixture.ts"), linked);
    const patches = [
      ["*** Update File: src/fixture.ts", "*** Move to: src/moved.ts", "@@", "-export const ready = true;", "+export const ready = false;"],
      ["*** Add File: src/fixture.ts", "+export const ready = false;"],
      ["*** Delete File: src/missing.ts"],
      ["*** Update File: src/linked.ts", "@@", "-export const ready = true;", "+export const ready = false;"],
    ];
    for (const section of patches) {
      const result = await evaluateToolHook({
        tool: "patch", input: { patchText: ["*** Begin Patch", ...section, "*** End Patch"].join("\n") },
      }, toolHookOptions());
      expect(result.decision).toBe("deny");
      expect(pluginViolation(result, "MAL-HOOK-PATCH-UNEVALUABLE")).toBeDefined();
      expect(formatPluginBlock(result)).not.toContain(repo);
    }
  });

  test("postimagen con secreto real sigue en DENY; evidencia de preestado cambiada no se reutiliza", async () => {
    const relativePath = "src/credential.ts";
    const identifier = ["access", "token"].join("_");
    const value = ["production", "0123456789abcdef"].join("-");
    writeSourceFixture(relativePath, "export const ready = false;");
    const secretPatch = ["*** Begin Patch", `*** Update File: ${relativePath}`, "@@",
      "-export const ready = false;", `+export const ${identifier} = '${value}';`, "*** End Patch"].join("\n");
    const result = await evaluateToolHook({ tool: "patch", input: { patchText: secretPatch } }, toolHookOptions());
    expect(result.decision).toBe("deny");
    expect(pluginViolation(result, "MAL-HOOK-SECRETS")?.diagnostic?.code).toBe("SECRET_PRESENT");
    expect(formatPluginBlock(result)).not.toContain(value);

    const cleanPatch = secretPatch.replace(`+export const ${identifier} = '${value}';`, "+export const ready = true;");
    const summary = buildSecretPatchSummary(cleanPatch, repo);
    expect(summary.evaluable).toBe(true);
    expect(revalidateSecretPatchSummary(summary, repo)).toBe(true);
    writeSourceFixture(relativePath, "export const ready = false;\nexport const changed = true;");
    expect(revalidateSecretPatchSummary(summary, repo)).toBe(false);
    expect(fs.readFileSync(path.join(repo, relativePath), "utf8")).toContain("changed = true");
  });

  test("un patch con dos archivos deniega si uno introduce Bearer y no filtra el valor", async () => {
    const token = ["abcdefghijklmnopqrstuvwxyz", "12345678"].join("");
    writeSourceFixture("src/first.ts", "export const first = false;");
    writeSourceFixture("src/second.ts", "export const second = false;");
    const result = await evaluateToolHook({
      tool: "patch", input: { patchText: [
        "*** Begin Patch", "*** Update File: src/first.ts", "@@",
        "-export const first = false;", "+export const first = true;",
        "*** Update File: src/second.ts", "@@",
        "-export const second = false;", `+export const header = "Bearer ${token}";`, "*** End Patch",
      ].join("\n") },
    }, toolHookOptions());
    expect(result.decision).toBe("deny");
    expect(pluginViolation(result, "MAL-HOOK-SECRETS")?.diagnostic?.code).toBe("SECRET_PRESENT");
    expect(formatPluginBlock(result)).not.toContain(token);
    expect(fs.readFileSync(path.join(repo, "src/first.ts"), "utf8")).toContain("first = false");
    expect(fs.readFileSync(path.join(repo, "src/second.ts"), "utf8")).toContain("second = false");
  });

  // follow-up: clasificación DENY incremental
  test("un patch benigno que el parser no puede evaluar conserva fail-closed sin afirmar secreto", async () => {
    const relativePath = "src/benign-move.ts";
    const destination = "src/benign-moved.ts";
    writeSourceFixture(relativePath, "export const digest = 'sha256:before';");

    const result = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${relativePath}`,
          `*** Move to: ${destination}`,
          "@@",
          "-export const digest = 'sha256:before';",
          "+export const digest = 'sha256:after';",
          "*** End Patch",
        ].join("\n"),
      },
    }, toolHookOptions());
    const violation = pluginViolation(result, "MAL-HOOK-PATCH-UNEVALUABLE");
    const output = formatPluginBlock(result);

    expect(result.decision).toBe("deny");
    expect(violation).toBeDefined();
    expect(violation?.blockClass).toBe("control-unavailable");
    expect(result.violations.some((item) => item.id === "MAL-HOOK-SECRETS")).toBe(false);
    expect(result.violations.some((item) =>
      (item as HookViolation & { blockClass?: unknown }).blockClass === "hard-deny")).toBe(false);
    expect(output).toMatch(/control-unavailable/i);
    expect(output).not.toMatch(/(?:secreto|credencial).*(?:detectad|confirmad)|(?:detectad|confirmad).*(?:secreto|credencial)/i);
  });

  test("un patch evaluable con digest, proof y secretPatchSummary no crea un falso positivo", async () => {
    const relativePath = "src/signed-state.ts";
    writeSourceFixture(relativePath, "export const ready = false;");

    const result = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${relativePath}`,
          "@@",
          "-export const ready = false;",
          "+export const digest = 'sha256:fixture';",
          "+export const proof = 'signed-fixture';",
          "+export const secretPatchSummary = { evaluable: true };",
          "*** End Patch",
        ].join("\n"),
      },
    }, toolHookOptions());

    expect(result.decision, JSON.stringify(result.violations)).toBe("allow");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-PATCH-UNEVALUABLE")).toBe(false);
  });

  test("el adaptador entrega la receta saneada al mensaje visible de OpenCode", async () => {
    const relativePath = "tests/fixtures/redaction.test.ts";
    const identifier = ["api", "key"].join("_");
    const syntheticValue = ["synthetic", "0123456789abcdef"].join("-");
    writeSourceFixture(relativePath, `const redactionProbe = "${identifier}='${syntheticValue}'";`);

    const result = await evaluateToolHook({
      tool: "read",
      input: { filePath: path.join(repo, relativePath) },
    }, toolHookOptions());
    const output = formatPluginBlock(result);

    expect(result.decision).toBe("deny");
    expect(output).toMatch(/abre tests\/fixtures\/redaction\.test\.ts:1/i);
    expect(output).toMatch(/referencia saneada/i);
    expect(output).toMatch(/reemplaza esa linea o bloque completo/i);
    expect(output).toContain('["api", "key"].join("_")');
    expect(output).not.toContain(syntheticValue);
  });

  test("el adaptador conserva una receta segura para sintaxis de fixture compleja", async () => {
    const relativePath = "tests/fixtures/complex-redaction.test.ts";
    const identifier = ["secret", "key"].join("_");
    const syntheticValue = ["synthetic", "fedcba9876543210"].join("-");
    writeSourceFixture(
      relativePath,
      `const request = { header: "prefix ${identifier}='${syntheticValue}' suffix" };`,
    );

    const result = await evaluateToolHook({
      tool: "read",
      input: { filePath: path.join(repo, relativePath) },
    }, toolHookOptions());
    const output = formatPluginBlock(result);

    expect(result.decision).toBe("deny");
    expect(output).toMatch(/abre tests\/fixtures\/complex-redaction\.test\.ts:1/i);
    expect(output).toContain('["secret", "key"].join("_")');
    expect(output).toContain('"prefix "');
    expect(output).toContain("\"' suffix\"");
    expect(output).not.toContain(syntheticValue);
  });

  test("tool edit evalúa la postimagen y permite eliminar el único fixture sintético", async () => {
    const relativePath = "src/edit-remediate.ts";
    const assignment = detectedAssignment();
    writeSourceFixture(relativePath, assignment);

    const result = await evaluateToolHook({
      tool: "edit",
      input: {
        path: path.join(repo, relativePath),
        oldString: assignment,
        newString: "export const ready = true;",
      },
    }, toolHookOptions());

    expect(result.decision, JSON.stringify(result.violations)).toBe("allow");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
  });

  test("tool edit no evaluable distingue contexto de secreto", async () => {
    const relativePath = "src/edit-unevaluable.ts";
    writeSourceFixture(relativePath, "export const ready = true;");

    const result = await evaluateToolHook({
      tool: "edit",
      input: {
        path: path.join(repo, relativePath),
        oldString: "texto-que-no-existe",
        newString: "export const ready = false;",
      },
    }, toolHookOptions());

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-PATCH-UNEVALUABLE")).toBe(true);
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
  });

  test("tool write escanea la postimagen y deniega un secreto real", async () => {
    const relativePath = "src/write-secret.ts";
    const assignment = detectedAssignment();

    const result = await evaluateToolHook({
      tool: "write",
      input: { path: path.join(repo, relativePath), content: `${assignment}\n` },
    }, toolHookOptions());

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("tool write limpio crea el archivo sin un falso positivo", async () => {
    const relativePath = "src/write-clean.ts";

    const result = await evaluateToolHook({
      tool: "write",
      input: { path: path.join(repo, relativePath), content: "export const ready = true;\n" },
    }, toolHookOptions());

    expect(result.decision, JSON.stringify(result.violations)).toBe("allow");
  });

  test("tool patch deniega un cambio no relacionado que conserva el hallazgo", async () => {
    const relativePath = "src/unchanged-secret.ts";
    const assignment = detectedAssignment();
    writeSourceFixture(relativePath, [assignment, "export const previous = true;"].join("\n"));

    const result = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${relativePath}`,
          "@@",
          "-export const previous = true;",
          "+export const current = true;",
          "*** End Patch",
        ].join("\n"),
      },
    }, toolHookOptions());

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("tool patch deniega eliminar solo una de dos ocurrencias del mismo tipo", async () => {
    const relativePath = "src/partially-remediated-secret.ts";
    const firstAssignment = detectedAssignment();
    const secondIdentifier = ["access", "token"].join("_");
    const secondSyntheticValue = ["synthetic", "fedcba9876543210"].join("-");
    const secondAssignment = `export const ${secondIdentifier} = '${secondSyntheticValue}';`;
    writeSourceFixture(relativePath, [firstAssignment, secondAssignment].join("\n"));

    const result = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${relativePath}`,
          "@@",
          `-${firstAssignment}`,
          "+export const firstOccurrenceRemoved = true;",
          "*** End Patch",
        ].join("\n"),
      },
    }, toolHookOptions());

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("tool patch deniega introducir un hallazgo en un archivo limpio", async () => {
    const relativePath = "src/introduced-secret.ts";
    const assignment = detectedAssignment();
    writeSourceFixture(relativePath, "export const ready = false;");

    const result = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${relativePath}`,
          "@@",
          "-export const ready = false;",
          "+export const ready = true;",
          `+${assignment}`,
          "*** End Patch",
        ].join("\n"),
      },
    }, toolHookOptions());

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("tool patch no bloquea por secretos un Delete File exacto", async () => {
    const relativePath = "src/deleted-secret.ts";
    writeSourceFixture(relativePath, detectedAssignment());

    const result = await evaluateToolHook({
      tool: "patch",
      input: {
        patchText: [
          "*** Begin Patch",
          `*** Delete File: ${relativePath}`,
          "*** End Patch",
        ].join("\n"),
      },
    }, toolHookOptions());

    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(false);
  });

  test("tool generica no puede falsificar metadata de remediacion", async () => {
    const relativePath = "src/forged-remediation.ts";
    writeSourceFixture(relativePath, detectedAssignment());

    const result = await evaluateToolHook({
      tool: "mnemo_malahor_hook_check",
      input: {
        event: "file.write.before",
        resourceKind: "filesystem",
        paths: [relativePath],
        metadata: {
          fileOperations: [{ kind: "update", path: relativePath }],
          secretPatchSummary: {
            evaluable: true,
            before: { "credential-assignment": 1 },
            after: {},
          },
        },
      },
    }, toolHookOptions());

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
    expect(result.violations.flatMap((violation) => violation.remediations ?? [])
      .some((remediation) => remediation.kind === "replace-block")).toBe(false);
  });

  test("shell hook bloquea ejecucion indirecta y minimiza entorno", async () => {
    writeProjectPolicy({
      shell: {
        inspectIndirectExecution: true,
        minimizeEnvironment: true,
        denyCredentialEnv: true,
      },
    });

    const result = await evaluateShellHook({
      command: "bash -c 'echo hola'",
      cwd: repo,
      timeout: 10,
      shell: "/bin/bash",
      env: { PATH: "/usr/bin", HOME: "/tmp", MY_SECRET: "x", FOO: "bar", NODE_ENV: "test", NODE_OPTIONS: "--require /tmp/evil.js" },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-SHELL-INDIRECT")).toBe(true);
    expect(result.env.MY_SECRET).toBeUndefined();
    expect(result.env.FOO).toBeUndefined();
    expect(result.env.NODE_OPTIONS).toBeUndefined();
    expect(result.env.NODE_ENV).toBe("test");
    expect(result.env.PATH).toBe("/usr/bin");
  });

  test("shell hook carga la politica del cwd real de la operacion", async () => {
    writeProjectPolicy({
      shell: {
        deniedCommands: ["echo target-policy"],
      },
    });

    const result = await evaluateShellHook({
      command: "echo target-policy",
      cwd: repo,
      timeout: 10,
      shell: "/bin/bash",
      env: { PATH: process.env.PATH },
    }, {
      cwd: home,
      permissionRegistered: true,
      shellRegistered: true,
      resolveSessionDirectory: async () => { throw new Error("no debe consultarse"); },
      env,
    });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-SHELL-DENY")).toBe(true);

    const audit = fs.readFileSync(path.join(home, "audit", "security.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { project: string });
    expect(audit.at(-1)?.project).toBe("demo");
  });

  test("permission hook resuelve la ubicacion de la sesion en vez de la instancia", async () => {
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    const result = await evaluatePermission({
      sessionID: "ses_demo",
      action: "mcp_bad_search",
      resources: [],
      effect: "allow",
    }, {
      cwd: home,
      permissionRegistered: true,
      resolveSessionDirectory: async (sessionID) => sessionID === "ses_demo" ? repo : undefined,
      env,
    });

    expect(result.effect).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-MCP-ALLOWLIST")).toBe(true);
  });

  test("hooks usan afinidad canonica desde home y rechazan otra raiz registrada", async () => {
    const other = path.join(root, "other-repo");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "other" }));
    fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo },
      other: { context: "memory", roots: [other], defaultRoot: other },
    }));
    writeProjectPolicy({
      integrations: { enforceMcpToolAllowlist: true, allowedMcpTools: ["mcp_ok*"] },
    });
    const options = {
      cwd: home,
      permissionRegistered: true,
      shellRegistered: true,
      resolveSessionDirectory: async () => home,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
      env,
    };

    const permission = await evaluatePermission({
      sessionID: "ses_demo",
      action: "mcp_bad_search",
      resources: [],
      effect: "allow",
    }, options);
    expect(permission.effect).toBe("deny");

    const crossProject = await evaluateToolHook({
      sessionID: "ses_demo",
      tool: "read",
      input: { filePath: path.join(other, "package.json") },
    }, options);
    expect(crossProject.decision).toBe("deny");
    expect(crossProject.violations.some((violation) => violation.id === "MAL-HOOK-PLUGIN-POLICY")).toBe(true);

    const audit = fs.readFileSync(path.join(home, "audit", "security.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { project: string });
    expect(audit.at(-1)?.project).toBe("demo");
  });

  test("question sigue disponible para resolver una afinidad ambigua", async () => {
    const result = await evaluateToolHook({
      sessionID: "ses_ambiguous",
      tool: "question",
      input: { questions: [] },
    }, {
      cwd: home,
      permissionRegistered: true,
      shellRegistered: true,
      resolveSessionProject: async () => undefined,
      env,
    });
    expect(result.decision, JSON.stringify(result.violations)).toBe("allow");
  });

  test("un fallo al resolver la sesion deniega en vez de usar la instancia", async () => {
    const result = await evaluateToolHook({
      sessionID: "ses_missing",
      tool: "read",
      input: { filePath: path.join(repo, "package.json") },
    }, {
      cwd: home,
      permissionRegistered: true,
      shellRegistered: true,
      resolveSessionDirectory: async () => { throw new Error("session unavailable"); },
      env,
    });

    expect(result.decision).toBe("deny");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-PLUGIN-POLICY")).toBe(true);
  });

  test("un control git sin mediacion bloquea shell en vez de presumir cobertura", async () => {
    writeProjectPolicy({ git: { scanOutgoingCommits: true } });

    const result = await evaluateShellHook({
      command: "echo hola",
      cwd: repo,
      timeout: 10,
      env: { PATH: process.env.PATH },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-POLICY-GAP")).toBe(true);
  });

  test("shell hook escanea secretos staged antes de un commit", async () => {
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(git(["init", "-q"]).exitCode).toBe(0);
    const fakeKey = ["sk", "123456789012345678901234"].join("-");
    fs.writeFileSync(path.join(repo, ".env"), `API_KEY='${fakeKey}'\n`, "utf8");
    expect(git(["add", ".env"]).exitCode).toBe(0);

    const result = await evaluateShellHook({
      command: "git commit -m 'test commit'",
      cwd: repo,
      timeout: 10,
      env: { PATH: process.env.PATH },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.result.decision).toBe("deny");
    expect(result.result.violations.some((violation) => violation.id === "MAL-HOOK-SECRETS")).toBe(true);
  });

  test("Code Mode nativo, execute, Python y REPL permanecen en hard DENY", async () => {
    const options = { cwd: repo, permissionRegistered: true, shellRegistered: true, env };
    for (const name of ["code", "execute", "python", "repl"]) {
      const tool = await evaluateToolHook({ tool: name, input: { code: "..." } }, options);
      const permission = await evaluatePermission({
        action: name,
        resources: [],
        effect: "allow",
      }, options);

      expect(tool.decision, name).toBe("deny");
      expect(tool.violations.some((violation) => violation.id === "MAL-HOOK-CODE-MODE"), name).toBe(true);
      expect(permission.effect, name).toBe("deny");
    }
  });

  test("reconoce malahor_plan_control sin abrir tools desconocidas", async () => {
    writeProjectPolicy({ integrations: { blockUnapprovedIntegrations: true } });
    const options = { cwd: repo, permissionRegistered: true, shellRegistered: true, env };
    const control = await evaluateToolHook({
      tool: "malahor_plan_control",
      input: { action: "status" },
    }, options);
    const unknown = await evaluateToolHook({ tool: "malahor_unknown", input: {} }, options);

    expect(control.decision).toBe("allow");
    expect(unknown.decision).toBe("deny");
    expect(unknown.violations.some((violation) => violation.id === "MAL-HOOK-TOOL-UNKNOWN")).toBe(true);
  });

  test("reconoce la tool estructural de commit sin abrir tools desconocidas", async () => {
    writeProjectPolicy({ integrations: { blockUnapprovedIntegrations: true } });
    const options = { cwd: repo, permissionRegistered: true, shellRegistered: true, env };
    const managed = await evaluateToolHook({
      tool: "malahor_commit_prepare",
      input: { paths: ["src/a.ts"] },
    }, options);
    const short = await evaluateToolHook({ tool: "commit_prepare", input: {} }, options);

    expect(managed.decision).toBe("allow");
    expect(short.decision).toBe("allow");
    expect(managed.violations.some((violation) => violation.id === "MAL-HOOK-TOOL-UNKNOWN")).toBe(false);
  });

  test("tool hook pide aprobacion para rutas fuera de raices sin borrar el control", async () => {
    writeProjectPolicy({ files: { requireApprovalOutsideRoots: true } });

    const result = await evaluateToolHook({
      tool: "read",
      input: { filePath: "/etc/hosts" },
    }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(result.decision).toBe("ask");
    expect(result.violations.some((violation) => violation.id === "MAL-HOOK-FILE-ROOT")).toBe(true);
  });

  test("tool hook bloquea MCP fuera de allowlist", async () => {
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    const blocked = await evaluateToolHook({ tool: "mcp_bad", input: {} }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });
    const allowed = await evaluateToolHook({ tool: "mcp_ok_search", input: {} }, { cwd: repo, permissionRegistered: true, shellRegistered: true, env });

    expect(blocked.decision).toBe("deny");
    expect(blocked.violations.some((violation) => violation.id === "MAL-HOOK-MCP-ALLOWLIST")).toBe(true);
    expect(allowed.decision).toBe("allow");
  });

  test("sesion bloquea secretos antes de prompt/contexto", async () => {
    writeProjectPolicy({ persistence: { blockSecrets: true } });

    const result = await evaluateSessionHook("session.prompt.before", {
      prompt: { text: `${["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ")}\nabc` },
    }, { cwd: repo, permissionRegistered: true, env });

    expect(result.decision).toBe("deny");
    const violation = result.violations.find((candidate) => candidate.id === "MAL-HOOK-EGRESS-SECRET");
    expect(violation?.message).toContain("private-key");
    expect(violation?.message).not.toContain("abc");
  });

  test("plugin registra hooks V2 reales y setup devuelve cleanup", async () => {
    const calls: Array<{ domain: string; name: string; callback: (input: Record<string, unknown>) => Promise<void> | void }> = [];
    const disposed: string[] = [];
    const storageWrites: Array<{ key: string; value: Record<string, unknown> }> = [];
    const hook = (domain: string) => (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => {
      calls.push({ domain, name, callback });
      return { dispose: () => { disposed.push(`${domain}.${name}`); } };
    };
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "demo" }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo },
    })}\n`, "utf8");
    writeProjectPolicy({
      integrations: {
        enforceMcpToolAllowlist: true,
        allowedMcpTools: ["mcp_ok*"],
      },
    });

    try {
      const cleanup = await plugin.setup({
        location: { directory: home },
        session: {
          hook: hook("session"),
          get: async ({ sessionID }: { sessionID: string }) => ({
            id: sessionID,
            location: { directory: repo },
          }),
        },
        permission: { hook: hook("permission") },
        tool: { hook: hook("tool") },
        shell: { hook: hook("shell") },
        mcp: { transform: () => undefined },
        agent: { transform: () => undefined },
        command: { transform: () => undefined },
        skill: { transform: () => undefined },
        event: { subscribe: () => undefined },
        storage: {
          get: async (key: string) => storageWrites.find((entry) => entry.key === key)?.value,
          set: async (key: string, value: Record<string, unknown>) => { storageWrites.push({ key, value }); },
          remove: async () => undefined,
          scan: async () => ({ entries: [] }),
        },
      });

      expect(typeof cleanup).toBe("function");
      expect(calls.map((call) => `${call.domain}.${call.name}`)).toEqual(expect.arrayContaining([
        "permission.evaluate",
        "tool.execute.before",
        "shell.create.before",
        "session.prompt",
        "session.context",
        "session.http.request",
      ]));

      const permission = calls.find((call) => call.domain === "permission" && call.name === "evaluate");
      const input: Record<string, unknown> = {
        sessionID: "ses_demo",
        action: "mcp_bad_search",
        resources: [],
        effect: "allow",
      };
      await permission?.callback(input);
      expect(input.effect).toBe("deny");

      const audit = fs.readFileSync(path.join(home, "audit", "security.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { project: string });
      expect(audit.at(-1)?.project).toBe("demo");

      const contextHooks = calls.filter((call) => call.domain === "session" && call.name === "context");
      const contextInput: Record<string, unknown> = {
        sessionID: "ses_demo",
        system: [{ type: "text", text: "base" }],
      };
      for (const contextHook of contextHooks) await contextHook.callback(contextInput);
      for (const contextHook of contextHooks) await contextHook.callback(contextInput);
      const system = contextInput.system as Array<{ text: string }>;
      expect(system).toHaveLength(1);
      expect(system[0]?.text).toContain(MALAHOR_PROTOCOL_MARKER);
      expect(system[0]?.text).toContain("proyecto/asignación/HU/área");
      expect(system[0]?.text).toContain("recuerdos contradictorios en un mismo scope");

      const compactionHooks = calls.filter((call) => call.domain === "session" && call.name === "compaction");
      const compactionInput: Record<string, unknown> = {
        sessionID: "ses_demo",
        messages: [],
        system: [{ type: "text", text: "base" }],
      };
      await compactionHooks.at(-1)?.callback(compactionInput);
      expect(storageWrites.at(-1)?.key).toBe("compaction/ses_demo");
      expect((compactionInput.system as Array<{ text: string }>)[0]?.text).toContain(MALAHOR_COMPACTION_MARKER);

      const memoryAfterHooks = calls.filter((call) => call.domain === "tool" && call.name === "execute.after");
      await memoryAfterHooks.at(-1)?.callback({
        sessionID: "ses_demo",
        tool: "mcp_mnemo_mem_session_summary",
        status: "completed",
      });
      expect(storageWrites.some((entry) => entry.key === "memory/freshness/demo")).toBe(true);
      const pluginState = JSON.parse(fs.readFileSync(path.join(home, "plugin-state.json"), "utf8")) as {
        capabilities: Record<string, boolean>;
      };
      expect(pluginState.capabilities["planning.retention"]).toBe(true);
      expect(pluginState.capabilities["point-action.approval"]).toBe(false);

      await (cleanup as () => Promise<void>)();
      expect(disposed).toContain("permission.evaluate");
    } finally {
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });

  test("hook real media una edición puntual con un único ASK nativo y reutiliza el ASK del host", async () => {
    const sessionID = "ses_point_action_plugin";
    const hooks = new Map<string, (input: Record<string, unknown>) => Promise<void> | void>();
    const values = new Map<string, Record<string, unknown>>();
    const approvals: Record<string, unknown>[] = [];
    const register = (domain: string) => (
      name: string,
      callback: (input: Record<string, unknown>) => Promise<void> | void,
    ) => {
      hooks.set(`${domain}.${name}`, callback);
      return { dispose: () => { hooks.delete(`${domain}.${name}`); } };
    };
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo },
    })}\n`, "utf8");
    fs.writeFileSync(path.join(home, "config.jsonc"), `${JSON.stringify({
      execution: { intervention: "ejecutar", verification: true },
    })}\n`, "utf8");
    writeSourceFixture("src/point.ts", "export const point = 1;");
    const target = path.join(repo, "src", "point.ts");
    let cleanup: unknown;
    try {
      cleanup = await plugin.setup({
        location: { directory: repo },
        session: {
          hook: register("session"),
          get: async ({ sessionID: requested }: { sessionID: string }) => requested === sessionID
            ? { id: requested, location: { directory: repo } }
            : undefined,
        },
        permission: {
          hook: register("permission"),
          assert: async (request: Record<string, unknown>) => {
            approvals.push(structuredClone(request));
            const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
            await hooks.get("permission.evaluate")?.(nativeInput);
            expect(nativeInput.effect).toBe("ask");
          },
        },
        tool: {
          hook: register("tool"),
          transform: (callback: (editor: {
            namespace: (value: Record<string, unknown>) => void;
            add: (value: Record<string, unknown>) => void;
          }) => void) => callback({ namespace: () => undefined, add: () => undefined }),
        },
        shell: { hook: register("shell") },
        storage: {
          get: async (key: string) => values.get(key),
          set: async (key: string, value: Record<string, unknown>) => { values.set(key, structuredClone(value)); },
          remove: async (key: string) => { values.delete(key); },
          scan: async () => ({ entries: [] }),
        },
      });

      const firstSource = { type: "tool", messageID: "msg_point_first", id: "call_point_first" };
      const firstPermission: Record<string, unknown> = {
        sessionID,
        action: "edit",
        resources: [target],
        source: firstSource,
        effect: "allow",
      };
      await hooks.get("permission.evaluate")?.(firstPermission);
      expect(firstPermission.effect).toBe("allow");
      await hooks.get("tool.execute.before")?.({
        sessionID,
        agent: "malahor",
        messageID: firstSource.messageID,
        id: firstSource.id,
        tool: "write",
        input: { path: target, content: "export const point = 2;\n" },
      });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ action: "malahor_point_action_execute", save: [] });
      expect([...values.keys()].some((key) => key.startsWith("planning/v5/sessions/"))).toBe(false);

      await hooks.get("session.prompt")?.({ sessionID, prompt: { text: "actualiza el mismo archivo" } });
      const hostSource = { type: "tool", messageID: "msg_point_host", id: "call_point_host" };
      const hostPermission: Record<string, unknown> = {
        sessionID,
        action: "edit",
        resources: [target],
        source: hostSource,
        effect: "ask",
      };
      await hooks.get("permission.evaluate")?.(hostPermission);
      expect(hostPermission.effect).toBe("ask");
      await hooks.get("tool.execute.before")?.({
        sessionID,
        agent: "malahor",
        messageID: hostSource.messageID,
        id: hostSource.id,
        tool: "edit",
        input: { filePath: target, oldString: "point = 1", newString: "point = 3" },
      });
      expect(approvals).toHaveLength(1);
    } finally {
      if (typeof cleanup === "function") await cleanup();
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });

  test("hook de prompt y tool gestionada autorizan el commit exacto sin crear plan", async () => {
    const sessionID = "ses_structural_commit";
    const hooks = new Map<string, (input: Record<string, unknown>) => Promise<void> | void>();
    const definitions = new Map<string, Record<string, unknown>>();
    const values = new Map<string, Record<string, unknown>>();
    const approvals: Record<string, unknown>[] = [];
    const register = (domain: string) => (
      name: string,
      callback: (input: Record<string, unknown>) => Promise<void> | void,
    ) => {
      hooks.set(`${domain}.${name}`, callback);
      return { dispose: () => { hooks.delete(`${domain}.${name}`); } };
    };
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo },
    })}\n`, "utf8");
    fs.writeFileSync(path.join(home, "config.jsonc"), `${JSON.stringify({
      execution: { intervention: "ejecutar", verification: true },
    })}\n`, "utf8");
    writeSourceFixture("src/a.ts", "export const a = 1;");
    fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({
      name: "structural-commit-fixture",
      scripts: { typecheck: "tsc --noEmit", test: "bun test", build: "bun build src/a.ts --outdir dist" },
    })}\n`, "utf8");
    let cleanup: unknown;
    try {
      cleanup = await plugin.setup({
        location: { directory: repo },
        session: {
          hook: register("session"),
          get: async ({ sessionID: requested }: { sessionID: string }) => requested === sessionID
            ? { id: requested, location: { directory: repo } }
            : undefined,
        },
        permission: { hook: register("permission"), assert: async (request: Record<string, unknown>) => {
          approvals.push(structuredClone(request));
          const nativeInput: Record<string, unknown> = { ...request, effect: "allow" };
          await hooks.get("permission.evaluate")?.(nativeInput);
          expect(nativeInput.effect).toBe("ask");
        } },
        tool: {
          hook: register("tool"),
          transform: (callback: (editor: {
            namespace: (value: Record<string, unknown>) => void;
            add: (value: Record<string, unknown>) => void;
          }) => void) => callback({
            namespace: () => undefined,
            add: (definition) => { definitions.set(String(definition.name), definition); },
          }),
        },
        shell: { hook: register("shell") },
        storage: {
          get: async (key: string) => values.get(key),
          set: async (key: string, value: Record<string, unknown>) => { values.set(key, structuredClone(value)); },
          remove: async (key: string) => { values.delete(key); },
          scan: async () => ({ entries: [] }),
        },
      });

      await hooks.get("session.prompt")?.({
        sessionID,
        messageID: "msg_user_commit",
        prompt: { text: "comitea" },
      });
      const subject = "🐛 fix(git): corrige autorización";
      const definition = definitions.get("commit_prepare");
      expect(typeof definition?.execute).toBe("function");
      const execute = definition?.execute as (value: unknown, call: Record<string, string>) => Promise<unknown>;
      await execute({
        paths: ["src/a.ts"],
        subject,
        commands: {
          diagnostics: ["bun run typecheck"],
          tests: ["bun test"],
          build: ["bun run build"],
          stage: "git add -- src/a.ts",
          precommit: `malahor-ai git precommit --message '${subject}' --json`,
          commit: `git commit -m '${subject}'`,
          verify: ["git status --short --untracked-files=all", "git --no-pager log -1 --oneline"],
        },
      }, { sessionID, agent: "malahor", messageID: "msg_agent_commit", id: "call_prepare" });
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ action: "malahor_commit_manifest", save: [] });

      const command = "bun run typecheck";
      const permission: Record<string, unknown> = {
        sessionID,
        action: "bash",
        resources: [command],
        metadata: { command },
        source: { type: "tool", messageID: "msg_gate", id: "call_gate" },
        effect: "allow",
      };
      await hooks.get("tool.execute.before")?.({
        sessionID,
        agent: "malahor",
        messageID: "msg_gate",
        id: "call_gate",
        tool: "bash",
        input: { command, workdir: repo },
      });
      await hooks.get("permission.evaluate")?.(permission);
      expect(permission.effect, String(permission.message ?? "sin mensaje de rechazo")).toBe("allow");
      expect([...values.keys()].some((key) => key.startsWith("planning/v5/sessions/"))).toBe(false);

      await hooks.get("session.prompt")?.({ sessionID, prompt: { text: "continúa" } });
      const stale: Record<string, unknown> = {
        sessionID,
        action: "bash",
        resources: ["bun test"],
        metadata: { command: "bun test" },
        effect: "allow",
      };
      await hooks.get("permission.evaluate")?.(stale);
      expect(stale.effect).toBe("deny");
    } finally {
      if (typeof cleanup === "function") await cleanup();
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });

  test("hook real media una reparación de stage exacta una sola vez", async () => {
    const sessionID = "ses_stage_repair";
    const hooks = new Map<string, (input: Record<string, unknown>) => Promise<void> | void>();
    const definitions = new Map<string, Record<string, unknown>>();
    const values = new Map<string, Record<string, unknown>>();
    const approvals: Record<string, unknown>[] = [];
    const register = (domain: string) => (
      name: string,
      callback: (input: Record<string, unknown>) => Promise<void> | void,
    ) => {
      hooks.set(`${domain}.${name}`, callback);
      return { dispose: () => { hooks.delete(`${domain}.${name}`); } };
    };
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.writeFileSync(path.join(home, "projects.json"), `${JSON.stringify({
      demo: { context: "memory", roots: [repo], defaultRoot: repo },
    })}\n`, "utf8");
    fs.writeFileSync(path.join(home, "config.jsonc"), `${JSON.stringify({
      execution: { intervention: "ejecutar", verification: true },
    })}\n`, "utf8");
    writeSourceFixture("src/core/a.ts", "export const a = 1;");
    writeSourceFixture("src/core/b.ts", "export const b = 2;");
    writeSourceFixture("tests/fixture.test.ts", "// fixture");

    const approval = async (request: Record<string, unknown>) => {
      approvals.push(structuredClone(request));
      if (request.action !== "malahor_plan_repair") return;
      const nativeAsk: Record<string, unknown> = { ...request, effect: "allow" };
      await hooks.get("permission.evaluate")?.(nativeAsk);
      expect(nativeAsk.effect).toBe("ask");
      expect(String(nativeAsk.message)).toContain("misma revisión");
    };

    let cleanup: unknown;
    try {
      cleanup = await plugin.setup({
        location: { directory: repo },
        session: {
          hook: register("session"),
          get: async ({ sessionID: requested }: { sessionID: string }) => requested === sessionID
            ? { id: requested, location: { directory: repo } }
            : undefined,
        },
        permission: { hook: register("permission"), assert: approval },
        tool: {
          hook: register("tool"),
          transform: (callback: (editor: {
            namespace: (value: Record<string, unknown>) => void;
            add: (value: Record<string, unknown>) => void;
          }) => void) => callback({
            namespace: () => undefined,
            add: (definition) => { definitions.set(String(definition.name), definition); },
          }),
        },
        shell: { hook: register("shell") },
        storage: {
          get: async (key: string) => values.get(key),
          set: async (key: string, value: Record<string, unknown>) => { values.set(key, structuredClone(value)); },
          remove: async (key: string) => { values.delete(key); },
          scan: async () => ({ entries: [] }),
        },
      });

      const execute = (name: string) => {
        const candidate = definitions.get(name)?.execute;
        expect(typeof candidate).toBe("function");
        return candidate as (value: unknown, call: Record<string, string>) => Promise<unknown>;
      };
      await execute("task_classify")({
        schema: 1,
        understood: true,
        requestedEffect: "mutation",
        userRequestedPlanning: true,
        symptomOrCauseUnknown: false,
        signals: {
          specification: "high", discovery: "low", scope: "medium",
          openDecisions: "low", reversibility: "high", verifiability: "high",
        },
        closure: {
          action: "known", targets: "known", verification: "objective",
          discovery: "none", openDecisionCount: 0,
        },
        proof: {
          effect: "Repara la serialización exacta del stage sin ampliar recursos.",
          targets: "src/core y tests/fixture.test.ts",
          verification: "La prueba de reparación de stage termina con código cero.",
        },
      }, { sessionID, agent: "malahor", messageID: "msg_classify", id: "call_classify" });
      const plannedCommand = "git add -- src/core tests/fixture.test.ts";
      const actualCommand = "git add -- src/core/a.ts src/core/b.ts tests/fixture.test.ts";
      await execute("plan")({
        level: 1,
        specRef: SPEC_REF,
        specHash: SPEC_HASH,
        summary: "Reparar la serialización exacta del stage",
        steps: ["Autorizar el manifest exacto"],
        presentation: {
          objective: "Mantener la misma revisión para un stage equivalente.",
          outcome: "El manifest exacto queda autorizado una sola vez.",
          steps: [{ title: "Autorizar", description: "Validar igualdad o estrechamiento del manifest." }],
          impact: [{ area: "Planning", description: "Solo cambia la serialización técnica del stage." }],
          risk: { level: "medium", categories: [], summary: "Alcance cerrado.", details: "No añade recursos ni cwd." },
          exclusions: ["No ejecutar Git"],
          completionCriteria: ["El hook consume una sola reparación"],
        },
        actions: [{ action: "shell", resource: plannedCommand }],
      }, { sessionID, agent: "malahor", messageID: "msg_plan", id: "call_plan" });
      await execute("run")({}, { sessionID, agent: "malahor", messageID: "msg_run", id: "call_run" });

      const toolBefore = hooks.get("tool.execute.before");
      expect(typeof toolBefore).toBe("function");
      await toolBefore?.({
        sessionID,
        tool: "mnemo_malahor_hook_check",
        input: {
          event: "file.stage.before",
          command: actualCommand,
          paths: ["src/core/a.ts", "src/core/b.ts", "tests/fixture.test.ts"],
          resourceKind: "filesystem",
          intent: "commit",
        },
      });
      const source = { type: "tool", messageID: "msg_stage", id: "call_stage" };
      const permissionInput: Record<string, unknown> = {
        sessionID,
        action: "bash",
        resources: [actualCommand],
        metadata: { command: actualCommand },
        source,
        effect: "allow",
      };
      await hooks.get("permission.evaluate")?.(permissionInput);
      expect(permissionInput.effect).toBe("allow");

      const toolInput = {
        sessionID,
        agent: "malahor",
        messageID: source.messageID,
        id: source.id,
        tool: "bash",
        input: { command: actualCommand, workdir: repo },
      };
      await toolBefore?.(toolInput);

      const repairApprovals = approvals.filter((request) => request.action === "malahor_plan_repair");
      expect(repairApprovals).toHaveLength(1);
      expect((repairApprovals[0]?.resources as string[]).slice(-3)).toEqual([
        "src/core/a.ts",
        "src/core/b.ts",
        "tests/fixture.test.ts",
      ]);
      expect([...values.keys()].filter((key) => key.startsWith("planning/v5/attempts/"))).toHaveLength(1);

      await expect(Promise.resolve().then(() => toolBefore?.({ ...toolInput, id: "call_stage_repeat" })))
        .rejects.toMatchObject({ code: "ACTION_REPAIR_EXHAUSTED" });
      expect(approvals.filter((request) => request.action === "malahor_plan_repair")).toHaveLength(1);
    } finally {
      if (typeof cleanup === "function") await cleanup();
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });

  test("asset bundleado no importa el SDK de OpenCode y carga sin SDK", () => {
    const asset = path.join(import.meta.dir, "..", "assets", "opencode", "plugins", "malahor", "index.ts");
    const content = fs.readFileSync(asset, "utf8");
    expect(content.startsWith("// malahor-managed")).toBe(true);
    expect(content).not.toContain("@opencode-ai/plugin");
    expect(content).not.toContain("@opencode/plugin");

    const loaded = Bun.spawnSync([
      process.execPath,
      "-e",
      `import("${asset}").then((module) => console.log(typeof module.default.setup))`,
    ], {
      env: { ...process.env, MALAHOR_HOME: home, MALAHOR_OPENCODE_DIR: opencode },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(loaded.exitCode).toBe(0);
    expect(loaded.stdout.toString()).toContain("function");
  });

  test("ctx.mcp.transform registra Mnemo y docs, y conserva MCPs ajenos", async () => {
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.mkdirSync(path.join(home, "mnemo"), { recursive: true });
    fs.writeFileSync(path.join(home, "mnemo", "index.js"), "// mnemo\n", "utf8");

    const sets: Array<{ name: string; config: Record<string, unknown> }> = [];
    const transforms: Array<(editor: {
      get: (name: string) => Record<string, unknown> | undefined;
      set: (name: string, config: Record<string, unknown>) => void;
    }) => void> = [];
    const editorState: Record<string, Record<string, unknown>> = {
      foreign: { type: "local", command: ["node", "/tmp/foreign.js"] },
      obsidian: { type: "local", command: ["legacy-obsidian"] },
    };
    const disposed: string[] = [];

    try {
      const cleanup = await plugin.setup({
        location: { directory: repo },
        mcp: {
          transform: (callback: (editor: typeof transforms[number] extends (editor: infer T) => void ? T : never) => void) => {
            transforms.push(callback);
            const editor = {
              get: (name: string) => editorState[name],
              set: (name: string, config: Record<string, unknown>) => {
                editorState[name] = config;
                sets.push({ name, config });
              },
            };
            callback(editor);
            return { dispose: () => { disposed.push("mcp.transform"); } };
          },
        },
      });

      expect(transforms).toHaveLength(1);
      expect(sets.find((entry) => entry.name === "mnemo")?.config).toMatchObject({
        type: "local",
        command: ["node", path.join(home, "mnemo", "index.js")],
        disabled: false,
        codemode: false,
      });
      expect(sets.find((entry) => entry.name === "docs")?.config).toMatchObject({
        type: "local",
        command: ["node", path.join(home, "docs", "index.js")],
        disabled: false,
        codemode: false,
      });
      expect(sets.some((entry) => entry.name === "foreign")).toBe(false);
      expect(sets.some((entry) => entry.name === "obsidian")).toBe(false);

      await (cleanup as () => Promise<void>)();
      expect(disposed).toContain("mcp.transform");
    } finally {
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });

  test("ctx.mcp.transform no pisa Mnemo ajeno, registra docs y nunca gestiona Obsidian", async () => {
    const originalHome = process.env.MALAHOR_HOME;
    const originalOpenCodeDir = process.env.MALAHOR_OPENCODE_DIR;
    process.env.MALAHOR_HOME = home;
    process.env.MALAHOR_OPENCODE_DIR = opencode;
    fs.mkdirSync(path.join(home, "mnemo"), { recursive: true });
    fs.writeFileSync(path.join(home, "mnemo", "index.js"), "// mnemo\n", "utf8");
    fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
      demo: { context: "memory+codegraph+obsidian", roots: [repo], defaultRoot: repo },
    }));

    const sets: string[] = [];
    const state: Record<string, Record<string, unknown>> = {
      mnemo: { type: "local", command: ["node", "/tmp/other-mnemo.js"] },
      obsidian: { type: "remote", url: "https://obsidian.example/mcp", headers: { Authorization: "Bearer {env:OBSIDIAN_API_KEY}" } },
    };

    try {
      await plugin.setup({
        location: { directory: repo },
        mcp: {
          transform: (callback: (editor: {
            get: (name: string) => Record<string, unknown> | undefined;
            set: (name: string, config: Record<string, unknown>) => void;
          }) => void) => {
            callback({
              get: (name) => state[name],
              set: (name, config) => {
                state[name] = config;
                sets.push(name);
              },
            });
          },
        },
      });

      expect(sets).toEqual(["docs"]);
      expect(state.mnemo.command).toEqual(["node", "/tmp/other-mnemo.js"]);
      expect(state.docs).toMatchObject({
        type: "local",
        command: ["node", path.join(home, "docs", "index.js")],
        disabled: false,
        codemode: false,
      });
      expect(state.obsidian).toEqual({
        type: "remote",
        url: "https://obsidian.example/mcp",
        headers: { Authorization: "Bearer {env:OBSIDIAN_API_KEY}" },
      });
    } finally {
      if (originalHome === undefined) delete process.env.MALAHOR_HOME;
      else process.env.MALAHOR_HOME = originalHome;
      if (originalOpenCodeDir === undefined) delete process.env.MALAHOR_OPENCODE_DIR;
      else process.env.MALAHOR_OPENCODE_DIR = originalOpenCodeDir;
    }
  });
});
