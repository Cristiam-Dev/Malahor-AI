import { HorielError, invalidInput, storeOperation } from "./errors";
import { assertHorielId, isHorielId, nextHorielId } from "./ids";
import type {
  DeleteScopePreview,
  HorielSnapshotDescriptor,
  RestorePreview,
  StoredPreview,
} from "./model";
import type { HorielCoreDependencies } from "./memories";
import { parseScopePath } from "./scopes";
import { canonicalHash, canonicalTimestamp } from "./validation";

export async function createBackup(
  dependencies: HorielCoreDependencies,
): Promise<HorielSnapshotDescriptor> {
  const snapshotId = nextHorielId(dependencies.idFactory, "snp");
  const descriptor = await storeOperation(() => dependencies.store.createSnapshot({
    id: snapshotId,
    createdAt: canonicalTimestamp(dependencies.clock.now()),
  }));
  assertSnapshotDescriptor(descriptor, { snapshotId });
  return descriptor;
}

export async function previewDeleteScope(
  dependencies: HorielCoreDependencies,
  input: { scope: string },
): Promise<DeleteScopePreview> {
  const scope = parseScopePath(input?.scope);
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const [info, inspection] = await Promise.all([
      transaction.getStoreInfo(),
      transaction.inspectScope(scope),
    ]);
    const preview: DeleteScopePreview = {
      id: nextHorielId(dependencies.idFactory, "prv"),
      kind: "delete_scope",
      scope,
      memoryIds: [...inspection.memoryIds].sort(),
      checkpointCount: inspection.checkpointCount,
      storeId: info.storeId,
      sequence: info.sequence,
      confirmation: `DELETE SCOPE ${scope}`,
      createdAt: canonicalTimestamp(dependencies.clock.now()),
    };
    await transaction.putPreview(preview);
    return preview;
  }));
}

export async function deleteScope(
  dependencies: HorielCoreDependencies,
  input: { previewId: string; confirmation: string },
): Promise<{ deletedMemoryIds: string[]; backup: HorielSnapshotDescriptor }> {
  const preview = await activePreview(dependencies, input, "delete_scope");
  const backup = await createBackup(dependencies);
  const deletedMemoryIds = await storeOperation(() => dependencies.store.write(async (transaction) => {
    const fresh = await transaction.getPreview(preview.id);
    const info = await transaction.getStoreInfo();
    assertSamePreview(fresh, preview, input.confirmation);
    if (info.storeId !== preview.storeId || info.sequence !== preview.sequence) {
      throw new HorielError("confirmation_mismatch", "Delete preview is stale.");
    }
    const removed = await transaction.deleteExactScope(preview.scope);
    await transaction.consumePreview(preview.id, canonicalTimestamp(dependencies.clock.now()));
    return removed;
  }));
  return { deletedMemoryIds, backup };
}

export async function previewRestore(
  dependencies: HorielCoreDependencies,
  input: { snapshotId: string },
): Promise<RestorePreview> {
  const snapshotId = assertHorielId(input?.snapshotId, "snp");
  const snapshot = await storeOperation(() => dependencies.store.inspectSnapshot(snapshotId));
  if (!snapshot) throw new HorielError("not_found", "Horiel snapshot was not found.");
  assertSnapshotDescriptor(snapshot, { snapshotId });
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const info = await transaction.getStoreInfo();
    if (snapshot.storeId !== info.storeId) {
      throw new HorielError("integrity_failed", "Horiel snapshot belongs to another store.");
    }
    const preview: RestorePreview = {
      id: nextHorielId(dependencies.idFactory, "prv"),
      kind: "restore",
      snapshotId,
      snapshotFingerprint: snapshot.fingerprint,
      storeId: info.storeId,
      sequence: info.sequence,
      confirmation: `RESTORE ${snapshotId}`,
      createdAt: canonicalTimestamp(dependencies.clock.now()),
    };
    await transaction.putPreview(preview);
    return preview;
  }));
}

export async function restore(
  dependencies: HorielCoreDependencies,
  input: { previewId: string; confirmation: string },
): Promise<{ snapshot: HorielSnapshotDescriptor; backup: HorielSnapshotDescriptor }> {
  const preview = await activePreview(dependencies, input, "restore");
  const snapshot = await storeOperation(() => dependencies.store.inspectSnapshot(preview.snapshotId));
  if (!snapshot) throw new HorielError("not_found", "Horiel snapshot was not found.");
  assertSnapshotDescriptor(snapshot, { snapshotId: preview.snapshotId, storeId: preview.storeId });
  if (snapshot.fingerprint !== preview.snapshotFingerprint) {
    throw new HorielError("integrity_failed", "Horiel snapshot no longer matches the restore preview.");
  }
  const backup = await createBackup(dependencies);
  const restored = await storeOperation(() => dependencies.store.restoreSnapshot({
    previewId: preview.id,
    snapshotId: preview.snapshotId,
    confirmation: input.confirmation,
    expectedStoreId: preview.storeId,
    expectedSequence: preview.sequence,
    consumedAt: canonicalTimestamp(dependencies.clock.now()),
  }));
  assertSnapshotDescriptor(restored, { snapshotId: preview.snapshotId, storeId: preview.storeId });
  return { snapshot: restored, backup };
}

async function activePreview<K extends StoredPreview["kind"]>(
  dependencies: HorielCoreDependencies,
  input: { previewId: string; confirmation: string },
  kind: K,
): Promise<Extract<StoredPreview, { kind: K }>> {
  const previewId = assertHorielId(input?.previewId, "prv");
  if (typeof input.confirmation !== "string") return invalidInput("Administrative confirmation is required.");
  return storeOperation(() => dependencies.store.read(async (transaction) => {
    const preview = await transaction.getPreview(previewId);
    if (!preview || preview.kind !== kind || preview.consumedAt || preview.confirmation !== input.confirmation) {
      throw new HorielError("confirmation_mismatch", "Administrative preview or confirmation does not match.");
    }
    const info = await transaction.getStoreInfo();
    if (info.storeId !== preview.storeId || info.sequence !== preview.sequence) {
      throw new HorielError("confirmation_mismatch", "Administrative preview is stale.");
    }
    return preview as Extract<StoredPreview, { kind: K }>;
  }));
}

function assertSamePreview(
  value: StoredPreview | undefined,
  expected: StoredPreview,
  confirmation: string,
): void {
  if (!value || value.id !== expected.id || value.kind !== expected.kind || value.consumedAt
    || value.confirmation !== confirmation || value.storeId !== expected.storeId
    || value.sequence !== expected.sequence || canonicalHash(value) !== canonicalHash(expected)) {
    throw new HorielError("confirmation_mismatch", "Administrative preview changed before apply.");
  }
}

function assertSnapshotDescriptor(
  value: HorielSnapshotDescriptor,
  expected: { snapshotId: string; storeId?: string },
): void {
  const counts = value?.counts;
  const canonicalDate = typeof value?.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && new Date(value.createdAt).toISOString() === value.createdAt;
  if (!value || value.id !== expected.snapshotId || !isHorielId(value.id, "snp")
    || !isHorielId(value.storeId, "store") || (expected.storeId !== undefined && value.storeId !== expected.storeId)
    || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !canonicalDate
    || !counts || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || value.verified !== true) {
    throw new HorielError("integrity_failed", "Horiel snapshot verification failed.");
  }
}
