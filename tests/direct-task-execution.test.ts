import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  TASK_CLASSIFICATION_SCHEMA,
  deriveTaskDecision,
  type TaskAssessmentV1,
  type TaskClassificationContext,
  type TaskDecisionV1,
} from "../src/cli/core/task-classification";
import {
  DIRECT_TASK_APPROVAL,
  createDirectTaskRegistry,
  type DirectTaskApprovalPort,
  type DirectTaskScope,
} from "../src/plugin/direct-task-execution";

const SESSION = "ses_direct_task";
const MESSAGE = "msg_direct_task";
const CALL_ID = "call_direct_task";
const SUBJECT = "src/example.ts";

let root: string;
let scope: DirectTaskScope;
let context: TaskClassificationContext;
let approvalRequests: Record<string, unknown>[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join("/tmp/opencode", "malahor-direct-task-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, SUBJECT), "export const value = 1;\n", "utf8");
  scope = {
    sessionID: SESSION,
    project: "demo",
    policyRevision: "policy-1",
    mode: "executor",
    root,
  };
  context = {
    sessionID: SESSION,
    messageID: MESSAGE,
    project: "demo",
    root,
    mode: "executor",
    policyRevision: "policy-1",
  };
  approvalRequests = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function assessment(overrides: Partial<TaskAssessmentV1> = {}): TaskAssessmentV1 {
  return {
    schema: TASK_CLASSIFICATION_SCHEMA,
    understood: true,
    requestedEffect: "mutation",
    userRequestedPlanning: false,
    symptomOrCauseUnknown: false,
    signals: {
      specification: "low", discovery: "low", scope: "low",
      openDecisions: "low", reversibility: "low", verifiability: "low",
    },
    closure: {
      action: "known", targets: "known", verification: "objective",
      discovery: "none", openDecisionCount: 0,
    },
    proof: {
      effect: "Reemplaza una línea exacta.",
      targets: SUBJECT,
      verification: "El test focalizado termina con código cero.",
    },
    ...overrides,
  };
}

function directDecision(overrides: Partial<TaskAssessmentV1> = {}): TaskDecisionV1 {
  return deriveTaskDecision(assessment(overrides), context);
}

function preparation(decision: TaskDecisionV1) {
  return {
    decisionRef: decision.decisionRef,
    summary: "Reemplaza una línea exacta del fixture.",
    mutations: [{
      kind: "edit" as const,
      path: SUBJECT,
      existence: "must-exist" as const,
      payload: { path: SUBJECT, oldString: "export const value = 1;", newString: "export const value = 2;" },
    }],
    verification: [{ kind: "shell" as const, argv: ["git", "status", "--short"] }],
  };
}

function approvalPort(): DirectTaskApprovalPort {
  return {
    assert: async (request) => {
      approvalRequests.push(structuredClone(request));
    },
  };
}

function toolCall(value: Record<string, unknown>, messageID = MESSAGE, id = CALL_ID) {
  return { sessionID: SESSION, agent: "malahor", messageID, id };
}

describe("ejecución directa", () => {
  test("prepara un envelope, pide un ASK y autoriza la edición exacta una sola vez", async () => {
    const registry = createDirectTaskRegistry();
    const decision = directDecision();
    const result = await registry.prepare(
      preparation(decision),
      toolCall({}),
      scope,
      decision,
      approvalPort(),
      async () => scope,
    );

    expect(result.envelope.actions).toHaveLength(1);
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      action: DIRECT_TASK_APPROVAL,
      save: [],
    });

    const call = { messageID: "msg_gate", toolCallID: "call_gate" };
    const input = { ...call, scope, tool: "edit", value: preparation(decision).mutations[0]!.payload, boundary: "tool" as const };
    expect(registry.authorizeTool(input)).toEqual({ effect: "allow" });
    expect(registry.authorizeTool({ ...input, boundary: "permission" })).toEqual({ effect: "allow" });
    expect(registry.authorizeTool({ ...input, boundary: "tool" })).toEqual({
      effect: "deny", code: "DIRECT_GRANT_MISMATCH",
    });
  });

  test("rechaza una decisión que no es directa y no pide aprobación", async () => {
    const registry = createDirectTaskRegistry();
    const decision = directDecision({ userRequestedPlanning: true });
    await expect(registry.prepare(
      preparation(decision),
      toolCall({}),
      scope,
      decision,
      approvalPort(),
      async () => scope,
    )).rejects.toThrow(/direct/i);
    expect(approvalRequests).toHaveLength(0);
  });

  test("rechaza paths fuera de raíz, payload sensible y verificación no read-only", async () => {
    const registry = createDirectTaskRegistry();
    const decision = directDecision();
    const base = preparation(decision);

    await expect(registry.prepare({
      ...base,
      mutations: [{ ...base.mutations[0]!, path: "../outside.ts" }],
    }, toolCall({}), scope, decision, approvalPort(), async () => scope)).rejects.toThrow(/ruta/i);

    await expect(registry.prepare({
      ...base,
      mutations: [{
        ...base.mutations[0]!,
        payload: {
          [["api", "key"].join("_")]: ["synthetic", "0123456789abcdef"].join("-"),
        },
      }],
    }, toolCall({}), scope, decision, approvalPort(), async () => scope)).rejects.toThrow(/sensible/i);

    await expect(registry.prepare({
      ...base,
      verification: [{ kind: "shell", argv: ["rm", "-rf", "dist"] }],
    }, toolCall({}), scope, decision, approvalPort(), async () => scope)).rejects.toThrow(/verificación/i);
  });

  test("un cambio de scope durante la aprobación invalida el envelope", async () => {
    const registry = createDirectTaskRegistry();
    const decision = directDecision();
    await expect(registry.prepare(
      preparation(decision),
      toolCall({}),
      scope,
      decision,
      approvalPort(),
      async () => ({ ...scope, policyRevision: "policy-2" }),
    )).rejects.toThrow(/cambió/i);
  });
});
