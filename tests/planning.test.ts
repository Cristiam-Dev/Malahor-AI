import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { loadConfig, type MalahorIntervention, type MalahorMode } from "../src/cli/core/config";
import type { PluginAdapterOptions } from "../src/cli/core/hooks/plugin-adapter";
import { MODE_CHANGE_ACTION, previewModeChange } from "../src/cli/core/mode";
import type { PlanningAuthority } from "../src/cli/core/planning-authority";
import {
  authorizePlan, controlPlan, planAllows, presentPlan, proposePlan, renderPlan, requestPlanExecution, reviewPlan, validState,
  type PlanInput, type PlanningAdapter, type PlanScope, type PlanState,
} from "../src/cli/core/planning";
import plugin from "../src/plugin/index";
import {
  evaluatePlanningPermission, evaluatePlanningTool, injectPlanningInstructions, planKey, planRecordKey,
  planRevisionKey, readPlan, registerPlanningTools, resolvePlanningScope, type PlanningStorage, type PlanningTools,
} from "../src/plugin/planning";
import { MALAHOR_RUNTIME_PROTOCOL } from "../src/plugin/protocol";

const SESSION = "ses_planning_fixture";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const PLAN_MESSAGE = "msg_plan_fixture";
const RUN_MESSAGE = "msg_run_fixture";
const PRESENTATION_ID_FIELDS = [
  "presentationMessageID", "presentedMessageID", "presentationInteractionID", "presentationID", "messageID", "interactionID",
] as const;

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
    level: 1,
    summary: "Cambiar una ruta del fixture",
    steps: ["Presentar plan", "Cambiar solo lo declarado"],
    presentation: {
      objective: "Cambiar exclusivamente la ruta declarada por el plan.",
      outcome: "La ruta queda actualizada y verificada sin ampliar el alcance autorizado.",
      steps: [
        {
          title: "Presentar el plan",
          description: "Mostrar una vista breve antes de pedir cualquier aprobación.",
        },
        {
          title: "Cambiar solo lo declarado",
          description: "Ejecutar únicamente la acción y el recurso del anexo técnico.",
        },
      ],
      impact: [{ area: "Código", description: "Solo cambia la ruta declarada en acciones." }],
      risk: {
        level: "low",
        categories: [],
        summary: "Cambio acotado al fixture.",
        details: "La autorización conserva exactamente el recurso declarado.",
      },
      exclusions: ["Cualquier otro archivo, comando o subagente"],
      completionCriteria: ["La accion declarada queda verificada sin ampliar el alcance"],
    },
    actions: [{ action, resource: action === "edit" ? path.join(repo, "file.ts") : action === "shell" ? "echo fixture" : "malahor-testing" }],
  };
}

function levelZeroInput(action: "edit" | "shell" | "subagent" = "edit"): PlanInput {
  const base = input(action);
  return {
    ...base,
    level: 0,
    steps: ["Ejecutar el cambio puntual"],
    presentation: {
      ...base.presentation,
      steps: [],
      impact: [],
      exclusions: [base.presentation.exclusions[0]!],
      completionCriteria: [base.presentation.completionCriteria[0]!],
    },
    dependencies: [],
  };
}

function conceptInput(summary = "Alternativas"): PlanInput {
  return {
    level: 1,
    summary,
    steps: [],
    presentation: {
      objective: summary,
      outcome: "Las alternativas quedan comparadas sin ejecutar cambios.",
      steps: [],
      impact: [],
      risk: {
        level: "low",
        categories: [],
        summary: "Análisis conceptual sin efectos ejecutables.",
        details: "No se modifican recursos ni permisos.",
      },
      exclusions: ["No se ejecutaran acciones ni se modificaran recursos"],
      completionCriteria: ["Las alternativas y sus implicaciones quedan explicadas"],
    },
    actions: [],
  };
}

const FOREGROUND_START = "<!-- malahor-plan-foreground:start -->";
const FOREGROUND_END = "<!-- malahor-plan-foreground:end -->";

function foregroundMarkdown(content: string): string {
  expect(content.split(FOREGROUND_START)).toHaveLength(2);
  expect(content.split(FOREGROUND_END)).toHaveLength(2);
  const start = content.indexOf(FOREGROUND_START) + FOREGROUND_START.length;
  const end = content.indexOf(FOREGROUND_END);
  expect(start).toBeGreaterThan(FOREGROUND_START.length - 1);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end).trim();
}

function expectProgressiveDisclosureContract(text: string): void {
  expect(text).toMatch(/(?:divulgaci[oó]n progresiva|resumen[\s\S]{0,240}anexo t[eé]cnico)/i);
  expect(text).toContain("/malahor-plan detalles");
  expect(text).toMatch(
    /(?:riesgo alto|categor[ií]a(?:s)? cr[ií]tica(?:s)?)[\s\S]{0,400}(?:riesgos?|consecuencias?|controles?)[\s\S]{0,180}visible/i,
  );
  expect(text).toMatch(/(?:comandos|rutas|identidad|digest)[\s\S]{0,260}(?:solo|[uú]nicamente)[\s\S]{0,180}\/malahor-plan detalles/i);
}

function expectLevelZeroContract(text: string): void {
  expect(text).toMatch(/nivel 0[\s\S]{0,500}plan (?:mínimo|minimo)/i);
  expect(text).toMatch(/plan (?:mínimo|minimo)[\s\S]{0,500}\bgo\b/i);
  expect(text).toMatch(/nivel 0[\s\S]{0,500}(?:sin|no usa)[\s\S]{0,160}(?:Discovery|SDD)/i);
  expect(text).toMatch(/commit[\s\S]{0,700}(?:status|diff)[\s\S]{0,300}(?:test|pruebas)[\s\S]{0,300}build/i);
}

function authorized(mode: "assistant" | "executor" = "assistant", now = Date.now()): PlanState {
  const plan = proposePlan(scope(mode), input(), now);
  return authorizePlan(mode === "assistant" ? reviewPlan(plan, plan.digest, now) : plan, plan.digest, now);
}

function call(sessionID = SESSION, agent = "malahor", messageID = PLAN_MESSAGE) {
  return { sessionID, agent, messageID, id: `tool_${messageID}` };
}

function presentationIdentity(state: PlanState): unknown {
  const record = state as unknown as Record<string, unknown>;
  const field = PRESENTATION_ID_FIELDS.find((candidate) => candidate in record);
  if (field) return record[field];
  const presentation = record.presentation;
  if (presentation && typeof presentation === "object" && !Array.isArray(presentation)) {
    const nested = presentation as Record<string, unknown>;
    return nested.messageID ?? nested.interactionID ?? nested.id;
  }
  return presentation;
}

function tamperPresentationIdentity(state: PlanState): unknown {
  const record = state as unknown as Record<string, unknown>;
  const field = PRESENTATION_ID_FIELDS.find((candidate) => candidate in record);
  if (field) return { ...record, [field]: "msg_tampered" };
  if (record.presentation && typeof record.presentation === "object" && !Array.isArray(record.presentation)) {
    const presentation = record.presentation as Record<string, unknown>;
    const nested = ["messageID", "interactionID", "id"].find((candidate) => candidate in presentation) ?? "messageID";
    return { ...record, presentation: { ...presentation, [nested]: "msg_tampered" } };
  }
  if ("presentation" in record) return { ...record, presentation: "msg_tampered" };
  return { ...record, presentationMessageID: "msg_tampered" };
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
  const execute = async (name: "plan" | "run" | "plan_control", value: unknown, context = call()) => {
    const definition = definitions.get(name);
    if (!definition || typeof definition.execute !== "function") throw new Error(`Tool ${name} no registrada`);
    return (definition.execute as (value: unknown, context: ReturnType<typeof call>) => Promise<{
      content: string;
      metadata?: { planID?: string; revision?: string; digest?: string; phase?: string };
    }>)(value, context);
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
    const plan = proposePlan(scope("advisor"), conceptInput(), NOW);
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

  test("nivel 0 queda firmado, exige go y rechaza ampliar el trabajo trivial", () => {
    const simple = levelZeroInput();
    const plan = proposePlan(scope("executor"), simple, NOW);
    const operation = simple.actions[0]!;
    expect(plan.plan.level).toBe(0);
    expect(plan.plan.presentation.steps).toEqual([]);
    expect(plan.plan.presentation.impact).toEqual([]);
    expect(validState(plan)).toBe(true);
    expect(planAllows(plan, scope("executor"), operation, NOW)).toBe(false);
    expect(planAllows(authorizePlan(plan, plan.digest, NOW), scope("executor"), operation, NOW)).toBe(true);

    const invalid: PlanInput[] = [
      { ...simple, presentation: { ...simple.presentation, risk: { ...simple.presentation.risk, level: "medium" } } },
      { ...simple, presentation: { ...simple.presentation, risk: { ...simple.presentation.risk, categories: ["architecture"] } } },
      { ...simple, dependencies: [{ planID: "a".repeat(32), revision: "b".repeat(32) }] },
      { ...levelZeroInput("subagent") },
      { ...simple, actions: [operation, { action: "edit", resource: path.join(repo, "other.ts") }] },
      { ...simple, steps: ["Uno", "Dos", "Tres", "Cuatro"] },
      { ...simple, presentation: { ...simple.presentation, steps: [
        { title: "Primero", description: "Primer paso todavía breve." },
        { title: "Segundo", description: "Segundo paso todavía breve." },
        { title: "Tercero", description: "El tercer paso ya exige nivel superior." },
      ] } },
    ];
    for (const candidate of invalid) expect(() => proposePlan(scope("executor"), candidate, NOW)).toThrow(/nivel 0/i);

    expect(validState({ ...plan, plan: { ...plan.plan, level: 1 } })).toBe(false);
    const { level: _level, ...legacyInput } = input();
    const legacy = proposePlan(scope("executor"), legacyInput, NOW);
    expect(legacy.plan.level).toBeUndefined();
    expect(validState(legacy)).toBe(true);
  });

  test("acciones canonicas sin duplicados; hash ligado a resultado, impacto, riesgo, recursos y scope", () => {
    const base = input();
    const first = proposePlan(scope(), { ...base, actions: [base.actions[0]!, { action: "shell", resource: "echo fixture" }] }, NOW);
    const reordered = proposePlan(scope(), { ...base, actions: [
      { action: "shell", resource: "echo fixture" }, base.actions[0]!, base.actions[0]!,
    ] }, NOW);
    expect(first.plan).toEqual(reordered.plan);
    expect(first.digest).not.toBe(reordered.digest);
    expect(first.plan.actions).toHaveLength(2);
    expect(first.plan.presentation).toEqual(base.presentation);
    expect(proposePlan(scope(), { ...base, steps: ["Distinto"] }, NOW).digest).not.toBe(first.digest);
    const digestOnlyAuthority: PlanningAuthority = {
      fingerprint: "digest-only-test",
      sign: () => "proof",
      verify: () => true,
    };
    const bound = proposePlan(scope(), base, NOW, "msg_digest_binding", "f".repeat(32), digestOnlyAuthority);
    for (const changedPresentation of [
      { ...bound.plan.presentation, outcome: "Un resultado materialmente distinto." },
      {
        ...bound.plan.presentation,
        impact: [{ area: "Operación", description: "Un impacto materialmente distinto." }],
      },
      {
        ...bound.plan.presentation,
        risk: {
          level: "high", categories: ["architecture"],
          summary: "Riesgo materialmente distinto.", details: "Requiere revisión arquitectónica.",
        },
      },
    ]) {
      expect(validState({ ...bound, plan: { ...bound.plan, presentation: changedPresentation } }, digestOnlyAuthority)).toBe(false);
    }
    expect(proposePlan(scope(), { ...base, actions: [{ action: "edit", resource: path.join(repo, "other.ts") }] }, NOW).digest).not.toBe(first.digest);
    expect(proposePlan({ ...scope(), project: "other" }, base, NOW).digest).not.toBe(first.digest);
    expect(proposePlan({ ...scope(), sessionID: "ses_other" }, base, NOW).digest).not.toBe(first.digest);
    expect(proposePlan(scope("executor"), base, NOW).digest).not.toBe(first.digest);
    expect(proposePlan({ ...scope(), policyRevision: "b".repeat(32) }, base, NOW).digest).not.toBe(first.digest);
  });

  test("rechaza entradas incompletas y acciones sin recurso exacto", () => {
    const { presentation: _presentation, ...withoutPresentation } = input();
    expect(() => proposePlan({ ...scope(), sessionID: "" }, input(), NOW)).toThrow();
    expect(() => proposePlan({ ...scope(), policyRevision: "invalid" }, input(), NOW)).toThrow();
    expect(() => proposePlan(scope(), withoutPresentation as PlanInput, NOW)).toThrow(/presentaci[oó]n/i);
    expect(() => proposePlan(scope(), { ...input(), steps: [] }, NOW)).toThrow();
    expect(() => proposePlan(scope(), { ...input(), actions: [{ action: "unknown", resource: "*" }] }, NOW)).toThrow();
    expect(() => proposePlan(scope(), { ...input(), actions: [{ action: "edit", resource: "" }] }, NOW)).toThrow();
  });

  test("el hash anterior y cualquier recurso no previsto cierran acceso, pero el tiempo no", () => {
    const presented = proposePlan(scope(), input(), NOW);
    const active = authorizePlan(reviewPlan(presented, presented.digest, NOW), presented.digest, NOW);
    const operation = input().actions[0]!;
    expect(() => reviewPlan(active, "0".repeat(64), NOW)).toThrow();
    expect(planAllows(active, scope(), operation, NOW + 365 * 24 * 60 * 60_000)).toBe(true);
    expect(authorizePlan(reviewPlan(presented, presented.digest, NOW), presented.digest,
      NOW + 365 * 24 * 60 * 60_000).phase).toBe("running");
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
      { ...active, version: 1 },
      { ...active, version: 3 },
      { ...active, policyRevision: "b".repeat(32) },
      { ...active, expiresAt: active.createdAt + 31 * 60_000 },
      { ...active, plan: { ...active.plan, actions: [{ ...operation, resource: path.join(repo, "other.ts") }] } },
      { ...active, plan: { ...active.plan, presentation: {
        ...active.plan.presentation, outcome: "Resultado adulterado.",
      } } },
      { ...active, plan: { ...active.plan, presentation: {
        ...active.plan.presentation,
        impact: [{ area: "Datos", description: "Impacto adulterado." }],
      } } },
      { ...active, plan: { ...active.plan, presentation: {
        ...active.plan.presentation,
        risk: {
          level: "high", categories: ["data"],
          summary: "Riesgo adulterado.", details: "No pertenece a la revisión firmada.",
        },
      } } },
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

describe("persistencia planning v5 fail-closed", () => {
  test("usa exclusivamente keys v5 para sesion, plan y revision", () => {
    expect(planKey(SESSION)).toBe(`planning/v5/sessions/${SESSION}`);
    expect(planRecordKey("a".repeat(32))).toBe(`planning/v5/plans/${"a".repeat(32)}`);
    expect(planRevisionKey("a".repeat(32), "b".repeat(32)))
      .toBe(`planning/v5/plans/${"a".repeat(32)}/revisions/${"b".repeat(32)}`);
  });

  test("un estado v3 nunca se acepta como estado v5 aunque conserve firma y payload", () => {
    const current = proposePlan(scope(), input(), NOW);
    expect(current.version).toBe(5);
    expect(validState({ ...current, version: 3 })).toBe(false);
  });

  test("readPlan no descubre ni migra silenciosamente el key legado v3", async () => {
    const current = proposePlan(scope(), input(), NOW);
    const legacy = { ...current, version: 3 };
    records.set(`planning/v3/sessions/${SESSION}`, legacy);
    expect(await readPlan(storage, SESSION)).toBeUndefined();

    records.set(planKey(SESSION), legacy);
    expect(await readPlan(storage, SESSION)).toBeUndefined();
  });
});

describe("nucleo: dependencias y control persistente", () => {
  test("una dependencia bloquea sin autoarranque y solo resume tras completarse", async () => {
    const active = new Map<string, PlanState>();
    const plans = new Map<string, PlanState>();
    const confirmations: string[] = [];
    const adapter: PlanningAdapter = {
      loadActive: async (sessionID) => active.get(sessionID),
      loadPlan: async (planID) => plans.get(planID),
      save: async (state) => { active.set(state.sessionID, state); plans.set(state.planID, state); },
      confirm: async (kind) => { confirmations.push(kind); },
    };
    const parentScope = scope("executor");
    const parent = await presentPlan(parentScope, input(), "msg-parent-plan", adapter);
    await requestPlanExecution(parentScope, parent.digest, "msg-parent-go", adapter);

    const childScope = { ...parentScope, sessionID: "ses_child_dependency" };
    const child = await presentPlan(childScope, {
      ...input(),
      dependencies: [{ planID: parent.planID, revision: parent.revision }],
    }, "msg-child-plan", adapter);
    const blocked = await requestPlanExecution(childScope, child.digest, "msg-child-go", adapter);
    expect(blocked.phase).toBe("blocked");
    expect(planAllows(blocked, childScope, child.plan.actions[0]!)).toBe(false);

    const completedParent = await controlPlan(parentScope, "complete", adapter);
    expect(completedParent.phase).toBe("completed");
    expect(active.get(childScope.sessionID)?.phase).toBe("blocked");
    const resumed = await controlPlan(childScope, "resume", adapter);
    expect(resumed.phase).toBe("running");
    expect(confirmations).toEqual(["run", "run", "complete", "resume"]);
  });

  test("requestPlanExecution inicia si la dependencia ya termino, pero authorizePlan directo la rechaza", async () => {
    const active = new Map<string, PlanState>();
    const plans = new Map<string, PlanState>();
    const confirmations: string[] = [];
    const adapter: PlanningAdapter = {
      loadActive: async (sessionID) => active.get(sessionID),
      loadPlan: async (planID) => plans.get(planID),
      save: async (state) => { active.set(state.sessionID, state); plans.set(state.planID, state); },
      confirm: async (kind) => { confirmations.push(kind); },
    };
    const parentScope = scope("executor");
    const parent = await presentPlan(parentScope, input(), "msg-completed-parent-plan", adapter);
    await requestPlanExecution(parentScope, parent.digest, "msg-completed-parent-run", adapter);
    const completedParent = await controlPlan(parentScope, "complete", adapter);
    expect(completedParent.phase).toBe("completed");

    const childScope = { ...parentScope, sessionID: "ses_child_completed_dependency" };
    const child = await presentPlan(childScope, {
      ...input(),
      dependencies: [{ planID: completedParent.planID, revision: completedParent.revision }],
    }, "msg-completed-child-plan", adapter);

    expect(() => authorizePlan(child, child.digest)).toThrow(/dependencias.*adaptador/i);
    const running = await requestPlanExecution(childScope, child.digest, "msg-completed-child-run", adapter);
    expect(running.phase).toBe("running");
    expect(running.blockedBy).toBeUndefined();
    expect(planAllows(running, childScope, child.plan.actions[0]!)).toBe(true);
    expect(confirmations).toEqual(["run", "complete", "run"]);
  });

  test("rechaza ciclos al revisar un plan existente", async () => {
    const active = new Map<string, PlanState>();
    const plans = new Map<string, PlanState>();
    const adapter: PlanningAdapter = {
      loadActive: async (sessionID) => active.get(sessionID),
      loadPlan: async (planID) => plans.get(planID),
      save: async (state) => { active.set(state.sessionID, state); plans.set(state.planID, state); },
      confirm: async () => undefined,
    };
    const firstScope = scope("executor");
    const first = await presentPlan(firstScope, input(), "msg-cycle-a", adapter);
    const secondScope = { ...firstScope, sessionID: "ses_cycle_b" };
    const second = await presentPlan(secondScope, {
      ...input(), dependencies: [{ planID: first.planID, revision: first.revision }],
    }, "msg-cycle-b", adapter);
    await expect(presentPlan(firstScope, {
      ...input(), dependencies: [{ planID: second.planID, revision: second.revision }],
    }, "msg-cycle-a2", adapter)).rejects.toThrow(/Ciclo/);
  });

  test("cambiar modo o politica reemplaza explicitamente el plan anterior", async () => {
    const active = new Map<string, PlanState>();
    const plans = new Map<string, PlanState>();
    const adapter: PlanningAdapter = {
      loadActive: async (sessionID) => active.get(sessionID),
      loadPlan: async (planID) => plans.get(planID),
      save: async (state) => { active.set(state.sessionID, state); plans.set(state.planID, state); },
      confirm: async () => undefined,
    };
    const originalScope = scope("executor");
    const original = await presentPlan(originalScope, input(), "msg-scope-original", adapter);
    const changedScope = { ...originalScope, policyRevision: "b".repeat(32) };
    const replacement = await presentPlan(changedScope, input(), "msg-scope-replacement", adapter);

    expect(replacement.planID).not.toBe(original.planID);
    expect(plans.get(original.planID)?.phase).toBe("superseded");
    expect(active.get(originalScope.sessionID)?.planID).toBe(replacement.planID);
  });
});

describe("adaptador: solicitudes de permiso y segunda frontera", () => {
  test("las lecturas shell cerradas no requieren plan y pueden variar sin replanificar", async () => {
    configure("ejecutar");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
    fs.writeFileSync(path.join(repo, "src", "fixture.ts"), "export {};\n");
    for (const command of [
      "git status --short --untracked-files=all",
      "git diff --check",
      "sha256sum README.md",
      "rg -n fixture README.md src tests",
    ]) {
      const permission = { sessionID: SESSION, action: "shell", resources: [command], effect: "allow" };
      await evaluatePlanningPermission(permission, options, storage);
      expect(permission.effect).toBe("allow");
      await evaluatePlanningTool({ sessionID: SESSION, tool: "shell", input: { command, workdir: repo } }, options, storage);
    }

    const split = {
      sessionID: SESSION,
      action: "bash",
      resources: ["git status --short", "git diff --check"],
      effect: "allow",
    };
    await evaluatePlanningPermission(split, options, storage);
    expect(split.effect).toBe("allow");
    await evaluatePlanningTool({
      sessionID: SESSION,
      tool: "bash",
      input: { command: "git status --short && git diff --check", workdir: repo },
    }, options, storage);
    await evaluatePlanningTool({
      sessionID: SESSION,
      tool: "shell",
      input: { command: "sha256sum fixture.ts", workdir: path.join(repo, "src") },
    }, options, storage);

    const withoutStorage = {
      sessionID: SESSION,
      action: "shell",
      resources: ["git status --short"],
      effect: "allow",
    };
    await evaluatePlanningPermission(withoutStorage, options);
    expect(withoutStorage.effect).toBe("allow");
    await evaluatePlanningTool({
      sessionID: SESSION,
      tool: "shell",
      input: { command: "git status --short", workdir: repo },
    }, options);
  });

  test("el fast path read-only falla cerrado en ambas fronteras y no alcanza al asesor", async () => {
    for (const command of [
      "git fetch origin",
      "git add -- README.md",
      "cat README.md > copy.md",
      "sh -c 'git status'",
      "sha256sum /etc/passwd",
      "git show --output=/tmp/leak HEAD",
      "bun test",
    ]) {
      const permission = { sessionID: SESSION, action: "shell", resources: [command], effect: "allow" };
      await evaluatePlanningPermission(permission, options, storage);
      expect(permission.effect).toBe("deny");
      await expect(evaluatePlanningTool({
        sessionID: SESSION,
        tool: "shell",
        input: { command, workdir: repo },
      }, options, storage)).rejects.toThrow(/plan/);
    }

    await expect(evaluatePlanningTool({
      sessionID: SESSION,
      tool: "shell",
      input: { command: "pwd", workdir: otherRepo },
    }, options, storage)).rejects.toThrow(/plan/);

    configure("acompanar");
    const advisor = { sessionID: SESSION, action: "shell", resources: ["git status --short"], effect: "allow" };
    await evaluatePlanningPermission(advisor, options, storage);
    expect(advisor.effect).toBe("deny");
    await expect(evaluatePlanningTool({
      sessionID: SESSION,
      tool: "shell",
      input: { command: "git status --short", workdir: repo },
    }, options, storage)).rejects.toThrow(/asesor/);
  });

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

  test("revision y run reutilizan el renderer canonico completo; hash ajeno, orden inverso y deny no se rebajan", async () => {
    const plan = proposePlan(scope(), input(), Date.now());
    records.set(planKey(SESSION), plan);
    const review = { sessionID: SESSION, action: "malahor_plan_review", resources: [plan.digest], effect: "allow" } as Record<string, unknown>;
    await evaluatePlanningPermission(review, options, storage);
    expect(review.effect).toBe("ask");
    expect(review.message).not.toContain(plan.planID);
    expect(review.message).not.toContain(plan.revision);
    expect(review.message).not.toContain(plan.digest);
    expect(String(review.message).endsWith(renderPlan(plan))).toBe(true);
    expect(String(review.message).split(renderPlan(plan))).toHaveLength(2);

    const denied = { ...review, effect: "deny" };
    await evaluatePlanningPermission(denied, options, storage);
    expect(denied.effect).toBe("deny");
    const wrong = { ...review, effect: "allow", resources: ["0".repeat(64)] };
    await evaluatePlanningPermission(wrong, options, storage);
    expect(wrong.effect).toBe("deny");
    const earlyRun = { sessionID: SESSION, action: "malahor_plan_run", resources: [plan.digest], effect: "allow" };
    await evaluatePlanningPermission(earlyRun, options, storage);
    expect(earlyRun.effect).toBe("deny");

    const reviewed = reviewPlan(plan, plan.digest);
    records.set(planKey(SESSION), reviewed);
    const run = { ...earlyRun, effect: "allow" };
    await evaluatePlanningPermission(run, options, storage);
    expect(run.effect).toBe("ask");
    expect(run.message).not.toContain(plan.planID);
    expect(run.message).not.toContain(plan.revision);
    expect(run.message).not.toContain(plan.digest);
    expect(String(run.message).endsWith(renderPlan(reviewed))).toBe(true);
    expect(String(run.message).split(renderPlan(reviewed))).toHaveLength(2);
    const hostDenied = { ...run, effect: "deny" };
    await evaluatePlanningPermission(hostDenied, options, storage);
    expect(hostDenied.effect).toBe("deny");
  });

  test("ejecutor solo pide run; asesor y sesion sin resolver no obtienen ask; la antiguedad no bloquea", async () => {
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
    const old = { ...request, effect: "allow", resources: [(records.get(planKey(SESSION)) as PlanState).digest] };
    await evaluatePlanningPermission(old, options, storage);
    expect(old.effect).toBe("ask");
    configure("acompanar");
    const concept = proposePlan(scope("advisor"), conceptInput("Idea"));
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

  test("permission reconstruye solo el comando shell compuesto exacto y tool exige el original", async () => {
    const first = "parte A";
    const second = "parte B";
    const command = `${first} && ${second}`;
    const presented = proposePlan(scope(), { ...input("shell"), actions: [{ action: "shell", resource: command }] });
    records.set(planKey(SESSION), authorizePlan(reviewPlan(presented, presented.digest), presented.digest));

    const split = { sessionID: SESSION, action: "bash", resources: [first, second], effect: "allow" };
    await evaluatePlanningPermission(split, options, storage);
    expect(split.effect).toBe("allow");

    for (const resources of [[first], [second, first]]) {
      const denied = { ...split, resources, effect: "allow" };
      await evaluatePlanningPermission(denied, options, storage);
      expect(denied.effect).toBe("deny");
    }

    await evaluatePlanningTool({ sessionID: SESSION, tool: "shell", input: { command } }, options, storage);
    for (const attempted of [first, `${first} && parte C`]) {
      await expect(evaluatePlanningTool({
        sessionID: SESSION, tool: "shell", input: { command: attempted },
      }, options, storage)).rejects.toMatchObject({ code: "ACTION_NOT_DECLARED" });
    }
  });

  test("stage directorio a manifest exacto pide un allow one-shot y conserva la revisión", async () => {
    configure("ejecutar");
    options.toolRegistered = true;
    const core = path.join(repo, "src", "core");
    const fixture = path.join(repo, "tests", "fixture.test.ts");
    fs.mkdirSync(core, { recursive: true });
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(path.join(core, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(core, "b.ts"), "export const b = 2;\n");
    fs.writeFileSync(fixture, "// fixture\n");
    fs.writeFileSync(path.join(repo, "outside.ts"), "export {};\n");

    const plannedCommand = "git add -- src/core tests/fixture.test.ts";
    const actualCommand = "git add -- src/core/a.ts src/core/b.ts tests/fixture.test.ts";
    const presented = proposePlan(scope("executor"), {
      ...input("shell"),
      actions: [{ action: "shell", resource: plannedCommand }],
    });
    const running = authorizePlan(presented, presented.digest);
    records.set(planKey(SESSION), running);
    const source = { type: "tool", messageID: "msg_stage_repair", id: "call_stage_repair" };
    const permission: Record<string, unknown> = {
      sessionID: SESSION,
      action: "shell",
      resources: [actualCommand],
      source,
      effect: "allow",
    };
    await evaluatePlanningPermission(permission, options, storage);
    expect(permission.effect).toBe("allow");

    const approvals: Array<Record<string, unknown>> = [];
    const approvalPort = {
      assert: async (request: Record<string, unknown>) => {
        approvals.push(request);
        const nativeAsk: Record<string, unknown> = { ...request, effect: "allow" };
        await evaluatePlanningPermission(nativeAsk, options, storage);
        expect(nativeAsk.effect).toBe("ask");
        expect(String(nativeAsk.message)).toContain("misma revisión");
      },
    };
    const toolInput = {
      sessionID: SESSION,
      agent: "malahor",
      messageID: source.messageID,
      id: source.id,
      tool: "shell",
      input: { command: actualCommand, workdir: repo },
    };

    await evaluatePlanningTool(toolInput, options, storage, undefined, approvalPort);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      sessionID: SESSION,
      agent: "malahor",
      action: "malahor_plan_repair",
      save: [],
    });
    expect((approvals[0]?.resources as string[]).slice(-3)).toEqual([
      "src/core/a.ts",
      "src/core/b.ts",
      "tests/fixture.test.ts",
    ]);
    const stillRunning = records.get(planKey(SESSION)) as PlanState;
    expect(stillRunning).toMatchObject({
      planID: running.planID,
      revision: running.revision,
      digest: running.digest,
      phase: "running",
    });
    const attempts = [...records.entries()].filter(([key]) => key.startsWith("planning/v5/attempts/"));
    expect(attempts).toHaveLength(1);

    await expect(evaluatePlanningTool({ ...toolInput, id: "call_stage_repair_repeat" }, options, storage, undefined, approvalPort))
      .rejects.toMatchObject({ code: "ACTION_REPAIR_EXHAUSTED" });
    expect(approvals).toHaveLength(1);

    const widened = {
      ...permission,
      resources: ["git add -- src/core/a.ts outside.ts"],
      effect: "allow",
    };
    await evaluatePlanningPermission(widened, options, storage);
    expect(widened.effect).toBe("deny");
    expect(String(widened.message)).toContain("ACTION_NOT_DECLARED");

    const replacementPresented = proposePlan(scope("executor"), {
      ...input("shell"),
      actions: [{ action: "shell", resource: plannedCommand }],
    });
    const replacement = authorizePlan(replacementPresented, replacementPresented.digest);
    records.set(planKey(SESSION), replacement);
    const mutatingInput: Record<string, unknown> = {
      ...toolInput,
      id: "call_stage_repair_mutated",
      input: { command: actualCommand, workdir: repo },
    };
    const mutatingPort = {
      assert: async (request: Record<string, unknown>) => {
        const nativeAsk: Record<string, unknown> = { ...request, effect: "allow" };
        await evaluatePlanningPermission(nativeAsk, options, storage);
        expect(nativeAsk.effect).toBe("ask");
        (mutatingInput.input as Record<string, unknown>).command = "git add -- src/core/a.ts outside.ts";
      },
    };
    await expect(evaluatePlanningTool(mutatingInput, options, storage, undefined, mutatingPort))
      .rejects.toMatchObject({ code: "PLAN_INVALID" });

    let signalApproval!: () => void;
    let releaseApproval!: () => void;
    const approvalStarted = new Promise<void>((resolve) => { signalApproval = resolve; });
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    let concurrentApprovals = 0;
    const concurrentPort = {
      assert: async () => {
        concurrentApprovals += 1;
        signalApproval();
        await approvalGate;
      },
    };
    const concurrentInput = {
      ...toolInput,
      id: "call_stage_repair_concurrent_a",
      input: { command: actualCommand, workdir: repo },
    };
    const firstRepair = evaluatePlanningTool(concurrentInput, options, storage, undefined, concurrentPort);
    await approvalStarted;
    await expect(evaluatePlanningTool({
      ...concurrentInput,
      id: "call_stage_repair_concurrent_b",
    }, options, storage, undefined, concurrentPort)).rejects.toMatchObject({ code: "ACTION_REPAIR_EXHAUSTED" });
    expect(concurrentApprovals).toBe(1);
    releaseApproval();
    await firstRepair;
  });

  test("el canonicalizador cerrado rechaza sustituciones y entorno inline en ambas fronteras", async () => {
    const mktemp = "mktemp -d /tmp/opencode/.sandbox/malahor-runtime-update-XXXXXX";
    const update = "node dist/index.js update --dry-run --yes";
    const command = `sandbox=$(${mktemp}) && MALAHOR_HOME="$sandbox/.malahor" MALAHOR_OPENCODE_DIR="$sandbox/opencode" MALAHOR_OPENCODE_DETECT=0 ${update}`;
    const presented = proposePlan(scope(), {
      ...input("shell"), actions: [{ action: "shell", resource: command }],
    });
    const running = authorizePlan(reviewPlan(presented, presented.digest), presented.digest);
    expect(running.phase).toBe("running");
    records.set(planKey(SESSION), running);

    const permissionEffect = async (resources: string[]): Promise<unknown> => {
      const request = { sessionID: SESSION, action: "bash", resources, effect: "allow" };
      await evaluatePlanningPermission(request, options, storage);
      return request.effect;
    };

    expect(await permissionEffect([command])).toBe("deny");
    for (const resources of [
      [mktemp],
      [update, mktemp],
      [mktemp, update, "echo inesperado"],
      [mktemp.replace("XXXXXX", "YYYYYY"), update],
      [update, mktemp, update],
    ]) {
      expect(await permissionEffect(resources)).toBe("deny");
    }

    await expect(evaluatePlanningTool({
      sessionID: SESSION, tool: "shell", input: { command },
    }, options, storage)).rejects.toMatchObject({ code: "ACTION_NOT_CANONICALIZABLE" });
    for (const attempted of [
      mktemp,
      update,
      `${mktemp} && ${update}`,
      command.replace("MALAHOR_OPENCODE_DETECT=0", "MALAHOR_OPENCODE_DETECT=1"),
    ]) {
      await expect(evaluatePlanningTool({
        sessionID: SESSION, tool: "shell", input: { command: attempted },
      }, options, storage)).rejects.toMatchObject({ code: "ACTION_NOT_CANONICALIZABLE" });
    }

    expect(await permissionEffect([mktemp, update])).toBe("deny");
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

  test("solo las ocho tools docs first-party y sus variantes MCP son rutinarias", async () => {
    for (const operation of ["resolve", "list", "read", "search", "write", "append", "move", "open"] as const) {
      for (const action of [`docs_${operation}`, `mcp_docs_${operation}`]) {
        const permission = { sessionID: SESSION, action, resources: [], effect: "allow" };
        await evaluatePlanningPermission(permission, options, storage);
        expect(permission.effect).toBe("allow");
        await evaluatePlanningTool({ sessionID: SESSION, tool: action, input: {} }, options, storage);
      }
    }

    for (const action of ["mnemo_mem_save"] as const) {
      const permission = { sessionID: SESSION, action, resources: [], effect: "allow" };
      await evaluatePlanningPermission(permission, options, storage);
      expect(permission.effect).toBe("allow");
      await evaluatePlanningTool({ sessionID: SESSION, tool: action, input: {} }, options, storage);
    }
  });

  test("docs no declaradas y Obsidian MCP no eluden planeacion", async () => {
    for (const action of ["docs_delete", "mcp_docs_delete", "docs_publish", "mcp_docs_publish"] as const) {
      const permission = { sessionID: SESSION, action, resources: [], effect: "allow" };
      await evaluatePlanningPermission(permission, options, storage);
      expect(permission.effect).toBe("deny");
      await expect(evaluatePlanningTool({
        sessionID: SESSION, tool: action, input: {},
      }, options, storage)).rejects.toThrow(/Malahor:/i);
    }

    const obsidianPermission = {
      sessionID: SESSION,
      action: "obsidian_vault_write",
      resources: [],
      effect: "allow",
    };
    await evaluatePlanningPermission(obsidianPermission, options, storage);
    expect(obsidianPermission.effect).toBe("deny");
    await expect(evaluatePlanningTool({
      sessionID: SESSION,
      tool: "obsidian_vault_write",
      input: { path: "Product/plan.md" },
    }, options, storage)).rejects.toMatchObject({ code: "NO_ACTIVE_PLAN" });
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
        await expect(evaluatePlanningTool({ sessionID: SESSION, tool, input: { command: "echo fixture", workdir } }, options, storage)).rejects.toThrow(/Malahor:/);
      }
    }
  });

  test("shell rechaza cwd local combinado con workdir ajeno", async () => {
    const planned = proposePlan(scope(), input("shell"));
    records.set(planKey(SESSION), authorizePlan(reviewPlan(planned, planned.digest), planned.digest));
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "shell", input: {
      command: "echo fixture", cwd: repo, workdir: otherRepo,
    } }, options, storage)).rejects.toThrow(/Malahor:/);
  });

  test("planning usa afinidad canonica aunque la sesion y la instancia esten fuera del repo", async () => {
    const affinityOptions: PluginAdapterOptions = {
      ...options,
      cwd: home,
      resolveSessionDirectory: async () => home,
      resolveSessionProject: async (sessionID) => sessionID === SESSION
        ? { canonicalKey: "demo", root: repo }
        : undefined,
    };
    expect(await resolvePlanningScope(SESSION, affinityOptions)).toMatchObject({
      directory: repo,
      scope: { sessionID: SESSION, project: "demo", mode: "assistant" },
    });

    records.set(planKey(SESSION), authorized());
    const edit = path.join(repo, "file.ts");
    const permission = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(permission, affinityOptions, storage);
    expect(permission.effect).toBe("allow");
    await evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, affinityOptions, storage);
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

  test("los schemas de planning mantienen la presentación estricta y hacen opcional el digest de run", async () => {
    const harness = await registeredTools();
    type Schema = {
      type?: string;
      required?: string[];
      properties?: Record<string, Schema>;
      items?: Schema;
      enum?: Array<string | number>;
      maxItems?: number;
      uniqueItems?: boolean;
      additionalProperties?: boolean;
    };
    const schema = harness.definitions.get("plan")?.input as Schema;
    const sorted = (items: string[] | undefined) => [...(items ?? [])].sort();
    expect(sorted(schema.required)).toEqual(sorted(["level", "summary", "steps", "presentation", "actions"]));
    expect(sorted(Object.keys(schema.properties ?? {}))).toEqual(sorted(["level", "summary", "steps", "presentation", "actions", "dependencies"]));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.level?.enum).toEqual([0, 1, 2]);
    expect(sorted(schema.properties?.presentation?.required)).toEqual(sorted([
      "objective", "outcome", "steps", "impact", "risk", "exclusions", "completionCriteria",
    ]));
    expect(schema.properties?.presentation?.additionalProperties).toBe(false);
    const presentationProperties = schema.properties?.presentation?.properties ?? {};
    expect(sorted(Object.keys(presentationProperties))).toEqual(sorted([
      "objective", "outcome", "steps", "impact", "risk", "exclusions", "completionCriteria",
    ]));
    const presentationSteps = presentationProperties.steps!;
    expect(presentationSteps.maxItems).toBe(5);
    expect(sorted(presentationSteps.items?.required)).toEqual(sorted(["title", "description"]));
    expect(sorted(Object.keys(presentationSteps.items?.properties ?? {}))).toEqual(sorted(["title", "description"]));
    expect(presentationSteps.items?.additionalProperties).toBe(false);

    const impact = presentationProperties.impact!;
    expect(sorted(impact.items?.required)).toEqual(sorted(["area", "description"]));
    expect(sorted(Object.keys(impact.items?.properties ?? {}))).toEqual(sorted(["area", "description"]));
    expect(impact.items?.additionalProperties).toBe(false);

    const risk = presentationProperties.risk!;
    expect(sorted(risk.required)).toEqual(sorted(["level", "categories", "summary", "details"]));
    expect(sorted(Object.keys(risk.properties ?? {}))).toEqual(sorted(["level", "categories", "summary", "details"]));
    expect(risk.additionalProperties).toBe(false);
    expect(sorted(risk.properties?.level?.enum)).toEqual(sorted(["low", "medium", "high"]));
    expect(sorted(risk.properties?.categories?.items?.enum)).toEqual(sorted([
      "security", "data", "architecture", "destructive",
    ]));
    expect(risk.properties?.categories?.uniqueItems).toBe(true);

    const runSchema = harness.definitions.get("run")?.input as Schema;
    expect(runSchema.type).toBe("object");
    expect(runSchema.required ?? []).toEqual([]);
    expect(Object.keys(runSchema.properties ?? {})).toEqual(["digest"]);
    expect(runSchema.additionalProperties).toBe(false);

    const { level: _level, ...withoutLevel } = input();
    await expect(harness.execute("plan", withoutLevel)).rejects.toThrow(/level 0, 1 o 2/i);
  });

  test("malahor_plan guarda estado v5 ligado al turno y rechaza estados v3", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    const planCall = call(SESSION, "malahor", "msg_executor_presentation");
    const planResult = await harness.execute("plan", input(), planCall);

    expect(planKey(SESSION)).toBe(`planning/v5/sessions/${SESSION}`);
    expect(records.has(planKey(SESSION))).toBe(true);
    const state = records.get(planKey(SESSION)) as PlanState;
    expect(state.version).toBe(5);
    expect(state.plan.presentation).toEqual(input().presentation);
    expect(planResult.metadata).toMatchObject({
      planID: state.planID, revision: state.revision, digest: state.digest, phase: state.phase,
    });
    expect(presentationIdentity(state)).toBe(planCall.messageID);
    expect(validState(state)).toBe(true);
    expect(harness.approvals).toHaveLength(0);
    expect(validState({ ...state, version: 3 })).toBe(false);
    expect(validState(tamperPresentationIdentity(state))).toBe(false);
  });

  test("malahor_plan delimita un unico Markdown foreground y ordena copiarlo como mensaje normal", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    const result = await harness.execute("plan", input(), call(SESSION, "malahor", "msg_foreground_envelope"));
    const state = records.get(planKey(SESSION)) as PlanState;

    expect(result.content).toMatch(/publica[\s\S]*bloque delimitado[\s\S]*exactamente una vez[\s\S]*mensaje normal/i);
    expect(foregroundMarkdown(result.content)).toBe(renderPlan(state));
    expect(result.content.match(/malahor-plan-foreground:start/g) ?? []).toHaveLength(1);
    expect(result.content.match(/malahor-plan-foreground:end/g) ?? []).toHaveLength(1);
    expect(foregroundMarkdown(result.content)).toMatch(/^## Objetivo$/m);
    expect(foregroundMarkdown(result.content)).toMatch(/^## Al terminar$/m);
    expect(foregroundMarkdown(result.content)).toMatch(/^## Qué debes hacer ahora$/m);
    expect(foregroundMarkdown(result.content)).toContain("/malahor-plan detalles");
    expect(foregroundMarkdown(result.content)).not.toContain(state.planID);
    expect(foregroundMarkdown(result.content)).not.toContain(state.revision);
    expect(foregroundMarkdown(result.content)).not.toContain(state.digest);
  });

  test("asistente revisa el plan pero bloquea la segunda confirmacion en el mismo turno", async () => {
    expect(loadConfig(env, repo).mode).toBe("assistant");
    expect(loadConfig(env, repo).execution.intervention).toBe("guiar");
    const phases: Array<{ action: string; state?: PlanState }> = [];
    const harness = await registeredTools((request) => {
      phases.push({ action: request.action, state: records.get(planKey(SESSION)) as PlanState });
    });
    expect([...harness.definitions.keys()]).toEqual(["plan", "run", "plan_control"]);
    expect(harness.definitions.get("plan")?.options).toMatchObject({ namespace: "malahor", codemode: false });
    const planCall = call(SESSION, "malahor", "msg_assistant_presentation");
    await harness.execute("plan", input(), planCall);
    const presented = records.get(planKey(SESSION)) as PlanState;
    expect(presentationIdentity(presented)).toBe(planCall.messageID);
    expect(presented.reviewedAt).toBeNumber();
    expect(presented.authorizedAt).toBeUndefined();
    expect(phases[0]?.state?.reviewedAt).toBeUndefined();
    expect(phases[0]?.state?.authorizedAt).toBeUndefined();
    const edit = path.join(repo, "file.ts");
    const beforeRun = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(beforeRun, options, storage);
    expect(beforeRun.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage)).rejects.toThrow();
    await expect(harness.execute("run", {}, planCall)).rejects.toThrow();
    expect(harness.approvals.map((request) => request.action)).toEqual(["malahor_plan_review"]);
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeUndefined();

    const runCall = call(SESSION, "malahor", "msg_assistant_go");
    const runResult = await harness.execute("run", {}, runCall);
    expect(phases[1]?.state?.authorizedAt).toBeUndefined();
    const running = records.get(planKey(SESSION)) as PlanState;
    expect(running.authorizedAt).toBeNumber();
    expect({ planID: running.planID, revision: running.revision, digest: running.digest }).toEqual({
      planID: presented.planID, revision: presented.revision, digest: presented.digest,
    });
    expect(runResult.metadata).toMatchObject({
      planID: running.planID, revision: running.revision, phase: running.phase,
    });
    expect(runResult.content).toBe(renderPlan(running));
    expect(runResult.content).not.toContain(running.planID);
    expect(runResult.content).not.toContain(running.revision);
    expect(runResult.content).not.toContain(running.digest);
    expect(harness.approvals.map((request) => request.action)).toEqual(["malahor_plan_review", "malahor_plan_run"]);
    const afterRun = { ...beforeRun, effect: "allow" };
    await evaluatePlanningPermission(afterRun, options, storage);
    expect(afterRun.effect).toBe("allow");
    await evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage);
    expect(harness.approvals[0]).toEqual({ sessionID: SESSION, agent: "malahor", source: { type: "tool", messageID: planCall.messageID, id: planCall.id }, action: "malahor_plan_review", resources: [presented.digest], save: [] });
    expect(harness.approvals[1]).toEqual({ sessionID: SESSION, agent: "malahor", source: { type: "tool", messageID: runCall.messageID, id: runCall.id }, action: "malahor_plan_run", resources: [presented.digest], save: [] });
    await expect(harness.execute("run", { digest: presented.digest }, call(SESSION, "malahor", "msg_assistant_repeat"))).rejects.toThrow();
    if (harness.registration) await harness.registration.dispose?.();
  });

  test("ejecutor rechaza malahor_run en el turno de presentacion antes de consultar el approval port", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    const planCall = call(SESSION, "malahor", "msg_executor_same_turn");
    await harness.execute("plan", input(), planCall);
    const executor = records.get(planKey(SESSION)) as PlanState;
    expect(harness.approvals).toHaveLength(0);

    await expect(harness.execute("run", {}, planCall)).rejects.toThrow();
    expect(harness.approvals).toHaveLength(0);
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeUndefined();
  });

  test("ejecutor autoriza desde un turno posterior; asesor no solicita aprobacion ni ejecuta", async () => {
    configure("ejecutar");
    expect(loadConfig(env, repo).mode).toBe("executor");
    const harness = await registeredTools();
    const planCall = call(SESSION, "malahor", "msg_executor_plan");
    await harness.execute("plan", input(), planCall);
    const executor = records.get(planKey(SESSION)) as PlanState;
    expect(executor.reviewedAt).toBeUndefined();
    expect(harness.approvals).toHaveLength(0);
    const edit = path.join(repo, "file.ts");
    const beforeRun = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(beforeRun, options, storage);
    expect(beforeRun.effect).toBe("deny");
    const runCall = call(SESSION, "malahor", "msg_executor_go");
    await harness.execute("run", {}, runCall);
    expect(harness.approvals.map((item) => [item.action, item.resources])).toEqual([["malahor_plan_run", [executor.digest]]]);
    expect(harness.approvals[0]?.source.messageID).toBe(runCall.messageID);
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
    await harness.execute("plan", conceptInput("Concepto"));
    expect(harness.approvals).toHaveLength(1);
    const concept = records.get(planKey(SESSION)) as PlanState;
    await expect(harness.execute("run", { digest: concept.digest })).rejects.toThrow();
    await expect(harness.execute("plan", input())).rejects.toThrow();
    const advisor = { ...afterRun, effect: "allow" };
    await evaluatePlanningPermission(advisor, options, storage);
    expect(advisor.effect).toBe("deny");
    await expect(evaluatePlanningTool({ sessionID: SESSION, tool: "write", input: { path: edit } }, options, storage)).rejects.toThrow();
  });

  test("run sin digest deriva solo un plan activo firmado y conserva el digest explícito fail-closed", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    await expect(harness.execute("run", {}, call(SESSION, "malahor", "msg_run_without_plan"))).rejects.toThrow();

    const planCall = call(SESSION, "malahor", "msg_run_active_plan");
    await harness.execute("plan", input(), planCall);
    const presented = records.get(planKey(SESSION)) as PlanState;
    records.set(planKey(SESSION), { ...presented, proof: "0".repeat(64) });
    await expect(harness.execute("run", {}, call(SESSION, "malahor", "msg_run_tampered"))).rejects.toThrow();
    expect(harness.approvals).toHaveLength(0);

    records.set(planKey(SESSION), presented);
    await expect(harness.execute("run", "invalid", call(SESSION, "malahor", "msg_run_invalid_input"))).rejects.toThrow();
    expect(harness.approvals).toHaveLength(0);
    await expect(harness.execute("run", { digest: "0".repeat(64) }, call(SESSION, "malahor", "msg_run_wrong_digest"))).rejects.toThrow();
    expect(harness.approvals).toHaveLength(0);

    await harness.execute("run", {}, call(SESSION, "malahor", "msg_run_active_go"));
    expect(harness.approvals).toEqual([expect.objectContaining({
      action: "malahor_plan_run",
      resources: [presented.digest],
    })]);
  });

  test("run sin digest falla si el plan cambia entre resolver el activo y autorizarlo", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    await harness.execute("plan", input(), call(SESSION, "malahor", "msg_run_race_plan"));
    const first = records.get(planKey(SESSION)) as PlanState;
    const get = storage.get.bind(storage);
    let replaceOnRead = true;
    storage.get = async (key) => {
      const value = await get(key);
      if (replaceOnRead && key === planKey(SESSION)) {
        replaceOnRead = false;
        records.set(key, proposePlan(scope("executor"), input(), NOW + 1, "msg_run_race_replacement"));
      }
      return value;
    };

    await expect(harness.execute("run", {}, call(SESSION, "malahor", "msg_run_race_go"))).rejects.toThrow();
    const replacement = records.get(planKey(SESSION)) as PlanState;
    expect(replacement.digest).not.toBe(first.digest);
    expect(replacement.authorizedAt).toBeUndefined();
    expect(harness.approvals).toHaveLength(0);
  });

  test("nivel 0 conserva plan foreground y aprobación go, y rechaza rutas protegidas", async () => {
    configure("ejecutar");
    fs.writeFileSync(path.join(repo, "file.ts"), "export const value = 1;\n");
    const harness = await registeredTools();
    const planCall = call(SESSION, "malahor", "msg_level_zero_plan");
    const result = await harness.execute("plan", levelZeroInput(), planCall);
    const state = records.get(planKey(SESSION)) as PlanState;

    expect(state.plan.level).toBe(0);
    expect(foregroundMarkdown(result.content)).toContain("nivel 0");
    expect(foregroundMarkdown(result.content)).not.toMatch(/^## Ruta$/m);
    const edit = path.join(repo, "file.ts");
    const before = { sessionID: SESSION, action: "edit", resources: [edit], effect: "allow" };
    await evaluatePlanningPermission(before, options, storage);
    expect(before.effect).toBe("deny");
    await harness.execute("run", {}, call(SESSION, "malahor", "msg_level_zero_go"));
    const after = { ...before, effect: "allow" };
    await evaluatePlanningPermission(after, options, storage);
    expect(after.effect).toBe("allow");

    fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
    const workflow = path.join(repo, ".github", "workflows", "ci.yml");
    fs.writeFileSync(workflow, "name: ci\n");
    await expect(harness.execute("plan", {
      ...levelZeroInput(),
      actions: [{ action: "edit", resource: workflow }],
    }, call(SESSION, "malahor", "msg_level_zero_infra"))).rejects.toThrow(/nivel 0|protegida/i);
    await expect(harness.execute("plan", {
      ...levelZeroInput(),
      actions: [{ action: "edit", resource: path.join(repo, "missing.ts") }],
    }, call(SESSION, "malahor", "msg_level_zero_missing"))).rejects.toThrow(/nivel 0|existente/i);
    await expect(harness.execute("plan", {
      ...levelZeroInput("shell"),
      actions: [{ action: "shell", resource: "sudo npm install left-pad" }],
    }, call(SESSION, "malahor", "msg_level_zero_install"))).rejects.toThrow(/nivel 0|instala/i);
    await expect(harness.execute("plan", {
      ...levelZeroInput("shell"),
      actions: [{ action: "shell", resource: "rm -rf .sandbox" }],
    }, call(SESSION, "malahor", "msg_level_zero_destructive"))).rejects.toThrow(/nivel 0|destructivo/i);

    if (process.platform !== "win32") {
      const outside = path.join(root, "outside.ts");
      const linkedDirectory = path.join(repo, "linked-outside");
      fs.writeFileSync(outside, "export const outside = true;\n");
      fs.symlinkSync(root, linkedDirectory, "dir");
      await expect(harness.execute("plan", {
        ...levelZeroInput(),
        actions: [{ action: "edit", resource: path.join(linkedDirectory, "outside.ts") }],
      }, call(SESSION, "malahor", "msg_level_zero_symlink"))).rejects.toThrow(/nivel 0|proyecto/i);
    }
  });

  test("plan_control pausa, reanuda y completa sin ampliar efectos", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    await harness.execute("plan", input(), call(SESSION, "malahor", "msg_control_plan"));
    const presented = records.get(planKey(SESSION)) as PlanState;
    const identity = { planID: presented.planID, revision: presented.revision, digest: presented.digest };
    await harness.execute("run", { digest: presented.digest }, call(SESSION, "malahor", "msg_control_go"));
    const pausedResult = await harness.execute("plan_control", { action: "pause" }, call(SESSION, "malahor", "msg_control_pause"));
    const paused = records.get(planKey(SESSION)) as PlanState;
    expect(paused.phase).toBe("paused");
    expect({ planID: paused.planID, revision: paused.revision, digest: paused.digest }).toEqual(identity);
    expect(pausedResult.content).toBe(renderPlan(paused));
    const resumedResult = await harness.execute("plan_control", { action: "resume" }, call(SESSION, "malahor", "msg_control_resume"));
    const resumed = records.get(planKey(SESSION)) as PlanState;
    expect(resumed.phase).toBe("running");
    expect({ planID: resumed.planID, revision: resumed.revision, digest: resumed.digest }).toEqual(identity);
    expect(resumedResult.content).toBe(renderPlan(resumed));
    const completedResult = await harness.execute("plan_control", { action: "complete" }, call(SESSION, "malahor", "msg_control_complete"));
    const completed = records.get(planKey(SESSION)) as PlanState;
    expect(completed.phase).toBe("completed");
    expect({ planID: completed.planID, revision: completed.revision, digest: completed.digest }).toEqual(identity);
    expect(completedResult.content).toBe(renderPlan(completed));
    expect(harness.approvals.map((item) => item.action)).toEqual([
      "malahor_plan_run", "malahor_plan_resume", "malahor_plan_complete",
    ]);
  });

  test("reemplazo de plan revoca autorizacion anterior y rehace confirmaciones", async () => {
    const harness = await registeredTools();
    await harness.execute("plan", input(), call(SESSION, "malahor", "msg_replace_plan_1"));
    const old = records.get(planKey(SESSION)) as PlanState;
    await harness.execute("run", { digest: old.digest }, call(SESSION, "malahor", "msg_replace_run_1"));
    await harness.execute("plan", { ...input(), summary: "Nueva version" }, call(SESSION, "malahor", "msg_replace_plan_2"));
    const next = records.get(planKey(SESSION)) as PlanState;
    expect(next.digest).not.toBe(old.digest);
    expect(next.authorizedAt).toBeUndefined();
    expect(harness.approvals.map((item) => item.action)).toEqual(["malahor_plan_review", "malahor_plan_run", "malahor_plan_review"]);
    await expect(harness.execute("run", { digest: old.digest }, call(SESSION, "malahor", "msg_replace_stale"))).rejects.toThrow();
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
    await harness.execute("plan", input(), call(SESSION, "malahor", "msg_repeat_plan_1"));
    const first = records.get(planKey(SESSION)) as PlanState;
    await harness.execute("run", { digest: first.digest }, call(SESSION, "malahor", "msg_repeat_run_1"));
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeNumber();

    await harness.execute("plan", input(), call(SESSION, "malahor", "msg_repeat_plan_2"));
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

    await expect(harness.execute("run", { digest: first.digest }, call(SESSION, "malahor", "msg_repeat_stale"))).rejects.toThrow();
    replaceDuringRun = true;
    await expect(harness.execute("run", { digest: second.digest }, call(SESSION, "malahor", "msg_repeat_run_2"))).rejects.toThrow(/cambio/);
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
    const running = harness.execute("run", { digest: presented.digest }, call(SESSION, "malahor", "msg_concurrent_run"));
    await started;
    const replacing = harness.execute("plan", input(), call(SESSION, "malahor", "msg_concurrent_replacement"));
    releaseRun();
    await Promise.all([running, replacing]);

    const replacement = records.get(planKey(SESSION)) as PlanState;
    expect(replacement.plan).toEqual(presented.plan);
    expect(replacement.digest).not.toBe(presented.digest);
    expect(replacement.authorizedAt).toBeUndefined();
    expect(planAllows(replacement, scope(), input().actions[0]!)).toBe(false);
    await expect(harness.execute("run", { digest: presented.digest }, call(SESSION, "malahor", "msg_concurrent_stale"))).rejects.toThrow();
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
    await expect(denied.execute("run", { digest: presentedForRun.digest }, call(SESSION, "malahor", "msg_denied_assistant_run"))).rejects.toThrow("host denied");
    expect(records.get(planKey(SESSION))).toEqual(reviewed);
    expect(records.get(planKey(SESSION))).toEqual(stateAtDeny[1]);
    expect(reviewed.authorizedAt).toBeUndefined();

    configure("ejecutar");
    const executor = proposePlan(scope("executor"), input());
    records.set(planKey(SESSION), executor);
    await expect(denied.execute("run", { digest: executor.digest }, call(SESSION, "malahor", "msg_denied_executor_run"))).rejects.toThrow("host denied");
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
    await expect(changed.execute("run", { digest: (records.get(planKey(SESSION)) as PlanState).digest }, call(SESSION, "malahor", "msg_changed_run"))).rejects.toThrow(/cambio/);
    expect((records.get(planKey(SESSION)) as PlanState).authorizedAt).toBeUndefined();
  });

  test("run acepta un plan antiguo sin caducidad y aun pide confirmacion al host", async () => {
    configure("ejecutar");
    const harness = await registeredTools();
    const stale = proposePlan(scope("executor"), input(), Date.now() - 31 * 60_000);
    records.set(planKey(SESSION), stale);
    await harness.execute("run", { digest: stale.digest }, call(SESSION, "malahor", RUN_MESSAGE));
    expect(harness.approvals).toHaveLength(1);
  });

  test("cambiar intervention tras revisar revoca el plan antes de la segunda confirmacion", async () => {
    const harness = await registeredTools();
    await harness.execute("plan", input(), call(SESSION, "malahor", "msg_intervention_plan"));
    const state = records.get(planKey(SESSION)) as PlanState;
    expect(harness.approvals.map((item) => item.action)).toEqual(["malahor_plan_review"]);
    for (const intervention of ["acompanar", "ejecutar"] as const) {
      configure(intervention);
      await expect(harness.execute("run", {}, call(SESSION, "malahor", `msg_intervention_${intervention}`))).rejects.toThrow();
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
    const text = (instructions.system as Array<{ text: string }>)[0]?.text ?? "";
    expect(text.match(/malahor-planning:v5/g) ?? []).toHaveLength(1);
    expect(text).not.toContain("malahor-planning:v3");
    expect(text).not.toContain("malahor-planning:v1");
    expect(text).toMatch(/presentaci[oó]n foreground[\s\S]*exactamente una vez[\s\S]*mensaje normal/i);
    expect(text).toMatch(/(?:traza|output)[\s\S]*background[\s\S]*no cuenta[\s\S]*presentaci[oó]n/i);
    expect(text).toMatch(/cop(?:ia|iar)[\s\S]*Markdown[\s\S]*termina(?:r)? (?:este )?turno/i);
    expect(text).toMatch(/solicitud posterior/i);
    expect(text).toMatch(/\bgo\b/i);
    expect(text).toMatch(/\bimplementa\b/i);
    expect(text).toMatch(/go previo.*no aprueba.*plan.*no visto/is);
    expect(text).toMatch(/malahor_run[\s\S]*plan activo firmado[\s\S]*(?:no pidas|no exige)[\s\S]*(?:digest|\/malahor-plan detalles)/i);
    expect(text).toMatch(/remediacion estructurada[\s\S]*persona no desarrolladora[\s\S]*bloques completos/i);
    expect(text).toMatch(/sin remediacion verificable[\s\S]*no inventes lineas ni codigo/i);
    expect(text).toMatch(/edicion manual[\s\S]*revalidar/i);
    expectProgressiveDisclosureContract(text);
    expectLevelZeroContract(text);
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

  test("actualiza el marker v3 a v5 en vez de conservar instrucciones antiguas", async () => {
    const legacy: Record<string, unknown> = {
      sessionID: SESSION,
      agent: "malahor",
      system: [{ type: "text", text: "base\n\n<!-- malahor-planning:v3 -->\ninstrucciones antiguas" }],
    };
    await injectPlanningInstructions(legacy, options, storage);
    const text = (legacy.system as Array<{ text: string }>)[0]?.text ?? "";
    expect(text.match(/malahor-planning:v5/g) ?? []).toHaveLength(1);
    expect(text).not.toContain("malahor-planning:v3");
    expect(text).not.toContain("instrucciones antiguas");
  });

  test("el protocolo exige una sola presentacion foreground y terminar el turno antes de run", () => {
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(
      /malahor_plan[\s\S]*presentaci[oó]n foreground[\s\S]*exactamente una vez[\s\S]*mensaje normal/i,
    );
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(
      /(?:traza|output)[\s\S]*(?:tool|t[eé]cnic)[\s\S]*background[\s\S]*no cuenta[\s\S]*presentaci[oó]n/i,
    );
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(
      /cop(?:ia|iar)[\s\S]*(?:Markdown|presentaci[oó]n)[\s\S]*termina(?:r)? (?:este )?turno[\s\S]*no invoques malahor_run/i,
    );
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(
      /malahor_run[\s\S]*plan activo firmado[\s\S]*(?:no pidas|no exige)[\s\S]*(?:digest|\/malahor-plan detalles)/i,
    );
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(
      /remediaci[oó]n estructurada y saneada[\s\S]*persona no desarrolladora[\s\S]*reemplaza el bloque completo/i,
    );
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/no inventes n[uú]meros de l[ií]nea, contenido ni c[oó]digo/i);
    expect(MALAHOR_RUNTIME_PROTOCOL).toMatch(/modificaci[oó]n manual[\s\S]*revalida/i);
    expectProgressiveDisclosureContract(MALAHOR_RUNTIME_PROTOCOL);
    expectLevelZeroContract(MALAHOR_RUNTIME_PROTOCOL);
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
      expect(definitions).toEqual(["plan", "run", "plan_control"]);
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
