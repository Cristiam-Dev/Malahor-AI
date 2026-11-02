import type {
  HorielSnapshotDescriptor,
  IdempotencyBinding,
  MemoryRecord,
  MemoryRelation,
  MemoryRelationType,
  MemoryType,
  ScopeInspection,
  ScopeSummary,
  SessionCheckpoint,
  StoredPreview,
} from "./model";

export type MaybePromise<T> = T | Promise<T>;

export interface StoreInfo {
  storeId: string;
  sequence: number;
}

export interface StoreSearchRequest {
  scope: string;
  terms: string[];
  includeAncestors: boolean;
  rollup: boolean;
  includeGlobal: boolean;
  types?: MemoryType[];
  tags?: string[];
  limit: number;
  cursor?: string;
}

export interface StoreSearchCandidate {
  memory: MemoryRecord;
  textScore: number;
  pinned: boolean;
  relationCount: number;
}

export interface StoreSearchPage {
  items: StoreSearchCandidate[];
  sequence: number;
  nextCursor?: string;
}

export interface StoreContextRequest {
  scope: string;
  rollup: boolean;
  includeGlobal: boolean;
}

export interface HorielReadTransaction {
  getStoreInfo(): MaybePromise<StoreInfo>;
  getMemory(id: string, version?: number): MaybePromise<MemoryRecord | undefined>;
  getIdempotencyBinding(key: string): MaybePromise<IdempotencyBinding | undefined>;
  getCheckpoint(id: string): MaybePromise<SessionCheckpoint | undefined>;
  listCheckpoints(): MaybePromise<SessionCheckpoint[]>;
  isPinned(memoryId: string): MaybePromise<boolean>;
  listPins(): MaybePromise<string[]>;
  getRelation(
    type: MemoryRelationType,
    sourceId: string,
    targetId: string,
  ): MaybePromise<MemoryRelation | undefined>;
  listRelations(memoryIds?: string[]): MaybePromise<MemoryRelation[]>;
  getPreview(id: string): MaybePromise<StoredPreview | undefined>;
  searchCandidates(request: StoreSearchRequest): MaybePromise<StoreSearchPage>;
  listContextCandidates(request: StoreContextRequest): MaybePromise<MemoryRecord[]>;
  listScopeSummaries(prefix?: string): MaybePromise<ScopeSummary[]>;
  inspectScope(scope: string): MaybePromise<ScopeInspection>;
}

export interface HorielWriteTransaction extends HorielReadTransaction {
  insertMemory(record: MemoryRecord): MaybePromise<void>;
  replaceMemory(record: MemoryRecord, expectedVersion: number): MaybePromise<void>;
  moveMemory(record: MemoryRecord, expectedVersion: number): MaybePromise<void>;
  putIdempotencyBinding(binding: IdempotencyBinding): MaybePromise<void>;
  putCheckpoint(checkpoint: SessionCheckpoint): MaybePromise<void>;
  putPin(memoryId: string): MaybePromise<void>;
  deletePin(memoryId: string): MaybePromise<void>;
  putRelation(relation: MemoryRelation): MaybePromise<void>;
  deleteRelation(type: MemoryRelationType, sourceId: string, targetId: string): MaybePromise<void>;
  putPreview(preview: StoredPreview): MaybePromise<void>;
  consumePreview(previewId: string, consumedAt: string): MaybePromise<void>;
  deleteExactScope(scope: string): MaybePromise<string[]>;
}

export interface StoreRestoreRequest {
  previewId: string;
  snapshotId: string;
  confirmation: string;
  expectedStoreId: string;
  expectedSequence: number;
  consumedAt: string;
}

export interface HorielStore {
  read<T>(callback: (transaction: HorielReadTransaction) => MaybePromise<T>): Promise<T>;
  write<T>(callback: (transaction: HorielWriteTransaction) => MaybePromise<T>): Promise<T>;
  createSnapshot(input: { id: string; createdAt: string }): Promise<HorielSnapshotDescriptor>;
  inspectSnapshot(snapshotId: string): Promise<HorielSnapshotDescriptor | undefined>;
  restoreSnapshot(input: StoreRestoreRequest): Promise<HorielSnapshotDescriptor>;
}
