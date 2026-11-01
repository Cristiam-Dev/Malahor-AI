import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { authorizePlan, proposePlan, renderPlan, type PlanInput, type PlanScope, type PlanState } from "../src/cli/core/planning";
import { createPlanningAuthority } from "../src/cli/core/planning-authority";
import type { PluginAdapterOptions } from "../src/cli/core/hooks/plugin-adapter";
import { registerPlanCommand, type PlanCommandHost } from "../src/plugin/plan-command";
import { planKey, planRecordKey, planRevisionKey, type PlanningStorage } from "../src/plugin/planning";

const SESSION = "ses_plan_command";
let root: string;
let repo: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-plan-command-"));
  repo = path.join(root, "repo");
  home = path.join(root, "home");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ demo: { context: "memory", roots: [repo], defaultRoot: repo } }));
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify({ execution: { intervention: "ejecutar", verification: true, revision: "1".repeat(32) } }));
  env = { HOME: root, MALAHOR_HOME: home, MALAHOR_CONFIG: path.join(home, "config.jsonc"), MALAHOR_OPENCODE_DETECT: "0" };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function planInput(): PlanInput {
  return {
    summary: "fixture",
    steps: ["editar"],
    presentation: {
      objective: "Editar exclusivamente el fixture declarado.",
      outcome: "El fixture queda actualizado y su revisión sigue siendo verificable.",
      steps: [{
        title: "Editar el fixture",
        description: "Modificar a.ts sin tocar ninguna otra ruta.",
      }],
      impact: [{ area: "Código", description: "Solo cambia el fixture a.ts." }],
      risk: {
        level: "low",
        categories: [],
        summary: "Cambio local y acotado.",
        details: "No amplía permisos ni recursos autorizados.",
      },
      exclusions: ["Cualquier otra ruta"],
      completionCriteria: ["El estado refleja la transición solicitada"],
    },
    actions: [{ action: "edit", resource: path.join(repo, "a.ts") }],
  };
}

function commandFixtureInput(): PlanInput {
  return planInput();
}

function render(state: PlanState, view: "summary" | "technical" = "summary"): string {
  const renderer = renderPlan as unknown as (
    value: PlanState,
    options?: { view: "summary" | "technical" } | "summary" | "technical",
  ) => string;
  const summary = renderer(state);
  if (view === "summary") return summary;
  const withOptions = renderer(state, { view: "technical" });
  return withOptions !== summary ? withOptions : renderer(state, "technical");
}

describe("/malahor-plan", () => {
  test("status y controles conservan la misma revisión firmada", async () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 7));
    const scope: PlanScope = { sessionID: SESSION, project: "demo", mode: "executor", policyRevision: "1".repeat(32) };
    const presented = proposePlan(scope, commandFixtureInput(), Date.now(), "msg-plan", undefined, authority);
    const running = authorizePlan(presented, presented.digest, Date.now(), authority);
    const identity = { planID: running.planID, revision: running.revision, digest: running.digest };
    const records = new Map<string, unknown>();
    const storage: PlanningStorage = { get: async (key) => records.get(key), set: async (key, value) => { records.set(key, value); } };
    const save = async (state: PlanState) => {
      await storage.set(planRevisionKey(state.planID, state.revision), state);
      await storage.set(planRecordKey(state.planID), state);
      await storage.set(planKey(state.sessionID), state);
    };
    await save(running);
    const messages: string[] = [];
    const permissions: string[] = [];
    let execute!: (input: any) => Promise<void>;
    const host: PlanCommandHost = {
      command: { transform: async (callback) => callback({ add: (definition) => { execute = definition.execute; } }) },
      session: { synthetic: async ({ text }) => { messages.push(text); } },
      permission: { assert: async ({ action }) => { permissions.push(action); } },
    };
    const options: PluginAdapterOptions = {
      cwd: home,
      env,
      resolveSessionDirectory: async () => home,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
    };
    await registerPlanCommand(host, storage, authority, options);
    const invoke = (action: string) => execute({ sessionID: SESSION, prompt: { text: `/malahor-plan ${action}` }, delivery: "steer" });

    await invoke("status");
    expect(messages.at(-1)).toBe(render(records.get(planKey(SESSION)) as PlanState));
    expect(messages.at(-1)).toMatch(/^## Objetivo$/m);
    expect(messages.at(-1)).toMatch(/^## Al terminar$/m);
    for (const action of ["pause", "resume", "revoke"] as const) {
      await invoke(action);
      const current = records.get(planKey(SESSION)) as PlanState;
      expect({ planID: current.planID, revision: current.revision, digest: current.digest }).toEqual(identity);
      expect(messages.at(-1)).toBe(render(current));
      expect(messages.at(-1)).toContain(current.revision);
    }
    expect(permissions).toEqual(["malahor_plan_resume"]);
    expect((records.get(planKey(SESSION)) as PlanState).phase).toBe("revoked");
    await expect(invoke("resume")).rejects.toThrow();
  });

  test("detalles y details consultan sin mutar y muestran la vista técnica expandida", async () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 8));
    const scope: PlanScope = { sessionID: SESSION, project: "demo", mode: "executor", policyRevision: "1".repeat(32) };
    const state = proposePlan(scope, commandFixtureInput(), Date.now(), "msg-details", undefined, authority);
    const records = new Map<string, unknown>([[planKey(SESSION), state]]);
    let writes = 0;
    const storage: PlanningStorage = {
      get: async (key) => records.get(key),
      set: async (key, value) => { writes++; records.set(key, value); },
    };
    const messages: string[] = [];
    const permissions: string[] = [];
    let execute!: (input: any) => Promise<void>;
    const host: PlanCommandHost = {
      command: { transform: async (callback) => callback({ add: (definition) => { execute = definition.execute; } }) },
      session: { synthetic: async ({ text }) => { messages.push(text); } },
      permission: { assert: async ({ action }) => { permissions.push(action); } },
    };
    await registerPlanCommand(host, storage, authority, {
      cwd: home,
      env,
      resolveSessionDirectory: async () => home,
      resolveSessionProject: async () => ({ canonicalKey: "demo", root: repo }),
    });
    const invoke = (action: string) => execute({ sessionID: SESSION, prompt: { text: `/malahor-plan ${action}` }, delivery: "steer" });
    const before = structuredClone(records.get(planKey(SESSION)));

    await invoke("detalles");
    expect(messages.at(-1)).toBe(render(state, "technical"));
    expect(messages.at(-1)).toContain(state.planID);
    expect(messages.at(-1)).toContain(state.revision);
    expect(messages.at(-1)).toContain(state.digest);
    expect(messages.at(-1)?.includes("<details open>") || !messages.at(-1)?.includes("<details")).toBe(true);
    expect(records.get(planKey(SESSION))).toEqual(before);
    expect(writes).toBe(0);
    expect(permissions).toEqual([]);

    await invoke("details");
    expect(messages.at(-1)).toBe(messages.at(-2));
    expect(records.get(planKey(SESSION))).toEqual(before);
    expect(writes).toBe(0);
    expect(permissions).toEqual([]);
  });

  test("rechaza adjuntos y el uso enumera las vistas de detalle", async () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 9));
    const storage: PlanningStorage = { get: async () => undefined, set: async () => undefined };
    let execute!: (input: any) => Promise<void>;
    const host: PlanCommandHost = {
      command: { transform: async (callback) => callback({ add: (definition) => { execute = definition.execute; } }) },
      session: { synthetic: async () => undefined }, permission: { assert: async () => undefined },
    };
    await registerPlanCommand(host, storage, authority, { cwd: repo, env, resolveSessionDirectory: async () => repo });
    const usageError = await execute({
      sessionID: SESSION, prompt: { text: "/malahor-plan unknown" }, delivery: "steer",
    }).then(() => undefined, (error: unknown) => error);
    expect(usageError).toBeInstanceOf(Error);
    expect((usageError as Error).message).toMatch(/Uso:/i);
    expect((usageError as Error).message).toContain("detalles");
    expect((usageError as Error).message).toContain("details");
    await expect(execute({ sessionID: SESSION, prompt: { text: "/malahor-plan status", files: ["x"] }, delivery: "steer" })).rejects.toThrow(/adjuntos/);
  });
});
