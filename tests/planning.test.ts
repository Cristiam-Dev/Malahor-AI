import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { loadConfig, type MalahorIntervention, type MalahorMode } from "../src/cli/core/config";
import type { PluginAdapterOptions } from "../src/cli/core/hooks/plugin-adapter";
import { MODE_CHANGE_ACTION, previewModeChange } from "../src/cli/core/mode";
import {
  authorizePlan, planAllows, proposePlan, reviewPlan, validState,
  type PlanInput, type PlanScope, type PlanState,
} from "../src/cli/core/planning";
import plugin from "../src/plugin/index";
import {
  evaluatePlanningPermission, evaluatePlanningTool, injectPlanningInstructions, planKey,
  registerPlanningTools, type PlanningStorage, type PlanningTools,
} from "../src/plugin/planning";

const SESSION = "ses_planning_fixture";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");

let root: string;
let repo: string;
let otherRepo: string;
let home: string;
let env: NodeJS.ProcessEnv;
let options: PluginAdapterOptions;
let records: Map<string, unknown>;
let storage: PlanningStorage;
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-planning-"));
  repo = path.join(root, "demo");
  otherRepo = path.join(root, "other");
  home = path.join(root, "malahor-home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(otherRepo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, "opencode"), { recursive: true });
  fs.mkdirSync(path.join(root, "user"), { recursive: true });
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
    demo: { context: "memory", roots: [repo], defaultRoot: repo },
    other: { context: "memory", roots: [otherRepo], defaultRoot: otherRepo },
  }));
  env = {
    HOME: path.join(root, "user"),
    XDG_CONFIG_HOME: path.join(root, "user", ".config"),
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: path.join(home, "config.jsonc"),
    MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  };
  // plugin.setup usa process.env; incluso su estado diagnostico debe quedar en este fixture.
  const sandboxed = [...Object.keys(env), "MALAHOR_MODE", "MALAHOR_EXECUTION_INTERVENTION", "MALAHOR_EXECUTION_VERIFICATION"];
  previousEnv = Object.fromEntries(sandboxed.map((key) => [key, process.env[key]]));
  for (const key of sandboxed) delete process.env[key];
  Object.assign(process.env, env);
  configure("guiar");
  options = {
    cwd: repo,
    env,
    permissionRegistered: true,
    shellRegistered: true,
    resolveSessionDirectory: async (sessionID) => sessionID === SESSION ? repo : undefined,
  };
  records = new Map();
  storage = {
    get: async (key) => records.get(key),
    set: async (key, value) => { records.set(key, value); },
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function configure(intervention: MalahorIntervention, legacyMode?: MalahorMode): void {
  fs.writeFileSync(env.MALAHOR_CONFIG!, JSON.stringify({
    ...(legacyMode ? { mode: legacyMode } : {}), execution: { intervention, verification: true },
  }));
}

function configureLegacy(mode: MalahorMode): void {
  fs.writeFileSync(env.MALAHOR_CONFIG!, JSON.stringify({ mode, execution: { verification: true } }));
}

function scope(mode: MalahorMode = "assistant"): PlanScope {
  return { sessionID: SESSION, project: "demo", mode, policyRevision: loadConfig(env, repo).execution.revision };
}

function input(action: "edit" | "shell" | "subagent" = "edit"): PlanInput {
  return {
    summary: "Cambiar una ruta del fixture",
    steps: ["Presentar plan", "Cambiar solo lo declarado"],
    actions: [{ action, resource: action === "edit" ? path.join(repo, "file.ts") : action === "shell" ? "echo fixture" : "malahor-testing" }],
  };
}

function authorized(mode: "assistant" | "executor" = "assistant", now = Date.now()): PlanState {
  const plan = proposePlan(scope(mode), input(), now);
  return authorizePlan(mode === "assistant" ? reviewPlan(plan, plan.digest, now) : plan, plan.digest, now);
}

function call(sessionID = SESSION, agent = "malahor") {
  return { sessionID, agent, messageID: "msg_fixture", id: "tool_fixture" };
}

async function registeredTools(onApproval?: (request: ApprovalRequest) => Promise<void> | void) {
  const definitions = new Map<string, Record<string, unknown>>();
  const approvals: ApprovalRequest[] = [];
  const tools: PlanningTools = {
    transform: async (callback) => {
      callback({
        namespace: (entry) => { expect(entry.name).toBe("malahor"); },
        add: (entry) => { definitions.set(entry.name as string, entry); },
      });
      return { dispose: () => { definitions.clear(); } };
    },
  };
  const port = {
    assert: async (request: ApprovalRequest) => {
      approvals.push(request);
      await onApproval?.(request);
    },
  };
  const registration = await registerPlanningTools(tools, port, storage, options);
  const execute = async (name: "plan" | "run", value: unknown, context = call()) => {
    const definition = definitions.get(name);
    if (!definition || typeof definition.execute !== "function") throw new Error(`Tool ${name} no registrada`);
    return (definition.execute as (value: unknown, context: ReturnType<typeof call>) => Promise<{ content: string }>)(value, context);
  };
  return { approvals, definitions, execute, registration };
}

type ApprovalRequest = {
  sessionID: string;
  agent: string;
  source: { type: "tool"; messageID: string; id: string };
  action: string;
  resources: string[];
  save: string[];
};

describe("configuracion: intervention es el unico modo efectivo", () => {
  test("acompanar, guiar y ejecutar derivan advisor, assistant y executor aunque mode legacy discrepe", () => {
    for (const [intervention, mode, legacy] of [
      ["acompanar", "advisor", "executor"],
      ["guiar", "assistant", "advisor"],
      ["ejecutar", "executor", "assistant"],
    ] as const) {
      configure(intervention, legacy);
      const config = loadConfig(env, repo);
      expect(config.execution.intervention).toBe(intervention);
      expect(config.mode).toBe(mode);
      expect(config.execution.verification).toBe(intervention !== "acompanar");
    }
  });

  test("mode legacy solo es fallback cuando intervention falta; el entorno prevalece si es explicito", () => {
    for (const [legacy, intervention] of [
      ["advisor", "acompanar"], ["assistant", "guiar"], ["executor", "ejecutar"],
    ] as const) {
      configureLegacy(legacy);
      expect(loadConfig(env, repo).execution.intervention).toBe(intervention);
      expect(loadConfig(env, repo).mode).toBe(legacy);
    }
    configureLegacy("advisor");
    env.MALAHOR_EXECUTION_INTERVENTION = "ejecutar";
    expect(loadConfig(env, repo).mode).toBe("executor");
  });
});

describe("nucleo: transiciones y binding del plan", () => {
  test("asesor presenta concepto sin pasos ni ejecucion", () => {
    const plan = proposePlan(scope("advisor"), { summary: "Alternativas", steps: [], actions: [] }, NOW);
    expect(validState(plan)).toBe(true);
    expect(() => reviewPlan(plan, plan.digest, NOW)).toThrow();
    expect(() => authorizePlan(plan, plan.digest, NOW)).toThrow();
    expect(planAllows({ ...plan, authorizedAt: NOW }, scope("advisor"), { action: "shell", resource: "echo fixture" }, NOW)).toBe(false);
    expect(() => proposePlan(scope("advisor"), input(), NOW)).toThrow();
  });

  test("asistente exige revision antes de autorizacion; revision no ejecuta", () => {
    const plan = proposePlan(scope(), input(), NOW);
    const operation = input().actions[0]!;
    expect(planAllows(plan, scope(), operation, NOW)).toBe(false);
    expect(() => authorizePlan(plan, plan.digest, NOW)).toThrow();
    const reviewed = reviewPlan(plan, plan.digest, NOW + 1);
    expect(planAllows(reviewed, scope(), operation, NOW + 1)).toBe(false);
    expect(() => reviewPlan(reviewed, plan.digest, NOW + 2)).toThrow();
    const active = authorizePlan(reviewed, plan.digest, NOW + 2);
    expect(planAllows(active, scope(), operation, NOW + 2)).toBe(true);
    expect(() => authorizePlan(active, plan.digest, NOW + 3)).toThrow();
  });

  test("ejecutor presenta y autoriza con una sola orden; nunca requiere revision", () => {
    const plan = proposePlan(scope("executor"), input("shell"), NOW);
    expect(() => reviewPlan(plan, plan.digest, NOW)).toThrow();
    expect(planAllows(plan, scope("executor"), input("shell").actions[0]!, NOW)).toBe(false);
    expect(planAllows(authorizePlan(plan, plan.digest, NOW), scope("executor"), input("shell").actions[0]!, NOW)).toBe(true);
  });

  test("acciones canonicas sin duplicados; hash ligado a revision, pasos, recursos y scope", () => {
    const base = input();
    const first = proposePlan(scope(), { ...base, actions: [base.actions[0]!, { action: "shell", resource: "echo fixture" }] }, NOW);
    const reordered = proposePlan(scope(), { ...base, actions: [
      { action: "shell", resource: "echo fixture" }, base.actions[0]!, base.actions[0]!,
    ] }, NOW);
    expect(first.plan).toEqual(reordered.plan);
    expect(first.digest).not.toBe(reordered.digest);
    expect(first.plan.actions).toHaveLength(2);
    expect(proposePlan(scope(), { ...base, steps: ["Distinto"] }, NOW).digest).not.toBe(first.digest);
    expect(proposePlan(scope(), { ...base, actions: [{ action: "edit", resource: path.join(repo, "other.ts") }] }, NOW).digest).not.toBe(first.digest);
    expect(proposePlan({ ...scope(), project: "other" }, base, NOW).digest).not.toBe(first.digest);
    expect(proposePlan({ ...scope(), sessionID: "ses_other" }, base, NOW).digest).not.toBe(first.digest);
    expect(proposePlan(scope("executor"), base, NOW).digest).not.toBe(first.digest);
    expect(proposePlan({ ...scope(), policyRevision: "b".repeat(32) }, base, NOW).digest).not.toBe(first.digest);
  });

  test("rechaza entradas incompletas y acciones sin recurso exacto", () => {
    expect(() => proposePlan({ ...scope(), sessionID: "" }, input(), NOW)).toThrow();
    expect(() => proposePlan({ ...scope(), policyRevision: "invalid" }, input(), NOW)).toThrow();
    expect(() => proposePlan(scope(), { ...input(), steps: [] }, NOW)).toThrow();
    expect(() => proposePlan(scope(), { ...input(), actions: [{ action: "unknown", resource: "*" }] }, NOW)).toThrow();
    expect(() => proposePlan(scope(), { ...input(), actions: [{ action: "edit", resource: "" }] }, NOW)).toThrow();
  });

  test("el hash anterior, la caducidad exacta y cualquier recurso no previsto cierran acceso", () => {
    const presented = proposePlan(scope(), input(), NOW);
    const active = authorizePlan(reviewPlan(presented, presented.digest, NOW), presented.digest, NOW);
    const operation = input().actions[0]!;
    expect(() => reviewPlan(active, "0".repeat(64), NOW)).toThrow();
    expect(planAllows(active, scope(), operation, active.expiresAt - 1)).toBe(true);
    expect(planAllows(active, scope(), operation, active.expiresAt)).toBe(false);
    expect(() => authorizePlan(reviewPlan(presented, presented.digest, NOW), presented.digest, active.expiresAt)).toThrow();
    expect(planAllows(active, scope(), { ...operation, resource: path.join(repo, "other.ts") }, NOW)).toBe(false);
    expect(planAllows(active, scope(), { action: "shell", resource: operation.resource }, NOW)).toBe(false);
    expect(planAllows(active, { ...scope(), sessionID: "ses_other" }, operation, NOW)).toBe(false);
    expect(planAllows(active, { ...scope(), project: "other" }, operation, NOW)).toBe(false);
    expect(planAllows(active, scope("executor"), operation, NOW)).toBe(false);
    expect(planAllows(active, { ...scope(), policyRevision: "b".repeat(32) }, operation, NOW)).toBe(false);
  });

  test("estado adulterado o no canónico nunca autoriza operaciones", () => {
    const active = authorized("assistant", NOW);
    const operation = input().actions[0]!;
    const variants: unknown[] = [null, {},
      { ...active, digest: "f".repeat(64) },
      { ...active, version: 2 },
      { ...active, policyRevision: "b".repeat(32) },
      { ...active, expiresAt: active.createdAt + 31 * 60_000 },
      { ...active, plan: { ...active.plan, actions: [{ ...operation, resource: path.join(repo, "other.ts") }] } },
    ];
    for (const variant of variants) {
      expect(validState(variant)).toBe(false);
      expect(planAllows(variant, scope(), operation, NOW)).toBe(false);
    }
  });

  test("un authorizedAt inyectado sin revision no equivale a una orden autenticada", () => {
    const presented = proposePlan(scope(), input(), NOW);
    const forged = { ...presented, authorizedAt: NOW };
    expect(planAllows(forged, scope(), presented.plan.actions[0]!, NOW)).toBe(false);
  });
});

describe("adaptador: solicitudes de permiso y segunda frontera", () => {
  test("el cambio de modo siempre pide confirmacion nativa sin exponer la version interna", async () => {
    const preview = previewModeChange("ejecutar", env, repo);
    const resources = [preview.configFile, preview.current, preview.target];
    const request = { sessionID: SESSION, action: MODE_CHANGE_ACTION, resources, effect: "allow" } as Record<string, unknown>;
    await evaluatePlanningPermission(request, options, storage);
    expect(request.effect).toBe("ask");
    expect(request.message).toContain("asistente -> ejecutor");
    expect(resources).not.toContain(preview.version);
    expect(String(request.message)).not.toContain(preview.version);

    const denied = { ...request, effect: "deny" };
    await evaluatePlanningPermission(denied, options, storage);
    expect(denied.effect).toBe("deny");
    const stale = { ...request, effect: "allow", resources: [preview.configFile, "asesor", preview.target] };
    await evaluatePlanningPermission(stale, options, storage);
    expect(stale.effect).toBe("deny");
  });

  test("confirmaciones vinculadas al hash siempre son ask; hash ajeno, orden inverso y deny del host no se rebajan", async () => {
    const plan = proposePlan(scope(), input(), Date.now());
    records.set(planKey(SESSION), plan);
    const review = { sessionID: SESSION, action: "malahor_plan_review", resources: [plan.digest], effect: "allow" } as Record<string, unknown>;
    await evaluatePlanningPermission(review, options, storage);
    expect(review.effect).toBe("ask");
    expect(review.message).toContain(plan.digest.slice(0, 12));

    const denied = { ...review, effect: "deny" };
    await evaluatePlanningPermission(denied, options, storage);
    expect(denied.effect).toBe("deny");
    const wrong = { ...review, effect: "allow", resources: ["0".repeat(64)] };
    await evaluatePlanningPermission(wrong, options, storage);
    expect(wrong.effect).toBe("deny");
    const earlyRun = { sessionID: SESSION, action: "malahor_plan_run", resources: [plan.digest], effect: "allow" };
    await evaluatePlanningPermission(earlyRun, options, storage);
    expect(earlyRun.effect).toBe("deny");

    records.set(planKey(SESSION), reviewPlan(plan, plan.digest));
    const run = { ...earlyRun, effect: "allow" };
    await evaluatePlanningPermission(run, options, storage);
    expect(run.effect).toBe("ask");
    expect(run.message).toContain(plan.digest.slice(0, 12));
    const hostDenied = { ...run, effect: "deny" };
    await evaluatePlanningPermission(hostDenied, options, storage);
    expect(hostDenied.effect).toBe("deny");
  });

  test("ejecutor solo pide run; asesor, plan vencido y sesion sin resolver no obtienen ask", async () => {
    configure("ejecutar");
    const plan = proposePlan(scope("executor"), input(), Date.now());
    records.set(planKey(SESSION), plan);
    const request: Record<string, unknown> = { sessionID: SESSION, action: "malahor_plan_run", resources: [plan.digest], effect: "allow" };
    await evaluatePlanningPermission(request, options, storage);
    expect(request.effect).toBe("ask");
    for (const invalid of [
      { ...request, action: "malahor_plan_review", effect: "allow" },
      { ...request, sessionID: "ses_missing", effect: "allow" },
    ]) {
      await evaluatePlanningPermission(invalid, options, storage);
      expect(invalid.effect).toBe("deny");
    }
    records.set(planKey(SESSION), proposePlan(scope("executor"), input(), Date.now() - 31 * 60_000));
    const expired = { ...request, effect: "allow", resources: [(records.get(planKey(SESSION)) as PlanState).digest] };
    await evaluatePlanningPermission(expired, options, storage);
    expect(expired.effect).toBe("deny");
    configure("acompanar");
    const concept = proposePlan(scope("advisor"), { summary: "Idea", steps: [], actions: [] });
    records.set(planKey(SESSION), concept);
    const advisor = { ...request, effect: "allow", resources: [concept.digest] };
    await evaluatePlanningPermission(advisor, options, storage);
    expect(advisor.effect).toBe("deny");
  });

  test("permission y tool niegan recursos extra, herramientas desconocidas y estado adulterado", async () => {
    records.set(planKey(SESSION), authorized());
    const edit = path.join(repo, "file.ts");
    const permission = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" } as Record<string, unknown>;
    await evaluatePlanningPermission(permission, options, storage);
    expect(permission.effect).toBe("allow");
    await evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage);
    for (const extra of [path.join(repo, "other.ts"), path.join(otherRepo, "file.ts")]) {
      const attempt = { ...permission, resources: [edit, extra] };
      await evaluatePlanningPermission(attempt, options, storage);
      expect(attempt.effect).toBe("deny");
      expect(evaluatePlanningTool({ sessionID: SESSION, tool: "patch", input: { patchText: `*** Begin Patch\n*** Update File: ${edit}\n*** Update File: ${extra}\n*** End Patch` } }, options, storage)).rejects.toThrow();
    }
    const unknown = { ...permission, action: "unclassified_tool" };
    await evaluatePlanningPermission(unknown, options, storage);
    expect(unknown.effect).toBe("deny");
    expect(evaluatePlanningTool({ sessionID: SESSION, tool: "unclassified_tool", input: {} }, options, storage)).rejects.toThrow();
    const active = records.get(planKey(SESSION)) as PlanState;
    records.set(planKey(SESSION), { ...active, plan: { ...active.plan, actions: [{ action: "edit", resource: path.join(repo, "other.ts") }] } });
    const altered = { ...permission, effect: "allow" };
    await evaluatePlanningPermission(altered, options, storage);
    expect(altered.effect).toBe("deny");
    expect(evaluatePlanningTool({ sessionID: SESSION, tool: "edit", input: { path: edit } }, options, storage)).rejects.toThrow();
  });

  test("permission y tool tampoco aceptan authorizedAt añadido a un plan solo presentado", async () => {
    const presented = proposePlan(scope(), input());
    records.set(planKey(SESSION), { ...presented, authorizedAt: Date.now() });
    const target = path.join(repo, "file.ts");
    const permission = { sessionID: SESSION, action: "edit", resources: [target], effect: "allow" };
    await evaluatePlanningPermission(permission, options, storage);
    expect(permission.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: target } }, options, storage)).rejects.toThrow();
  });

  test("comandos y subagentes deben coincidir exactamente en permission y tool", async () => {
    for (const [action, tool, key, resource] of [
      ["shell", "shell", "command", "echo fixture"],
      ["subagent", "task", "agent", "malahor-testing"],
    ] as const) {
      const presented = proposePlan(scope(), input(action));
      records.set(planKey(SESSION), authorizePlan(reviewPlan(presented, presented.digest), presented.digest));
      const allowed = { sessionID: SESSION, action, resources: [resource], effect: "allow" } as Record<string, unknown>;
      await evaluatePlanningPermission(allowed, options, storage);
      expect(allowed.effect).toBe("allow");
      await evaluatePlanningTool({ sessionID: SESSION, tool, input: { [key]: resource } }, options, storage);
      const changed = action === "shell" ? "echo other" : "malahor-diagnostico";
      const wrong = { ...allowed, effect: "allow", resources: [changed] };
      await evaluatePlanningPermission(wrong, options, storage);
      expect(wrong.effect).toBe("deny");
      expect(evaluatePlanningTool({ sessionID: SESSION, tool, input: { [key]: changed } }, options, storage)).rejects.toThrow();
    }
  });

  test("permission normaliza bash, write, patch y task sin ampliar los recursos del plan", async () => {
    const planned = proposePlan(scope(), { ...input(), actions: [
      input().actions[0]!, input("shell").actions[0]!, input("subagent").actions[0]!,
    ] });
    records.set(planKey(SESSION), authorizePlan(reviewPlan(planned, planned.digest), planned.digest));
    for (const [action, resource, different] of [
      ["bash", "echo fixture", "echo other"],
      ["write", "file.ts", "other.ts"],
      ["patch", "file.ts", "other.ts"],
      ["task", "malahor-testing", "malahor-diagnostico"],
    ] as const) {
      const allowed = { sessionID: SESSION, action, resources: [resource], effect: "allow" };
      await evaluatePlanningPermission(allowed, options, storage);
      expect(allowed.effect).toBe("allow");
      const denied = { ...allowed, resources: [different], effect: "allow" };
      await evaluatePlanningPermission(denied, options, storage);
      expect(denied.effect).toBe("deny");
    }
  });

  test("asesor no usa read, glob ni grep en ninguna frontera", async () => {
    configure("acompanar");
    for (const [tool, resource] of [
      ["read", path.join(repo, "file.ts")], ["glob", "**/*.ts"], ["grep", "fixture"],
    ] as const) {
      const permission = { sessionID: SESSION, action: tool, resources: [resource], effect: "allow" };
      await evaluatePlanningPermission(permission, options, storage);
      expect(permission.effect).toBe("deny");
      await expect(evaluatePlanningTool({ sessionID: SESSION, tool, input: { path: resource } }, options, storage)).rejects.toThrow(/asesor/);
    }
  });

  test("shell y bash no aceptan workdir distinto aunque el comando este aprobado", async () => {
    const planned = proposePlan(scope(), input("shell"));
    records.set(planKey(SESSION), authorizePlan(reviewPlan(planned, planned.digest), planned.digest));
    for (const tool of ["shell", "bash"] as const) {
      await evaluatePlanningTool({ sessionID: SESSION, tool, input: { command: "echo fixture", workdir: repo } }, options, storage);
      for (const workdir of [otherRepo, path.join(repo, "src")]) {
        await expect(evaluatePlanningTool({ sessionID: SESSION, tool, input: { command: "echo fixture", workdir } }, options, storage)).rejects.toThrow(/plan/);
      }
    }
  });

  test("shell rechaza cwd local combinado con workdir ajeno", async () => {
    const planned = proposePlan(scope(), input("shell"));
    records.set(planKey(SESSION), authorizePlan(reviewPlan(planned, planned.digest), planned.digest));
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "shell", input: {
      command: "echo fixture", cwd: repo, workdir: otherRepo,
    } }, options, storage)).rejects.toThrow(/plan/);
  });

  test("solo el especialista gestionado con parentID directo y delegacion aprobada hereda edit/shell", async () => {
    const child = "ses_managed_child";
    const grandchild = "ses_managed_grandchild";
    const thirdParty = "ses_third_party";
    const foreignProject = "ses_foreign_project";
    const unrelated = "ses_unrelated";
    const delegatedOptions: PluginAdapterOptions = {
      ...options,
      resolveSessionDirectory: async (sessionID) =>
        sessionID === foreignProject ? otherRepo
          : [SESSION, child, grandchild, thirdParty, unrelated].includes(sessionID) ? repo : undefined,
      resolveParentSession: async (sessionID) => ({
        [child]: { parentID: SESSION, agent: "malahor-testing" },
        [grandchild]: { parentID: child, agent: "malahor-testing" },
        [thirdParty]: { parentID: SESSION, agent: "third-party" },
        [foreignProject]: { parentID: SESSION, agent: "malahor-testing" },
      })[sessionID],
    };
    const approved = proposePlan(scope(), input("subagent"));
    records.set(planKey(SESSION), authorizePlan(reviewPlan(approved, approved.digest), approved.digest));
    const edit = path.join(repo, "specialist.ts");
    for (const [action, tool, value] of [
      ["edit", "write", { path: edit }],
      ["shell", "shell", { command: "echo fixture specialist" }],
    ] as const) {
      const resource = action === "edit" ? edit : "echo fixture specialist";
      const permitted = { sessionID: child, action, resources: [resource], effect: "allow" };
      await evaluatePlanningPermission(permitted, delegatedOptions, storage);
      expect(permitted.effect).toBe("allow");
      await evaluatePlanningTool({ sessionID: child, tool, input: value }, delegatedOptions, storage);
      for (const sessionID of [grandchild, thirdParty, foreignProject, unrelated]) {
        const denied = { sessionID, action, resources: [resource], effect: "allow" };
        await evaluatePlanningPermission(denied, delegatedOptions, storage);
        expect(denied.effect).toBe("deny");
        await expect(evaluatePlanningTool({ sessionID, tool, input: value }, delegatedOptions, storage)).rejects.toThrow();
      }
    }
    const nestedDelegation = { sessionID: child, action: "subagent", resources: ["malahor-testing"], effect: "allow" };
    await evaluatePlanningPermission(nestedDelegation, delegatedOptions, storage);
    expect(nestedDelegation.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: child, tool: "task", input: { agent: "malahor-testing" } }, delegatedOptions, storage)).rejects.toThrow();

    records.set(planKey(SESSION), proposePlan(scope(), input("edit")));
    const revoked = { sessionID: child, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(revoked, delegatedOptions, storage);
    expect(revoked.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: child, tool: "write", input: { path: edit } }, delegatedOptions, storage)).rejects.toThrow();

    records.set(planKey(SESSION), proposePlan(scope(), input("subagent"), Date.now() - 31 * 60_000));
    const expired = { ...revoked, effect: "allow" };
    await evaluatePlanningPermission(expired, delegatedOptions, storage);
    expect(expired.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: child, tool: "write", input: { path: edit } }, delegatedOptions, storage)).rejects.toThrow();
  });

  test("storage ausente/fallido, sesion/proyecto/modo distinto y cambio de intervention cierran ambas fronteras", async () => {
    records.set(planKey(SESSION), authorized());
    const operation = { sessionID: SESSION, action: "edit", resources: [path.join(repo, "file.ts")], effect: "allow" };
    const tool = { sessionID: SESSION, tool: "edit", input: { path: path.join(repo, "file.ts") } };
    const unavailable: PlanningStorage = { get: async () => { throw new Error("storage unavailable"); }, set: storage.set };
    for (const [adapter, store] of [
      [options, undefined],
      [options, unavailable],
      [{ ...options, resolveSessionDirectory: undefined }, storage],
      [{ ...options, resolveSessionDirectory: async () => otherRepo }, storage],
    ] as const) {
      const attempt = { ...operation, effect: "allow" };
      await evaluatePlanningPermission(attempt, adapter, store);
      expect(attempt.effect).toBe("deny");
      expect(evaluatePlanningTool(tool, adapter, store)).rejects.toThrow();
    }
    for (const intervention of ["acompanar", "ejecutar"] as const) {
      configure(intervention);
      const attempt = { ...operation, effect: "allow" };
      await evaluatePlanningPermission(attempt, options, storage);
      expect(attempt.effect).toBe("deny");
      expect(evaluatePlanningTool(tool, options, storage)).rejects.toThrow();
    }
    expect(() => planKey("not-a-session")).toThrow();
  });

  test("mode assistant legado con intervention ejecutar exige plan executor en ambas fronteras", async () => {
    records.set(planKey(SESSION), authorized("assistant"));
    configure("ejecutar", "assistant");
    expect(loadConfig(env, repo).mode).toBe("executor");
    const edit = path.join(repo, "file.ts");
    const tool = { sessionID: SESSION, tool: "write", input: { path: edit } };
    const mismatched = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(mismatched, options, storage);
    expect(mismatched.effect).toBe("deny");
    await expect(evaluatePlanningTool(tool, options, storage)).rejects.toThrow();

    records.set(planKey(SESSION), authorized("executor"));
    const allowed = { ...mismatched, effect: "allow" };
    await evaluatePlanningPermission(allowed, options, storage);
    expect(allowed.effect).toBe("allow");
    await evaluatePlanningTool(tool, options, storage);
  });
});


describe("tools registradas y flujo sin APIs host reales", () => {
  test("plan grande pero con campos individuales validos se rechaza antes de storage y UI", async () => {
    const oversized = { ...input(), steps: Array.from({ length: 18 }, (_, index) => `Paso ${index}: ${"x".repeat(800)}`) };
    expect(oversized.steps).toHaveLength(18);
    expect(oversized.steps.every((step) => step.length < 1000)).toBe(true);
    expect(JSON.stringify(oversized).length).toBeGreaterThan(12_000);
    expect(() => proposePlan(scope(), oversized)).toThrow(/demasiado grande/);
    const saves: PlanState[] = [];
    const save = storage.set;
    storage.set = async (key, value) => { saves.push(value); await save(key, value); };
    const harness = await registeredTools();
    for (const intervention of ["guiar", "ejecutar"] as const) {
      configure(intervention);
      await expect(harness.execute("plan", oversized)).rejects.toThrow(/demasiado grande/);
      expect(saves).toHaveLength(0);
      expect(records.size).toBe(0);
      expect(harness.approvals).toHaveLength(0);
    }
  });

  test("asistente solicita revision y orden separadas con hash, sin autorizar en la primera", async () => {
    expect(loadConfig(env, repo).mode).toBe("assistant");
    expect(loadConfig(env, repo).execution.intervention).toBe("guiar");
    const phases: Array<{ action: string; state?: PlanState }> = [];
    const harness = await registeredTools((request) => {
      phases.push({ action: request.action, state: records.get(planKey(SESSION)) as PlanState });
    });
    expect([...harness.definitions.keys()]).toEqual(["plan", "run"]);
    expect(harness.definitions.get("plan")?.options).toMatchObject({ namespace: "malahor", codemode: false });
    await harness.execute("plan", input());
    const presented = records.get(planKey(SESSION)) as PlanState;
    expect(presented.reviewedAt).toBeNumber();
    expect(presented.authorizedAt).toBeUndefined();
    expect(phases[0]?.state?.reviewedAt).toBeUndefined();
    expect(phases[0]?.state?.authorizedAt).toBeUndefined();
    const edit = path.join(repo, "file.ts");
    const beforeRun = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(beforeRun, options, storage);
    expect(beforeRun.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage)).rejects.toThrow();
    await harness.execute("run", { digest: presented.digest });
    expect(phases[1]?.state?.authorizedAt).toBeUndefined();
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeNumber();
    expect(harness.approvals.map((request) => request.action)).toEqual(["malahor_plan_review", "malahor_plan_run"]);
    const afterRun = { ...beforeRun, effect: "allow" };
    await evaluatePlanningPermission(afterRun, options, storage);
    expect(afterRun.effect).toBe("allow");
    await evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage);
    for (const request of harness.approvals) {
      expect(request).toEqual({ sessionID: SESSION, agent: "malahor", source: { type: "tool", messageID: "msg_fixture", id: "tool_fixture" }, action: request.action, resources: [presented.digest], save: [] });
    }
    await expect(harness.execute("run", { digest: presented.digest })).rejects.toThrow();
    if (harness.registration) await harness.registration.dispose?.();
  });

  test("ejecutor solicita una orden; asesor no solicita ninguna ni puede ejecutar", async () => {
    configure("ejecutar");
    expect(loadConfig(env, repo).mode).toBe("executor");
    const harness = await registeredTools();
    await harness.execute("plan", input());
    const executor = records.get(planKey(SESSION)) as PlanState;
    expect(executor.reviewedAt).toBeUndefined();
    expect(harness.approvals).toHaveLength(0);
    const edit = path.join(repo, "file.ts");
    const beforeRun = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(beforeRun, options, storage);
    expect(beforeRun.effect).toBe("deny");
    await harness.execute("run", { digest: executor.digest });
    expect(harness.approvals.map((item) => [item.action, item.resources])).toEqual([["malahor_plan_run", [executor.digest]]]);
    const afterRun = { ...beforeRun, effect: "allow" };
    await evaluatePlanningPermission(afterRun, options, storage);
    expect(afterRun.effect).toBe("allow");
    await evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage);
    configure("acompanar");
    expect(loadConfig(env, repo).mode).toBe("advisor");
    const withOldApproval = { ...afterRun, effect: "allow" };
    await evaluatePlanningPermission(withOldApproval, options, storage);
    expect(withOldApproval.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage)).rejects.toThrow();
    await harness.execute("plan", { summary: "Concepto", steps: [], actions: [] });
    expect(harness.approvals).toHaveLength(1);
    const concept = records.get(planKey(SESSION)) as PlanState;
    await expect(harness.execute("run", { digest: concept.digest })).rejects.toThrow();
    await expect(harness.execute("plan", input())).rejects.toThrow();
    const advisor = { ...afterRun, effect: "allow" };
    await evaluatePlanningPermission(advisor, options, storage);
    expect(advisor.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage)).rejects.toThrow();
  });

  test("reemplazo de plan revoca autorizacion anterior y rehace confirmaciones", async () => {
    const harness = await registeredTools();
    await harness.execute("plan", input());
    const old = records.get(planKey(SESSION)) as PlanState;
    await harness.execute("run", { digest: old.digest });
    await harness.execute("plan", { ...input(), summary: "Nueva version" });
    const next = records.get(planKey(SESSION)) as PlanState;
    expect(next.digest).not.toBe(old.digest);
    expect(next.authorizedAt).toBeUndefined();
    expect(harness.approvals.map((item) => item.action)).toEqual(["malahor_plan_review", "malahor_plan_run", "malahor_plan_review"]);
    await expect(harness.execute("run", { digest: old.digest })).rejects.toThrow();
    const permission = { sessionID: SESSION, action: "edit", resources: [path.join(repo, "file.ts")], effect: "allow" };
    await evaluatePlanningPermission(permission, options, storage);
    expect(permission.effect).toBe("deny");
  });

  test("re-presentar un plan identico revoca permisos y una orden en vuelo no sobrevive al cambio de revision", async () => {
    let replaceDuringRun = false;
    const harness = await registeredTools((request) => {
      if (replaceDuringRun && request.action === "malahor_plan_run") {
        const current = records.get(planKey(SESSION)) as PlanState;
        const replacement = proposePlan(scope(), input());
        expect(replacement.digest).not.toBe(current.digest);
        expect(replacement.revision).not.toBe(current.revision);
        records.set(planKey(SESSION), replacement);
      }
    });
    await harness.execute("plan", input());
    const first = records.get(planKey(SESSION)) as PlanState;
    await harness.execute("run", { digest: first.digest });
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeNumber();

    await harness.execute("plan", input());
    const second = records.get(planKey(SESSION)) as PlanState;
    expect(second.plan).toEqual(first.plan);
    expect(second.digest).not.toBe(first.digest);
    expect(second.revision).not.toBe(first.revision);
    expect(second.reviewedAt).toBeNumber();
    expect(second.authorizedAt).toBeUndefined();
    const edit = path.join(repo, "file.ts");
    const previouslyAllowed = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(previouslyAllowed, options, storage);
    expect(previouslyAllowed.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage)).rejects.toThrow();

    await expect(harness.execute("run", { digest: first.digest })).rejects.toThrow();
    replaceDuringRun = true;
    await expect(harness.execute("run", { digest: second.digest })).rejects.toThrow(/cambio/);
    const third = records.get(planKey(SESSION)) as PlanState;
    expect(third.digest).not.toBe(first.digest);
    expect(third.revision).not.toBe(second.revision);
    expect(third.authorizedAt).toBeUndefined();
    expect(harness.approvals.map((request) => request.action)).toEqual([
      "malahor_plan_review", "malahor_plan_run", "malahor_plan_review", "malahor_plan_run",
    ]);
  });

  test("run y nueva presentacion concurrentes en la misma sesion no resucitan la autorizacion previa", async () => {
    let runStarted!: () => void;
    let releaseRun!: () => void;
    const started = new Promise<void>((resolve) => { runStarted = resolve; });
    const pending = new Promise<void>((resolve) => { releaseRun = resolve; });
    const harness = await registeredTools(async (request) => {
      if (request.action === "malahor_plan_run") {
        runStarted();
        await pending;
      }
    });
    const presented = proposePlan(scope(), input());
    records.set(planKey(SESSION), reviewPlan(presented, presented.digest));
    const running = harness.execute("run", { digest: presented.digest });
    await started;
    const replacing = harness.execute("plan", input());
    releaseRun();
    await Promise.all([running, replacing]);

    const replacement = records.get(planKey(SESSION)) as PlanState;
    expect(replacement.plan).toEqual(presented.plan);
    expect(replacement.digest).not.toBe(presented.digest);
    expect(replacement.authorizedAt).toBeUndefined();
    expect(planAllows(replacement, scope(), input().actions[0]!)).toBe(false);
    await expect(harness.execute("run", { digest: presented.digest })).rejects.toThrow();
    const permission = { sessionID: SESSION, action: "edit", resources: [path.join(repo, "file.ts")], effect: "allow" };
    await evaluatePlanningPermission(permission, options, storage);
    expect(permission.effect).toBe("deny");
  });

  test("deny del host conserva exactamente el plan presentado/revisado sin autorizarlo", async () => {
    const stateAtDeny: PlanState[] = [];
    const denied = await registeredTools(() => {
      stateAtDeny.push(structuredClone(records.get(planKey(SESSION)) as PlanState));
      throw new Error("host denied");
    });
    await expect(denied.execute("plan", input())).rejects.toThrow("host denied");
    expect(records.get(planKey(SESSION))).toEqual(stateAtDeny[0]);
    expect(stateAtDeny[0]?.reviewedAt).toBeUndefined();
    expect(stateAtDeny[0]?.authorizedAt).toBeUndefined();

    const presentedForRun = proposePlan(scope(), input());
    const reviewed = reviewPlan(presentedForRun, presentedForRun.digest);
    records.set(planKey(SESSION), reviewed);
    await expect(denied.execute("run", { digest: presentedForRun.digest })).rejects.toThrow("host denied");
    expect(records.get(planKey(SESSION))).toEqual(reviewed);
    expect(records.get(planKey(SESSION))).toEqual(stateAtDeny[1]);
    expect(reviewed.authorizedAt).toBeUndefined();

    configure("ejecutar");
    const executor = proposePlan(scope("executor"), input());
    records.set(planKey(SESSION), executor);
    await expect(denied.execute("run", { digest: executor.digest })).rejects.toThrow("host denied");
    expect(records.get(planKey(SESSION))).toEqual(executor);
    expect(records.get(planKey(SESSION))).toEqual(stateAtDeny[2]);
    expect(executor.authorizedAt).toBeUndefined();
  });

  test("un plan cambiado durante la confirmacion no persiste autorizacion", async () => {
    const changed = await registeredTools((request) => {
      if (request.action === "malahor_plan_review" || request.action === "malahor_plan_run") {
        const current = records.get(planKey(SESSION)) as PlanState;
        records.set(planKey(SESSION), proposePlan(scope(), { ...input(), summary: "Revision concurrente" }, current.createdAt + 1));
      }
    });
    await expect(changed.execute("plan", input())).rejects.toThrow(/cambio/);
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeUndefined();

    const presented = proposePlan(scope(), input());
    records.set(planKey(SESSION), reviewPlan(presented, presented.digest));
    await expect(changed.execute("run", { digest: (records.get(planKey(SESSION)) as PlanState).digest })).rejects.toThrow(/cambio/);
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeUndefined();
  });

  test("run rechaza estado vencido antes de pedir confirmacion al host", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    const stale = proposePlan(scope("executor"), input(), Date.now() - 31 * 60_000);
    records.set(planKey(SESSION), stale);
    await expect(harness.execute("run", { digest: stale.digest })).rejects.toThrow();
    expect(harness.approvals).toHaveLength(0);
  });

  test("cambiar intervention tras revisar revoca el plan antes de la segunda confirmacion", async () => {
    const harness = await registeredTools();
    await harness.execute("plan", input());
    const state = records.get(planKey(SESSION)) as PlanState;
    expect(harness.approvals.map((item) => item.action)).toEqual(["malahor_plan_review"]);
    for (const intervention of ["acompanar", "ejecutar"] as const) {
      configure(intervention);
      await expect(harness.execute("run", { digest: state.digest })).rejects.toThrow();
      expect(harness.approvals.map((item) => item.action)).toEqual(["malahor_plan_review"]);
      expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeUndefined();
    }
  });

  test("solo primario con sesion/proyecto registrado presenta o solicita plan", async () => {
    const harness = await registeredTools();
    for (const wrong of [call(SESSION, "malahor-testing"), call("ses_missing"), call("not-a-session")]) {
      await expect(harness.execute("plan", input(), wrong)).rejects.toThrow();
      await expect(harness.execute("run", { digest: "0".repeat(64) }, wrong)).rejects.toThrow();
    }
    expect(harness.approvals).toHaveLength(0);
    expect(records.size).toBe(0);
  });

  test("instrucciones al primario son idempotentes y fallan cerrado sin sesion/storage", async () => {
    const instructions: Record<string, unknown> = { sessionID: SESSION, agent: "malahor", system: [{ type: "text", text: "base" }] };
    await injectPlanningInstructions(instructions, options, storage);
    await injectPlanningInstructions(instructions, options, storage);
    expect((instructions.system as Array<{ text: string }>)[0]?.text.match(/malahor-planning:v1/g)).toHaveLength(1);
    const absent: Record<string, unknown> = { sessionID: SESSION, agent: "malahor", system: [] };
    await injectPlanningInstructions(absent, options);
    expect((absent.system as Array<{ text: string }>)[0]?.text).toContain("no ejecutes");
    configure("acompanar");
    const advisor: Record<string, unknown> = { sessionID: SESSION, agent: "malahor", system: [] };
    await injectPlanningInstructions(advisor, options, storage);
    expect((advisor.system as Array<{ text: string }>)[0]?.text).toContain("sin pasos");
    const specialist: Record<string, unknown> = { sessionID: SESSION, agent: "malahor-testing", system: [] };
    await injectPlanningInstructions(specialist, options, storage);
    expect(specialist.system).toEqual([]);
  });

  test("plugin V2 registra tools y hooks con un host estructural sintético, sin instalacion", async () => {
    const hooks = new Map<string, (input: Record<string, unknown>) => Promise<void> | void>();
    const definitions: string[] = [];
    const registration = (domain: string) => (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => {
      hooks.set(`${domain}.${name}`, callback);
      return { dispose: () => { hooks.delete(`${domain}.${name}`); } };
    };
    const cleanup = await plugin.setup({
      location: { directory: repo },
      session: { hook: registration("session"), get: async ({ sessionID }: { sessionID: string }) =>
        sessionID === SESSION ? { location: { directory: repo } } : undefined },
      permission: { hook: registration("permission"), assert: async () => undefined },
      tool: { hook: registration("tool"), transform: (callback: (editor: {
        namespace: (value: { name: string }) => void;
        add: (value: { name: string }) => void;
      }) => void) => {
        callback({ namespace: (item) => { expect(item.name).toBe("malahor"); }, add: (item) => { definitions.push(item.name); } });
      } },
      shell: { hook: registration("shell") },
      storage,
    });
    try {
      expect(definitions).toEqual(["plan", "run"]);
      expect(hooks.has("permission.evaluate")).toBe(true);
      expect(hooks.has("tool.execute.before")).toBe(true);
      expect(hooks.has("shell.create.before")).toBe(true);
      const modePreview = previewModeChange("ejecutar", env, repo);
      const modePermission: Record<string, unknown> = {
        sessionID: SESSION,
        action: MODE_CHANGE_ACTION,
        resources: [modePreview.configFile, modePreview.current, modePreview.target],
        effect: "allow",
      };
      await hooks.get("permission.evaluate")?.(modePermission);
      expect(modePermission.effect).toBe("ask");
      const blocked: Record<string, unknown> = { sessionID: SESSION, action: "edit", resources: [path.join(repo, "file.ts")], effect: "allow" };
      await hooks.get("permission.evaluate")?.(blocked);
      expect(blocked.effect).toBe("deny");
      await expect(Promise.resolve().then(() => hooks.get("tool.execute.before")?.({ sessionID: SESSION, tool: "edit", input: { path: path.join(repo, "file.ts") } }))).rejects.toThrow();
      await hooks.get("shell.create.before")?.({ command: "echo fixture", cwd: repo, shell: "/bin/sh", env: {}, timeout: 30 });
      expect(fs.existsSync(path.join(home, "plugin-state.json"))).toBe(true);
    } finally {
      if (typeof cleanup === "function") await cleanup();
    }
  });

  test("plugin no registra tools si faltan storage o resolucion de sesion", async () => {
    for (const missing of ["storage", "session"] as const) {
      const hooks = new Map<string, (input: Record<string, unknown>) => Promise<void> | void>();
      let toolRegistrations = 0;
      const hook = (domain: string) => (name: string, callback: (input: Record<string, unknown>) => Promise<void> | void) => {
        hooks.set(`${domain}.${name}`, callback);
      };
      const cleanup = await plugin.setup({
        location: { directory: repo },
        session: {
          hook: hook("session"),
          ...(missing === "storage" ? { get: async () => ({ location: { directory: repo } }) } : {}),
        },
        permission: { hook: hook("permission"), assert: async () => undefined },
        tool: { hook: hook("tool"), transform: () => { toolRegistrations++; } },
        shell: { hook: hook("shell") },
        ...(missing === "session" ? { storage } : {}),
      });
      try {
        expect(toolRegistrations).toBe(0);
        const attempt: Record<string, unknown> = {
          sessionID: SESSION, action: "edit", resources: [path.join(repo, "file.ts")], effect: "allow",
        };
        await hooks.get("permission.evaluate")?.(attempt);
        expect(attempt.effect).toBe("deny");
        await expect(Promise.resolve().then(() => hooks.get("tool.execute.before")?.({
          sessionID: SESSION, tool: "edit", input: { path: path.join(repo, "file.ts") },
        }))).rejects.toThrow();
      } finally {
        if (typeof cleanup === "function") await cleanup();
      }
    }
  });
});
