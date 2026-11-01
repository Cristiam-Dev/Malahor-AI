import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { authorizePlan, proposePlan, type PlanScope, type PlanState } from "../src/cli/core/planning";
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

describe("/malahor-plan", () => {
  test("status, pause, resume y revoke usan el mismo estado firmado", async () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 7));
    const scope: PlanScope = { sessionID: SESSION, project: "demo", mode: "executor", policyRevision: "1".repeat(32) };
    const presented = proposePlan(scope, { summary: "fixture", steps: ["editar"], actions: [{ action: "edit", resource: path.join(repo, "a.ts") }] }, Date.now(), "msg-plan", undefined, authority);
    const running = authorizePlan(presented, presented.digest, Date.now(), authority);
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
    expect(messages.at(-1)).toContain("Estado: running");
    await invoke("pause");
    expect(messages.at(-1)).toContain("Estado: paused");
    await invoke("resume");
    expect(messages.at(-1)).toContain("Estado: running");
    expect(permissions).toEqual(["malahor_plan_resume"]);
    await invoke("revoke");
    expect(messages.at(-1)).toContain("Estado: revoked");
    await expect(invoke("resume")).rejects.toThrow();
  });

  test("rechaza adjuntos y comandos desconocidos", async () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 9));
    const storage: PlanningStorage = { get: async () => undefined, set: async () => undefined };
    let execute!: (input: any) => Promise<void>;
    const host: PlanCommandHost = {
      command: { transform: async (callback) => callback({ add: (definition) => { execute = definition.execute; } }) },
      session: { synthetic: async () => undefined }, permission: { assert: async () => undefined },
    };
    await registerPlanCommand(host, storage, authority, { cwd: repo, env, resolveSessionDirectory: async () => repo });
    await expect(execute({ sessionID: SESSION, prompt: { text: "/malahor-plan unknown" }, delivery: "steer" })).rejects.toThrow(/Uso/);
    await expect(execute({ sessionID: SESSION, prompt: { text: "/malahor-plan status", files: ["x"] }, delivery: "steer" })).rejects.toThrow(/adjuntos/);
  });
});
