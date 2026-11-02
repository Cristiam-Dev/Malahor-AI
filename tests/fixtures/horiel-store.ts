import { createHash } from "node:crypto";

import { HorielError } from "../../src/horiel/core";
import type {
  HorielReadTransaction,
  HorielSnapshotDescriptor,
  HorielStore,
  HorielWriteTransaction,
  IdempotencyBinding,
  MemoryRecord,
  MemoryRelation,
  ScopeInspection,
  ScopeSummary,
  SessionCheckpoint,
  StoreContextRequest,
  StoreRestoreRequest,
  StoreSearchCandidate,
  StoreSearchPage,
  StoreSearchRequest,
  StoredPreview,
} from "../../src/horiel/core";

type MaybePromise<T> = T | Promise<T>;

interface FakeState {
  storeId: string;
  sequence: number;
  memories: Map<string, MemoryRecord>;
  history: Map<string, MemoryRecord[]>;
  idempotency: Map<string, IdempotencyBinding>;
  checkpoints: Map<string, SessionCheckpoint>;
  pins: Set<string>;
  relations: Map<string, MemoryRelation>;
  previews: Map<string, StoredPreview>;
}

interface StoredSnapshot {
  descriptor: HorielSnapshotDescriptor;
  state: FakeState;
}

export interface FakeHorielStoreInspection {
  storeId: string;
  sequence: number;
  memories: MemoryRecord[];
  history: Record<string, MemoryRecord[]>;
  idempotency: IdempotencyBinding[];
  checkpoints: SessionCheckpoint[];
  pins: string[];
  relations: MemoryRelation[];
  previews: StoredPreview[];
  snapshots: HorielSnapshotDescriptor[];
  writeCommits: number;
  lastSearch?: StoreSearchRequest;
}

const DEFAULT_STORE_ID = `store_${"f".repeat(32)}`;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function cloneState(state: FakeState): FakeState {
  return {
    storeId: state.storeId,
    sequence: state.sequence,
    memories: new Map([...state.memories].map(([id, value]) => [id, copy(value)])),
    history: new Map([...state.history].map(([id, values]) => [id, copy(values)])),
    idempotency: new Map([...state.idempotency].map(([key, value]) => [key, copy(value)])),
    checkpoints: new Map([...state.checkpoints].map(([id, value]) => [id, copy(value)])),
    pins: new Set(state.pins),
    relations: new Map([...state.relations].map(([key, value]) => [key, copy(value)])),
    previews: new Map([...state.previews].map(([id, value]) => [id, copy(value)])),
  };
}

function isSymmetric(type: string): boolean {
  return type === "related" || type === "conflicts_with";
}

function relationKey(type: string, sourceId: string, targetId: string): string {
  const [source, target] = isSymmetric(type) && sourceId > targetId
    ? [targetId, sourceId]
    : [sourceId, targetId];
  return `${type}\u0000${source}\u0000${target}`;
}

function segments(scope: string): string[] {
  return scope === "@global" ? [] : scope.split("/");
}

function isSameOrDescendant(scope: string, ancestor: string): boolean {
  if (scope === "@global" || ancestor === "@global") return scope === ancestor;
  const value = segments(scope);
  const parent = segments(ancestor);
  return parent.length <= value.length && parent.every((segment, index) => value[index] === segment);
}

function scopeEligible(recordScope: string, request: StoreSearchRequest): boolean {
  if (recordScope === "@global") return request.includeGlobal === true;
  if (request.scope === "@global") return false;
  const recordProject = segments(recordScope)[0];
  const requestedProject = segments(request.scope)[0];
  if (recordProject !== requestedProject) return false;
  if (recordScope === request.scope) return true;
  if (request.includeAncestors && isSameOrDescendant(request.scope, recordScope)) return true;
  return request.rollup === true && isSameOrDescendant(recordScope, request.scope);
}

function contextEligible(recordScope: string, request: StoreContextRequest): boolean {
  if (recordScope === "@global") return request.includeGlobal;
  if (request.scope === "@global") return false;
  if (segments(recordScope)[0] !== segments(request.scope)[0]) return false;
  if (recordScope === request.scope || isSameOrDescendant(request.scope, recordScope)) return true;
  return request.rollup && isSameOrDescendant(recordScope, request.scope);
}

function literalOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + needle.length;
  }
  return count;
}

function textScore(record: MemoryRecord, terms: string[]): number {
  const haystack = [record.title, record.content, ...record.tags]
    .join("\n")
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
  let occurrences = 0;
  let uniqueMatches = 0;
  for (const rawTerm of terms) {
    const term = rawTerm.normalize("NFC").toLocaleLowerCase("en-US");
    const count = literalOccurrences(haystack, term);
    occurrences += count;
    if (count > 0) uniqueMatches += 1;
  }
  if (uniqueMatches === 0) return 0;
  return Math.min(1000, uniqueMatches * 200 + Math.min(occurrences, 20) * 10);
}

function compareById<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function snapshotCounts(state: FakeState): HorielSnapshotDescriptor["counts"] {
  return {
    memories: state.memories.size,
    checkpoints: state.checkpoints.size,
    pins: state.pins.size,
    relations: state.relations.size,
  };
}

function fingerprint(state: FakeState): string {
  const canonical = {
    storeId: state.storeId,
    sequence: state.sequence,
    memories: [...state.memories].sort(([left], [right]) => left.localeCompare(right)),
    history: [...state.history].sort(([left], [right]) => left.localeCompare(right)),
    idempotency: [...state.idempotency].sort(([left], [right]) => left.localeCompare(right)),
    checkpoints: [...state.checkpoints].sort(([left], [right]) => left.localeCompare(right)),
    pins: [...state.pins].sort(),
    relations: [...state.relations].sort(([left], [right]) => left.localeCompare(right)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Transactional, in-memory implementation of the public P2 port.
 *
 * It intentionally does not touch a filesystem, database, home directory or
 * network. Every write works against a deep clone and only publishes that clone
 * after the callback and the synthetic commit both succeed.
 */
export class FakeHorielStore implements HorielStore {
  private state: FakeState;
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private writeTail: Promise<void> = Promise.resolve();
  private writeCommits = 0;
  private nextWriteFailure?: Error;
  private nextSnapshotFailure?: Error;
  private nextRestoreFailure?: Error;
  private nextSnapshotVerified = true;
  private readonly leakedSearchCandidates = new Map<string, number>();
  private lastSearch?: StoreSearchRequest;

  constructor(storeId = DEFAULT_STORE_ID) {
    this.state = {
      storeId,
      sequence: 0,
      memories: new Map(),
      history: new Map(),
      idempotency: new Map(),
      checkpoints: new Map(),
      pins: new Set(),
      relations: new Map(),
      previews: new Map(),
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.writeTail.then(operation, operation);
    this.writeTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async read<T>(callback: (transaction: HorielReadTransaction) => MaybePromise<T>): Promise<T> {
    await this.writeTail;
    const stable = cloneState(this.state);
    return await callback(this.readTransaction(stable));
  }

  write<T>(callback: (transaction: HorielWriteTransaction) => MaybePromise<T>): Promise<T> {
    return this.enqueue(async () => {
      const before = this.state;
      const working = cloneState(before);
      const mutation = { dataChanged: false };
      const result = await callback(this.writeTransaction(working, mutation));
      if (this.nextWriteFailure) {
        const failure = this.nextWriteFailure;
        this.nextWriteFailure = undefined;
        throw failure;
      }
      working.sequence = mutation.dataChanged ? before.sequence + 1 : before.sequence;
      this.state = working;
      this.writeCommits += 1;
      return result;
    });
  }

  createSnapshot(input: { id: string; createdAt: string }): Promise<HorielSnapshotDescriptor> {
    return this.enqueue(async () => {
      if (this.nextSnapshotFailure) {
        const failure = this.nextSnapshotFailure;
        this.nextSnapshotFailure = undefined;
        throw failure;
      }
      const stable = cloneState(this.state);
      const descriptor = {
        id: input.id,
        storeId: stable.storeId,
        schemaVersion: 1,
        sequence: stable.sequence,
        createdAt: input.createdAt,
        counts: snapshotCounts(stable),
        fingerprint: fingerprint(stable),
        verified: this.nextSnapshotVerified,
      } as HorielSnapshotDescriptor;
      this.nextSnapshotVerified = true;
      this.snapshots.set(descriptor.id, { descriptor: copy(descriptor), state: stable });
      return copy(descriptor);
    });
  }

  async inspectSnapshot(snapshotId: string): Promise<HorielSnapshotDescriptor | undefined> {
    await this.writeTail;
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot ? copy(snapshot.descriptor) : undefined;
  }

  restoreSnapshot(input: StoreRestoreRequest): Promise<HorielSnapshotDescriptor> {
    return this.enqueue(async () => {
      const current = this.state;
      const preview = current.previews.get(input.previewId);
      const snapshot = this.snapshots.get(input.snapshotId);
      if (!preview || preview.consumedAt) {
        throw new HorielError("confirmation_mismatch", "Restore preview is absent or already consumed");
      }
      if (
        preview.kind !== "restore"
        || preview.confirmation !== input.confirmation
        || preview.storeId !== input.expectedStoreId
        || preview.sequence !== input.expectedSequence
        || preview.snapshotId !== input.snapshotId
      ) {
        throw new HorielError("confirmation_mismatch", "Restore preview binding does not match");
      }
      if (current.storeId !== input.expectedStoreId || current.sequence !== input.expectedSequence) {
        throw new HorielError("confirmation_mismatch", "Restore preview is stale");
      }
      if (!snapshot) throw new HorielError("not_found", "Snapshot was not found");
      if (snapshot.descriptor.storeId !== current.storeId || !snapshot.descriptor.verified) {
        throw new HorielError("integrity_failed", "Snapshot verification failed");
      }

      const restored = cloneState(snapshot.state);
      restored.storeId = current.storeId;
      restored.sequence = current.sequence + 1;
      restored.previews.set(input.previewId, {
        ...copy(preview),
        consumedAt: input.consumedAt,
      });

      if (this.nextRestoreFailure) {
        const failure = this.nextRestoreFailure;
        this.nextRestoreFailure = undefined;
        throw failure;
      }
      this.state = restored;
      this.writeCommits += 1;
      return copy(snapshot.descriptor);
    });
  }

  failNextWrite(error: Error = new Error("synthetic write commit failure")): void {
    this.nextWriteFailure = error;
  }

  failNextSnapshot(error: Error = new Error("synthetic snapshot failure")): void {
    this.nextSnapshotFailure = error;
  }

  failNextRestore(error: Error = new Error("synthetic restore failure")): void {
    this.nextRestoreFailure = error;
  }

  setNextSnapshotVerified(verified: boolean): void {
    this.nextSnapshotVerified = verified;
  }

  leakSearchCandidate(memoryId: string, textScore = 1000): void {
    this.leakedSearchCandidates.set(memoryId, textScore);
  }

  clearSearchLeaks(): void {
    this.leakedSearchCandidates.clear();
  }

  inspect(): FakeHorielStoreInspection {
    const stable = cloneState(this.state);
    return {
      storeId: stable.storeId,
      sequence: stable.sequence,
      memories: [...stable.memories.values()].sort(compareById),
      history: Object.fromEntries(
        [...stable.history]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, versions]) => [id, copy(versions)]),
      ),
      idempotency: [...stable.idempotency.values()].sort((left, right) => left.key.localeCompare(right.key)),
      checkpoints: [...stable.checkpoints.values()].sort(compareById),
      pins: [...stable.pins].sort(),
      relations: [...stable.relations.values()].sort(compareById),
      previews: [...stable.previews.values()].sort(compareById),
      snapshots: [...this.snapshots.values()].map(({ descriptor }) => copy(descriptor)).sort(compareById),
      writeCommits: this.writeCommits,
      lastSearch: this.lastSearch ? copy(this.lastSearch) : undefined,
    };
  }

  private readTransaction(state: FakeState): HorielReadTransaction {
    return {
      getStoreInfo: async () => ({ storeId: state.storeId, sequence: state.sequence }),
      getMemory: async (id: string, version?: number) => {
        if (version === undefined) {
          const current = state.memories.get(id);
          return current ? copy(current) : undefined;
        }
        const historical = state.history.get(id)?.find((entry) => entry.version === version);
        return historical ? copy(historical) : undefined;
      },
      getIdempotencyBinding: async (key: string) => {
        const binding = state.idempotency.get(key);
        return binding ? copy(binding) : undefined;
      },
      getCheckpoint: async (id: string) => {
        const checkpoint = state.checkpoints.get(id);
        return checkpoint ? copy(checkpoint) : undefined;
      },
      listCheckpoints: async () => copy([...state.checkpoints.values()]),
      isPinned: async (memoryId: string) => state.pins.has(memoryId),
      listPins: async () => [...state.pins].sort(),
      getRelation: async (type: string, sourceId: string, targetId: string) => {
        const relation = state.relations.get(relationKey(type, sourceId, targetId));
        return relation ? copy(relation) : undefined;
      },
      listRelations: async (memoryIds?: string[]) => {
        const selected = memoryIds ? new Set(memoryIds) : undefined;
        return copy([...state.relations.values()].filter((relation) => (
          !selected || selected.has(relation.sourceId) || selected.has(relation.targetId)
        )));
      },
      getPreview: async (id: string) => {
        const preview = state.previews.get(id);
        return preview ? copy(preview) : undefined;
      },
      searchCandidates: async (request: StoreSearchRequest): Promise<StoreSearchPage> => {
        this.lastSearch = copy(request);
        const candidates = new Map<string, StoreSearchCandidate>();
        for (const record of state.memories.values()) {
          const score = textScore(record, request.terms);
          if (score < 1 || !scopeEligible(record.scope, request)) continue;
          if (request.types?.length && !request.types.includes(record.type)) continue;
          if (request.tags?.length && !request.tags.every((tag) => record.tags.includes(tag))) continue;
          candidates.set(record.id, {
            memory: copy(record),
            textScore: score,
            pinned: state.pins.has(record.id),
            relationCount: [...state.relations.values()].filter((relation) => (
              relation.sourceId === record.id || relation.targetId === record.id
            )).length,
          });
        }
        for (const [memoryId, score] of this.leakedSearchCandidates) {
          const record = state.memories.get(memoryId);
          if (!record) continue;
          candidates.set(memoryId, {
            memory: copy(record),
            textScore: score,
            pinned: state.pins.has(record.id),
            relationCount: 0,
          });
        }
        return {
          items: [...candidates.values()],
          sequence: state.sequence,
          nextCursor: undefined,
        };
      },
      listContextCandidates: async (request: StoreContextRequest) => copy(
        [...state.memories.values()].filter((record) => contextEligible(record.scope, request)),
      ),
      listScopeSummaries: async (prefix?: string): Promise<ScopeSummary[]> => {
        const scopes = new Set<string>();
        for (const record of state.memories.values()) scopes.add(record.scope);
        for (const checkpoint of state.checkpoints.values()) scopes.add(checkpoint.scope);
        return [...scopes]
          .filter((scope) => !prefix || isSameOrDescendant(scope, prefix))
          .sort()
          .map((scope) => ({
            scope,
            memoryCount: [...state.memories.values()].filter((record) => record.scope === scope).length,
            checkpointCount: [...state.checkpoints.values()].filter((entry) => entry.scope === scope).length,
          }));
      },
      inspectScope: async (scope: string): Promise<ScopeInspection> => {
        const memoryIds = [...state.memories.values()]
          .filter((record) => record.scope === scope)
          .map((record) => record.id);
        const selected = new Set(memoryIds);
        return {
          scope,
          memoryIds: memoryIds.sort(),
          memoryCount: memoryIds.length,
          checkpointCount: [...state.checkpoints.values()].filter((entry) => entry.scope === scope).length,
          pinCount: memoryIds.filter((id) => state.pins.has(id)).length,
          relationCount: [...state.relations.values()].filter((relation) => (
            selected.has(relation.sourceId) || selected.has(relation.targetId)
          )).length,
          storeId: state.storeId,
          sequence: state.sequence,
        };
      },
    } as HorielReadTransaction;
  }

  private writeTransaction(state: FakeState, mutation: { dataChanged: boolean }): HorielWriteTransaction {
    const read = this.readTransaction(state);
    const replaceMemory = async (record: MemoryRecord, expectedVersion: number): Promise<void> => {
      const current = state.memories.get(record.id);
      if (!current) throw new HorielError("not_found", "Memory was not found");
      if (current.version !== expectedVersion) {
        throw new HorielError("conflict", "Memory version does not match");
      }
      if (record.version !== expectedVersion + 1) {
        throw new HorielError("conflict", "Replacement version is not monotonic");
      }
      state.memories.set(record.id, copy(record));
      const history = state.history.get(record.id) ?? [];
      history.push(copy(record));
      state.history.set(record.id, history);
      mutation.dataChanged = true;
    };

    const deleteExactScope = async (scope: string): Promise<string[]> => {
      const memoryIds = [...state.memories.values()]
        .filter((record) => record.scope === scope)
        .map((record) => record.id);
      const checkpointIds = [...state.checkpoints.values()]
        .filter((checkpoint) => checkpoint.scope === scope)
        .map((checkpoint) => checkpoint.id);
      const removedEntities = new Set([...memoryIds, ...checkpointIds]);
      for (const id of memoryIds) {
        state.memories.delete(id);
        state.history.delete(id);
        state.pins.delete(id);
      }
      for (const id of checkpointIds) state.checkpoints.delete(id);
      for (const [key, relation] of state.relations) {
        if (removedEntities.has(relation.sourceId) || removedEntities.has(relation.targetId)) {
          state.relations.delete(key);
        }
      }
      for (const [key, binding] of state.idempotency) {
        if (removedEntities.has(binding.entityId)) state.idempotency.delete(key);
      }
      mutation.dataChanged = true;
      return memoryIds.sort();
    };

    return {
      ...read,
      insertMemory: async (record: MemoryRecord) => {
        if (state.memories.has(record.id)) throw new HorielError("conflict", "Memory identity already exists");
        state.memories.set(record.id, copy(record));
        state.history.set(record.id, [copy(record)]);
        mutation.dataChanged = true;
      },
      replaceMemory,
      moveMemory: replaceMemory,
      putIdempotencyBinding: async (binding: IdempotencyBinding) => {
        const existing = state.idempotency.get(binding.key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
          throw new HorielError("conflict", "Idempotency key is already bound");
        }
        if (!existing) {
          state.idempotency.set(binding.key, copy(binding));
          mutation.dataChanged = true;
        }
      },
      putCheckpoint: async (checkpoint: SessionCheckpoint) => {
        if (!state.checkpoints.has(checkpoint.id)) {
          state.checkpoints.set(checkpoint.id, copy(checkpoint));
          mutation.dataChanged = true;
        }
      },
      putPin: async (memoryId: string) => {
        if (!state.memories.has(memoryId)) throw new HorielError("not_found", "Memory was not found");
        if (!state.pins.has(memoryId)) {
          state.pins.add(memoryId);
          mutation.dataChanged = true;
        }
      },
      deletePin: async (memoryId: string) => {
        if (state.pins.delete(memoryId)) mutation.dataChanged = true;
      },
      putRelation: async (relation: MemoryRelation) => {
        if (!state.memories.has(relation.sourceId) || !state.memories.has(relation.targetId)) {
          throw new HorielError("not_found", "Relation endpoint was not found");
        }
        const key = relationKey(relation.type, relation.sourceId, relation.targetId);
        if (!state.relations.has(key)) {
          state.relations.set(key, copy(relation));
          mutation.dataChanged = true;
        }
      },
      deleteRelation: async (type: string, sourceId: string, targetId: string) => {
        if (state.relations.delete(relationKey(type, sourceId, targetId))) mutation.dataChanged = true;
      },
      putPreview: async (preview: StoredPreview) => {
        if (state.previews.has(preview.id)) throw new HorielError("conflict", "Preview identity already exists");
        state.previews.set(preview.id, copy(preview));
      },
      consumePreview: async (previewId: string, consumedAt: string) => {
        const preview = state.previews.get(previewId);
        if (!preview || preview.consumedAt) {
          throw new HorielError("confirmation_mismatch", "Preview is absent or already consumed");
        }
        state.previews.set(previewId, { ...copy(preview), consumedAt });
      },
      deleteExactScope,
      deleteScope: deleteExactScope,
    } as HorielWriteTransaction;
  }
}

export function deterministicClock(initial = "2026-11-02T12:00:00.000Z"): {
  now(): Date;
  set(value: string): void;
  advance(milliseconds: number): void;
} {
  let value = new Date(initial).getTime();
  return {
    now: () => new Date(value),
    set: (next) => {
      value = new Date(next).getTime();
    },
    advance: (milliseconds) => {
      value += milliseconds;
    },
  };
}

export function deterministicIdFactory(): { create(prefix: string): string } {
  let sequence = 0;
  return {
    create(prefix: string): string {
      sequence += 1;
      return `${prefix}_${sequence.toString(16).padStart(32, "0")}`;
    },
  };
}
