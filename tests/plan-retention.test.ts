import { describe, expect, test } from "bun:test";

import { createPlanningAuthority, type PlanningAuthority } from "../src/cli/core/planning-authority";
import {
  controlPlan,
  presentPlan,
  requestPlanExecution,
  type PlanInput,
  type PlanningAdapter,
  type PlanScope,
  type PlanState,
} from "../src/cli/core/planning";
import {
  compactTerminalPlans,
  loadPlanRecord,
  persistPlanState,
  planArchiveRecordKey,
  planArchiveRevisionKey,
  planKey,
  planRecordKey,
  planRevisionKey,
  type PlanningRetentionStorage,
} from "../src/plugin/plan-retention";

const POLICY = "a".repeat(32);
const authority = createPlanningAuthority(Buffer.alloc(32, 23));

interface StorageFixture {
  records: Map<string, unknown>;
  events: string[];
  storage: PlanningRetentionStorage;
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

describe("retención de planes terminales", () => {
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

  test("compacta registros V4 terminales existentes de forma idempotente y acotada", async () => {
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
});
