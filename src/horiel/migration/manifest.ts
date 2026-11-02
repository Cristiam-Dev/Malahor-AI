import fs from "node:fs";
import path from "node:path";

import { assertInsideSandbox, ensurePrivateDirectory } from "./boundary";
import { canonicalHash, fsyncDirectory, fsyncFile } from "./canonical";
import { migrationFailure, normalizeMigrationFailure } from "./errors";
import {
  HORIEL_MIGRATION_FORMAT,
  HORIEL_MIGRATION_MAPPING_VERSION,
  type MigrationManifest,
  type MigrationManifestSnapshot,
  type MigrationState,
} from "./model";

const STATES = new Set<MigrationState>([
  "previewed",
  "source-locked",
  "backup-verified",
  "staging-created",
  "transformed",
  "validated",
]);

export function sealMigrationManifest(manifest: MigrationManifest): MigrationManifest {
  const unsigned = { ...manifest, revisionHash: "" };
  return { ...unsigned, revisionHash: canonicalHash(unsigned) };
}

export function migrationManifestHash(manifest: MigrationManifest): string {
  assertMigrationManifest(manifest);
  return canonicalHash(manifest);
}

export function transitionMigrationManifest(
  manifest: MigrationManifest,
  state: MigrationState,
  additions: Partial<Pick<MigrationManifest, "backup" | "target">> = {},
): MigrationManifest {
  return sealMigrationManifest({ ...manifest, ...additions, state, revisionHash: "" });
}

export function assertMigrationManifest(value: unknown): asserts value is MigrationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return migrationFailure("manifest_invalid", "Horiel migration manifest is invalid.");
  }
  const manifest = value as MigrationManifest;
  if (manifest.format !== HORIEL_MIGRATION_FORMAT
    || manifest.mappingVersion !== HORIEL_MIGRATION_MAPPING_VERSION
    || !/^[a-f0-9]{64}$/.test(manifest.migrationId)
    || !/^[a-f0-9]{64}$/.test(manifest.installationHash)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceIdentityHash)
    || !/^[a-f0-9]{64}$/.test(manifest.resolverDigest)
    || !/^[a-f0-9]{64}$/.test(manifest.approvalHash)
    || !/^[a-f0-9]{64}$/.test(manifest.revisionHash)
    || !["json", "sqlite"].includes(manifest.backend)
    || !STATES.has(manifest.state)
    || !Array.isArray(manifest.entries)
    || !manifest.counts || typeof manifest.counts !== "object") {
    return migrationFailure("manifest_invalid", "Horiel migration manifest is invalid.");
  }
  const expected = canonicalHash({ ...manifest, revisionHash: "" });
  if (expected !== manifest.revisionHash) {
    return migrationFailure("manifest_invalid", "Horiel migration manifest revision is invalid.");
  }
}

export function writeMigrationManifest(
  sandboxRoot: string,
  manifestPath: string,
  manifest: MigrationManifest,
): void {
  assertInsideSandbox(sandboxRoot, manifestPath);
  assertMigrationManifest(manifest);
  const directory = path.dirname(manifestPath);
  ensurePrivateDirectory(sandboxRoot, directory);
  const temporary = path.join(directory, ".manifest.json.tmp");
  assertInsideSandbox(sandboxRoot, temporary);
  try {
    if (fs.existsSync(temporary)) {
      const existing = fs.lstatSync(temporary);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        return migrationFailure("manifest_invalid", "Horiel migration manifest temporary file is unsafe.");
      }
      fs.rmSync(temporary, { force: true });
    }
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fsyncFile(temporary);
    fs.renameSync(temporary, manifestPath);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    } catch {
      // The sanitized manifest failure remains authoritative.
    }
    throw normalizeMigrationFailure(error, "manifest_invalid", "Horiel migration manifest cannot be persisted.");
  }
}

export function readMigrationManifest(
  sandboxRoot: string,
  manifestPath: string,
): MigrationManifestSnapshot | null {
  assertInsideSandbox(sandboxRoot, manifestPath);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const stats = fs.lstatSync(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
      return migrationFailure("manifest_invalid", "Horiel migration manifest file is unsafe.");
    }
    const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    assertMigrationManifest(value);
    return {
      manifest: value,
      revisionHash: value.revisionHash,
      manifestPath,
    };
  } catch (error) {
    throw normalizeMigrationFailure(error, "manifest_invalid", "Horiel migration manifest is invalid.");
  }
}
