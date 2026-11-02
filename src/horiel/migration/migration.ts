import fs from "node:fs";
import path from "node:path";

import {
  assertApprovedSandboxRoot,
  assertInsideSandbox,
  ensurePrivateDirectory,
  migrationPaths,
  normalizeMigrationInput,
  removeKnownArtifact,
  targetExists,
} from "./boundary";
import { createVerifiedSourceBackup, verifySourceBackup } from "./backup";
import { canonicalHash } from "./canonical";
import { HorielMigrationError, migrationFailure } from "./errors";
import { acquireMigrationLock } from "./lock";
import {
  migrationManifestHash,
  readMigrationManifest,
  transitionMigrationManifest,
  writeMigrationManifest,
} from "./manifest";
import { createMigrationMapping } from "./mapping";
import type {
  MigrationFaultPoint,
  MigrationBackupDescriptor,
  MigrationInput,
  MigrationManifest,
  MigrationManifestSnapshot,
  MigrationMapping,
  MigrationPaths,
  MigrationPreview,
  MigrationResult,
  MigrationSourceSnapshot,
  MigrationState,
} from "./model";
import { readJsonMigrationSource } from "./source-json";
import { readSqliteMigrationSource } from "./source-sqlite";
import {
  createStagingDatabase,
  populateStagingDatabase,
  resetStagingArtifacts,
} from "./staging";
import { verifyStagingDatabase } from "./verification";

const STATE_ORDER: MigrationState[] = [
  "previewed",
  "source-locked",
  "backup-verified",
  "staging-created",
  "transformed",
  "validated",
];

interface ValidatedPreview {
  input: MigrationInput;
  paths: MigrationPaths;
  mapping: MigrationMapping;
}

export async function previewHorielMigration(rawInput: MigrationInput): Promise<MigrationPreview> {
  const input = normalizeMigrationInput(rawInput);
  const source = readMigrationSource(input);
  const mapping = createMigrationMapping(input, source, targetExists(input.targetDirectory));
  const paths = migrationPaths(input, mapping.manifest.migrationId);
  const persisted = readMigrationManifest(input.sandboxRoot, paths.manifestPath);
  if (persisted) assertPersistentContract(persisted.manifest, mapping.manifest);
  return {
    migrationId: mapping.manifest.migrationId,
    sourceFingerprint: mapping.sourceFingerprint,
    manifestHash: mapping.manifestHash,
    canApply: mapping.manifest.counts.blocked === 0,
    resumable: Boolean(persisted && persisted.manifest.state !== "validated"),
    manifest: mapping.manifest,
    paths,
    input,
  };
}

export async function applyHorielMigration(input: {
  preview: MigrationPreview;
  expectedManifestHash: string;
  faultAt?: MigrationFaultPoint;
}): Promise<MigrationResult> {
  const validated = validatePreview(input.preview, input.expectedManifestHash);
  const { mapping, paths } = validated;
  prepareTransactionDirectories(validated.input, paths);
  const recoverySnapshot = readMigrationManifest(validated.input.sandboxRoot, paths.manifestPath);
  if (recoverySnapshot) assertPersistentContract(recoverySnapshot.manifest, mapping.manifest);
  const lock = acquireMigrationLock({
    sandboxRoot: validated.input.sandboxRoot,
    transactionDirectory: paths.transactionDirectory,
    migrationId: mapping.manifest.migrationId,
    allowStaleRecovery: recoverySnapshot !== null,
  });
  try {
    let persisted = readMigrationManifest(validated.input.sandboxRoot, paths.manifestPath);
    const resumed = persisted !== null;
    const initialState = persisted?.manifest.state;
    if (!persisted) {
      assertNoOrphanArtifacts(validated.input, paths);
      const sourceLocked = transitionMigrationManifest(mapping.manifest, "source-locked");
      writeMigrationManifest(validated.input.sandboxRoot, paths.manifestPath, sourceLocked);
      persisted = snapshot(sourceLocked, paths.manifestPath);
    } else {
      assertPersistentContract(persisted.manifest, mapping.manifest);
    }

    let manifest = persisted.manifest;
    if (stateBefore(manifest.state, "backup-verified")) {
      const backupDescriptor = await prepareSourceBackup(validated.input, paths, mapping);
      manifest = transitionMigrationManifest(manifest, "backup-verified", { backup: backupDescriptor });
      writeMigrationManifest(validated.input.sandboxRoot, paths.manifestPath, manifest);
      assertSourceStillMatches(validated.input, mapping);
      injectFault(input.faultAt, "after-backup");
    } else {
      assertBackupState(validated.input, paths, mapping, manifest);
    }

    if (stateBefore(manifest.state, "staging-created")) {
      resetStagingArtifacts(validated.input.sandboxRoot, paths.stagingDatabasePath);
      createStagingDatabase({
        sandboxRoot: validated.input.sandboxRoot,
        databasePath: paths.stagingDatabasePath,
        mapping,
      });
      manifest = transitionMigrationManifest(manifest, "staging-created");
      writeMigrationManifest(validated.input.sandboxRoot, paths.manifestPath, manifest);
      injectFault(input.faultAt, "after-staging-created");
    }

    if (manifest.state === "staging-created") {
      if (initialState === "staging-created") {
        resetStagingArtifacts(validated.input.sandboxRoot, paths.stagingDatabasePath);
        createStagingDatabase({
          sandboxRoot: validated.input.sandboxRoot,
          databasePath: paths.stagingDatabasePath,
          mapping,
        });
      }
      populateStagingDatabase({
        sandboxRoot: validated.input.sandboxRoot,
        databasePath: paths.stagingDatabasePath,
        mapping,
      });
      manifest = transitionMigrationManifest(manifest, "transformed");
      writeMigrationManifest(validated.input.sandboxRoot, paths.manifestPath, manifest);
      injectFault(input.faultAt, "after-transformed");
    }

    const target = verifyStagingDatabase({
      databasePath: paths.stagingDatabasePath,
      mapping,
    });
    if (manifest.state === "validated") {
      if (!manifest.target || canonicalHash(manifest.target) !== canonicalHash(target)) {
        return migrationFailure("verification_failed", "Horiel migration target fingerprint changed.");
      }
    } else {
      manifest = transitionMigrationManifest(manifest, "validated", { target });
      writeMigrationManifest(validated.input.sandboxRoot, paths.manifestPath, manifest);
      injectFault(input.faultAt, "after-validated");
    }
    return resultFrom(manifest, paths, resumed);
  } finally {
    lock.release();
  }
}

export async function verifyHorielMigration(input: {
  preview: MigrationPreview;
  expectedManifestHash: string;
}): Promise<MigrationResult> {
  const validated = validatePreview(input.preview, input.expectedManifestHash);
  if (!fs.existsSync(validated.paths.transactionDirectory)) {
    return migrationFailure("manifest_invalid", "Horiel migration transaction is unavailable.");
  }
  const recoverySnapshot = readMigrationManifest(
    validated.input.sandboxRoot,
    validated.paths.manifestPath,
  );
  if (recoverySnapshot) {
    assertPersistentContract(recoverySnapshot.manifest, validated.mapping.manifest);
  }
  const lock = acquireMigrationLock({
    sandboxRoot: validated.input.sandboxRoot,
    transactionDirectory: validated.paths.transactionDirectory,
    migrationId: validated.mapping.manifest.migrationId,
    allowStaleRecovery: recoverySnapshot !== null,
  });
  try {
    const persisted = readMigrationManifest(validated.input.sandboxRoot, validated.paths.manifestPath);
    if (!persisted) return migrationFailure("manifest_invalid", "Horiel migration manifest is unavailable.");
    assertPersistentContract(persisted.manifest, validated.mapping.manifest);
    if (stateBefore(persisted.manifest.state, "transformed")) {
      return migrationFailure("verification_failed", "Horiel migration staging is not ready for verification.");
    }
    assertBackupState(validated.input, validated.paths, validated.mapping, persisted.manifest);
    const target = verifyStagingDatabase({
      databasePath: validated.paths.stagingDatabasePath,
      mapping: validated.mapping,
    });
    let manifest = persisted.manifest;
    if (manifest.state === "validated") {
      if (!manifest.target || canonicalHash(manifest.target) !== canonicalHash(target)) {
        return migrationFailure("verification_failed", "Horiel migration target fingerprint changed.");
      }
    } else {
      manifest = transitionMigrationManifest(manifest, "validated", { target });
      writeMigrationManifest(validated.input.sandboxRoot, validated.paths.manifestPath, manifest);
    }
    return resultFrom(manifest, validated.paths, true);
  } finally {
    lock.release();
  }
}

export function readHorielMigrationManifest(input: {
  sandboxRoot: string;
  migrationId: string;
}): MigrationManifestSnapshot | null {
  if (typeof input.sandboxRoot !== "string" || !/^[a-f0-9]{64}$/.test(input.migrationId)) {
    return migrationFailure("invalid_input", "Horiel migration manifest lookup is invalid.");
  }
  const root = path.resolve(input.sandboxRoot);
  assertApprovedSandboxRoot(root);
  const manifestPath = path.join(root, ".horiel-migrations", input.migrationId, "manifest.json");
  assertInsideSandbox(root, manifestPath);
  return readMigrationManifest(root, manifestPath);
}

function validatePreview(preview: MigrationPreview, expectedManifestHash: string): ValidatedPreview {
  if (!preview || typeof preview !== "object" || typeof expectedManifestHash !== "string") {
    return migrationFailure("preview_mismatch", "Horiel migration preview is invalid.");
  }
  let actualPreviewHash: string;
  try {
    actualPreviewHash = migrationManifestHash(preview.manifest);
  } catch (error) {
    if (error instanceof HorielMigrationError) {
      return migrationFailure("preview_mismatch", "Horiel migration preview manifest is invalid.");
    }
    throw error;
  }
  if (expectedManifestHash !== preview.manifestHash || actualPreviewHash !== preview.manifestHash) {
    return migrationFailure("preview_mismatch", "Horiel migration preview hash changed.");
  }
  const normalized = normalizeMigrationInput(preview.input);
  const source = readMigrationSource(normalized);
  const mapping = createMigrationMapping(normalized, source, targetExists(normalized.targetDirectory));
  if (mapping.sourceFingerprint !== preview.sourceFingerprint
    || mapping.manifest.migrationId !== preview.migrationId
    || mapping.manifestHash !== preview.manifestHash) {
    return migrationFailure("preview_mismatch", "Horiel migration source or contract changed after preview.");
  }
  const paths = migrationPaths(normalized, mapping.manifest.migrationId);
  if (canonicalHash(paths) !== canonicalHash(preview.paths)
    || canonicalHash(normalized) !== canonicalHash(preview.input)) {
    return migrationFailure("preview_mismatch", "Horiel migration preview paths changed.");
  }
  if (!preview.canApply || mapping.manifest.counts.blocked !== 0) {
    return migrationFailure("blocked", "Horiel migration preview contains blocking entries.");
  }
  return { input: normalized, paths, mapping };
}

function readMigrationSource(input: MigrationInput): MigrationSourceSnapshot {
  return input.source.backend === "json"
    ? readJsonMigrationSource(input.source.filePath)
    : readSqliteMigrationSource(input.source.filePath);
}

function assertSourceStillMatches(input: MigrationInput, approved: MigrationMapping): void {
  const current = createMigrationMapping(
    input,
    readMigrationSource(input),
    targetExists(input.targetDirectory),
  );
  if (current.sourceFingerprint !== approved.sourceFingerprint
    || current.manifest.sourceIdentityHash !== approved.manifest.sourceIdentityHash
    || current.manifest.approvalHash !== approved.manifest.approvalHash) {
    return migrationFailure("preview_mismatch", "Horiel migration source changed during backup.");
  }
}

async function prepareSourceBackup(
  input: MigrationInput,
  paths: MigrationPaths,
  mapping: MigrationMapping,
): Promise<MigrationBackupDescriptor> {
  const artifacts = [
    paths.backupPath,
    `${paths.backupPath}-journal`,
    `${paths.backupPath}-wal`,
    `${paths.backupPath}-shm`,
  ];
  if (fs.existsSync(paths.backupPath)
    && artifacts.slice(1).every((target) => !fs.existsSync(target))) {
    try {
      return verifySourceBackup({
        sandboxRoot: input.sandboxRoot,
        backupPath: paths.backupPath,
        source: mapping.source,
      });
    } catch {
      // A recognized but incomplete provisional backup may be reconstructed.
    }
  }
  for (const target of artifacts) removeKnownArtifact(input.sandboxRoot, target);
  return await createVerifiedSourceBackup({
    sandboxRoot: input.sandboxRoot,
    sourcePath: input.source.filePath,
    backupPath: paths.backupPath,
    source: mapping.source,
  });
}

function prepareTransactionDirectories(input: MigrationInput, paths: MigrationPaths): void {
  ensurePrivateDirectory(input.sandboxRoot, path.dirname(paths.transactionDirectory));
  ensurePrivateDirectory(input.sandboxRoot, paths.transactionDirectory);
}

function assertNoOrphanArtifacts(input: MigrationInput, paths: MigrationPaths): void {
  const artifacts = [
    paths.backupPath,
    paths.stagingDatabasePath,
    `${paths.stagingDatabasePath}-journal`,
    `${paths.stagingDatabasePath}-wal`,
    `${paths.stagingDatabasePath}-shm`,
    path.join(paths.transactionDirectory, ".manifest.json.tmp"),
  ];
  if (artifacts.some((target) => fs.existsSync(target))) {
    return migrationFailure("manifest_invalid", "Horiel migration found orphaned transaction artifacts.");
  }
  for (const target of artifacts) assertInsideSandbox(input.sandboxRoot, target);
}

function assertPersistentContract(persisted: MigrationManifest, approved: MigrationManifest): void {
  const stablePersisted = {
    format: persisted.format,
    mappingVersion: persisted.mappingVersion,
    migrationId: persisted.migrationId,
    installationHash: persisted.installationHash,
    backend: persisted.backend,
    sourceFingerprint: persisted.sourceFingerprint,
    sourceIdentityHash: persisted.sourceIdentityHash,
    resolverDigest: persisted.resolverDigest,
    targetSchemaVersion: persisted.targetSchemaVersion,
    approvalHash: persisted.approvalHash,
    entries: persisted.entries,
    counts: persisted.counts,
  };
  const stableApproved = {
    format: approved.format,
    mappingVersion: approved.mappingVersion,
    migrationId: approved.migrationId,
    installationHash: approved.installationHash,
    backend: approved.backend,
    sourceFingerprint: approved.sourceFingerprint,
    sourceIdentityHash: approved.sourceIdentityHash,
    resolverDigest: approved.resolverDigest,
    targetSchemaVersion: approved.targetSchemaVersion,
    approvalHash: approved.approvalHash,
    entries: approved.entries,
    counts: approved.counts,
  };
  if (canonicalHash(stablePersisted) !== canonicalHash(stableApproved)) {
    return migrationFailure("manifest_invalid", "Horiel migration manifest no longer matches its preview.");
  }
  if (stateAtLeast(persisted.state, "backup-verified") && !persisted.backup) {
    return migrationFailure("manifest_invalid", "Horiel migration backup descriptor is missing.");
  }
  if (persisted.state === "validated" && !persisted.target) {
    return migrationFailure("manifest_invalid", "Horiel migration target descriptor is missing.");
  }
}

function assertBackupState(
  input: MigrationInput,
  paths: MigrationPaths,
  mapping: MigrationMapping,
  manifest: MigrationManifest,
): void {
  if (!manifest.backup) {
    return migrationFailure("manifest_invalid", "Horiel migration backup descriptor is missing.");
  }
  verifySourceBackup({
    sandboxRoot: input.sandboxRoot,
    backupPath: paths.backupPath,
    source: mapping.source,
    expected: manifest.backup,
  });
}

function resultFrom(
  manifest: MigrationManifest,
  paths: MigrationPaths,
  resumed: boolean,
): MigrationResult {
  if (manifest.state !== "validated" || !manifest.target) {
    return migrationFailure("verification_failed", "Horiel migration result is not validated.");
  }
  return {
    migrationId: manifest.migrationId,
    state: "validated",
    resumed,
    sourceFingerprint: manifest.sourceFingerprint,
    targetFingerprint: manifest.target.fingerprint,
    manifestHash: migrationManifestHash(manifest),
    paths,
    manifest,
  };
}

function snapshot(manifest: MigrationManifest, manifestPath: string): MigrationManifestSnapshot {
  return { manifest, revisionHash: manifest.revisionHash, manifestPath };
}

function injectFault(actual: MigrationFaultPoint | undefined, expected: MigrationFaultPoint): void {
  if (actual === expected) {
    return migrationFailure("fault_injected", "Synthetic Horiel migration fault was injected.");
  }
}

function stateBefore(actual: MigrationState, expected: MigrationState): boolean {
  return stateIndex(actual) < stateIndex(expected);
}

function stateAtLeast(actual: MigrationState, expected: MigrationState): boolean {
  return stateIndex(actual) >= stateIndex(expected);
}

function stateIndex(state: MigrationState): number {
  const index = STATE_ORDER.indexOf(state);
  if (index < 0) return migrationFailure("manifest_invalid", "Horiel migration state is invalid.");
  return index;
}
