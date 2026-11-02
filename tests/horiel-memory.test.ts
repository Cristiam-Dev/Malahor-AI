import { describe, expect, test } from "bun:test";

import {
  HorielError,
  createHorielCore,
} from "../src/horiel/core";
import type {
  HorielCore,
  MemoryRecord,
  SaveMemoryInput,
} from "../src/horiel/core";
import {
  FakeHorielStore,
  deterministicClock,
  deterministicIdFactory,
} from "./fixtures/horiel-store";

function harness() {
  const store = new FakeHorielStore();
  const clock = deterministicClock();
  const idFactory = deterministicIdFactory();
  const core = createHorielCore({ store, clock, idFactory });
  return { core, store, clock };
}

let requestSequence = 0;

function memoryInput(overrides: Partial<SaveMemoryInput> = {}): SaveMemoryInput {
  requestSequence += 1;
  return {
    scope: "acme/task",
    type: "decision",
    title: "Synthetic decision",
    content: "Use the synthetic path.",
    tags: ["synthetic"],
    idempotencyKey: `memory-request-${requestSequence.toString().padStart(4, "0")}`,
    provenance: { source: "test" },
    ...overrides,
  };
}

async function save(core: HorielCore, overrides: Partial<SaveMemoryInput> = {}): Promise<MemoryRecord> {
  return (await core.saveMemory(memoryInput(overrides))).memory;
}

async function expectAsyncCode(promise: Promise<unknown>, code: string): Promise<HorielError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HorielError);
    expect(error).toMatchObject({ code });
    return error as HorielError;
  }
  throw new Error(`Expected HorielError(${code})`);
}

function contextIds(result: {
  sections: {
    exact: MemoryRecord[];
    ancestors: MemoryRecord[];
    descendants: MemoryRecord[];
    global: MemoryRecord[];
  };
}): string[] {
  return [
    ...result.sections.exact,
    ...result.sections.ancestors,
    ...result.sections.descendants,
    ...result.sections.global,
  ].map((memory) => memory.id);
}

describe("Horiel memory creation and optimistic updates", () => {
  test("keeps create separate from update and replays only an identical idempotent create", async () => {
    const { core, store } = harness();
    const input = memoryInput({
      title: "Choose an embedded store",
      content: "SQLite is the canonical source.",
      tags: ["Storage", "storage"],
    });

    const created = await core.saveMemory(input);
    const replayed = await core.saveMemory({ ...input, tags: [...input.tags!] });
    const distinct = await core.saveMemory(memoryInput({
      title: input.title,
      content: input.content,
      tags: input.tags,
    }));

    expect(created.status).toBe("created");
    expect(created.memory).toMatchObject({ version: 1, tags: ["storage"] });
    expect(replayed).toEqual({ status: "replayed", memory: created.memory });
    expect(distinct.memory.id).not.toBe(created.memory.id);
    expect(store.inspect().memories).toHaveLength(2);
    expect(store.inspect().sequence).toBe(2);

    await expectAsyncCode(core.saveMemory({ ...input, content: "A conflicting payload." }), "conflict");
    expect(store.inspect().memories).toHaveLength(2);
    expect(store.inspect().sequence).toBe(2);
  });

  test("requires the current version, preserves history and never creates a stale substitute", async () => {
    const { core, store, clock } = harness();
    const original = await save(core, { title: "Original", content: "Version one." });
    clock.advance(1_000);

    const updated = await core.updateMemory({
      id: original.id,
      expectedVersion: 1,
      title: "Updated",
      tags: ["BETA", "alpha"],
    });

    expect(updated.memory).toMatchObject({
      id: original.id,
      version: 2,
      title: "Updated",
      content: "Version one.",
      tags: ["alpha", "beta"],
      createdAt: original.createdAt,
    });
    expect(updated.memory.updatedAt).not.toBe(original.updatedAt);
    expect(await core.getMemory({ id: original.id })).toEqual(updated.memory);
    expect(await core.getMemory({ id: original.id, version: 1 })).toEqual(original);
    expect(store.inspect().history[original.id]).toEqual([original, updated.memory]);

    await expectAsyncCode(core.updateMemory({
      id: original.id,
      expectedVersion: 1,
      content: "Stale overwrite.",
    }), "conflict");
    expect(store.inspect().memories).toHaveLength(1);
    expect(store.inspect().history[original.id]).toHaveLength(2);

    await expectAsyncCode(core.updateMemory({ id: original.id, expectedVersion: 2 }), "invalid_input");
    await expectAsyncCode(
      core.getMemory({ id: `mem_${"e".repeat(32)}` }),
      "not_found",
    );
  });

  test("publishes no partial state when the adapter callback or synthetic commit fails", async () => {
    const { core, store } = harness();
    store.failNextWrite(new Error("raw adapter detail: do not leak"));

    const error = await expectAsyncCode(core.saveMemory(memoryInput()), "unavailable");
    expect(error.message).not.toContain("raw adapter detail");
    expect(store.inspect()).toMatchObject({
      sequence: 0,
      memories: [],
      idempotency: [],
    });

    await expect(store.write(async (transaction) => {
      await transaction.insertMemory({
        id: `mem_${"d".repeat(32)}`,
        scope: "acme/task",
        type: "general",
        title: "Rolled back",
        content: "This record must never become visible.",
        tags: [],
        createdAt: "2026-11-02T12:00:00.000Z",
        updatedAt: "2026-11-02T12:00:00.000Z",
        version: 1,
        provenance: { source: "test" },
      });
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");
    expect(store.inspect().memories).toEqual([]);
    expect(store.inspect().sequence).toBe(0);
  });
});

describe("Horiel literal search and ranking v1", () => {
  test("applies filters and textual eligibility before pin priority", async () => {
    const { core, store } = harness();
    const exactA = await save(core, {
      scope: "acme/task",
      title: "Alpha decision A",
      content: "literal alpha",
      tags: ["search"],
    });
    const exactB = await save(core, {
      scope: "acme/task",
      title: "Alpha decision B",
      content: "literal alpha",
      tags: ["search"],
    });
    const ancestor = await save(core, {
      scope: "acme",
      title: "Alpha ancestor",
      content: "literal alpha",
      tags: ["search"],
    });
    const irrelevant = await save(core, {
      scope: "acme/task",
      title: "Gamma only",
      content: "no matching term",
      tags: ["search"],
    });
    const wrongProject = await save(core, {
      scope: "other/task",
      title: "Alpha from another project",
      content: "literal alpha",
      tags: ["search"],
    });
    const wrongType = await save(core, {
      scope: "acme/task",
      type: "bug",
      title: "Alpha bug",
      content: "literal alpha",
      tags: ["search"],
    });

    await core.pinMemory({ id: exactB.id });
    await core.pinMemory({ id: ancestor.id });
    await core.pinMemory({ id: irrelevant.id });
    await core.pinMemory({ id: wrongProject.id });
    store.leakSearchCandidate(irrelevant.id, 0);
    store.leakSearchCandidate(wrongProject.id, 1000);
    store.leakSearchCandidate(wrongType.id, 1000);

    const request = {
      scope: "acme/task",
      query: "Alpha OR title:*",
      includeAncestors: true,
      rollup: false,
      includeGlobal: false,
      types: ["decision" as const],
      tags: ["SEARCH"],
      limit: 20,
    };
    const first = await core.searchMemory(request);
    const second = await core.searchMemory(request);

    expect(store.inspect().lastSearch?.terms).toEqual(["alpha", "or", "title"]);
    expect(first.rankingVersion).toBe(1);
    expect(first.items.map((item) => item.memory.id)).toEqual([
      exactB.id,
      exactA.id,
      ancestor.id,
    ]);
    expect(second).toEqual(first);
    expect(first.items[0]?.rank).toMatchObject({
      scopeClass: "exact",
      scopeDistance: 0,
      pinned: true,
    });
    expect(first.items[2]?.rank).toMatchObject({
      scopeClass: "ancestor",
      pinned: true,
    });
    expect(first.items.map((item) => item.memory.id)).not.toContain(irrelevant.id);
    expect(first.items.map((item) => item.memory.id)).not.toContain(wrongProject.id);
    expect(first.items.map((item) => item.memory.id)).not.toContain(wrongType.id);
  });

  test("uses stable identity as the final reproducible tie-break", async () => {
    const { core } = harness();
    const first = await save(core, {
      title: "Tie alpha",
      content: "alpha",
      tags: ["tie"],
    });
    const second = await save(core, {
      title: "Tie alpha",
      content: "alpha",
      tags: ["tie"],
    });

    const result = await core.searchMemory({
      scope: "acme/task",
      query: "alpha",
      includeAncestors: false,
      rollup: false,
      includeGlobal: false,
      limit: 10,
    });

    expect(result.items.map((item) => item.memory.id)).toEqual([first.id, second.id].sort());
    expect(result.items.every((item) => item.rank.textScore >= 1 && item.rank.textScore <= 1000)).toBe(true);
  });
});

describe("Horiel context, brief and session continuity", () => {
  test("keeps exact, ancestor, explicit rollup and global collections separated by segments", async () => {
    const { core } = harness();
    const root = await save(core, { scope: "acme", title: "Root", content: "root context" });
    const ancestor = await save(core, { scope: "acme/task", title: "Task", content: "task context" });
    const exact = await save(core, { scope: "acme/task/HU-1", title: "HU", content: "exact context" });
    const child = await save(core, {
      scope: "acme/task/HU-1/backend",
      title: "Backend",
      content: "child context",
    });
    const neighbour = await save(core, {
      scope: "acme/task/HU-10",
      title: "Neighbour",
      content: "prefix neighbour",
    });
    const global = await save(core, { scope: "@global", title: "Global", content: "global context" });
    const foreign = await save(core, { scope: "other/task", title: "Foreign", content: "foreign context" });

    const normal = await core.getContext({
      scope: "acme/task/HU-1",
      rollup: false,
      budgetBytes: 262_144,
    });
    expect(normal.sections.exact.map((entry) => entry.id)).toEqual([exact.id]);
    expect(new Set(normal.sections.ancestors.map((entry) => entry.id))).toEqual(new Set([root.id, ancestor.id]));
    expect(normal.sections.descendants).toEqual([]);
    expect(normal.sections.global.map((entry) => entry.id)).toEqual([global.id]);
    expect(contextIds(normal)).not.toContain(neighbour.id);
    expect(contextIds(normal)).not.toContain(foreign.id);

    const rolledUp = await core.getContext({
      scope: "acme/task/HU-1",
      rollup: true,
      includeGlobal: false,
      budgetBytes: 262_144,
    });
    expect(rolledUp.sections.descendants.map((entry) => entry.id)).toEqual([child.id]);
    expect(rolledUp.sections.global).toEqual([]);
    expect(contextIds(rolledUp)).not.toContain(neighbour.id);
    expect(new Set(contextIds(rolledUp)).size).toBe(contextIds(rolledUp).length);
  });

  test("budgets complete records, reports omissions and never returns truncated content", async () => {
    const { core } = harness();
    const fullContent = "😀".repeat(200);
    await save(core, { scope: "acme/task", title: "Large A", content: fullContent });
    await save(core, { scope: "acme/task", title: "Large B", content: fullContent });

    const result = await core.getContext({
      scope: "acme/task",
      rollup: false,
      includeGlobal: false,
      budgetBytes: 1,
    });

    expect(result.budget.usedBytes).toBeLessThanOrEqual(1);
    expect(result.budget.omittedCount).toBe(2);
    expect(result.budget.omittedByReason).toEqual({ budget: 2, limit: 0 });
    expect(contextIds(result)).toEqual([]);

    const enough = await core.getContext({
      scope: "acme/task",
      rollup: false,
      includeGlobal: false,
      budgetBytes: 262_144,
    });
    expect(enough.sections.exact).toHaveLength(2);
    expect(enough.sections.exact.every((entry) => entry.content === fullContent)).toBe(true);
    expect(enough.budget.usedBytes).toBeLessThanOrEqual(enough.budget.limitBytes);
  });

  test("persists one idempotent checkpoint and rehydrates it before deduplicated brief results", async () => {
    const { core, store } = harness();
    const direct = await save(core, {
      scope: "acme/task/HU-1",
      title: "Shared direct",
      content: "shared topic in direct context",
    });
    const related = await save(core, {
      scope: "acme/other",
      title: "Shared related",
      content: "shared topic elsewhere in the project",
    });
    await save(core, {
      scope: "other/task",
      title: "Shared foreign",
      content: "shared but not authorized",
    });
    const checkpointInput = {
      scope: "acme/task/HU-1",
      sessionRef: "session-p2-0001",
      idempotencyKey: "checkpoint-request-0001",
      objective: "Implement the synthetic core",
      implemented: ["domain tests"],
      verified: ["focused runner"],
      pending: ["production implementation"],
      decisions: ["keep the store behind a port"],
      blockers: [],
      validations: ["bun test focused"],
      nextStep: "Implement the port",
    };

    const created = await core.saveSessionCheckpoint(checkpointInput);
    const replayed = await core.saveSessionCheckpoint({ ...checkpointInput });
    expect(created.status).toBe("created");
    expect(replayed).toEqual({ status: "replayed", checkpoint: created.checkpoint });
    expect(store.inspect().checkpoints).toHaveLength(1);

    const brief = await core.getBrief({
      scope: "acme/task/HU-1",
      query: "shared topic",
      rollup: false,
      includeGlobal: false,
      relatedLimit: 10,
      budgetBytes: 262_144,
    });
    expect(brief.checkpoint?.id).toBe(created.checkpoint.id);
    expect(brief.sections.exact.map((entry) => entry.id)).toContain(direct.id);
    expect(brief.related.map((entry) => entry.memory.id)).toEqual([related.id]);
    expect(brief.related.map((entry) => entry.memory.id)).not.toContain(direct.id);

    await expectAsyncCode(core.saveSessionCheckpoint({
      ...checkpointInput,
      objective: "Conflicting retry",
    }), "conflict");
    await expectAsyncCode(core.saveSessionCheckpoint({
      ...checkpointInput,
      idempotencyKey: "checkpoint-request-0002",
      transcript: "raw transcript must not be accepted",
    } as typeof checkpointInput), "invalid_input");
  });

  test("lists and inspects only the requested scope subtree", async () => {
    const { core } = harness();
    const root = await save(core, { scope: "acme", title: "Root", content: "root" });
    const child = await save(core, { scope: "acme/task", title: "Child", content: "child" });
    await save(core, { scope: "other/task", title: "Other", content: "other" });
    await core.pinMemory({ id: child.id });

    const tree = await core.listTree({ prefix: "acme" });
    expect(tree.nodes.map((node) => node.scope)).toEqual(["acme", "acme/task"]);
    expect(tree.nodes.find((node) => node.scope === "acme")?.memoryCount).toBe(1);

    const inspection = await core.inspectScope({ scope: "acme/task" });
    expect(inspection).toMatchObject({
      scope: "acme/task",
      memoryCount: 1,
      pinCount: 1,
    });
    expect(inspection.memoryIds).toEqual([child.id]);
    expect(inspection.memoryIds).not.toContain(root.id);
  });
});
