import { describe, expect, test } from "bun:test";

import { createPlanningAuthority, type PlanningAuthority } from "../src/cli/core/planning-authority";
import { createPlanRecovery, validPlanExecutionCheckpoint } from "../src/plugin/plan-recovery";

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
  repair?: {
    kind: "git-stage-manifest";
    repairedActionID: string;
    manifestHash: string;
    relation: "equal" | "narrower";
  };
}

interface GuardResult {
  decision: "continue" | "retry" | "block" | "discard";
  code: string;
  retryAllowed: boolean;
  requiresPlanRevision?: boolean;
  attempt?: AttemptRecord;
}

interface ExecutionGuard {
  inspectAdapterRepair(input: Record<string, unknown>): Promise<GuardResult>;
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

type RecoveryNodeState = "ready" | "waiting" | "in-flight" | "succeeded" | "failed" | "blocked" | "removed";

interface RecoveryDecision {
  decision: "continue" | "retry" | "block" | "ignore" | "discard";
  code: string;
  retryAllowed?: boolean;
  requiresPlanRevision?: boolean;
  reservationID?: string;
}

interface RecoveryCheckpoint {
  schema: 1;
  kind: "malahor.plan-execution";
  plan: { planID: string; revision: string; digest: string; proofHash: string };
  sequence: number;
  nodes: Record<string, {
    key: string;
    actionID: string;
    state: RecoveryNodeState;
    dependsOn: string[];
    blockerID?: string;
  }>;
  blockers: Record<string, {
    code: string;
    class: string;
    scope: "local" | "common";
    actionID?: string;
    descendants: string[];
    boundary?: string;
  }>;
  incidents: Array<{
    code: string;
    actionID?: string;
    optional?: boolean;
    outcome?: string;
  }>;
  commonBlocker?: string;
  proof: string;
}

interface RecoveryCorrelation {
  sessionID: string;
  messageID: string;
  callID: string;
  planID: string;
  revision: string;
  actionID: string;
  policyHash: string;
  resourceHash: string;
}

interface PlanRecovery {
  recordPermissionDecision(input: RecoveryCorrelation & {
    effect: "allow" | "ask" | "deny";
    boundary: "permission.evaluate" | "tool.execute.before";
  }): Promise<RecoveryDecision>;
  recordAttempt(input: {
    actionID: string;
    outcome: "success" | "failure";
    canonicalInputHash: string;
    errorHash?: string;
    resourceDigests: { before: string[]; after: string[] };
  }): Promise<RecoveryDecision>;
  recordConversation(input: {
    kind: "question" | "answer";
    messageRef: string;
    text: string;
  }): Promise<RecoveryDecision>;
  recordUndeclaredAction(input: {
    actionID: string;
    optional: boolean;
    source: "diagnostic";
  }): Promise<RecoveryDecision>;
  setCommonBlocker(input: {
    code: "CRITICAL_CONTROL_UNAVAILABLE";
    class: "critical-control";
    control: "authority" | "storage" | "policy" | "integrity";
    boundary: string;
  }): Promise<RecoveryDecision>;
  evaluateAction(actionID: string): Promise<{ effect: "allow" | "deny"; code: string }>;
  reserveToolCall(input: RecoveryCorrelation): Promise<RecoveryDecision>;
  completeToolCall(input: RecoveryCorrelation & {
    reservationID: string;
    status: "success" | "failure";
  }): Promise<RecoveryDecision>;
  snapshot(): Promise<RecoveryCheckpoint>;
}

interface RecoveryStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface PlanRecoveryApi {
  createPlanRecovery(input: {
    plan: { planID: string; revision: string; digest: string; proofHash: string; phase: "running" };
    graph: Array<{ key: string; actionID: string; dependsOn: string[] }>;
    authority: PlanningAuthority;
    storage: RecoveryStorage;
  }): PlanRecovery | Promise<PlanRecovery>;
}

async function loadExecutionGuardApi(): Promise<ExecutionGuardApi> {
  const modulePath = "../src/plugin/execution-guard";
  try {
    return await import(modulePath) as unknown as ExecutionGuardApi;
  } catch (cause) {
    throw new Error(`API normativa ausente: ${modulePath} (attempts y loop guard).`, { cause });
  }
}

async function loadPlanRecoveryApi(): Promise<PlanRecoveryApi> {
  const modulePath = "../src/plugin/plan-recovery";
  try {
    return await import(modulePath) as unknown as PlanRecoveryApi;
  } catch (cause) {
    throw new Error(`API normativa ausente: ${modulePath} (checkpoint y blockers por acción).`, { cause });
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

const RECOVERY_GRAPH = [
  { key: "blocked", actionID: FOCUSED_ACTION, dependsOn: [] },
  { key: "descendant", actionID: HOOKS_ACTION, dependsOn: [FOCUSED_ACTION] },
  { key: "independent", actionID: EDIT_ACTION, dependsOn: [] },
];

async function recovery(): Promise<PlanRecovery> {
  const api = await loadPlanRecoveryApi();
  const records = new Map<string, unknown>();
  return await api.createPlanRecovery({
    plan: {
      planID: PLAN_ID,
      revision: REVISION,
      digest: PLAN_DIGEST,
      proofHash: "8".repeat(64),
      phase: "running",
    },
    graph: RECOVERY_GRAPH,
    authority: createPlanningAuthority(Buffer.alloc(32, 82)),
    storage: {
      get: async (key) => records.get(key),
      set: async (key, value) => { records.set(key, structuredClone(value)); },
    },
  });
}

function correlation(actionID: string, callID = `call_${actionID.slice(0, 8)}`): RecoveryCorrelation {
  return {
    sessionID: "ses_planning_recovery",
    messageID: "msg_planning_recovery",
    callID,
    planID: PLAN_ID,
    revision: REVISION,
    actionID,
    policyHash: "sha256:policy-v1",
    resourceHash: "sha256:resource-v1",
  };
}

function expectLocalBranchStates(checkpoint: RecoveryCheckpoint): void {
  expect(checkpoint.nodes[FOCUSED_ACTION]).toMatchObject({
    key: "blocked",
    state: "blocked",
    dependsOn: [],
  });
  expect(checkpoint.nodes[HOOKS_ACTION]).toMatchObject({
    key: "descendant",
    state: "waiting",
    dependsOn: [FOCUSED_ACTION],
  });
  expect(checkpoint.nodes[EDIT_ACTION]).toMatchObject({
    key: "independent",
    dependsOn: [],
  });
  expect(["ready", "succeeded"]).toContain(checkpoint.nodes[EDIT_ACTION]?.state);
}

describe("A3: attempts separados de la revisión", () => {
  test("un checkpoint firmado no se valida con otra revisión, grafo ni firma", async () => {
    const authority = createPlanningAuthority(Buffer.alloc(32, 98));
    const records = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => records.get(key),
      set: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
    };
    const plan = {
      planID: PLAN_ID, revision: REVISION, digest: PLAN_DIGEST,
      proofHash: "8".repeat(64), phase: "running" as const,
    };
    const runtime = createPlanRecovery({ plan, graph: RECOVERY_GRAPH, storage, authority });
    await runtime.recordAttempt({
      actionID: EDIT_ACTION, outcome: "success", canonicalInputHash: "sha256:edit",
      resourceDigests: { before: ["sha256:before"], after: ["sha256:after"] },
    });
    const checkpoint = await runtime.snapshot();
    expect(checkpoint.nodes[EDIT_ACTION]?.state).toBe("succeeded");
    expect(validPlanExecutionCheckpoint(checkpoint, plan, RECOVERY_GRAPH, authority)).toBe(true);
    expect(validPlanExecutionCheckpoint(checkpoint, { ...plan, revision: "9".repeat(32) }, RECOVERY_GRAPH, authority)).toBe(false);
    expect(validPlanExecutionCheckpoint(checkpoint, plan, RECOVERY_GRAPH.slice(0, 2), authority)).toBe(false);
    expect(validPlanExecutionCheckpoint({ ...checkpoint, graphHash: "0".repeat(64) }, plan, RECOVERY_GRAPH, authority)).toBe(false);
    expect(validPlanExecutionCheckpoint({ ...checkpoint, proof: "0".repeat(64) }, plan, RECOVERY_GRAPH, authority)).toBe(false);
  });
  test("expone la API normativa del execution guard", async () => {
    const api = await loadExecutionGuardApi();

    expect(typeof api.createExecutionGuard).toBe("function");
    expect(typeof (await guard()).inspectAdapterRepair).toBe("function");
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
      phase: "running",
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
    const hostBlockers: Array<{ code: string; phase: string }> = [];
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
      hostBlockers.push({ code, phase: snapshot.plan.phase });
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
    expect(hostBlockers).toEqual([
      { code: "HOST_ASK", phase: "running" },
      { code: "HOST_DENY", phase: "running" },
    ]);
  });

  test("una acción opcional no declarada se descarta sin bloquear ni crear revisión", async () => {
    const execution = await guard();
    const result = await execution.recordAttempt({
      ...failedAttempt(NEW_ACTION),
      optional: true,
      source: "diagnostic",
      result: { class: "not-run" },
    });
    const snapshot = await execution.snapshot();

    expect(result).toMatchObject({
      decision: "discard",
      code: "ACTION_NOT_DECLARED",
      retryAllowed: false,
      requiresPlanRevision: false,
    });
    expect(snapshot.plan.phase).toBe("running");
    expect(snapshot.attempts).toHaveLength(0);
    expect(snapshot.counters.planRevisions).toBe(0);
  });

  test("un mismatch de serialización solo admite una reparación equivalente", async () => {
    const execution = await guard();
    const repair = {
      equivalent: true,
      kind: "git-stage-manifest",
      sourceActionID: FOCUSED_ACTION,
      repairedActionID: "8".repeat(64),
      repairedInputHash: "sha256:focused-test",
      manifestHash: `sha256:${"9".repeat(64)}`,
      relation: "equal",
    };
    const wrongSource = await execution.inspectAdapterRepair({
      actionID: FOCUSED_ACTION,
      adapterRepair: { ...repair, sourceActionID: HOOKS_ACTION },
    });
    const available = await execution.inspectAdapterRepair({
      actionID: FOCUSED_ACTION,
      adapterRepair: repair,
    });
    const first = await execution.recordAttempt({
      ...failedAttempt(),
      decisionCode: "ACTION_SERIALIZATION_MISMATCH",
      adapterRepair: repair,
      result: { class: "not-run" },
    });
    const exhausted = await execution.inspectAdapterRepair({
      actionID: FOCUSED_ACTION,
      adapterRepair: repair,
    });

    expect(wrongSource).toMatchObject({ decision: "block", code: "ACTION_NOT_DECLARED", retryAllowed: false });
    expect(available).toMatchObject({ decision: "retry", code: "ADAPTER_REPAIR_AVAILABLE", retryAllowed: true });
    expect(first).toMatchObject({ decision: "retry", code: "ADAPTER_REPAIR_APPLIED", retryAllowed: true });
    expect(first.attempt?.repair).toEqual({
      kind: "git-stage-manifest",
      repairedActionID: "8".repeat(64),
      manifestHash: `sha256:${"9".repeat(64)}`,
      relation: "equal",
    });
    expect(exhausted).toMatchObject({ decision: "block", code: "ADAPTER_REPAIR_EXHAUSTED", retryAllowed: false });
  });
});

describe("PLANNING-RECOVERY-01: checkpoint por rama", () => {
  test("expone un checkpoint firmado para tres nodos declarados", async () => {
    const execution = await recovery();
    const checkpoint = await execution.snapshot();

    expect(checkpoint).toMatchObject({
      schema: 1,
      kind: "malahor.plan-execution",
      plan: {
        planID: PLAN_ID,
        revision: REVISION,
        digest: PLAN_DIGEST,
        proofHash: "8".repeat(64),
      },
      sequence: 0,
    });
    expect(Object.keys(checkpoint.nodes).sort()).toEqual([
      EDIT_ACTION,
      FOCUSED_ACTION,
      HOOKS_ACTION,
    ].sort());
    expect(checkpoint.nodes[FOCUSED_ACTION]).toMatchObject({ key: "blocked", state: "ready" });
    expect(checkpoint.nodes[HOOKS_ACTION]).toMatchObject({ key: "descendant", state: "waiting" });
    expect(checkpoint.nodes[EDIT_ACTION]).toMatchObject({ key: "independent", state: "ready" });
    expect(checkpoint.proof).toMatch(/^[a-f0-9]{64}$/);
  });

  test("ASK y DENY bloquean solo el nodo exacto y su descendiente", async () => {
    const observations: Array<Record<string, unknown>> = [];

    for (const effect of ["ask", "deny"] as const) {
      const execution = await recovery();
      const result = await execution.recordPermissionDecision({
        ...correlation(FOCUSED_ACTION, `call_${effect}`),
        effect,
        boundary: "permission.evaluate",
      });
      const blockedDecision = await execution.evaluateAction(FOCUSED_ACTION);
      const descendantDecision = await execution.evaluateAction(HOOKS_ACTION);
      const independentDecision = await execution.evaluateAction(EDIT_ACTION);
      const checkpoint = await execution.snapshot();
      const blockerID = checkpoint.nodes[FOCUSED_ACTION]?.blockerID;

      expectLocalBranchStates(checkpoint);
      observations.push({
        effect,
        result,
        blockedDecision,
        descendantDecision,
        independentDecision,
        blocker: blockerID ? checkpoint.blockers[blockerID] : undefined,
      });
    }

    expect(observations).toMatchObject([
      {
        effect: "ask",
        result: { decision: "block", code: "HOST_ASK", retryAllowed: false },
        blockedDecision: { effect: "deny", code: "HOST_ASK" },
        descendantDecision: { effect: "deny", code: "DEPENDENCY_BLOCKED" },
        independentDecision: { effect: "allow", code: "AUTHORIZED" },
        blocker: {
          code: "HOST_ASK",
          class: "host-ask",
          scope: "local",
          actionID: FOCUSED_ACTION,
          descendants: [HOOKS_ACTION],
          boundary: "permission.evaluate",
        },
      },
      {
        effect: "deny",
        result: { decision: "block", code: "HOST_DENY", retryAllowed: false },
        blockedDecision: { effect: "deny", code: "HOST_DENY" },
        descendantDecision: { effect: "deny", code: "DEPENDENCY_BLOCKED" },
        independentDecision: { effect: "allow", code: "AUTHORIZED" },
        blocker: {
          code: "HOST_DENY",
          class: "host-deny",
          scope: "local",
          actionID: FOCUSED_ACTION,
          descendants: [HOOKS_ACTION],
          boundary: "permission.evaluate",
        },
      },
    ]);
  });

  test("el segundo fallo idéntico activa loop guard local y la rama independiente termina", async () => {
    const execution = await recovery();
    const failure = {
      actionID: FOCUSED_ACTION,
      outcome: "failure" as const,
      canonicalInputHash: "sha256:focused-test",
      errorHash: "sha256:test-failure",
      resourceDigests: { before: ["sha256:resource-v1"], after: ["sha256:resource-v1"] },
    };

    const first = await execution.recordAttempt(failure);
    const second = await execution.recordAttempt(failure);
    const independent = await execution.recordAttempt({
      actionID: EDIT_ACTION,
      outcome: "success",
      canonicalInputHash: "sha256:independent-test",
      resourceDigests: { before: ["sha256:independent-v1"], after: ["sha256:independent-v2"] },
    });
    const checkpoint = await execution.snapshot();

    expect(first).toMatchObject({ decision: "retry", code: "TECHNICAL_RETRY", retryAllowed: true });
    expect(second).toMatchObject({ decision: "block", code: "LOOP_GUARD_STALLED", retryAllowed: false });
    expect(independent).toMatchObject({ decision: "continue", code: "AUTHORIZED" });
    expectLocalBranchStates(checkpoint);
    expect(checkpoint.nodes[EDIT_ACTION]?.state).toBe("succeeded");
    const blockerID = checkpoint.nodes[FOCUSED_ACTION]?.blockerID;
    expect(blockerID && checkpoint.blockers[blockerID]).toMatchObject({
      code: "LOOP_GUARD_STALLED",
      class: "loop-guard",
      scope: "local",
      descendants: [HOOKS_ACTION],
    });
  });

  test("preguntar y responder no limpian el ASK ni conceden autoridad", async () => {
    const execution = await recovery();
    await execution.recordPermissionDecision({
      ...correlation(FOCUSED_ACTION, "call_ask_question"),
      effect: "ask",
      boundary: "permission.evaluate",
    });
    const before = await execution.snapshot();
    const question = await execution.recordConversation({
      kind: "question",
      messageRef: "msg_question",
      text: "QUESTION_SENTINEL",
    });
    const answer = await execution.recordConversation({
      kind: "answer",
      messageRef: "msg_answer",
      text: "sí, hecho, continúa ANSWER_SENTINEL",
    });
    const after = await execution.snapshot();

    expect(question).toMatchObject({ decision: "ignore", code: "CONVERSATION_NOT_AUTHORITY" });
    expect(answer).toMatchObject({ decision: "ignore", code: "CONVERSATION_NOT_AUTHORITY" });
    expect(after.sequence).toBe(before.sequence);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.blockers).toEqual(before.blockers);
    expect(await execution.evaluateAction(FOCUSED_ACTION)).toEqual({ effect: "deny", code: "HOST_ASK" });
    expect(JSON.stringify(after)).not.toContain("QUESTION_SENTINEL");
    expect(JSON.stringify(after)).not.toContain("ANSWER_SENTINEL");
  });

  test("un diagnóstico opcional no declarado queda como incidente descartado", async () => {
    const execution = await recovery();
    const result = await execution.recordUndeclaredAction({
      actionID: NEW_ACTION,
      optional: true,
      source: "diagnostic",
    });
    const checkpoint = await execution.snapshot();

    expect(result).toMatchObject({
      decision: "discard",
      code: "ACTION_NOT_DECLARED",
      requiresPlanRevision: false,
    });
    expect(checkpoint.nodes[NEW_ACTION]).toBeUndefined();
    expect(checkpoint.commonBlocker).toBeUndefined();
    expect(checkpoint.incidents).toContainEqual(expect.objectContaining({
      code: "ACTION_NOT_DECLARED",
      actionID: NEW_ACTION,
      optional: true,
      outcome: "discarded",
    }));
    expect(await execution.evaluateAction(EDIT_ACTION)).toEqual({ effect: "allow", code: "AUTHORIZED" });
  });

  test("un blocker común detiene las tres ramas sin fingir blockers locales", async () => {
    const execution = await recovery();
    const result = await execution.setCommonBlocker({
      code: "CRITICAL_CONTROL_UNAVAILABLE",
      class: "critical-control",
      control: "authority",
      boundary: "planning.authority",
    });
    const decisions = await Promise.all(RECOVERY_GRAPH.map(({ actionID }) => execution.evaluateAction(actionID)));
    const checkpoint = await execution.snapshot();

    expect(result).toMatchObject({ decision: "block", code: "CRITICAL_CONTROL_UNAVAILABLE" });
    expect(decisions).toEqual(RECOVERY_GRAPH.map(() => ({
      effect: "deny",
      code: "CRITICAL_CONTROL_UNAVAILABLE",
    })));
    expect(typeof checkpoint.commonBlocker).toBe("string");
    expect(checkpoint.blockers[checkpoint.commonBlocker!]).toMatchObject({
      code: "CRITICAL_CONTROL_UNAVAILABLE",
      class: "critical-control",
      scope: "common",
    });
    expect(Object.values(checkpoint.nodes).every((node) => node.blockerID === undefined)).toBe(true);
  });

  test("solo un after exacto consume la reserva; mismatch, duplicado y tardío no producen éxito", async () => {
    const execution = await recovery();
    const exact = correlation(EDIT_ACTION, "call_exact_after");
    const reserved = await execution.reserveToolCall(exact);
    expect(reserved).toMatchObject({ decision: "continue" });
    expect(typeof reserved.reservationID).toBe("string");

    const mismatch = await execution.completeToolCall({
      ...exact,
      callID: "call_other",
      reservationID: reserved.reservationID!,
      status: "success",
    });
    expect(mismatch.decision).toBe("ignore");
    expect(mismatch.code).toMatch(/^RESERVATION_/);
    expect((await execution.snapshot()).nodes[EDIT_ACTION]?.state).toBe("in-flight");

    const completed = await execution.completeToolCall({
      ...exact,
      reservationID: reserved.reservationID!,
      status: "success",
    });
    const duplicate = await execution.completeToolCall({
      ...exact,
      reservationID: reserved.reservationID!,
      status: "success",
    });
    const late = await execution.completeToolCall({
      ...correlation(EDIT_ACTION, "call_late"),
      reservationID: "reservation_missing",
      status: "success",
    });
    const checkpoint = await execution.snapshot();

    expect(completed).toMatchObject({ decision: "continue", code: "ACTION_SUCCEEDED" });
    expect(duplicate.decision).toBe("ignore");
    expect(duplicate.code).toMatch(/^RESERVATION_/);
    expect(late.decision).toBe("ignore");
    expect(late.code).toMatch(/^RESERVATION_/);
    expect(checkpoint.nodes[EDIT_ACTION]?.state).toBe("succeeded");
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
