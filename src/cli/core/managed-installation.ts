import fs from "node:fs";
import path from "node:path";

import { timestamp } from "./backup";
import type { MalahorPaths } from "./paths";

type TransactionStatus = "prepared" | "committed" | "rolled-back";

interface SnapshotEntry {
  source: string;
  backup: string;
  existed: boolean;
}

interface TransactionMetadata {
  version: 1;
  status: TransactionStatus;
  createdAt: string;
  updatedAt: string;
  entries: SnapshotEntry[];
}

export interface ManagedInstallationTransaction {
  backupDirectory: string;
  dryRun: boolean;
  commit(): void;
  rollback(): void;
}

const LEGACY_RUNTIME_ARTIFACTS = [
  "node_modules",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
] as const;

export function beginManagedInstallation(
  paths: MalahorPaths,
  dryRun: boolean,
): ManagedInstallationTransaction {
  if (dryRun) {
    return {
      backupDirectory: "",
      dryRun: true,
      commit: () => undefined,
      rollback: () => undefined,
    };
  }

  const backupDirectory = uniqueBackupDirectory(paths.backupsDir);
  const entriesDirectory = path.join(backupDirectory, "entries");
  fs.mkdirSync(entriesDirectory, { recursive: true, mode: 0o700 });
  const entries = managedTargets(paths).map((source, index) => {
    const backup = path.join(entriesDirectory, index.toString().padStart(3, "0"));
    const existed = fs.existsSync(source);
    if (existed) copyPath(source, backup);
    return { source, backup, existed };
  });
  const now = new Date().toISOString();
  const metadata: TransactionMetadata = {
    version: 1,
    status: "prepared",
    createdAt: now,
    updatedAt: now,
    entries,
  };
  writeMetadata(backupDirectory, metadata);
  let status: TransactionStatus = "prepared";

  return {
    backupDirectory,
    dryRun: false,
    commit: () => {
      if (status !== "prepared") return;
      status = "committed";
      writeMetadata(backupDirectory, { ...metadata, status, updatedAt: new Date().toISOString() });
    },
    rollback: () => {
      if (status !== "prepared") return;
      for (const entry of [...entries].reverse()) restoreEntry(entry);
      status = "rolled-back";
      writeMetadata(backupDirectory, { ...metadata, status, updatedAt: new Date().toISOString() });
    },
  };
}

export function removeManagedAssets(paths: MalahorPaths, dryRun: boolean): boolean {
  if (!fs.existsSync(paths.assetsDir)) return false;
  if (!dryRun) fs.rmSync(paths.assetsDir, { recursive: true, force: true });
  return true;
}

export function pruneLegacyRuntimeArtifacts(paths: MalahorPaths, dryRun: boolean): string[] {
  const removed: string[] = [];
  for (const directory of [paths.mnemoDir, paths.docsDir]) {
    for (const name of LEGACY_RUNTIME_ARTIFACTS) {
      const target = path.join(directory, name);
      if (!fs.existsSync(target)) continue;
      removed.push(target);
      if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    }
  }
  return removed;
}

function managedTargets(paths: MalahorPaths): string[] {
  const runtimeArtifacts = [paths.mnemoDir, paths.docsDir]
    .flatMap((directory) => LEGACY_RUNTIME_ARTIFACTS.map((name) => path.join(directory, name)));
  return [
    paths.assetsDir,
    paths.mnemoIndex,
    paths.docsIndex,
    path.join(paths.opencodeDir, "commands"),
    paths.opencodeSkillsDir,
    paths.malahorPluginDir,
    path.join(paths.opencodeDir, "agents"),
    paths.agentsMd,
    paths.opencodeMd,
    paths.opencodeConfig,
    paths.configFile,
    paths.projectsFile,
    paths.pluginState,
    paths.opencodeSdkState,
    path.join(paths.opencodeDir, "package.json"),
    path.join(paths.opencodeDir, "bun.lock"),
    path.join(paths.opencodeDir, "package-lock.json"),
    ...runtimeArtifacts,
  ].map((target) => path.resolve(target));
}

function restoreEntry(entry: SnapshotEntry): void {
  fs.rmSync(entry.source, { recursive: true, force: true });
  if (!entry.existed) return;
  fs.mkdirSync(path.dirname(entry.source), { recursive: true });
  copyPath(entry.backup, entry.source);
}

function copyPath(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`No se respalda un symlink gestionado: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
    return;
  }
  fs.copyFileSync(source, destination);
}

function uniqueBackupDirectory(backupsDir: string): string {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(backupsDir, 0o700);
  const base = `managed-installation-${timestamp()}-${process.pid}`;
  let candidate = path.join(backupsDir, base);
  let suffix = 0;
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = path.join(backupsDir, `${base}-${suffix}`);
  }
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  return candidate;
}

function writeMetadata(directory: string, metadata: TransactionMetadata): void {
  const destination = path.join(directory, "transaction.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(destination, 0o600);
  }
}
