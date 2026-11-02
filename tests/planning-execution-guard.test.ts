import { describe, expect, test } from "bun:test";

const PLAN_ID = "1".repeat(32);
const REVISION = "2".repeat(32);
const PLAN_DIGEST = "3".repeat(64);
const EDIT_ACTION = "4".repeat(64);
const FOCUSED_ACTION = "5".repeat(64);
const HOOKS_ACTION = "6".repeat(64);
const NEW_ACTION = "7".repeat(64);

interface AttemptRecord {
  attemptID: string;
  actionID: string;
  ordinal: number;
  decisionCode: string;
  canonicalInputHash: string;
  errorHash?: string;
}

interface GuardResult {
  decision: "continue" | "retry" | "block";
  code: string;
  retryAllowed: boolean;
  requiresPlanRevision?: boolean;
  attempt?: AttemptRecord;
}

interface ExecutionGuard {
  recordAttempt(input: Record<string, unknown>): Promise<GuardResult>;
  snapshot(): Promise<{
    plan: { planID: string; revision: string; digest: string; phase: string };
    attempts: AttemptRecord[];
    counters: { modelCalls: number; planRevisions: number; loopBlocks: number };
  }>;
}

interface ExecutionGuardApi {
  createExecutionGuard(input: Record<string, unknown>): ExecutionGuard;
}

async function loadExecutionGuardApi(): Promise<ExecutionGuardApi> {
  const modulePath = "../src/plugin/execution-guard";
  try {
    return await import(modulePath) as unknown as ExecutionGuardApi;
  } catch (cause) {
    throw new Error(`API normativa ausente: ${modulePath} (attempts y loop guard).`, { cause });
  }
}

async function guard(): Promise<ExecutionGuard> {
  const api = await loadExecutionGuardApi();
  return api.createExecutionGuard({
    plan: {
      planID: PLAN_ID,
      revision: REVISION,
      digest: PLAN_DIGEST,
      phase: "running",
      actionIDs: [EDIT_ACTION, FOCUSED_ACTION, HOOKS_ACTION],
    },
  });
}

function failedAttempt(
  actionID = FOCUSED_ACTION,
  resourceDigest = "sha256:resource-v1",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actionID,
    decisionCode: "AUTHORIZED",
    canonicalInputHash: "sha256:focused-test",
    resourceDigests: { before: [resourceDigest], after: [resourceDigest] },
    result: { class: "failure", exitCode: 1, errorHash: "sha256:test-failure" },
    durationMs: 25,
    inputBytes: 128,
    outputBytes: 256,
    ...overrides,
  };
}

function successfulEdit(before: string, after: string): Record<string, unknown> {
  return {
    actionID: EDIT_ACTION,
    decisionCode: "AUTHORIZED",
    canonicalInputHash: "sha256:authorized-edit",
    resourceDigests: { before: [before], after: [after] },
    result: { class: "success", exitCode: 0 },
    durationMs: 10,
    inputBytes: 64,
    outputBytes: 0,
  };
}

describe("A3: attempts separados de la revisión", () => {
  test("expone la API normativa del execution guard", async () => {
    const api = await loadExecutionGuardApi();

    expect(typeof api.createExecutionGuard).toBe("function");
    expect(typeof (await guard()).recordAttempt).toBe("function");
  });

  test("un retry equivalente crea otro attemptID sin cambiar digest ni revisión", async () => {
    const execution = await guard();
    const first = await execution.recordAttempt(failedAttempt());
    const second = await execution.recordAttempt(failedAttempt());
    const snapshot = await execution.snapshot();

    expect(first).toMatchObject({ decision: "retry", retryAllowed: true });
    expect(first.attempt).toMatchObject({ actionID: FOCUSED_ACTION, ordinal: 1 });
    expect(second.attempt).toMatchObject({ actionID: FOCUSED_ACTION, ordinal: 2 });
    expect(second.attempt?.attemptID).not.toBe(first.attempt?.attemptID);
    expect(snapshot.plan).toEqual({
      planID: PLAN_ID,
      revision: REVISION,
      digest: PLAN_DIGEST,
      phase: "blocked",
    });
    expect(snapshot.attempts).toHaveLength(2);
  });

  test("el segundo fallo idéntico sin progreso bloquea de forma determinista y no crea plan ni llama a modelo", async () => {
    const execution = await guard();
    await execution.recordAttempt(failedAttempt());
    const blocked = await execution.recordAttempt(failedAttempt());
    const snapshot = await execution.snapshot();

    expect(blocked).toMatchObject({
      decision: "block",
      code: "LOOP_GUARD_STALLED",
      retryAllowed: false,
      requiresPlanRevision: false,
    });
    expect(snapshot.counters).toEqual({ modelCalls: 0, planRevisions: 0, loopBlocks: 1 });
    expect(snapshot.plan.revision).toBe(REVISION);
    expect(snapshot.plan.digest).toBe(PLAN_DIGEST);
  });

  test("editar un recurso autorizado cuenta como progreso y permite repetir la validación", async () => {
    const execution = await guard();
    await execution.recordAttempt(failedAttempt(FOCUSED_ACTION, "sha256:resource-v1"));
    const edit = await execution.recordAttempt(successfulEdit("sha256:resource-v1", "sha256:resource-v2"));
    const retried = await execution.recordAttempt(failedAttempt(FOCUSED_ACTION, "sha256:resource-v2"));
    const snapshot = await execution.snapshot();

    expect(edit).toMatchObject({ decision: "continue", retryAllowed: false });
    expect(retried).toMatchObject({ decision: "retry", retryAllowed: true });
    expect(snapshot.plan.phase).toBe("running");
    expect(snapshot.attempts.map((attempt) => attempt.ordinal)).toEqual([1, 1, 2]);
    expect(snapshot.counters.loopBlocks).toBe(0);
  });

  test("HOST_ASK, HOST_DENY y un cambio material bloquean sin retry ni auto-plan", async () => {
    for (const code of ["HOST_ASK", "HOST_DENY"] as const) {
      const execution = await guard();
      const result = await execution.recordAttempt({
        ...failedAttempt(),
        decisionCode: code,
        result: { class: "not-run" },
      });
      const snapshot = await execution.snapshot();

      expect(result).toMatchObject({ decision: "block", code, retryAllowed: false });
      expect(snapshot.attempts).toHaveLength(1);
      expect(snapshot.counters.planRevisions).toBe(0);
    }

    const execution = await guard();
    const changed = await execution.recordAttempt(failedAttempt(NEW_ACTION));
    const snapshot = await execution.snapshot();
    expect(changed).toMatchObject({
      decision: "block",
      code: "ACTION_NOT_DECLARED",
      retryAllowed: false,
      requiresPlanRevision: true,
    });
    expect(snapshot.attempts).toHaveLength(0);
    expect(snapshot.counters).toMatchObject({ modelCalls: 0, planRevisions: 0 });
  });

  test("un mismatch de serialización solo admite una reparación equivalente", async () => {
    const execution = await guard();
    const first = await execution.recordAttempt({
      ...failedAttempt(),
      decisionCode: "ACTION_SERIALIZATION_MISMATCH",
      adapterRepair: { equivalent: true, repairedInputHash: "sha256:focused-test" },
      result: { class: "not-run" },
    });
    const second = await execution.recordAttempt({
      ...failedAttempt(),
      decisionCode: "ACTION_SERIALIZATION_MISMATCH",
      adapterRepair: { equivalent: true, repairedInputHash: "sha256:focused-test" },
      result: { class: "not-run" },
    });

    expect(first).toMatchObject({ decision: "retry", code: "ADAPTER_REPAIR_APPLIED", retryAllowed: true });
    expect(second).toMatchObject({ decision: "block", code: "ADAPTER_REPAIR_EXHAUSTED", retryAllowed: false });
  });
});

describe("regresión sintética equivalente a Horiel P5 pausado", () => {
  test("una sola revisión permite comando focalizado, split/join y retry tras edit; una acción nueva bloquea", async () => {
    const execution = await guard();
    const focused = await execution.recordAttempt(failedAttempt(FOCUSED_ACTION, "sha256:p5-v1"));
    await execution.recordAttempt(successfulEdit("sha256:p5-v1", "sha256:p5-v2"));
    const retry = await execution.recordAttempt(failedAttempt(FOCUSED_ACTION, "sha256:p5-v2"));
    const joined = await execution.recordAttempt({
      actionIDs: [FOCUSED_ACTION, HOOKS_ACTION],
      decisionCode: "AUTHORIZED",
      canonicalInputHash: "sha256:ordered-validation-sequence",
      resourceDigests: { before: ["sha256:p5-v2"], after: ["sha256:p5-v2"] },
      result: { class: "success", exitCode: 0 },
      durationMs: 40,
      inputBytes: 64,
      outputBytes: 64,
    });
    const newAction = await execution.recordAttempt(failedAttempt(NEW_ACTION, "sha256:p5-v2"));
    const snapshot = await execution.snapshot();

    expect(focused.decision).toBe("retry");
    expect(retry.decision).toBe("retry");
    expect(joined).toMatchObject({ decision: "continue", code: "AUTHORIZED" });
    expect(newAction).toMatchObject({ decision: "block", code: "ACTION_NOT_DECLARED" });
    expect(snapshot.plan).toMatchObject({ planID: PLAN_ID, revision: REVISION, digest: PLAN_DIGEST });
    expect(snapshot.counters).toMatchObject({ modelCalls: 0, planRevisions: 0 });
  });
});
