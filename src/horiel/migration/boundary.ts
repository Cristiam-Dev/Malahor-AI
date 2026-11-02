import fs from "node:fs";
import path from "node:path";

import { migrationFailure } from "./errors";
import type { MigrationInput, MigrationPaths } from "./model";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MIGRATION_DIRECTORY = ".horiel-migrations";
const APPROVED_SANDBOX_BASE = path.resolve("/tmp/opencode");

export function normalizeMigrationInput(input: MigrationInput): MigrationInput {
  if (!input || typeof input !== "object" || !input.source || typeof input.source !== "object") {
    return migrationFailure("invalid_input", "Horiel migration input is invalid.");
  }
  if (typeof input.sandboxRoot !== "string" || typeof input.installationId !== "string"
    || typeof input.targetDirectory !== "string" || typeof input.source.filePath !== "string"
    || !["json", "sqlite"].includes(input.source.backend)) {
    return migrationFailure("invalid_input", "Horiel migration input is invalid.");
  }
  const installationId = input.installationId.trim();
  if (!installationId || installationId.length > 256 || /[\u0000-\u001f\u007f]/.test(installationId)) {
    return migrationFailure("invalid_input", "Horiel migration installation identity is invalid.");
  }
  const sandboxRoot = path.resolve(input.sandboxRoot);
  const sourcePath = path.resolve(input.source.filePath);
  const targetDirectory = path.resolve(input.targetDirectory);
  assertApprovedSandboxRoot(sandboxRoot);
  assertSafeSandboxRoot(sandboxRoot);
  assertInsideSandbox(sandboxRoot, sourcePath);
  assertInsideSandbox(sandboxRoot, targetDirectory);
  const internalRoot = path.join(sandboxRoot, MIGRATION_DIRECTORY);
  if (sourcePath === targetDirectory || isPathWithin(targetDirectory, sourcePath)
    || isPathWithin(internalRoot, sourcePath) || isPathWithin(internalRoot, targetDirectory)) {
    return migrationFailure("boundary", "Horiel migration paths overlap unsafely.");
  }
  assertSafePathChain(sandboxRoot, sourcePath);
  assertSafeSourceFile(sourcePath);
  assertSafePathChain(sandboxRoot, targetDirectory);
  inspectExistingTarget(targetDirectory);
  return {
    sandboxRoot,
    installationId,
    source: { backend: input.source.backend, filePath: sourcePath },
    ...(input.aliases === undefined ? {} : { aliases: normalizeAliases(input.aliases) }),
    targetDirectory,
  };
}

export function migrationPaths(input: MigrationInput, migrationId: string): MigrationPaths {
  if (!/^[a-f0-9]{64}$/.test(migrationId)) {
    return migrationFailure("invalid_input", "Horiel migration identity is invalid.");
  }
  const parent = path.join(input.sandboxRoot, MIGRATION_DIRECTORY);
  const transactionDirectory = path.join(parent, migrationId);
  for (const target of [parent, transactionDirectory]) assertInsideSandbox(input.sandboxRoot, target);
  return {
    transactionDirectory,
    manifestPath: path.join(transactionDirectory, "manifest.json"),
    backupPath: path.join(
      transactionDirectory,
      input.source.backend === "json" ? "mnemo-backup.json" : "mnemo-backup.sqlite",
    ),
    stagingDatabasePath: path.join(transactionDirectory, "horiel-staging.sqlite"),
  };
}

export function assertInsideSandbox(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return migrationFailure("boundary", "Horiel migration path is outside the sandbox.");
  }
}

export function assertApprovedSandboxRoot(root: string): void {
  const resolved = path.resolve(root);
  const relative = path.relative(APPROVED_SANDBOX_BASE, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return migrationFailure("boundary", "Horiel migration root is not an approved sandbox.");
  }
  let current = APPROVED_SANDBOX_BASE;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      return migrationFailure("boundary", "Horiel migration sandbox chain is unavailable.");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return migrationFailure("boundary", "Horiel migration sandbox chain is unsafe.");
    }
  }
}

export function assertSafeSourceFile(target: string): fs.Stats {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return migrationFailure("boundary", "Horiel migration source is unavailable.");
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
    || stats.size < 1 || stats.size > MAX_SOURCE_BYTES) {
    return migrationFailure("boundary", "Horiel migration source is unsafe.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    return migrationFailure("boundary", "Horiel migration source permissions are unsafe.");
  }
  return stats;
}

export function targetExists(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  inspectExistingTarget(target);
  return true;
}

export function ensurePrivateDirectory(root: string, target: string): void {
  assertInsideSandbox(root, target);
  assertSafePathChain(root, target);
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return migrationFailure("boundary", "Horiel migration directory is unsafe.");
    }
    if (process.platform !== "win32") fs.chmodSync(target, 0o700);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
      && (error as { code?: unknown }).code === "boundary") throw error;
    return migrationFailure("boundary", "Horiel migration directory cannot be prepared safely.");
  }
}

export function assertPrivateRegularFile(root: string, target: string): fs.Stats {
  assertInsideSandbox(root, target);
  const stats = assertSafeSourceFile(target);
  return stats;
}

export function removeKnownArtifact(root: string, target: string): void {
  assertInsideSandbox(root, target);
  if (!fs.existsSync(target)) return;
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
    || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    return migrationFailure("boundary", "Horiel migration artifact is unsafe.");
  }
  fs.rmSync(target, { force: false });
}

function isPathWithin(ancestor: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeSandboxRoot(root: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(root);
  } catch {
    return migrationFailure("boundary", "Horiel migration sandbox is unavailable.");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return migrationFailure("boundary", "Horiel migration sandbox is unsafe.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    return migrationFailure("boundary", "Horiel migration sandbox permissions are unsafe.");
  }
}

function assertSafePathChain(root: string, target: string): void {
  assertInsideSandbox(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && current !== target)) {
      return migrationFailure("boundary", "Horiel migration path traverses an unsafe entry.");
    }
  }
}

function inspectExistingTarget(target: string): void {
  if (!fs.existsSync(target)) return;
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
    return migrationFailure("boundary", "Horiel migration target is unsafe.");
  }
}

function normalizeAliases(value: Record<string, string[]>): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return migrationFailure("invalid_input", "Horiel migration aliases are invalid.");
  }
  const entries = Object.entries(value);
  if (entries.length > 256) return migrationFailure("invalid_input", "Horiel migration aliases are invalid.");
  const result: Record<string, string[]> = {};
  for (const [project, aliases] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!project || !Array.isArray(aliases) || aliases.length > 256
      || aliases.some((alias) => typeof alias !== "string" || !alias || alias.length > 256)) {
      return migrationFailure("invalid_input", "Horiel migration aliases are invalid.");
    }
    result[project] = [...new Set(aliases)].sort((left, right) => left.localeCompare(right));
  }
  return result;
}
