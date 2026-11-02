import {
  createBackup,
  deleteScope,
  previewDeleteScope,
  previewRestore,
  restore,
} from "./administration";
import {
  getBrief,
  getContext,
  inspectScope,
  listTree,
  saveSessionCheckpoint,
  type GetBriefInput,
  type GetContextInput,
  type MemoryBriefResult,
  type MemoryContextResult,
  type SaveSessionCheckpointInput,
  type SaveSessionCheckpointResult,
} from "./context";
import { createCryptoIdFactory, type HorielIdFactory } from "./ids";
import type {
  DeleteScopePreview,
  HorielClock,
  HorielSnapshotDescriptor,
  MemoryRecord,
  MemoryRelation,
  MovePreview,
  RestorePreview,
  ScopeInspection,
  ScopeSummary,
} from "./model";
import {
  getMemory,
  saveMemory,
  searchMemory,
  updateMemory,
  type GetMemoryInput,
  type HorielCoreDependencies,
  type SaveMemoryInput,
  type SaveMemoryResult,
  type SearchMemoryResult,
  type UpdateMemoryInput,
  type UpdateMemoryResult,
} from "./memories";
import {
  linkMemory,
  moveMemory,
  pinMemory,
  previewMove,
  previewPromote,
  promoteMemory,
  unlinkMemory,
  unpinMemory,
  type LinkMemoryInput,
} from "./mutations";
import type { SearchMemoryInput } from "./query";
import type { HorielStore } from "./store";

export interface CreateHorielCoreInput {
  store: HorielStore;
  clock?: HorielClock;
  idFactory?: HorielIdFactory;
}

export interface HorielCore {
  saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult>;
  updateMemory(input: UpdateMemoryInput): Promise<UpdateMemoryResult>;
  getMemory(input: GetMemoryInput): Promise<MemoryRecord>;
  searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResult>;
  getContext(input: GetContextInput): Promise<MemoryContextResult>;
  getBrief(input: GetBriefInput): Promise<MemoryBriefResult>;
  saveSessionCheckpoint(input: SaveSessionCheckpointInput): Promise<SaveSessionCheckpointResult>;
  listTree(input?: { prefix?: string }): Promise<{ nodes: ScopeSummary[]; storeId: string; sequence: number }>;
  inspectScope(input: { scope: string }): Promise<ScopeInspection>;
  pinMemory(input: { id: string }): Promise<{ changed: boolean; pinned: true }>;
  unpinMemory(input: { id: string }): Promise<{ changed: boolean; pinned: false }>;
  linkMemory(input: LinkMemoryInput): Promise<{ changed: boolean; relation: MemoryRelation }>;
  unlinkMemory(input: LinkMemoryInput): Promise<{ changed: boolean }>;
  previewMove(input: { id: string; destinationScope: string }): Promise<MovePreview>;
  moveMemory(input: { previewId: string; confirmation: string }): Promise<{ memory: MemoryRecord }>;
  previewPromote(input: { id: string; ancestor: string }): Promise<MovePreview>;
  promoteMemory(input: { previewId: string; confirmation: string }): Promise<{ memory: MemoryRecord }>;
  createBackup(): Promise<HorielSnapshotDescriptor>;
  previewDeleteScope(input: { scope: string }): Promise<DeleteScopePreview>;
  deleteScope(input: {
    previewId: string;
    confirmation: string;
  }): Promise<{ deletedMemoryIds: string[]; backup: HorielSnapshotDescriptor }>;
  previewRestore(input: { snapshotId: string }): Promise<RestorePreview>;
  restore(input: {
    previewId: string;
    confirmation: string;
  }): Promise<{ snapshot: HorielSnapshotDescriptor; backup: HorielSnapshotDescriptor }>;
}

export function createHorielCore(input: CreateHorielCoreInput): HorielCore {
  if (!input?.store || typeof input.store.read !== "function" || typeof input.store.write !== "function") {
    throw new TypeError("Horiel Core requires a store port.");
  }
  const dependencies: HorielCoreDependencies = {
    store: input.store,
    clock: input.clock ?? { now: () => new Date() },
    idFactory: input.idFactory ?? createCryptoIdFactory(),
  };
  return {
    saveMemory: (value) => saveMemory(dependencies, value),
    updateMemory: (value) => updateMemory(dependencies, value),
    getMemory: (value) => getMemory(dependencies, value),
    searchMemory: (value) => searchMemory(dependencies, value),
    getContext: (value) => getContext(dependencies, value),
    getBrief: (value) => getBrief(dependencies, value),
    saveSessionCheckpoint: (value) => saveSessionCheckpoint(dependencies, value),
    listTree: (value = {}) => listTree(dependencies, value),
    inspectScope: (value) => inspectScope(dependencies, value),
    pinMemory: (value) => pinMemory(dependencies, value),
    unpinMemory: (value) => unpinMemory(dependencies, value),
    linkMemory: (value) => linkMemory(dependencies, value),
    unlinkMemory: (value) => unlinkMemory(dependencies, value),
    previewMove: (value) => previewMove(dependencies, value),
    moveMemory: (value) => moveMemory(dependencies, value),
    previewPromote: (value) => previewPromote(dependencies, value),
    promoteMemory: (value) => promoteMemory(dependencies, value),
    createBackup: () => createBackup(dependencies),
    previewDeleteScope: (value) => previewDeleteScope(dependencies, value),
    deleteScope: (value) => deleteScope(dependencies, value),
    previewRestore: (value) => previewRestore(dependencies, value),
    restore: (value) => restore(dependencies, value),
  };
}
