import type { MnemoDb, ObservationType } from "../db";
import type { ProjectAliases } from "../../cli/core/project";

export interface MemoryMigrationOptions {
  source?: string;
  aliases?: ProjectAliases;
  approval?: string;
}

export type MemoryMigrationState = "ready" | "retryable" | "resumable" | "active" | "blocked";

export interface ScopeMigrationMapping {
  source: string;
  target: string;
  observations: number;
  sessions: number;
  changed: boolean;
}

export interface ScopeMigrationCount {
  scope: string;
  observations: number;
  sessions: number;
}

export interface ObservationTypeMigrationCount {
  type: ObservationType;
  count: number;
}

export interface LegacyMemorySnapshot {
  path: string;
  raw: Buffer;
  hash: string;
  size: number;
  mtimeMs: number;
  db: MnemoDb;
  recordsDigest: string;
  maxObservationId: number;
  mappings: ScopeMigrationMapping[];
  aliasCollisions: Array<{ target: string; sources: string[] }>;
  counts: ScopeMigrationCount[];
  typeCounts: ObservationTypeMigrationCount[];
}

export interface MemoryMigrationManifest {
  version: 1;
  schemaVersion: number;
  state: "preparing" | "verified" | "failed";
  transactionId: string;
  sourcePath: string;
  sourceHash: string;
  sourceSize: number;
  destinationPath: string;
  markerPath: string;
  stagingPath: string;
  backupPath: string;
  backupHash: string;
  recordsDigest: string;
  observations: number;
  sessions: number;
  nextId: number;
  mappings: ScopeMigrationMapping[];
  startedAt: string;
  verifiedAt: string | null;
  error: string | null;
  artifacts: string[];
}

export interface MemoryMigrationPreview {
  state: MemoryMigrationState;
  source: string;
  destination: string;
  marker: string;
  manifest: string;
  sourceHash: string | null;
  recordsDigest: string | null;
  observations: number;
  sessions: number;
  nextId: number | null;
  maxObservationId: number | null;
  counts: ScopeMigrationCount[];
  typeCounts: ObservationTypeMigrationCount[];
  mappings: ScopeMigrationMapping[];
  aliasCollisions: Array<{ target: string; sources: string[] }>;
  confirmation: string | null;
  issue: string | null;
  warnings: string[];
  postMigrationChanges: boolean;
  rollbackAutomatic: false;
  manifestHash: string | null;
}

export interface MemoryMigrationResult extends MemoryMigrationPreview {
  applied: boolean;
  resumed: boolean;
  active: boolean;
  backup: string | null;
  databaseHash: string | null;
}
