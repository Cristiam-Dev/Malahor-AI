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

function harness(store = new FakeHorielStore()) {
  const clock = deterministicClock();
  const core = createHorielCore({
    store,
    clock,
    idFactory: deterministicIdFactory(),
  });
  return { core, store, clock };
}

let requestSequence = 0;

async function save(
  core: HorielCore,
  overrides: Partial<SaveMemoryInput> = {},
): Promise<MemoryRecord> {
  requestSequence += 1;
  return (await core.saveMemory({
    scope: "acme/task",
    type: "decision",
    title: `Synthetic memory ${requestSequence}`,
    content: "Synthetic administration fixture.",
    tags: ["administration"],
    idempotencyKey: `admin-request-${requestSequence.toString().padStart(4, "0")}`,
    provenance: { source: "test" },
    ...overrides,
  })).memory;
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

describe("Horiel pins and explicit relations", () => {
  test("makes pin and unpin idempotent while requiring an existing target to pin", async () => {
    const { core, store } = harness();
    const memory = await save(core);
    const sequenceBeforePin = store.inspect().sequence;

    expect(await core.pinMemory({ id: memory.id })).toEqual({ changed: true, pinned: true });
    expect(await core.pinMemory({ id: memory.id })).toEqual({ changed: false, pinned: true });
    expect(store.inspect().pins).toEqual([memory.id]);
    expect(store.inspect().sequence).toBe(sequenceBeforePin + 1);

    expect(await core.unpinMemory({ id: memory.id })).toEqual({ changed: true, pinned: false });
    expect(await core.unpinMemory({ id: memory.id })).toEqual({ changed: false, pinned: false });
    expect(store.inspect().pins).toEqual([]);

    await expectAsyncCode(core.pinMemory({ id: `mem_${"a".repeat(32)}` }), "not_found");
  });

  test("canonicalizes symmetric links, preserves directed links and validates both endpoints", async () => {
    const { core, store } = harness();
    const first = await save(core, { title: "First endpoint" });
    const second = await save(core, { title: "Second endpoint" });

    const related = await core.linkMemory({
      sourceId: second.id,
      targetId: first.id,
      type: "related",
    });
    const relatedAgain = await core.linkMemory({
      sourceId: first.id,
      targetId: second.id,
      type: "related",
    });
    expect(related.changed).toBe(true);
    expect(related.relation).toMatchObject({
      sourceId: [first.id, second.id].sort()[0],
      targetId: [first.id, second.id].sort()[1],
      type: "related",
    });
    expect(relatedAgain).toEqual({ changed: false, relation: related.relation });

    const forward = await core.linkMemory({
      sourceId: first.id,
      targetId: second.id,
      type: "supersedes",
    });
    const reverse = await core.linkMemory({
      sourceId: second.id,
      targetId: first.id,
      type: "supersedes",
    });
    expect(forward.relation.id).not.toBe(reverse.relation.id);
    expect(store.inspect().relations).toHaveLength(3);

    expect(await core.unlinkMemory({
      sourceId: second.id,
      targetId: first.id,
      type: "related",
    })).toEqual({ changed: true });
    expect(await core.unlinkMemory({
      sourceId: first.id,
      targetId: second.id,
      type: "related",
    })).toEqual({ changed: false });
    expect(await core.getMemory({ id: first.id })).toMatchObject({ id: first.id });

    await expectAsyncCode(core.linkMemory({
      sourceId: first.id,
      targetId: first.id,
      type: "related",
    }), "invalid_input");
    await expectAsyncCode(core.linkMemory({
      sourceId: first.id,
      targetId: `mem_${"b".repeat(32)}`,
      type: "conflicts_with",
    }), "not_found");
    await expectAsyncCode(core.linkMemory({
      sourceId: first.id,
      targetId: second.id,
      type: "authorizes",
    } as never), "invalid_input");
  });
});

describe("Horiel move and promote previews", () => {
  test("moves atomically with exact confirmation while preserving identity and history", async () => {
    const { core, store, clock } = harness();
    const original = await save(core, { scope: "acme/task/HU-7", title: "Move me" });
    const sequence = store.inspect().sequence;
    const preview = await core.previewMove({
      id: original.id,
      destinationScope: "acme/task/HU-8",
    });

    expect(preview).toMatchObject({
      kind: "move",
      memoryId: original.id,
      sourceScope: "acme/task/HU-7",
      destinationScope: "acme/task/HU-8",
      expectedVersion: 1,
      sequence,
      storeId: store.inspect().storeId,
    });
    expect(store.inspect().sequence).toBe(sequence);

    await expectAsyncCode(core.moveMemory({
      previewId: preview.id,
      confirmation: `${preview.confirmation}-wrong`,
    }), "confirmation_mismatch");
    expect((await core.getMemory({ id: original.id })).scope).toBe("acme/task/HU-7");

    clock.advance(1_000);
    const moved = await core.moveMemory({
      previewId: preview.id,
      confirmation: preview.confirmation,
    });
    expect(moved.memory).toMatchObject({
      id: original.id,
      scope: "acme/task/HU-8",
      version: 2,
      createdAt: original.createdAt,
    });
    expect(await core.getMemory({ id: original.id, version: 1 })).toEqual(original);
    expect(store.inspect().history[original.id]).toHaveLength(2);

    await expectAsyncCode(core.moveMemory({
      previewId: preview.id,
      confirmation: preview.confirmation,
    }), "confirmation_mismatch");
  });

  test("rejects stale previews and only promotes to a strict segment ancestor", async () => {
    const { core } = harness();
    const staleTarget = await save(core, { scope: "acme/task/HU-9", title: "Stale target" });
    const stale = await core.previewMove({
      id: staleTarget.id,
      destinationScope: "acme/task/HU-10",
    });
    await core.pinMemory({ id: staleTarget.id });
    await expectAsyncCode(core.moveMemory({
      previewId: stale.id,
      confirmation: stale.confirmation,
    }), "confirmation_mismatch");
    expect((await core.getMemory({ id: staleTarget.id })).scope).toBe("acme/task/HU-9");

    const promotable = await save(core, {
      scope: "acme/task/HU-11/backend",
      title: "Promotable",
    });
    for (const ancestor of [
      "acme/task/HU-11/backend",
      "acme/task/HU-11/backend/deeper",
      "acme/task/HU-12",
      "other",
      "@global",
    ]) {
      await expectAsyncCode(core.previewPromote({ id: promotable.id, ancestor }), "invalid_input");
    }

    const preview = await core.previewPromote({
      id: promotable.id,
      ancestor: "acme/task",
    });
    const promoted = await core.promoteMemory({
      previewId: preview.id,
      confirmation: preview.confirmation,
    });
    expect(promoted.memory).toMatchObject({
      id: promotable.id,
      scope: "acme/task",
      version: 2,
    });
  });
});

describe("Horiel backup, exact delete and conditional restore", () => {
  test("requires a verified backup, deletes only the exact scope and consumes confirmation once", async () => {
    const { core, store } = harness();
    const exact = await save(core, { scope: "acme/task", title: "Delete exact" });
    const child = await save(core, { scope: "acme/task/HU-1", title: "Keep child" });
    const sibling = await save(core, { scope: "acme/other", title: "Keep sibling" });
    const preview = await core.previewDeleteScope({ scope: "acme/task" });
    const before = store.inspect();

    store.setNextSnapshotVerified(false);
    await expectAsyncCode(core.deleteScope({
      previewId: preview.id,
      confirmation: preview.confirmation,
    }), "integrity_failed");
    expect(store.inspect().memories.map((memory) => memory.id).sort()).toEqual(
      before.memories.map((memory) => memory.id).sort(),
    );
    expect(store.inspect().sequence).toBe(before.sequence);

    const deleted = await core.deleteScope({
      previewId: preview.id,
      confirmation: preview.confirmation,
    });
    expect(deleted.deletedMemoryIds).toEqual([exact.id]);
    expect(deleted.backup.verified).toBe(true);
    expect(store.inspect().memories.map((memory) => memory.id).sort()).toEqual([child.id, sibling.id].sort());
    expect(store.inspect().snapshots).toHaveLength(2);

    await expectAsyncCode(core.deleteScope({
      previewId: preview.id,
      confirmation: preview.confirmation,
    }), "confirmation_mismatch");
  });

  test("rolls back a failed delete but retains the safe backup that was already created", async () => {
    const { core, store } = harness();
    const memory = await save(core, { scope: "acme/task", title: "Rollback delete" });
    const preview = await core.previewDeleteScope({ scope: "acme/task" });
    store.failNextWrite(new Error("synthetic delete commit failure"));

    await expectAsyncCode(core.deleteScope({
      previewId: preview.id,
      confirmation: preview.confirmation,
    }), "unavailable");
    expect(await core.getMemory({ id: memory.id })).toMatchObject({ id: memory.id });
    expect(store.inspect().snapshots.at(-1)?.verified).toBe(true);
    expect(store.inspect().previews.find((entry) => entry.id === preview.id)?.consumedAt).toBeUndefined();
  });

  test("binds restore to snapshot, store and sequence and leaves no partial restore on failure", async () => {
    const { core, store, clock } = harness();
    const original = await save(core, { title: "Before snapshot", content: "original" });
    const snapshot = await core.createBackup();
    expect(snapshot).toMatchObject({
      storeId: store.inspect().storeId,
      sequence: store.inspect().sequence,
      verified: true,
    });

    clock.advance(1_000);
    const changed = await core.updateMemory({
      id: original.id,
      expectedVersion: 1,
      content: "changed after backup",
    });
    const stale = await core.previewRestore({ snapshotId: snapshot.id });
    expect(stale).toMatchObject({
      kind: "restore",
      snapshotId: snapshot.id,
      storeId: store.inspect().storeId,
      sequence: store.inspect().sequence,
    });

    await expectAsyncCode(core.restore({
      previewId: stale.id,
      confirmation: `${stale.confirmation}-wrong`,
    }), "confirmation_mismatch");
    expect((await core.getMemory({ id: original.id })).content).toBe("changed after backup");

    await core.pinMemory({ id: original.id });
    await expectAsyncCode(core.restore({
      previewId: stale.id,
      confirmation: stale.confirmation,
    }), "confirmation_mismatch");

    const preview = await core.previewRestore({ snapshotId: snapshot.id });
    const snapshotsBeforeFailure = store.inspect().snapshots.length;
    store.failNextRestore(new Error("raw restore adapter failure"));
    const failure = await expectAsyncCode(core.restore({
      previewId: preview.id,
      confirmation: preview.confirmation,
    }), "unavailable");
    expect(failure.message).not.toContain("raw restore adapter failure");
    expect(await core.getMemory({ id: original.id })).toEqual(changed.memory);
    expect(store.inspect().snapshots.length).toBe(snapshotsBeforeFailure + 1);
    expect(store.inspect().previews.find((entry) => entry.id === preview.id)?.consumedAt).toBeUndefined();

    const restored = await core.restore({
      previewId: preview.id,
      confirmation: preview.confirmation,
    });
    expect(restored.snapshot.id).toBe(snapshot.id);
    expect(await core.getMemory({ id: original.id })).toEqual(original);
    expect(store.inspect().pins).toEqual([]);

    await expectAsyncCode(core.restore({
      previewId: preview.id,
      confirmation: preview.confirmation,
    }), "confirmation_mismatch");
  });
});
