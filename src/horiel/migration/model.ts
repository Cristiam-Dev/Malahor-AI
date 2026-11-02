import type {
  MemoryRecord,
  MemoryRelation,
  MemoryType,
  SessionCheckpoint,
} from "../core/model";

export const HORIEL_MIGRATION_FORMAT = "horiel-migration-v1" as const;
export const HORIEL_MIGRATION_MAPPING_VERSION = 1 as const;

export type MigrationSourceBackend = "json" | "sqlite";

export type MigrationState =
  | "previewed"
  | "source-locked"
  | "backup-verified"
  | "staging-created"
  | "transformed"
  | "validated";

export type MigrationFaultPoint =
  | "after-backup"
  | "after-staging-created"
  | "after-transformed"
  | "after-validated";

export interface MigrationInput {
  sandboxRoot: string;
  installationId: string;
  source: {
    backend: MigrationSourceBackend;
    filePath: string;
  };
  aliases?: Record<string, string[]>;
  targetDirectory: string;
}

export interface MigrationPaths {
  transactionDirectory: string;
  manifestPath: string;
  backupPath: string;
  stagingDatabasePath: string;
}

export interface MigrationManifestEntry {
  kind: string;
  status: "mapped" | "derived" | "blocked";
  sourceKey: string;
  sourceDigest: string;
  targetId?: string;
  targetDigest?: string;
  targetScope?: string;
  transformations: string[];
  block?: {
    code: string;
    findingHash?: string;
  };
}

export interface MigrationCounts {
  source: {
    observations: number;
    sessions: number;
    pins: number;
    relations: number;
  };
  target: {
    memories: number;
    checkpoints: number;
    pins: number;
    relations: number;
  };
  mapped: number;
  derived: number;
  blocked: number;
}

export interface MigrationBackupDescriptor {
  verified: boolean;
  hash: string;
  size: number;
}

export interface MigrationTargetDescriptor {
  storeId: string;
  sequence: number;
  fingerprint: string;
}

export interface MigrationManifest {
  format: typeof HORIEL_MIGRATION_FORMAT;
  mappingVersion: typeof HORIEL_MIGRATION_MAPPING_VERSION;
  migrationId: string;
  installationHash: string;
  backend: MigrationSourceBackend;
  sourceFingerprint: string;
  sourceIdentityHash: string;
  resolverDigest: string;
  targetSchemaVersion: number;
  approvalHash: string;
  revisionHash: string;
  state: MigrationState;
  entries: MigrationManifestEntry[];
  counts: MigrationCounts;
  backup?: MigrationBackupDescriptor;
  target?: MigrationTargetDescriptor;
}

export interface MigrationPreview {
  migrationId: string;
  sourceFingerprint: string;
  manifestHash: string;
  canApply: boolean;
  resumable: boolean;
  manifest: MigrationManifest;
  paths: MigrationPaths;
  input: MigrationInput;
}

export interface MigrationResult {
  migrationId: string;
  state: "validated";
  resumed: boolean;
  sourceFingerprint: string;
  targetFingerprint: string;
  manifestHash: string;
  paths: MigrationPaths;
  manifest: MigrationManifest;
}

export interface MigrationManifestSnapshot {
  manifest: MigrationManifest;
  revisionHash: string;
  manifestPath: string;
}

export interface SourceObservation {
  stableKey: string;
  id: number;
  scope: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string;
  createdAt: string;
  position: number;
}

export interface SourceSession {
  stableKey: string;
  sourceId?: string;
  scope: string;
  summary: string;
  createdAt: string;
  position: number;
}

export interface SourcePin {
  stableKey: string;
  observationId: number;
  createdAt: string;
}

export interface SourceRelation {
  stableKey: string;
  sourceObservationId: number;
  targetObservationId: number;
  kind: "supersedes" | "conflicts";
  createdAt: string;
}

export interface SourceScope {
  path: string;
  parentPath: string | null;
  depth: number;
}

export interface MigrationSourceSnapshot {
  backend: MigrationSourceBackend;
  state: Record<string, string | number>;
  scopes: SourceScope[];
  observations: SourceObservation[];
  sessions: SourceSession[];
  pins: SourcePin[];
  relations: SourceRelation[];
}

export interface MappedPin {
  memoryId: string;
  createdAt: string;
}

export interface MigrationMapping {
  source: MigrationSourceSnapshot;
  sourceFingerprint: string;
  manifest: MigrationManifest;
  manifestHash: string;
  targetStoreId: string;
  storeCreatedAt: string;
  memories: MemoryRecord[];
  checkpoints: SessionCheckpoint[];
  pins: MappedPin[];
  relations: MemoryRelation[];
}
