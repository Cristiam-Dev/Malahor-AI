import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { backupFile } from "./backup";

// SDK de plugins de OpenCode V2. Pin exacto y piso contractual: nunca se degrada
// una version exacta mayor que el usuario ya tenga, y el pin V1 no se toca.
export const OPENCODE_SDK_PACKAGE = "@opencode/plugin";
export const OPENCODE_SDK_MIN_VERSION = "2.0.4";
export const OPENCODE_SDK_PIN = "2.0.4";

export type PackageManager = "bun" | "npm";

export interface SdkCommands {
  bun?: boolean;
  npm?: boolean;
}

export interface SdkOwnership {
  package: string;
  pinnedVersion: string;
  addedDependency: boolean;
  createdPackageJson: boolean;
  installedWith: PackageManager | null;
  updatedAt: string;
}

export type SdkEnsureStatus =
  | "installed"
  | "up-to-date"
  | "would-install"
  | "skipped-no-manager"
  | "skipped-invalid-json"
  | "kept-unmanaged"
  | "install-failed";

export interface SdkEnsureResult {
  status: SdkEnsureStatus;
  packageJsonPath: string;
  dependency: string | null;
  manager: PackageManager | null;
  packageJsonCreated: boolean;
  dependencyChanged: boolean;
  message?: string;
}

export type SdkRemoveStatus = "removed" | "would-remove" | "nothing-to-remove" | "kept-not-owned" | "skipped-invalid-json";

export interface SdkRemoveResult {
  status: SdkRemoveStatus;
  dependency: string | null;
  packageJsonDeleted: boolean;
}

export interface EnsureSdkOptions {
  opencodeDir: string;
  backupsDir: string;
  stateFile: string;
  dryRun: boolean;
  commands: SdkCommands;
  runInstall?: (manager: PackageManager, cwd: string) => void;
}

export interface RemoveSdkOptions {
  opencodeDir: string;
  backupsDir: string;
  stateFile: string;
  dryRun: boolean;
}

export function ensureOpencodeSdk(options: EnsureSdkOptions): SdkEnsureResult {
  const packageJsonPath = path.join(options.opencodeDir, "package.json");
  const existed = fs.existsSync(packageJsonPath);
  let pkg: Record<string, unknown> = {};

  if (existed) {
    const parsed = readPackageFile(packageJsonPath);
    if (!parsed.ok) {
      return {
        status: "skipped-invalid-json",
        packageJsonPath,
        dependency: null,
        manager: null,
        packageJsonCreated: false,
        dependencyChanged: false,
        message: parsed.error,
      };
    }
    pkg = parsed.value;
  }

  const deps = isRecord(pkg.dependencies) ? { ...pkg.dependencies } : {};
  const rawCurrent = deps[OPENCODE_SDK_PACKAGE];
  const current = typeof rawCurrent === "string" ? rawCurrent : null;
  const satisfied = current !== null && floorSatisfied(current);
  const unmanaged = current !== null && !satisfied && parseFloor(current) === null;
  const dependencyChanged = !satisfied && !unmanaged;
  const manager = resolveManager(options.commands);
  const nodeModulesReady = hasInstalledSdk(options.opencodeDir);
  const needInstall = dependencyChanged || !nodeModulesReady;

  if (unmanaged) {
    return {
      status: "kept-unmanaged",
      packageJsonPath,
      dependency: current,
      manager,
      packageJsonCreated: false,
      dependencyChanged: false,
    };
  }

  if (!needInstall) {
    return {
      status: "up-to-date",
      packageJsonPath,
      dependency: current,
      manager,
      packageJsonCreated: false,
      dependencyChanged: false,
    };
  }

  if (options.dryRun) {
    return {
      status: "would-install",
      packageJsonPath,
      dependency: dependencyChanged ? OPENCODE_SDK_PIN : current,
      manager,
      packageJsonCreated: !existed && dependencyChanged,
      dependencyChanged,
    };
  }

  if (dependencyChanged) {
    if (existed) {
      backupFile(packageJsonPath, options.backupsDir, false);
    }

    const nextPkg = { ...pkg, dependencies: { ...deps, [OPENCODE_SDK_PACKAGE]: OPENCODE_SDK_PIN } };
    fs.mkdirSync(options.opencodeDir, { recursive: true });
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(nextPkg, null, 2)}\n`, "utf8");

    writeOwnership(options.stateFile, {
      package: OPENCODE_SDK_PACKAGE,
      pinnedVersion: OPENCODE_SDK_PIN,
      addedDependency: true,
      createdPackageJson: !existed,
      installedWith: null,
      updatedAt: new Date().toISOString(),
    });
  }

  if (!manager) {
    return {
      status: "skipped-no-manager",
      packageJsonPath,
      dependency: dependencyChanged ? OPENCODE_SDK_PIN : current,
      manager: null,
      packageJsonCreated: !existed && dependencyChanged,
      dependencyChanged,
    };
  }

  try {
    (options.runInstall ?? defaultRunInstall)(manager, options.opencodeDir);
  } catch (error) {
    return {
      status: "install-failed",
      packageJsonPath,
      dependency: dependencyChanged ? OPENCODE_SDK_PIN : current,
      manager,
      packageJsonCreated: false,
      dependencyChanged,
      message: (error as Error).message,
    };
  }

  const ownership = readOwnership(options.stateFile);
  if (ownership) {
    writeOwnership(options.stateFile, { ...ownership, installedWith: manager, updatedAt: new Date().toISOString() });
  }

  return {
    status: "installed",
    packageJsonPath,
    dependency: dependencyChanged ? OPENCODE_SDK_PIN : current,
    manager,
    packageJsonCreated: !existed && dependencyChanged,
    dependencyChanged,
  };
}

export function removeOpencodeSdk(options: RemoveSdkOptions): SdkRemoveResult {
  const state = readOwnership(options.stateFile);
  const packageJsonPath = path.join(options.opencodeDir, "package.json");
  const parsed = readPackageFile(packageJsonPath);

  if (!state || !state.addedDependency) {
    const dependency = parsed.ok ? dependencyFrom(parsed.value) : null;
    return { status: "kept-not-owned", dependency, packageJsonDeleted: false };
  }

  if (!parsed.ok) {
    if (parsed.missing) {
      if (!options.dryRun) {
        fs.rmSync(options.stateFile, { force: true });
      }
      return { status: "nothing-to-remove", dependency: null, packageJsonDeleted: false };
    }

    return { status: "skipped-invalid-json", dependency: null, packageJsonDeleted: false };
  }

  const pkg = parsed.value;
  const deps = isRecord(pkg.dependencies) ? { ...pkg.dependencies } : {};
  const dependency = dependencyFrom(pkg);

  if (dependency !== state.pinnedVersion) {
    if (!options.dryRun) {
      fs.rmSync(options.stateFile, { force: true });
    }
    return { status: "kept-not-owned", dependency, packageJsonDeleted: false };
  }

  const deleteFile = state.createdPackageJson && isEffectivelyEmptyAfterRemoval(pkg);

  if (options.dryRun) {
    return { status: "would-remove", dependency, packageJsonDeleted: deleteFile };
  }

  backupFile(packageJsonPath, options.backupsDir, false);
  delete deps[OPENCODE_SDK_PACKAGE];

  if (deleteFile) {
    fs.unlinkSync(packageJsonPath);
  } else {
    const nextPkg = { ...pkg };
    if (Object.keys(deps).length === 0) {
      delete nextPkg.dependencies;
    } else {
      nextPkg.dependencies = deps;
    }
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(nextPkg, null, 2)}\n`, "utf8");
  }

  fs.rmSync(options.stateFile, { force: true });
  return { status: "removed", dependency, packageJsonDeleted: deleteFile };
}

export function describeSdkEnsure(result: SdkEnsureResult): string {
  switch (result.status) {
    case "installed":
      return `OpenCode SDK: ${result.dependencyChanged ? "pinned" : "installed"} ${result.dependency} (${result.manager})`;
    case "up-to-date":
      return `OpenCode SDK: up to date (${result.dependency})`;
    case "would-install":
      return `OpenCode SDK: would ${result.dependencyChanged ? "pin" : "install"} ${result.dependency} (${result.manager ?? "sin gestor"})`;
    case "skipped-no-manager":
      return `OpenCode SDK: WARN sin bun/npm; agrega ${OPENCODE_SDK_PACKAGE}@${OPENCODE_SDK_PIN} manualmente`;
    case "skipped-invalid-json":
      return `OpenCode SDK: WARN ${result.packageJsonPath} invalido; no se toca`;
    case "kept-unmanaged":
      return `OpenCode SDK: kept (${result.dependency} no gestionado)`;
    case "install-failed":
      return `OpenCode SDK: WARN install fallo (${result.message}); reintenta con \`malahor-ai update\``;
  }
}

export function describeSdkRemove(result: SdkRemoveResult): string {
  switch (result.status) {
    case "removed":
      return `OpenCode SDK: removed ${result.dependency}${result.packageJsonDeleted ? " (package.json vacio eliminado)" : ""}`;
    case "would-remove":
      return `OpenCode SDK: would remove ${result.dependency}`;
    case "nothing-to-remove":
      return "OpenCode SDK: nothing to remove";
    case "kept-not-owned":
      return "OpenCode SDK: kept (no gestionado por Malahor)";
    case "skipped-invalid-json":
      return "OpenCode SDK: WARN package.json invalido; no se toca";
  }
}

// Lectura sin efectos para doctor: el ownership solo se escribe al agregar o
// actualizar la dependencia, nunca al diagnosticar.
export function readSdkOwnership(filePath: string): SdkOwnership | null {
  return readOwnership(filePath);
}

export function compareVersions(left: string, right: string): number {
  const a = parseNumeric(left);
  const b = parseNumeric(right);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  return 0;
}

export function floorSatisfied(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("<")) return false;
  if (trimmed.includes("||") || /\bx\b/i.test(trimmed)) return false;

  const exact = normalizeVersion(trimmed);
  if (exact) return compareVersions(exact, OPENCODE_SDK_MIN_VERSION) >= 0;

  const floor = parseFloor(trimmed);
  return floor !== null && compareVersions(floor, OPENCODE_SDK_MIN_VERSION) >= 0;
}

function resolveManager(commands: SdkCommands): PackageManager | null {
  if (commands.bun) return "bun";
  if (commands.npm) return "npm";
  return null;
}

function defaultRunInstall(manager: PackageManager, cwd: string): void {
  const command = process.platform === "win32" && manager === "npm" ? "npm.cmd" : manager;
  execFileSync(command, ["install"], {
    cwd,
    stdio: "pipe",
    timeout: 180_000,
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
}

function hasInstalledSdk(opencodeDir: string): boolean {
  const installedPath = path.join(opencodeDir, "node_modules", "@opencode", "plugin", "package.json");
  if (!fs.existsSync(installedPath)) return false;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(installedPath, "utf8"));
    if (!isRecord(parsed) || typeof parsed.version !== "string") return false;
    return floorSatisfied(parsed.version);
  } catch {
    return false;
  }
}

function normalizeVersion(value: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim());
  return match ? match[1] ?? null : null;
}

function parseFloor(value: string): string | null {
  if (value.trim().startsWith("<")) return null;
  const stripped = value.trim().replace(/^(\^|~|>=?|=)?\s*/, "");
  return normalizeVersion(stripped);
}

function parseNumeric(value: string): number[] {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (!match) return [];
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function readPackageFile(filePath: string): { ok: true; value: Record<string, unknown> } | { ok: false; missing: boolean; error?: string } {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: true };
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(parsed)) {
      return { ok: false, missing: false, error: "no es un objeto JSON" };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, missing: false, error: (error as Error).message };
  }
}

function dependencyFrom(pkg: Record<string, unknown>): string | null {
  if (!isRecord(pkg.dependencies)) return null;
  const value = pkg.dependencies[OPENCODE_SDK_PACKAGE];
  return typeof value === "string" ? value : null;
}

function isEffectivelyEmptyAfterRemoval(pkg: Record<string, unknown>): boolean {
  const deps = isRecord(pkg.dependencies) ? pkg.dependencies : {};
  const otherDeps = Object.keys(deps).filter((key) => key !== OPENCODE_SDK_PACKAGE);
  const otherKeys = Object.keys(pkg).filter((key) => key !== "dependencies");
  return otherDeps.length === 0 && otherKeys.length === 0;
}

function readOwnership(filePath: string): SdkOwnership | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(parsed)) return null;
    if (parsed.package !== OPENCODE_SDK_PACKAGE) return null;
    if (typeof parsed.pinnedVersion !== "string" || parsed.addedDependency !== true) return null;

    return {
      package: OPENCODE_SDK_PACKAGE,
      pinnedVersion: parsed.pinnedVersion,
      addedDependency: true,
      createdPackageJson: parsed.createdPackageJson === true,
      installedWith: parsed.installedWith === "bun" || parsed.installedWith === "npm" ? parsed.installedWith : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeOwnership(filePath: string, ownership: SdkOwnership): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(ownership, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
