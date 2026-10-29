import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../cli/core/config";
import type { ProjectAliases } from "../../cli/core/project";
import { assertHooksAllowed } from "../../cli/core/hooks/engine";
import { dbPath } from "../db";
import { MemoryEngine, MemoryError } from "../engine";
import { MEMORY_SCHEMA_VERSION } from "../engine/schema";
import { mnemoHookContext } from "../hook-context";
import {
  activateMemoryMarker,
  assertNoSqliteSidecars,
  copySnapshotBackup,
  ensureMigrationDirectories,
  hashPrivateFile,
  publishDatabase,
  quarantineArtifact,
  removeIfPresent,
  type MemoryMigrationPaths,
} from "./files";
import { assertActionable, backupMatches, inspectMigration, type MigrationInspection } from "./inspection";
import { saveMigrationManifest } from "./manifest";
import { withMigrationExclusion } from "./locks";
import { legacySessionIds, readLegacyMemorySnapshot } from "./snapshot";
import type {
  LegacyMemorySnapshot,
  MemoryMigrationManifest,
  MemoryMigrationOptions,
  MemoryMigrationPreview,
  MemoryMigrationResult,
} from "./types";
import { inspectMigrationDatabase } from "./verify";

export type { MemoryMigrationOptions, MemoryMigrationPreview, MemoryMigrationResult } from "./types";

export function previewMemoryMigration(options: MemoryMigrationOptions = {}): MemoryMigrationPreview {
  return inspectMigration(options).preview;
}

export function applyMemoryMigration(confirm: string, options: MemoryMigrationOptions = {}): MemoryMigrationResult {
  const aliases = options.aliases ?? loadConfig().projects.aliases;
  const source = options.source ?? dbPath();
  const initial = inspectMigration({ ...options, source, aliases });
  if (initial.preview.state === "active") return noOpResult(initial);
  assertActionable(initial.preview, confirm);
  assertMigrationHook(initial, confirm, options.approval);
  return withMigrationExclusion(source, {
    sourceHash: initial.preview.sourceHash!,
    confirmation: confirm,
    startedAt: new Date().toISOString(),
  }, () => {
    const locked = inspectMigration({ ...options, source, aliases });
    if (locked.preview.state === "active") return noOpResult(locked);
    assertActionable(locked.preview, confirm);
    if (!locked.snapshot) throw new MemoryError("MEMORY_FORMAT", "No hay snapshot valido para migrar.");
    return locked.preview.state === "resumable"
      ? resumeVerifiedMigration(locked, aliases)
      : importFreshMigration(locked, aliases);
  });
}

function assertMigrationHook(inspection: MigrationInspection, confirm: string, approval?: string): void {
  assertHooksAllowed(mnemoHookContext("database.change.before", "cli", {
    confirmation: confirm,
    approval,
    destructive: true,
    targetPaths: [inspection.paths.source, inspection.paths.destination, inspection.paths.marker,
      inspection.paths.manifest, inspection.paths.backupsDirectory],
    metadata: {
      operation: "memory.migrate",
      previewToken: inspection.preview.confirmation,
      requiresConfirmation: inspection.preview.confirmation,
      writesMalahorData: true,
      sourceHash: inspection.preview.sourceHash,
    },
  }));
}

function importFreshMigration(inspection: MigrationInspection, aliases: ProjectAliases): MemoryMigrationResult {
  const snapshot = inspection.snapshot!;
  const paths = inspection.paths;
  ensureMigrationDirectories(paths);
  const transactionId = `${Date.now().toString(36)}-${randomUUID()}`;
  const stagingPath = `${paths.destination}.staging-${transactionId}`;
  const backupPath = path.join(paths.backupsDirectory,
    `memory-legacy-${snapshot.hash.slice(0, 12)}-${transactionId}.json`);
  const artifacts = previousArtifacts(inspection.manifest?.manifest);
  if (inspection.preview.state === "retryable") {
    quarantinePreviousAttempt(inspection, transactionId, artifacts);
  }
  let manifest = createManifest(paths, snapshot, transactionId, stagingPath, backupPath, artifacts);
  let manifestHash = saveMigrationManifest(paths.manifest, manifest, inspection.manifest?.hash ?? null);
  let destinationCreated = false;
  try {
    copySnapshotBackup(snapshot.raw, backupPath, snapshot.hash);
    const backupSnapshot = readLegacyMemorySnapshot(backupPath, aliases);
    if (backupSnapshot.hash !== snapshot.hash || backupSnapshot.recordsDigest !== snapshot.recordsDigest) {
      throw new MemoryError("MEMORY_FORMAT", "El backup verificado no representa el mismo snapshot canonico.");
    }
    createMigratedDatabase(stagingPath, backupSnapshot);
    publishDatabase(stagingPath, paths.destination);
    destinationCreated = true;
    inspectMigrationDatabase(paths.destination, snapshot, true);
    assertNoSqliteSidecars(paths.destination);
    assertSourceUnchanged(paths.source, snapshot, aliases);
    manifest = { ...manifest, state: "verified", verifiedAt: new Date().toISOString(), error: null };
    manifestHash = saveMigrationManifest(paths.manifest, manifest, manifestHash);
    removeIfPresent(stagingPath);
    const databaseHash = hashPrivateFile(paths.destination);
    activateMemoryMarker(paths.marker);
    return resultFrom(inspection.preview, true, false, backupPath, databaseHash);
  } catch (error) {
    const isolated = isolateFailedArtifacts(stagingPath,
      destinationCreated && !pathExists(paths.marker) ? paths.destination : null, transactionId);
    persistFailure(paths.manifest, manifest, manifestHash, error, isolated);
    throw error;
  }
}

function resumeVerifiedMigration(inspection: MigrationInspection, aliases: ProjectAliases): MemoryMigrationResult {
  const snapshot = inspection.snapshot!;
  const manifestSnapshot = inspection.manifest!;
  const manifest = manifestSnapshot.manifest;
  if (!backupMatches(manifest)) throw new MemoryError("MEMORY_FORMAT", "No se puede reanudar sin backup JSON verificado.");
  inspectMigrationDatabase(inspection.paths.destination, snapshot, true);
  assertNoSqliteSidecars(inspection.paths.destination);
  assertSourceUnchanged(inspection.paths.source, snapshot, aliases);
  let manifestHash = manifestSnapshot.hash;
  if (manifest.state !== "verified") {
    manifestHash = saveMigrationManifest(inspection.paths.manifest, {
      ...manifest, state: "verified", verifiedAt: new Date().toISOString(), error: null,
    }, manifestHash);
  }
  if (!manifestHash) throw new MemoryError("MEMORY_FORMAT", "No se verifico el manifiesto de reanudacion.");
  const databaseHash = hashPrivateFile(inspection.paths.destination);
  activateMemoryMarker(inspection.paths.marker);
  return resultFrom(inspection.preview, false, true, manifest.backupPath, databaseHash);
}

function createMigratedDatabase(file: string, snapshot: LegacyMemorySnapshot): void {
  const engine = MemoryEngine.open(file, { access: "create", aliases: {} });
  try {
    engine.importLegacySnapshot(snapshot.db, legacySessionIds(snapshot));
    engine.integrity();
    engine.checkpoint();
  } finally {
    engine.close();
  }
  assertNoSqliteSidecars(file);
  inspectMigrationDatabase(file, snapshot, true);
  assertNoSqliteSidecars(file);
}

function createManifest(paths: MemoryMigrationPaths, snapshot: LegacyMemorySnapshot, transactionId: string,
  stagingPath: string, backupPath: string, artifacts: string[]): MemoryMigrationManifest {
  return {
    version: 1,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    state: "preparing",
    transactionId,
    sourcePath: paths.source,
    sourceHash: snapshot.hash,
    sourceSize: snapshot.size,
    destinationPath: paths.destination,
    markerPath: paths.marker,
    stagingPath,
    backupPath,
    backupHash: snapshot.hash,
    recordsDigest: snapshot.recordsDigest,
    observations: snapshot.db.observations.length,
    sessions: snapshot.db.sessions.length,
    nextId: snapshot.db.nextId,
    mappings: snapshot.mappings,
    startedAt: new Date().toISOString(),
    verifiedAt: null,
    error: null,
    artifacts,
  };
}

function assertSourceUnchanged(source: string, expected: LegacyMemorySnapshot, aliases: ProjectAliases): void {
  const current = readLegacyMemorySnapshot(source, aliases);
  if (current.hash !== expected.hash || current.recordsDigest !== expected.recordsDigest) {
    throw new MemoryError("MEMORY_BUSY", "El JSON cambio durante la migracion; no se activa SQLite.");
  }
}

function quarantinePreviousAttempt(inspection: MigrationInspection, transactionId: string, artifacts: string[]): void {
  for (const candidate of [inspection.manifest?.manifest.stagingPath, inspection.paths.destination]) {
    if (!candidate) continue;
    const quarantined = quarantineArtifact(candidate, transactionId);
    if (quarantined) artifacts.push(quarantined);
  }
}

function previousArtifacts(manifest?: MemoryMigrationManifest): string[] {
  if (!manifest) return [];
  return [...new Set([...manifest.artifacts, manifest.backupPath, manifest.stagingPath])];
}

function isolateFailedArtifacts(staging: string, destination: string | null, transactionId: string): string[] {
  const artifacts: string[] = [];
  for (const candidate of [staging, destination]) {
    if (!candidate) continue;
    try {
      const isolated = quarantineArtifact(candidate, transactionId);
      if (isolated) artifacts.push(isolated);
    } catch {
      if (pathExists(candidate)) artifacts.push(candidate);
    }
  }
  return artifacts;
}

function persistFailure(file: string, manifest: MemoryMigrationManifest, expectedHash: string, error: unknown,
  artifacts: string[]): void {
  try {
    saveMigrationManifest(file, {
      ...manifest,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
      artifacts: [...new Set([...manifest.artifacts, ...artifacts])],
    }, expectedHash);
  } catch {
    // La falla primaria y los artefactos aislados tienen prioridad; el proximo preview conserva el manifiesto previo.
  }
}

function resultFrom(preview: MemoryMigrationPreview, applied: boolean, resumed: boolean,
  backup: string | null, databaseHash: string | null): MemoryMigrationResult {
  return { ...preview, state: "active", confirmation: null, applied, resumed, active: true, backup, databaseHash };
}

function noOpResult(inspection: MigrationInspection): MemoryMigrationResult {
  return resultFrom(inspection.preview, false, false, inspection.manifest?.manifest.backupPath ?? null, null);
}

function pathExists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
