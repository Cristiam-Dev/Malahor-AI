import { HorielError, invalidInput, storeOperation } from "./errors";
import { assertHorielId, nextHorielId, type HorielIdFactory } from "./ids";
import type { HorielClock, IdempotencyBinding, MemoryProvenance, MemoryRecord, MemoryType } from "./model";
import {
  normalizeSearchRequest,
  rankSearchCandidates,
  type RankedMemory,
  type SearchMemoryInput,
} from "./query";
import { parseScopePath } from "./scopes";
import type { HorielStore } from "./store";
import {
  canonicalHash,
  canonicalTimestamp,
  validateMemoryDraft,
  validatePositiveVersion,
  type MemoryDraftInput,
} from "./validation";

export interface HorielCoreDependencies {
  store: HorielStore;
  clock: HorielClock;
  idFactory: HorielIdFactory;
}

export interface SaveMemoryInput extends MemoryDraftInput {
  provenance: MemoryProvenance;
}

export interface SaveMemoryResult {
  status: "created" | "replayed";
  memory: MemoryRecord;
}

export interface UpdateMemoryInput {
  id: string;
  expectedVersion: number;
  type?: MemoryType;
  title?: string;
  content?: string;
  tags?: readonly string[];
  provenance?: MemoryProvenance;
}

export interface UpdateMemoryResult {
  status: "updated";
  memory: MemoryRecord;
}

export interface GetMemoryInput {
  id: string;
  version?: number;
}

export interface SearchMemoryResult {
  rankingVersion: 1;
  items: RankedMemory[];
  sequence: number;
  nextCursor?: string;
}

export async function saveMemory(
  dependencies: HorielCoreDependencies,
  input: SaveMemoryInput,
): Promise<SaveMemoryResult> {
  const draft = validateMemoryDraft(input);
  const requestHash = canonicalHash({
    scope: draft.scope,
    type: draft.type,
    title: draft.title,
    content: draft.content,
    tags: draft.tags,
    provenance: draft.provenance,
  });
  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const existing = await transaction.getIdempotencyBinding(draft.idempotencyKey);
    if (existing) {
      assertMatchingBinding(existing, "memory.create", requestHash);
      const memory = await transaction.getMemory(existing.entityId, existing.entityVersion);
      if (!memory) throw new HorielError("integrity_failed", "Idempotent memory result is unavailable.");
      return { status: "replayed", memory };
    }

    const now = canonicalTimestamp(dependencies.clock.now());
    const memory: MemoryRecord = {
      id: nextHorielId(dependencies.idFactory, "mem"),
      scope: draft.scope,
      type: draft.type,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      createdAt: now,
      updatedAt: now,
      version: 1,
      provenance: draft.provenance,
    };
    const binding: IdempotencyBinding = {
      key: draft.idempotencyKey,
      operation: "memory.create",
      requestHash,
      entity: "memory",
      entityId: memory.id,
      entityVersion: memory.version,
      createdAt: now,
    };
    await transaction.insertMemory(memory);
    await transaction.putIdempotencyBinding(binding);
    return { status: "created", memory };
  }));
}

export async function updateMemory(
  dependencies: HorielCoreDependencies,
  input: UpdateMemoryInput,
): Promise<UpdateMemoryResult> {
  if (!input || typeof input !== "object") return invalidInput("Memory update is required.");
  const id = assertHorielId(input.id, "mem");
  const expectedVersion = validatePositiveVersion(input.expectedVersion);
  const fields = ["type", "title", "content", "tags", "provenance"] as const;
  if (!fields.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
    return invalidInput("Memory update must contain at least one change.");
  }
  const allowed = new Set(["id", "expectedVersion", ...fields]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return invalidInput("Memory update contains unknown fields.");

  return storeOperation(() => dependencies.store.write(async (transaction) => {
    const current = await transaction.getMemory(id);
    if (!current) throw new HorielError("not_found", "Memory was not found.");
    if (current.version !== expectedVersion) throw new HorielError("conflict", "Memory version does not match.");
    const normalized = validateMemoryDraft({
      scope: current.scope,
      type: input.type ?? current.type,
      title: input.title ?? current.title,
      content: input.content ?? current.content,
      tags: input.tags ?? current.tags,
      idempotencyKey: "update-000000",
      provenance: input.provenance ?? current.provenance,
    });
    const memory: MemoryRecord = {
      ...current,
      type: normalized.type,
      title: normalized.title,
      content: normalized.content,
      tags: normalized.tags,
      provenance: normalized.provenance,
      version: current.version + 1,
      updatedAt: canonicalTimestamp(dependencies.clock.now()),
    };
    await transaction.replaceMemory(memory, expectedVersion);
    return { status: "updated", memory };
  }));
}

export async function getMemory(
  dependencies: HorielCoreDependencies,
  input: GetMemoryInput,
): Promise<MemoryRecord> {
  if (!input || typeof input !== "object") return invalidInput("Memory lookup is required.");
  const id = assertHorielId(input.id, "mem");
  const version = input.version === undefined ? undefined : validatePositiveVersion(input.version);
  return storeOperation(async () => {
    const memory = await dependencies.store.read((transaction) => transaction.getMemory(id, version));
    if (!memory) throw new HorielError("not_found", "Memory was not found.");
    return memory;
  });
}

export async function searchMemory(
  dependencies: HorielCoreDependencies,
  input: SearchMemoryInput,
): Promise<SearchMemoryResult> {
  const request = normalizeSearchRequest({ ...input, scope: parseScopePath(input?.scope) });
  return storeOperation(async () => {
    const page = await dependencies.store.read((transaction) => transaction.searchCandidates(request));
    const items = rankSearchCandidates(page.items, request);
    return {
      rankingVersion: 1,
      items,
      sequence: page.sequence,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });
}

function assertMatchingBinding(
  binding: IdempotencyBinding,
  operation: IdempotencyBinding["operation"],
  requestHash: string,
): void {
  if (binding.operation !== operation || binding.requestHash !== requestHash) {
    throw new HorielError("conflict", "Idempotency key is already bound to a different request.");
  }
}
