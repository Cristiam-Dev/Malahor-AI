import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../src/cli/core/config";
import type { PluginAdapterOptions } from "../src/cli/core/hooks/plugin-adapter";
import {
  createPlanningAuthority,
  type PlanningAuthority,
} from "../src/cli/core/planning-authority";
import {
  authorizePlan,
  proposePlan,
  validState,
  type PlanInput,
  type PlanScope,
  type PlanState,
} from "../src/cli/core/planning";
import {
  evaluatePlanningPermission,
  evaluatePlanningTool,
  planKey,
  type PlanningStorage,
} from "../src/plugin/planning";

const SESSION = "ses_auth01_action_intent";
const PROJECT = "auth01-fixture";
const NOW = Date.parse("2026-11-02T18:00:00.000Z");
const FOCUSED = "bun test tests/planning.test.ts";
const HOOKS = "bun test tests/hooks.test.ts";
const PLANNED_SEQUENCE = `${FOCUSED} && ${HOOKS}`;
const EQUIVALENT_SEQUENCE = "bun   test \"tests/planning.test.ts\" && bun test 'tests/hooks.test.ts'";

let root: string;
let repo: string;
let sandbox: string;
let env: NodeJS.ProcessEnv;
let options: PluginAdapterOptions;
let records: Map<string, unknown>;
let storage: PlanningStorage;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-auth01-intent-"));
  repo = path.join(root, "repo");
  sandbox = path.join(root, "sandbox");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.mkdirSync(sandbox, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(repo, "tests", "planning.test.ts"), "// synthetic fixture\n");
  fs.writeFileSync(path.join(repo, "tests", "hooks.test.ts"), "// synthetic fixture\n");
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({
    [PROJECT]: { context: "memory", roots: [repo], defaultRoot: repo },
  }));
  env = {
    HOME: path.join(root, "user"),
    XDG_CONFIG_HOME: path.join(root, "user", ".config"),
    MALAHOR_HOME: home,
    MALAHOR_CONFIG: path.join(home, "config.jsonc"),
    MALAHOR_OPENCODE_DIR: path.join(root, "opencode"),
    MALAHOR_OPENCODE_DETECT: "0",
  };
  fs.mkdirSync(env.MALAHOR_OPENCODE_DIR!, { recursive: true });
  fs.writeFileSync(env.MALAHOR_CONFIG!, JSON.stringify({
    execution: { intervention: "ejecutar", verification: true },
  }));
  options = {
    cwd: repo,
    env,
    permissionRegistered: true,
    shellRegistered: true,
    toolRegistered: true,
    resolveSessionProject: async (sessionID) => sessionID === SESSION
      ? { canonicalKey: PROJECT, root: repo }
      : undefined,
  };
  records = new Map();
  storage = {
    get: async (key) => records.get(key),
    set: async (key, value) => { records.set(key, value); },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function scope(): PlanScope {
  return {
    sessionID: SESSION,
    project: PROJECT,
    mode: "executor",
    policyRevision: loadConfig(env, repo).execution.revision,
  };
}

function planInput(command = PLANNED_SEQUENCE): PlanInput {
  return {
    level: 1,
    summary: "Ejecutar validaciones sintéticas AUTH-01",
    steps: ["Ejecutar solo la secuencia declarada"],
    presentation: {
      objective: "Validar la autorización canónica sin tocar Horiel P5.",
      outcome: "Las validaciones equivalentes reutilizan una única revisión.",
      steps: [{
        title: "Validar",
        description: "Ejecutar únicamente las pruebas sintéticas declaradas.",
      }],
      impact: [{ area: "Planning", description: "Solo afecta fixtures temporales de prueba." }],
      risk: {
        level: "medium",
        categories: ["security"],
        summary: "La prueba fija la frontera de autorización.",
        details: "Una equivalencia incorrecta podría ampliar o bloquear el alcance.",
      },
      exclusions: ["Horiel P5", "Datos reales", "Instalación o despliegue"],
      completionCriteria: ["La misma intención conserva autorización y una acción nueva se bloquea"],
    },
    actions: [{ action: "shell", resource: command }],
  };
}

function storeRunningPlan(command = PLANNED_SEQUENCE): PlanState {
  const presented = proposePlan(scope(), planInput(command));
  const running = authorizePlan(presented, presented.digest);
  records.set(planKey(SESSION), running);
  return running;
}

async function toolRejection(command: string): Promise<Error & { code?: string }> {
  try {
    await evaluatePlanningTool({
      sessionID: SESSION,
      tool: "shell",
      input: { command, workdir: repo },
    }, options, storage);
    return new Error("La llamada fue autorizada inesperadamente");
  } catch (error) {
    return error as Error & { code?: string };
  }
}

interface ActionIntent {
  schema: 1;
  canonicalizer: "action-intent-v1";
  actionID: string;
  kind: "edit" | "shell" | "subagent";
  command?: { executable: string; argv: string[]; cwd: string; composition: "single" | "and-sequence" };
}

interface ActionIntentApi {
  ACTION_INTENT_CANONICALIZER: "action-intent-v1";
  canonicalizeActionIntent(input: Record<string, unknown>): ActionIntent[];
  sameActionIntentSequence(left: readonly ActionIntent[], right: readonly ActionIntent[]): boolean;
}

interface AuthorizationDecisionApi {
  AUTHORIZATION_DENIAL_CODES: readonly string[];
  decideAuthorization(input: Record<string, unknown>): {
    effect: "allow" | "defer" | "deny";
    code: string;
    actionID?: string;
  };
}

async function loadActionIntentApi(): Promise<ActionIntentApi> {
  const modulePath = "../src/cli/core/action-intent";
  try {
    return await import(modulePath) as unknown as ActionIntentApi;
  } catch (cause) {
    throw new Error(`API normativa ausente: ${modulePath} (ActionIntentV1).`, { cause });
  }
}

async function loadAuthorizationDecisionApi(): Promise<AuthorizationDecisionApi> {
  const modulePath = "../src/cli/core/authorization-decision";
  try {
    return await import(modulePath) as unknown as AuthorizationDecisionApi;
  } catch (cause) {
    throw new Error(`API normativa ausente: ${modulePath} (decisiones tipadas).`, { cause });
  }
}

function shellRequest(command: string, cwd = repo): Record<string, unknown> {
  return {
    kind: "shell",
    project: PROJECT,
    root: repo,
    rootRef: "project",
    command,
    cwd,
    filesystem: {
      readRoots: [repo],
      writePaths: [],
      createPaths: [],
      sandboxWriteRoots: [sandbox],
    },
    network: "forbidden",
    environment: [],
    constraints: { remote: false, infrastructure: false },
  };
}

function editRequest(target: string): Record<string, unknown> {
  return {
    kind: "edit",
    project: PROJECT,
    root: repo,
    rootRef: "project",
    path: target,
    existence: "must-exist",
    constraints: { remote: false, infrastructure: false },
  };
}

function expectCanonicalizationCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("La canonicalización aceptó una entrada que debía bloquear.");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function legacyV4State(
  phase: "running" | "completed",
  authority: PlanningAuthority,
): Record<string, unknown> {
  const legacyScope = {
    sessionID: SESSION,
    project: PROJECT,
    mode: "executor" as const,
    policyRevision: "a".repeat(32),
  };
  const plan = {
    level: 1,
    summary: "Fixture terminal V4",
    steps: ["Conservar compatibilidad"],
    presentation: planInput(FOCUSED).presentation,
    actions: [{ action: "shell", resource: FOCUSED }],
    dependencies: [],
  };
  const planID = "b".repeat(32);
  const revision = "c".repeat(32);
  const presentationInteractionID = "msg_auth01_legacy_v4";
  const digest = createHash("sha256").update(canonical({
    scope: legacyScope,
    plan,
    planID,
    revision,
    presentationInteractionID,
  })).digest("hex");
  const unsigned: Record<string, unknown> = {
    version: 4,
    planID,
    ...legacyScope,
    presentationInteractionID,
    plan,
    digest,
    revision,
    phase,
    createdAt: NOW,
    updatedAt: NOW + 3,
    authorizedAt: NOW + 1,
    startedAt: NOW + 1,
    ...(phase === "completed" ? { completedAt: NOW + 3 } : {}),
    proof: "",
  };
  const { proof: _proof, ...payload } = unsigned;
  return { ...unsigned, proof: authority.sign(canonical(payload)) };
}

describe("A0: reproducción de la representación frágil actual", () => {
  test("un split permitido por permission se rechaza en tool aunque espacios y quoting expresen la misma secuencia", async () => {
    storeRunningPlan();
    const permission = {
      sessionID: SESSION,
      action: "bash",
      resources: [FOCUSED, HOOKS],
      effect: "allow",
    };

    await evaluatePlanningPermission(permission, options, storage);

    expect(permission.effect).toBe("allow");
    await expect(evaluatePlanningTool({
      sessionID: SESSION,
      tool: "shell",
      input: { command: EQUIVALENT_SEQUENCE, workdir: repo },
    }, options, storage)).resolves.toBeUndefined();
  });

  test("el adaptador expone códigos distintos para plan ausente, inválido, no running y acción nueva", async () => {
    const noActive = await toolRejection(FOCUSED);

    const presented = proposePlan(scope(), planInput(FOCUSED));
    records.set(planKey(SESSION), { ...presented, digest: "0".repeat(64) });
    const invalid = await toolRejection(FOCUSED);

    records.set(planKey(SESSION), presented);
    const notRunning = await toolRejection(FOCUSED);

    storeRunningPlan(FOCUSED);
    const newAction = await toolRejection("bun test tests/new-action.test.ts");

    expect({
      noActive: { code: noActive.code, message: noActive.message },
      invalid: { code: invalid.code, message: invalid.message },
      notRunning: { code: notRunning.code, message: notRunning.message },
      newAction: { code: newAction.code, message: newAction.message },
    }).toMatchObject({
      noActive: { code: "NO_ACTIVE_PLAN" },
      invalid: { code: "PLAN_INVALID" },
      notRunning: { code: "PLAN_NOT_RUNNING" },
      newAction: { code: "ACTION_NOT_DECLARED" },
    });
  });
});

describe("A1: ActionIntentV1 y decisiones tipadas", () => {
  test("expone la API normativa del canonicalizador y la decisión estructurada", async () => {
    const intents = await loadActionIntentApi();
    const decisions = await loadAuthorizationDecisionApi();

    expect(intents.ACTION_INTENT_CANONICALIZER).toBe("action-intent-v1");
    expect(typeof intents.canonicalizeActionIntent).toBe("function");
    expect(typeof intents.sameActionIntentSequence).toBe("function");
    expect(typeof decisions.decideAuthorization).toBe("function");
  });

  test("canonicaliza espacios y quoting equivalentes de forma determinista", async () => {
    const api = await loadActionIntentApi();
    const literal = api.canonicalizeActionIntent(shellRequest(FOCUSED));
    const quoted = api.canonicalizeActionIntent(shellRequest("bun   test \"tests/planning.test.ts\""));
    const repeated = api.canonicalizeActionIntent(shellRequest(FOCUSED));

    expect(literal).toEqual(repeated);
    expect(literal.map((intent) => intent.actionID)).toEqual(quoted.map((intent) => intent.actionID));
    expect(literal[0]).toMatchObject({
      schema: 1,
      canonicalizer: "action-intent-v1",
      kind: "shell",
      command: { executable: "bun", argv: ["test", "tests/planning.test.ts"] },
    });
  });

  test("split y join de la misma secuencia conservan IDs y orden; reordenar o añadir argumentos cambia la intención", async () => {
    const api = await loadActionIntentApi();
    const joined = api.canonicalizeActionIntent(shellRequest(PLANNED_SEQUENCE));
    const split = [
      ...api.canonicalizeActionIntent(shellRequest(FOCUSED)),
      ...api.canonicalizeActionIntent(shellRequest(HOOKS)),
    ];
    const reversed = api.canonicalizeActionIntent(shellRequest(`${HOOKS} && ${FOCUSED}`));
    const changedArgs = api.canonicalizeActionIntent(shellRequest(`${FOCUSED} --rerun-each 2`));
    const changedCwd = api.canonicalizeActionIntent(shellRequest(FOCUSED, path.join(repo, "tests")));

    expect(joined.map((intent) => intent.actionID)).toEqual(split.map((intent) => intent.actionID));
    expect(api.sameActionIntentSequence(joined, split)).toBe(true);
    expect(api.sameActionIntentSequence(joined, reversed)).toBe(false);
    expect(changedArgs[0]?.actionID).not.toBe(split[0]?.actionID);
    expect(changedCwd[0]?.actionID).not.toBe(split[0]?.actionID);
  });

  test("shell V1 bloquea pipe, redirects, sustituciones, glob, eval, shell anidado y composiciones distintas de &&", async () => {
    const api = await loadActionIntentApi();
    for (const command of [
      `${FOCUSED} | tee result.txt`,
      `${FOCUSED} > result.txt`,
      `target=$(pwd) && ${FOCUSED}`,
      "echo `pwd`",
      "bun test tests/*.test.ts",
      `eval '${FOCUSED}'`,
      `sh -c '${FOCUSED}'`,
      `bash -c '${FOCUSED}'`,
      `${FOCUSED} || ${HOOKS}`,
      `${FOCUSED}; ${HOOKS}`,
      `${FOCUSED} & ${HOOKS}`,
      "bun test $TARGET",
    ]) {
      expectCanonicalizationCode(
        () => api.canonicalizeActionIntent(shellRequest(command)),
        "ACTION_NOT_CANONICALIZABLE",
      );
    }
  });

  test("edit y subagent ligan path y especialista exactos y fallan cerrados fuera del scope", async () => {
    const api = await loadActionIntentApi();
    const relative = api.canonicalizeActionIntent(editRequest("tests/planning.test.ts"));
    const normalized = api.canonicalizeActionIntent(editRequest("./tests/planning.test.ts"));
    const different = api.canonicalizeActionIntent(editRequest("tests/hooks.test.ts"));
    const specialist = api.canonicalizeActionIntent({
      kind: "subagent",
      project: PROJECT,
      root: repo,
      rootRef: "project",
      agent: "malahor-testing",
      constraints: { remote: false, infrastructure: false },
    });

    expect(relative.map((intent) => intent.actionID)).toEqual(normalized.map((intent) => intent.actionID));
    expect(different[0]?.actionID).not.toBe(relative[0]?.actionID);
    expect(specialist[0]).toMatchObject({ kind: "subagent" });
    expectCanonicalizationCode(
      () => api.canonicalizeActionIntent(editRequest(path.join(root, "outside.ts"))),
      "RESOURCE_OUTSIDE_SCOPE",
    );
    expectCanonicalizationCode(
      () => api.canonicalizeActionIntent({
        kind: "subagent",
        project: PROJECT,
        root: repo,
        rootRef: "project",
        agent: "third-party",
        constraints: { remote: false, infrastructure: false },
      }),
      "ACTION_NOT_CANONICALIZABLE",
    );
  });

  test("publica como mínimo todos los códigos de rechazo AUTH-01", async () => {
    const api = await loadAuthorizationDecisionApi();
    const minimum = [
      "NO_ACTIVE_PLAN",
      "PLAN_INVALID",
      "PLAN_NOT_RUNNING",
      "PLAN_SCHEMA_UPGRADE_REQUIRED",
      "SESSION_MISMATCH",
      "PROJECT_MISMATCH",
      "MODE_MISMATCH",
      "POLICY_CHANGED",
      "ACTION_NOT_DECLARED",
      "ACTION_NOT_CANONICALIZABLE",
      "ACTION_SERIALIZATION_MISMATCH",
      "RESOURCE_OUTSIDE_SCOPE",
      "PROTECTED_APPROVAL_REQUIRED",
      "HOST_ASK",
      "HOST_DENY",
      "CRITICAL_CONTROL_UNAVAILABLE",
    ];

    expect(api.AUTHORIZATION_DENIAL_CODES).toEqual(expect.arrayContaining(minimum));
    expect(new Set(api.AUTHORIZATION_DENIAL_CODES).size).toBe(api.AUTHORIZATION_DENIAL_CODES.length);
  });
});

describe("A2: Planning V5 y compatibilidad V4", () => {
  test("un V5 firma contractVersion, canonicalizerVersion e intents; adulterarlos invalida la revisión", async () => {
    const api = await loadActionIntentApi();
    const actionIntents = api.canonicalizeActionIntent(shellRequest(FOCUSED));
    const state = proposePlan(scope(), {
      ...planInput(FOCUSED),
      contractVersion: 5,
      canonicalizerVersion: "action-intent-v1",
      actionIntents,
    } as PlanInput);
    const record = state as unknown as Record<string, unknown>;

    expect(record).toMatchObject({
      version: 5,
      contractVersion: 5,
      canonicalizerVersion: "action-intent-v1",
    });
    expect(record.actionIntents).toEqual(actionIntents);
    const tampered = structuredClone(record);
    const tamperedIntents = tampered.actionIntents as Array<Record<string, unknown>>;
    tamperedIntents[0] = { ...tamperedIntents[0], actionID: "f".repeat(64) };
    expect(validState(tampered)).toBe(false);
  });

  test("la decisión V5 distingue estado, scope, acción, serialización, recursos, controles y respuesta host", async () => {
    const intentApi = await loadActionIntentApi();
    const decisionApi = await loadAuthorizationDecisionApi();
    const actionIntents = intentApi.canonicalizeActionIntent(shellRequest(FOCUSED));
    const presented = proposePlan(scope(), {
      ...planInput(FOCUSED),
      contractVersion: 5,
      canonicalizerVersion: "action-intent-v1",
      actionIntents,
    } as PlanInput);
    const running = authorizePlan(presented, presented.digest);
    const base = {
      state: running,
      scope: scope(),
      action: actionIntents[0],
      canonicalization: { status: "ok" },
      serialization: { matches: true },
      resourceScope: { inside: true },
      protectedApproval: { required: false, approved: false },
      host: { effect: "allow" },
      criticalControls: { authority: true, policy: true, toolHook: true, audit: true },
      now: Date.now(),
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, state: undefined }, "NO_ACTIVE_PLAN"],
      [{ ...base, state: { ...running, proof: "invalid" } }, "PLAN_INVALID"],
      [{ ...base, state: presented }, "PLAN_NOT_RUNNING"],
      [{ ...base, scope: { ...scope(), sessionID: "ses_other" } }, "SESSION_MISMATCH"],
      [{ ...base, scope: { ...scope(), project: "other" } }, "PROJECT_MISMATCH"],
      [{ ...base, scope: { ...scope(), mode: "assistant" } }, "MODE_MISMATCH"],
      [{ ...base, scope: { ...scope(), policyRevision: "e".repeat(32) } }, "POLICY_CHANGED"],
      [{ ...base, action: { ...actionIntents[0], actionID: "e".repeat(64) } }, "ACTION_NOT_DECLARED"],
      [{ ...base, canonicalization: { status: "error", code: "ACTION_NOT_CANONICALIZABLE" } }, "ACTION_NOT_CANONICALIZABLE"],
      [{ ...base, serialization: { matches: false } }, "ACTION_SERIALIZATION_MISMATCH"],
      [{ ...base, resourceScope: { inside: false } }, "RESOURCE_OUTSIDE_SCOPE"],
      [{ ...base, protectedApproval: { required: true, approved: false } }, "PROTECTED_APPROVAL_REQUIRED"],
      [{ ...base, host: { effect: "ask" } }, "HOST_ASK"],
      [{ ...base, host: { effect: "deny" } }, "HOST_DENY"],
      [{ ...base, criticalControls: { authority: true, policy: true, toolHook: false, audit: true } }, "CRITICAL_CONTROL_UNAVAILABLE"],
    ];

    for (const [candidate, code] of cases) {
      expect(decisionApi.decideAuthorization(candidate)).toEqual({ effect: "deny", code });
    }
    expect(decisionApi.decideAuthorization(base)).toEqual({
      effect: "allow",
      code: "AUTHORIZED",
      actionID: actionIntents[0]?.actionID,
    });
  });

  test("un V4 terminal sigue siendo legible y verificable", () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 41));
    const terminal = legacyV4State("completed", authority);

    expect(validState(terminal, authority)).toBe(true);
    expect(terminal).toMatchObject({ version: 4, phase: "completed" });
  });

  test("un V4 activo no se ejecuta ni migra silenciosamente", async () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 42));
    const active = legacyV4State("running", authority);
    const api = await loadAuthorizationDecisionApi();
    const decision = api.decideAuthorization({
      state: active,
      scope: {
        sessionID: SESSION,
        project: PROJECT,
        mode: "executor",
        policyRevision: "a".repeat(32),
      },
      action: { actionID: "d".repeat(64) },
      host: { effect: "allow" },
      criticalControls: { authority: true, policy: true, toolHook: true },
      now: NOW + 4,
    });

    expect(decision).toEqual({ effect: "deny", code: "PLAN_SCHEMA_UPGRADE_REQUIRED" });
    expect(active).toMatchObject({ version: 4, phase: "running" });
  });
});
