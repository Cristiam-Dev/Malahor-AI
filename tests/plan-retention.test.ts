import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createPlanningAuthority, type PlanningAuthority } from "../src/cli/core/planning-authority";
import {
  actionGraphForPlan,
  authorizePlan,
  controlPlan,
  presentPlan,
  proposePlan,
  requestPlanExecution,
  validState,
  type PlanInput,
  type PlanningAdapter,
  type PlanScope,
  type PlanState,
  type PlanStateV5,
} from "../src/cli/core/planning";
import {
  compactTerminalPlans,
  legacyPlanKey,
  legacyPlanRecordKey,
  legacyPlanRevisionKey,
  loadActivePlan,
  loadPlanRecord,
  persistPlanState,
  planArchiveRecordKey,
  planArchiveRevisionKey,
  planKey,
  planRecordKey,
  planRevisionKey,
  type PlanningRetentionStorage,
} from "../src/plugin/plan-retention";
import {
  createPlanRecovery,
  validPlanExecutionCheckpoint,
  type PlanExecutionCheckpointV1,
} from "../src/plugin/plan-recovery";

const POLICY = "a".repeat(32);
const authority = createPlanningAuthority(Buffer.alloc(32, 23));

interface StorageFixture {
  records: Map<string, unknown>;
  events: string[];
  storage: PlanningRetentionStorage;
}

interface TerminalRecoveryEvidence {
  lineage: PlanStateV5[];
  delta: {
    parentRevision: string;
    childRevision: string;
    preserved: string[];
    changed: string[];
    added: string[];
    removed: string[];
  };
  checkpoints: PlanExecutionCheckpointV1[];
}

interface TerminalArchiveBundle {
  state: PlanStateV5;
  lineage: PlanStateV5[];
  delta: TerminalRecoveryEvidence["delta"];
  checkpoints: PlanExecutionCheckpointV1[];
}

interface RecoveryRetentionApi {
  persistPlanState(
    storage: PlanningRetentionStorage,
    state: PlanState,
    authority: PlanningAuthority,
    evidence?: TerminalRecoveryEvidence,
  ): Promise<{ status: string; removed: number }>;
  loadPlanArchiveBundle(
    storage: PlanningRetentionStorage,
    planID: string,
    revision: string,
    authority: PlanningAuthority,
  ): Promise<TerminalArchiveBundle | undefined>;
}

async function loadRecoveryRetentionApi(): Promise<RecoveryRetentionApi> {
  const modulePath = "../src/plugin/plan-retention";
  const api = await import(modulePath) as unknown as Partial<RecoveryRetentionApi>;
  if (typeof api.persistPlanState !== "function" || typeof api.loadPlanArchiveBundle !== "function") {
    throw new Error(`API normativa ausente: ${modulePath} (archivo terminal con lineage y checkpoints).`);
  }
  return api as RecoveryRetentionApi;
}

function fixtureStorage(options: {
  remove?: boolean;
  scan?: boolean;
  unreadableArchive?: boolean;
  failRemoveAt?: number;
} = {}): StorageFixture {
  const records = new Map<string, unknown>();
  const events: string[] = [];
  let removeCalls = 0;
  const storage: PlanningRetentionStorage = {
    get: async (key) => {
      events.push(`get:${key}`);
      if (options.unreadableArchive && key.startsWith("planning/archive/")) return undefined;
      return records.get(key);
    },
    set: async (key, value) => {
      events.push(`set:${key}`);
      records.set(key, structuredClone(value));
    },
    ...(options.remove === false ? {} : {
      remove: async (key: string) => {
        events.push(`remove:${key}`);
        removeCalls++;
        if (removeCalls === options.failRemoveAt) throw new Error("remove fixture failure");
        records.delete(key);
      },
    }),
    ...(options.scan === false ? {} : {
      scan: async ({ prefix, after, limit = 100 }) => {
        const keys = [...records.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = after ? Math.max(0, keys.findIndex((key) => key > after)) : 0;
        const selected = keys.slice(start, start + limit);
        return {
          entries: selected.map((key) => ({ key, value: structuredClone(records.get(key)) })),
          ...(start + selected.length < keys.length && selected.length > 0 ? { next: selected.at(-1) } : {}),
        };
      },
    }),
  };
  return { records, events, storage };
}

function scope(sessionID = "ses_retention_parent"): PlanScope {
  return { sessionID, project: "demo", mode: "executor", policyRevision: POLICY };
}

function input(dependencies: PlanInput["dependencies"] = []): PlanInput {
  return {
    level: 1,
    summary: "Conservar una revisión verificable",
    steps: ["Ejecutar el fixture"],
    presentation: {
      objective: "Ejecutar únicamente el fixture de retención.",
      outcome: "El estado terminal conserva una evidencia verificable.",
      steps: [{ title: "Ejecutar", description: "Aplicar solo la acción declarada." }],
      impact: [{ area: "Planning", description: "Afecta únicamente la persistencia sintética." }],
      risk: {
        level: "medium",
        categories: [],
        summary: "Persistencia sintética y acotada.",
        details: "No toca almacenamiento ni sesiones reales.",
      },
      exclusions: ["Datos reales"],
      completionCriteria: ["La revisión terminal puede validarse"],
    },
    actions: [{ action: "edit", resource: "/tmp/opencode/retention-fixture.ts" }],
    dependencies,
  };
}

async function completedState(targetAuthority: PlanningAuthority = authority): Promise<PlanState> {
  const active = new Map<string, PlanState>();
  const plans = new Map<string, PlanState>();
  const adapter: PlanningAdapter = {
    loadActive: async (sessionID) => active.get(sessionID),
    loadPlan: async (planID) => plans.get(planID),
    save: async (state) => { active.set(state.sessionID, state); plans.set(state.planID, state); },
    confirm: async () => undefined,
  };
  const targetScope = scope();
  const presented = await presentPlan(targetScope, input(), "msg-retention-plan", adapter, targetAuthority);
  await requestPlanExecution(targetScope, presented.digest, "msg-retention-run", adapter, targetAuthority);
  return controlPlan(targetScope, "complete", adapter, targetAuthority);
}

function legacyCompletedState(source: PlanState): PlanState {
  const scope = {
    sessionID: source.sessionID,
    project: source.project,
    mode: source.mode,
    policyRevision: source.policyRevision,
  };
  const digest = createHash("sha256").update(canonical({
    scope,
    plan: source.plan,
    planID: source.planID,
    revision: source.revision,
    presentationInteractionID: source.presentationInteractionID,
  })).digest("hex");
  const unsigned = {
    version: 4 as const,
    planID: source.planID,
    ...scope,
    presentationInteractionID: source.presentationInteractionID,
    plan: source.plan,
    digest,
    revision: source.revision,
    phase: "completed" as const,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    authorizedAt: source.authorizedAt,
    startedAt: source.startedAt,
    completedAt: source.completedAt,
    proof: "",
  };
  const { proof: _proof, ...payload } = unsigned;
  return { ...unsigned, proof: authority.sign(canonical(payload)) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sealRetentionState(
  state: PlanStateV5,
  patch: Partial<PlanStateV5>,
  targetAuthority: PlanningAuthority,
): PlanStateV5 {
  const unsigned = { ...state, ...patch, proof: "" } as PlanStateV5;
  const { proof: _proof, ...payload } = unsigned;
  return { ...unsigned, proof: targetAuthority.sign(canonical(payload)) };
}

async function terminalRecoveryFixture(fixture: StorageFixture): Promise<{
  state: PlanStateV5;
  evidence: TerminalRecoveryEvidence;
  graph: ReturnType<typeof actionGraphForPlan>;
}> {
  const planID = "d".repeat(32);
  const parentInput = {
    ...input(),
    summary: "Revisión padre archivada",
    actions: [{
      action: "edit",
      resource: "/tmp/opencode/retention-fixture.ts",
      key: "root",
      dependsOn: [],
    }],
  } satisfies PlanInput;
  const childInput = {
    ...input(),
    summary: "Revisión hija terminal",
    actions: [
      ...parentInput.actions,
      { action: "shell", resource: "echo retained", key: "added", dependsOn: [] },
    ],
  } satisfies PlanInput;
  const parentPresented = proposePlan(
    scope(), parentInput, 100, "msg-retention-lineage-parent", planID, authority,
  );
  const parentRunning = authorizePlan(parentPresented, parentPresented.digest, 101, authority);
  const parent = sealRetentionState(parentRunning, {
    phase: "superseded",
    supersededAt: 102,
    updatedAt: 102,
  }, authority);
  const childPresented = proposePlan(
    scope(), childInput, 103, "msg-retention-lineage-child", planID, authority,
  );
  const childRunning = authorizePlan(childPresented, childPresented.digest, 104, authority);
  const graph = actionGraphForPlan(childRunning);
  const recovery = createPlanRecovery({
    plan: {
      planID: childRunning.planID,
      revision: childRunning.revision,
      digest: childRunning.digest,
      proofHash: createHash("sha256").update(childRunning.proof).digest("hex"),
      phase: "running",
    },
    graph,
    authority,
    storage: fixture.storage,
    now: () => 105,
  });
  for (const node of graph) {
    await recovery.recordAttempt({
      actionID: node.actionID,
      outcome: "success",
      canonicalInputHash: `sha256:${node.key}`,
      resourceDigests: { before: [`sha256:${node.key}-before`], after: [`sha256:${node.key}-after`] },
    });
  }
  const checkpoint = await recovery.snapshot();
  const state = sealRetentionState(childRunning, {
    phase: "completed",
    completedAt: 106,
    updatedAt: 106,
  }, authority);
  const parentIDs = new Set(actionGraphForPlan(parent).map((node) => node.actionID));
  const childIDs = new Set(graph.map((node) => node.actionID));
  const preserved = [...childIDs].filter((actionID) => parentIDs.has(actionID));
  const added = [...childIDs].filter((actionID) => !parentIDs.has(actionID));

  expect(validState(parent, authority)).toBe(true);
  expect(validState(childRunning, authority)).toBe(true);
  expect(validState(state, authority)).toBe(true);
  expect(validPlanExecutionCheckpoint(checkpoint, {
    planID: childRunning.planID,
    revision: childRunning.revision,
    digest: childRunning.digest,
    proofHash: createHash("sha256").update(childRunning.proof).digest("hex"),
    phase: "running",
  }, graph, authority)).toBe(true);

  return {
    state,
    graph,
    evidence: {
      lineage: [parent, childRunning, state],
      delta: {
        parentRevision: parent.revision,
        childRevision: state.revision,
        preserved,
        changed: [],
        added,
        removed: [],
      },
      checkpoints: [checkpoint],
    },
  };
}

describe("retención de planes terminales", () => {
  test("el ancla de pausa conserva un checkpoint firmado durante ejecución y sobrevive la reanudación", async () => {
    const presented = proposePlan(
      scope("ses_retention_pause_anchor"), input(), 100, "msg_retention_pause_anchor", "7".repeat(32), authority,
    );
    const running = authorizePlan(presented, presented.digest, 101, authority);
    let active: PlanState = running;
    const adapter: PlanningAdapter = {
      loadActive: async () => active,
      loadPlan: async () => active,
      save: async (value) => { active = value; },
      confirm: async () => undefined,
    };
    const graph = actionGraphForPlan(running);
    const fixture = fixtureStorage();
    const proofHash = createHash("sha256").update(running.proof).digest("hex");
    const recovery = createPlanRecovery({
      plan: { planID: running.planID, revision: running.revision, digest: running.digest,
        proofHash, phase: "running" },
      graph, authority, storage: fixture.storage,
    });
    await recovery.recordAttempt({
      actionID: graph[0]!.actionID, outcome: "success", canonicalInputHash: "sha256:anchor-test",
      resourceDigests: { before: ["sha256:old"], after: ["sha256:new"] },
    });
    const checkpoint = await recovery.snapshot();
    const paused = await controlPlan(scope("ses_retention_pause_anchor"), "pause", adapter, authority);
    expect(paused.version).toBe(5);
    if (paused.version !== 5) throw new Error("se esperaba V5");
    expect(paused.proof).not.toBe(running.proof);
    expect(paused.executionAnchor).toBe(proofHash);
    expect(validPlanExecutionCheckpoint(checkpoint, {
      planID: paused.planID, revision: paused.revision, digest: paused.digest,
      proofHash: paused.executionAnchor!, phase: "paused",
    }, graph, authority)).toBe(true);
    const resumed = await controlPlan(scope("ses_retention_pause_anchor"), "resume", adapter, authority);
    expect(resumed.version).toBe(5);
    if (resumed.version !== 5) throw new Error("se esperaba V5");
    expect(resumed.executionAnchor).toBe(proofHash);
    expect(resumed.proof).not.toBe(paused.proof);
  });
  test("archiva y verifica antes de retirar las tres copias vivas", async () => {
    const state = await completedState();
    const fixture = fixtureStorage();

    const result = await persistPlanState(fixture.storage, state, authority);

    expect(result).toMatchObject({ status: "archived", removed: 3 });
    expect(fixture.records.has(planKey(state.sessionID))).toBe(false);
    expect(fixture.records.has(planRecordKey(state.planID))).toBe(false);
    expect(fixture.records.has(planRevisionKey(state.planID, state.revision))).toBe(false);
    const archiveKey = planArchiveRevisionKey(state.planID, state.revision);
    const archive = fixture.records.get(archiveKey) as Record<string, unknown>;
    expect(archive).toMatchObject({
      kind: "malahor.plan.archive",
      encoding: "gzip-base64",
      planID: state.planID,
      revision: state.revision,
      digest: state.digest,
      phase: "completed",
    });
    expect(JSON.stringify(archive)).not.toContain(state.plan.presentation.objective);
    expect(fixture.records.get(planArchiveRecordKey(state.planID))).toMatchObject({
      kind: "malahor.plan.archive-pointer",
      revision: state.revision,
      archiveKey,
    });
    expect(await loadPlanRecord(fixture.storage, state.planID, authority)).toEqual(state);

    const firstRemove = fixture.events.findIndex((event) => event.startsWith("remove:"));
    const archiveWrite = fixture.events.findIndex((event) => event === `set:${archiveKey}`);
    const pointerWrite = fixture.events.findIndex((event) => event === `set:${planArchiveRecordKey(state.planID)}`);
    expect(firstRemove).toBeGreaterThan(archiveWrite);
    expect(firstRemove).toBeGreaterThan(pointerWrite);
  });

  test("conserva todas las copias si el archivo no puede releerse o remove no existe", async () => {
    const state = await completedState();
    for (const options of [
      { unreadableArchive: true },
      { remove: false },
    ]) {
      const fixture = fixtureStorage(options);
      const result = await persistPlanState(fixture.storage, state, authority);
      expect(result.status).toBe("retained");
      expect(fixture.records.has(planKey(state.sessionID))).toBe(true);
      expect(fixture.records.has(planRecordKey(state.planID))).toBe(true);
      expect(fixture.records.has(planRevisionKey(state.planID, state.revision))).toBe(true);
      expect(fixture.events.some((event) => event.startsWith("remove:"))).toBe(false);
    }
  });

  test("restaura las copias ya retiradas si remove falla a mitad de la compactación", async () => {
    const state = await completedState();
    const fixture = fixtureStorage({ failRemoveAt: 2 });

    const result = await persistPlanState(fixture.storage, state, authority);

    expect(result).toMatchObject({ status: "retained", removed: 0 });
    expect(fixture.records.get(planKey(state.sessionID))).toEqual(state);
    expect(fixture.records.get(planRecordKey(state.planID))).toEqual(state);
    expect(fixture.records.get(planRevisionKey(state.planID, state.revision))).toEqual(state);
  });

  test("rechaza un archivo adulterado y no lo usa como evidencia de dependencia", async () => {
    const state = await completedState();
    const fixture = fixtureStorage();
    await persistPlanState(fixture.storage, state, authority);
    const key = planArchiveRevisionKey(state.planID, state.revision);
    const archive = fixture.records.get(key) as Record<string, unknown>;
    const payload = String(archive.payload);
    const tamperAt = Math.floor(payload.length / 2);
    const replacement = payload[tamperAt] === "A" ? "B" : "A";
    fixture.records.set(key, {
      ...archive,
      payload: `${payload.slice(0, tamperAt)}${replacement}${payload.slice(tamperAt + 1)}`,
    });

    expect(await loadPlanRecord(fixture.storage, state.planID, authority)).toBeUndefined();
  });

  test("una dependencia completada se resuelve desde el archivo sin restaurar copias vivas", async () => {
    const parent = await completedState();
    const fixture = fixtureStorage();
    await persistPlanState(fixture.storage, parent, authority);
    const active = new Map<string, PlanState>();
    const childScope = scope("ses_retention_child");
    const adapter: PlanningAdapter = {
      loadActive: async (sessionID) => active.get(sessionID),
      loadPlan: async (planID) => loadPlanRecord(fixture.storage, planID, authority),
      save: async (state) => { active.set(state.sessionID, state); },
      confirm: async () => undefined,
    };
    const child = await presentPlan(childScope, input([{
      planID: parent.planID,
      revision: parent.revision,
    }]), "msg-retention-child-plan", adapter, authority);

    const running = await requestPlanExecution(
      childScope, child.digest, "msg-retention-child-run", adapter, authority,
    );
    expect(running.phase).toBe("running");
    expect(fixture.records.has(planRecordKey(parent.planID))).toBe(false);
  });

  test("un terminal V4 permanece legible desde su namespace legado sin migración silenciosa", async () => {
    const state = legacyCompletedState(await completedState());
    const fixture = fixtureStorage();
    fixture.records.set(legacyPlanKey(state.sessionID), state);
    fixture.records.set(legacyPlanRecordKey(state.planID), state);
    fixture.records.set(legacyPlanRevisionKey(state.planID, state.revision), state);

    expect(await loadActivePlan(fixture.storage, state.sessionID, authority)).toEqual(state);
    expect(await loadPlanRecord(fixture.storage, state.planID, authority)).toEqual(state);
    expect(fixture.records.has(planKey(state.sessionID))).toBe(false);
  });

  test("compacta registros V5 terminales existentes de forma idempotente y acotada", async () => {
    const state = await completedState();
    const fixture = fixtureStorage();
    fixture.records.set(planKey(state.sessionID), state);
    fixture.records.set(planRecordKey(state.planID), state);
    fixture.records.set(planRevisionKey(state.planID, state.revision), state);

    const first = await compactTerminalPlans(fixture.storage, authority, { maxEntries: 100 });
    const second = await compactTerminalPlans(fixture.storage, authority, { maxEntries: 100 });

    expect(first).toMatchObject({ supported: true, compacted: 1, failed: 0 });
    expect(first.removed).toBe(3);
    expect(second).toMatchObject({ supported: true, compacted: 0, removed: 0, failed: 0 });
    expect(await loadPlanRecord(fixture.storage, state.planID, authority)).toEqual(state);
  });

  test("sin scan/remove declara retención degradada y no toca datos", async () => {
    const state = await completedState();
    const fixture = fixtureStorage({ remove: false, scan: false });
    fixture.records.set(planKey(state.sessionID), state);
    const before = structuredClone([...fixture.records]);

    const result = await compactTerminalPlans(fixture.storage, authority);

    expect(result).toMatchObject({ supported: false, compacted: 0, removed: 0 });
    expect([...fixture.records]).toEqual(before);
  });

  test("PLANNING-RECOVERY-01 archiva lineage, delta y checkpoint verificable antes de retirar copias", async () => {
    const fixture = fixtureStorage();
    const terminal = await terminalRecoveryFixture(fixture);
    const api = await loadRecoveryRetentionApi();

    const result = await api.persistPlanState(fixture.storage, terminal.state, authority, terminal.evidence);
    const bundle = await api.loadPlanArchiveBundle(
      fixture.storage,
      terminal.state.planID,
      terminal.state.revision,
      authority,
    );

    expect(result).toMatchObject({ status: "archived" });
    expect(bundle).toBeDefined();
    if (!bundle) throw new Error("El archivo terminal no devolvió el bundle de recuperación.");
    expect(bundle.state).toEqual(terminal.state);
    expect(bundle.lineage).toEqual(terminal.evidence.lineage);
    expect(bundle.delta).toEqual(terminal.evidence.delta);
    expect(bundle.checkpoints).toHaveLength(1);
    expect(bundle.lineage.every((state) => validState(state, authority))).toBe(true);

    const running = bundle.lineage.find((state) =>
      state.revision === bundle.checkpoints[0]?.plan.revision && state.phase === "running");
    expect(running).toBeDefined();
    expect(validPlanExecutionCheckpoint(
      bundle.checkpoints[0],
      {
        planID: running!.planID,
        revision: running!.revision,
        digest: running!.digest,
        proofHash: createHash("sha256").update(running!.proof).digest("hex"),
        phase: "running",
      },
      actionGraphForPlan(running!),
      authority,
    )).toBe(true);
  });
});
