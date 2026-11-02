import { HorielError, invalidInput, storeOperation } from "./errors";
import { assertHorielId, nextHorielId } from "./ids";
import {
  RELATION_TYPES,
  type MemoryRecord,
  type MemoryRelation,
  type MemoryRelationType,
  type MovePreview,
} from "./model";
import type { HorielCoreDependencies } from "./memories";
import { isStrictScopeAncestor, parseScopePath } from "./scopes";
import type { HorielWriteTransaction } from "./store";
import { canonicalTimestamp } from "./validation";

export async function pinMemory(
  dependencies: HorielCoreDependencies,
  input: { id: string },
): Promise<{ changed: boolean; pinned: true }> {
  const id = assertHorielId(input?.id, "mem");
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    if (!await transaction.getMemory(id)) throw new HorielError("not_found", "Memory was not found.");
    if (await transaction.isPinned(id)) return { changed: false, pinned: true };
    await transaction.putPin(id);
    return { changed: true, pinned: true };
  }));
}

export async function unpinMemory(
  dependencies: HorielCoreDependencies,
  input: { id: string },
): Promise<{ changed: boolean; pinned: false }> {
  const id = assertHorielId(input?.id, "mem");
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    if (!await transaction.isPinned(id)) return { changed: false, pinned: false };
    await transaction.deletePin(id);
    return { changed: true, pinned: false };
  }));
}

export interface LinkMemoryInput {
  sourceId: string;
  targetId: string;
  type: MemoryRelationType;
}

export async function linkMemory(
  dependencies: HorielCoreDependencies,
  input: LinkMemoryInput,
): Promise<{ changed: boolean; relation: MemoryRelation }> {
  const normalized = normalizeRelationInput(input);
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const [source, target] = await Promise.all([
      transaction.getMemory(normalized.sourceId),
      transaction.getMemory(normalized.targetId),
    ]);
    if (!source || !target) throw new HorielError("not_found", "Relation endpoint was not found.");
    const existing = await transaction.getRelation(normalized.type, normalized.sourceId, normalized.targetId);
    if (existing) return { changed: false, relation: existing };
    const relation: MemoryRelation = {
      id: nextHorielId(dependencies.idFactory, "rel"),
      ...normalized,
      createdAt: canonicalTimestamp(dependencies.clock.now()),
    };
    await transaction.putRelation(relation);
    return { changed: true, relation };
  }));
}

export async function unlinkMemory(
  dependencies: HorielCoreDependencies,
  input: LinkMemoryInput,
): Promise<{ changed: boolean }> {
  const normalized = normalizeRelationInput(input);
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const existing = await transaction.getRelation(normalized.type, normalized.sourceId, normalized.targetId);
    if (!existing) return { changed: false };
    await transaction.deleteRelation(normalized.type, normalized.sourceId, normalized.targetId);
    return { changed: true };
  }));
}

export async function previewMove(
  dependencies: HorielCoreDependencies,
  input: { id: string; destinationScope: string },
): Promise<MovePreview> {
  const id = assertHorielId(input?.id, "mem");
  const destinationScope = parseScopePath(input?.destinationScope);
  return createMovePreview(dependencies, id, destinationScope, "move");
}

export async function previewPromote(
  dependencies: HorielCoreDependencies,
  input: { id: string; ancestor: string },
): Promise<MovePreview> {
  const id = assertHorielId(input?.id, "mem");
  const ancestor = parseScopePath(input?.ancestor);
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const memory = await transaction.getMemory(id);
    if (!memory) throw new HorielError("not_found", "Memory was not found.");
    if (!isStrictScopeAncestor(ancestor, memory.scope)) {
      throw new HorielError("invalid_input", "Promotion target must be a strict scope ancestor.");
    }
    return putMovePreview(dependencies, transaction, memory, ancestor, "promote");
  }));
}

export async function moveMemory(
  dependencies: HorielCoreDependencies,
  input: { previewId: string; confirmation: string },
): Promise<{ memory: MemoryRecord }> {
  return applyMovePreview(dependencies, input, "move");
}

export async function promoteMemory(
  dependencies: HorielCoreDependencies,
  input: { previewId: string; confirmation: string },
): Promise<{ memory: MemoryRecord }> {
  return applyMovePreview(dependencies, input, "promote");
}

async function createMovePreview(
  dependencies: HorielCoreDependencies,
  id: string,
  destinationScope: string,
  kind: MovePreview["kind"],
): Promise<MovePreview> {
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const memory = await transaction.getMemory(id);
    if (!memory) throw new HorielError("not_found", "Memory was not found.");
    if (memory.scope === destinationScope) return invalidInput("Move destination must differ from the current scope.");
    return putMovePreview(dependencies, transaction, memory, destinationScope, kind);
  }));
}

async function putMovePreview(
  dependencies: HorielCoreDependencies,
  transaction: HorielWriteTransaction,
  memory: MemoryRecord,
  destinationScope: string,
  kind: MovePreview["kind"],
): Promise<MovePreview> {
  const info = await transaction.getStoreInfo();
  const destinationRecords = await transaction.listContextCandidates({
    scope: destinationScope,
    rollup: false,
    includeGlobal: destinationScope === "@global",
  });
  const conflictIds = destinationRecords
    .filter((candidate) => candidate.scope === destinationScope && candidate.id !== memory.id
      && candidate.type === memory.type && candidate.title === memory.title)
    .map((candidate) => candidate.id)
    .sort();
  const verb = kind === "promote" ? "PROMOTE" : "MOVE";
  const preview: MovePreview = {
    id: nextHorielId(dependencies.idFactory, "prv"),
    kind,
    memoryId: memory.id,
    sourceScope: memory.scope,
    destinationScope,
    expectedVersion: memory.version,
    conflictIds,
    storeId: info.storeId,
    sequence: info.sequence,
    confirmation: `${verb} ${memory.id} TO ${destinationScope}`,
    createdAt: canonicalTimestamp(dependencies.clock.now()),
  };
  await transaction.putPreview(preview);
  return preview;
}

async function applyMovePreview(
  dependencies: HorielCoreDependencies,
  input: { previewId: string; confirmation: string },
  expectedKind: MovePreview["kind"],
): Promise<{ memory: MemoryRecord }> {
  const previewId = assertHorielId(input?.previewId, "prv");
  if (typeof input.confirmation !== "string") return invalidInput("Move confirmation is required.");
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const preview = await transaction.getPreview(previewId);
    if (!preview || preview.kind !== expectedKind || preview.consumedAt
      || preview.confirmation !== input.confirmation) {
      throw new HorielError("confirmation_mismatch", "Move preview or confirmation does not match.");
    }
    const info = await transaction.getStoreInfo();
    if (info.storeId !== preview.storeId || info.sequence !== preview.sequence) {
      throw new HorielError("confirmation_mismatch", "Move preview is stale.");
    }
    const current = await transaction.getMemory(preview.memoryId);
    if (!current || current.scope !== preview.sourceScope || current.version !== preview.expectedVersion) {
      throw new HorielError("conflict", "Memory changed after the move preview.");
    }
    const now = canonicalTimestamp(dependencies.clock.now());
    const memory: MemoryRecord = {
      ...current,
      scope: preview.destinationScope,
      version: current.version + 1,
      updatedAt: now,
    };
    await transaction.moveMemory(memory, current.version);
    await transaction.consumePreview(preview.id, now);
    return { memory };
  }));
}

function normalizeRelationInput(input: LinkMemoryInput): LinkMemoryInput {
  if (!input || typeof input !== "object") return invalidInput("Relation input is required.");
  let sourceId = assertHorielId(input.sourceId, "mem");
  let targetId = assertHorielId(input.targetId, "mem");
  if (sourceId === targetId) return invalidInput("A memory cannot relate to itself.");
  if (typeof input.type !== "string" || !RELATION_TYPES.includes(input.type as MemoryRelationType)) {
    return invalidInput("Relation type is not supported.");
  }
  const type = input.type as MemoryRelationType;
  if ((type === "related" || type === "conflicts_with") && sourceId > targetId) {
    [sourceId, targetId] = [targetId, sourceId];
  }
  return { sourceId, targetId, type };
}
