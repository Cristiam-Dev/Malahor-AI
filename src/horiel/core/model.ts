export const MEMORY_TYPES = ["decision", "bug", "pattern", "architecture", "learning", "general"] as const;
export type MemoryType = typeof MEMORY_TYPES[number];

export const RELATION_TYPES = ["related", "conflicts_with", "supersedes"] as const;
export type MemoryRelationType = typeof RELATION_TYPES[number];

export interface MemoryProvenance {
  source: string;
  sessionRef?: string;
  externalRef?: string;
}

export interface MemoryRecord {
  id: string;
  scope: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
  provenance: MemoryProvenance;
}

export interface SessionCheckpoint {
  id: string;
  scope: string;
  sessionRef: string;
  objective: string;
  implemented: string[];
  verified: string[];
  pending: string[];
  decisions: string[];
  blockers: string[];
  validations: string[];
  nextStep: string;
  createdAt: string;
  version: 1;
}

export interface MemoryRelation {
  id: string;
  sourceId: string;
  targetId: string;
  type: MemoryRelationType;
  createdAt: string;
}

export type IdempotencyOperation = "memory.create" | "checkpoint.create";
export type IdempotencyEntity = "memory" | "checkpoint";

export interface IdempotencyBinding {
  key: string;
  operation: IdempotencyOperation;
  requestHash: string;
  entity: IdempotencyEntity;
  entityId: string;
  entityVersion: number;
  createdAt: string;
}

interface PreviewBase {
  id: string;
  storeId: string;
  sequence: number;
  confirmation: string;
  createdAt: string;
  consumedAt?: string;
}

export interface MovePreview extends PreviewBase {
  kind: "move" | "promote";
  memoryId: string;
  sourceScope: string;
  destinationScope: string;
  expectedVersion: number;
  conflictIds: string[];
}

export interface DeleteScopePreview extends PreviewBase {
  kind: "delete_scope";
  scope: string;
  memoryIds: string[];
  checkpointCount: number;
}

export interface RestorePreview extends PreviewBase {
  kind: "restore";
  snapshotId: string;
  snapshotFingerprint: string;
}

export type StoredPreview = MovePreview | DeleteScopePreview | RestorePreview;

export interface HorielSnapshotDescriptor {
  id: string;
  storeId: string;
  schemaVersion: number;
  sequence: number;
  createdAt: string;
  counts: {
    memories: number;
    checkpoints: number;
    pins: number;
    relations: number;
  };
  fingerprint: string;
  verified: boolean;
}

export interface ScopeSummary {
  scope: string;
  memoryCount: number;
  checkpointCount: number;
}

export interface ScopeInspection extends ScopeSummary {
  memoryIds: string[];
  pinCount: number;
  relationCount: number;
  storeId: string;
  sequence: number;
}

export interface HorielClock {
  now(): Date;
}
