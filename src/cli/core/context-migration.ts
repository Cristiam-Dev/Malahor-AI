import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { timestamp } from "./backup";
import { LEGACY_CONTEXT_MIGRATIONS, migratedContextLevel } from "./context";

export type ContextMigrationStage =
  | "locked"
  | "backed-up"
  | "staged"
  | "published"
  | "verified"
  | "rolled-back";

export interface ContextMigrationWriteRequest {
  event: "file.write.before";
  targetPaths: string[];
  expectedVersion: string;
  approval?: string;
}

export interface ContextMigrationCheckpoint {
  projectsFile: string;
  lockFile: string;
  backupFile?: string;
  temporaryFile?: string;
}

export interface ContextMigrationPorts {
  assertWriteAllowed(request: ContextMigrationWriteRequest): void;
  checkpoint(stage: ContextMigrationStage, state: Readonly<ContextMigrationCheckpoint>): void;
}

export interface ContextMigrationCounts {
  entries: number;
  legacy: number;
  modern: number;
  unknown: number;
  withoutContext: number;
  migrated: number;
  unchanged: number;
}

export interface ContextMigrationPreview {
  state: "ready" | "noop";
  projectsFile: string;
  lockFile: string;
  version: string;
  mappings: Array<{ from: string; to: string; count: number }>;
  changes: Array<{ project: string; from: string; to: string }>;
  counts: ContextMigrationCounts;
}

export interface ContextMigrationResult {
  state: "applied" | "noop";
  applied: boolean;
  verified: boolean;
  backup: string | null;
  counts: ContextMigrationCounts;
}

export interface PreviewContextMigrationOptions {
  projectsFile: string;
  backupsDir: string;
}

export interface ApplyContextMigrationOptions extends PreviewContextMigrationOptions {
  expectedVersion: string;
  approval?: string;
  ports: ContextMigrationPorts;
}

interface MigrationSnapshot {
  source: Buffer;
  registry: Record<string, unknown>;
  preview: ContextMigrationPreview;
}

const MODERN_LEVELS = new Set(["memory", "memory+codegraph", "memory+codegraph+obsidian"]);

export function previewContextMigration(options: PreviewContextMigrationOptions): ContextMigrationPreview {
  return snapshot(options.projectsFile).preview;
}

export function applyContextMigration(options: ApplyContextMigrationOptions): ContextMigrationResult {
  const initial = snapshot(options.projectsFile);
  assertExpectedVersion(options.expectedVersion, initial.preview.version);
  if (initial.preview.state === "noop") return noOpResult(initial.preview.counts);

  options.ports.assertWriteAllowed({
    event: "file.write.before",
    targetPaths: [options.projectsFile, options.backupsDir],
    expectedVersion: options.expectedVersion,
    ...(options.approval ? { approval: options.approval } : {}),
  });

  assertSafePath(options.projectsFile);
  assertSafePath(options.backupsDir);
  const state: ContextMigrationCheckpoint = {
    projectsFile: options.projectsFile,
    lockFile: initial.preview.lockFile,
  };
  let lockDescriptor: number | undefined;
  let temporaryFile: string | undefined;
  let published = false;

  try {
    try {
      lockDescriptor = fs.openSync(state.lockFile, "wx", 0o600);
    } catch (error) {
      throw new Error(`Migracion bloqueada: el lock esta ocupado (${state.lockFile}): ${(error as Error).message}`);
    }
    options.ports.checkpoint("locked", state);

    const fresh = snapshot(options.projectsFile);
    assertExpectedVersion(options.expectedVersion, fresh.preview.version);
    if (fresh.preview.state === "noop") return noOpResult(fresh.preview.counts);

    state.backupFile = writeBackup(options.backupsDir, options.projectsFile, fresh.source);
    options.ports.checkpoint("backed-up", state);

    const migrated = migrateSource(fresh.source, fresh.registry, fresh.preview.changes);
    temporaryFile = `${options.projectsFile}.${randomBytes(10).toString("hex")}.tmp`;
    state.temporaryFile = temporaryFile;
    fs.writeFileSync(temporaryFile, migrated, { flag: "wx", mode: 0o600 });
    secureChmod(temporaryFile, 0o600);
    syncFile(temporaryFile);
    options.ports.checkpoint("staged", state);

    if (!readRegularFile(options.projectsFile).equals(fresh.source)) {
      throw new Error("projects.json cambio durante la migracion; no se publica el staging.");
    }
    fs.renameSync(temporaryFile, options.projectsFile);
    temporaryFile = undefined;
    delete state.temporaryFile;
    published = true;
    secureChmod(options.projectsFile, 0o600);
    options.ports.checkpoint("published", state);

    const verified = readRegularFile(options.projectsFile);
    if (!verified.equals(migrated)) throw new Error("La verificacion posterior de projects.json no coincide con el staging publicado.");
    const verification = snapshot(options.projectsFile);
    if (verification.preview.state !== "noop" || verification.preview.counts.legacy !== 0) {
      throw new Error("La verificacion posterior aun detecta niveles legacy.");
    }
    options.ports.checkpoint("verified", state);

    return {
      state: "applied",
      applied: true,
      verified: true,
      backup: state.backupFile,
      counts: fresh.preview.counts,
    };
  } catch (error) {
    if (published && state.backupFile) {
      try {
        restoreBackup(options.projectsFile, state.backupFile);
        options.ports.checkpoint("rolled-back", state);
      } catch (rollbackError) {
        throw new Error(
          `Fallo la migracion (${errorMessage(error)}) y tambien el rollback (${errorMessage(rollbackError)}). Respaldo: ${state.backupFile}`,
        );
      }
    }
    throw error;
  } finally {
    if (temporaryFile) fs.rmSync(temporaryFile, { force: true });
    if (lockDescriptor !== undefined) releaseOwnedLock(lockDescriptor, state.lockFile);
  }
}

function snapshot(projectsFile: string): MigrationSnapshot {
  const source = readRegularFile(projectsFile);
  const registry = parseRegistry(source, projectsFile);
  const changes: ContextMigrationPreview["changes"] = [];
  let modern = 0;
  let unknown = 0;
  let withoutContext = 0;

  for (const [project, rawEntry] of Object.entries(registry)) {
    if (!isRecord(rawEntry) || typeof rawEntry.context !== "string") {
      withoutContext += 1;
      continue;
    }
    const replacement = migratedContextLevel(rawEntry.context);
    if (replacement) {
      changes.push({ project, from: rawEntry.context, to: replacement });
    } else if (MODERN_LEVELS.has(rawEntry.context)) {
      modern += 1;
    } else {
      unknown += 1;
    }
  }

  const mappings = LEGACY_CONTEXT_MIGRATIONS.map(({ from, to }) => ({
    from,
    to,
    count: changes.filter((change) => change.from === from).length,
  }));
  const entries = Object.keys(registry).length;
  const legacy = changes.length;
  const counts: ContextMigrationCounts = {
    entries,
    legacy,
    modern,
    unknown,
    withoutContext,
    migrated: legacy,
    unchanged: entries - legacy,
  };

  return {
    source,
    registry,
    preview: {
      state: legacy > 0 ? "ready" : "noop",
      projectsFile,
      lockFile: `${projectsFile}.context-migration.lock`,
      version: hash(projectsFile, source),
      mappings,
      changes,
      counts,
    },
  };
}

function migrateSource(
  source: Buffer,
  registry: Record<string, unknown>,
  changes: ContextMigrationPreview["changes"],
): Buffer {
  const next = structuredClone(registry);
  for (const change of changes) {
    const entry = next[change.project];
    if (!isRecord(entry) || entry.context !== change.from) {
      throw new Error(`La entrada ${change.project} cambio durante la migracion.`);
    }
    entry.context = change.to;
  }

  const raw = source.toString("utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const indentation = detectIndentation(raw);
  const trailingEol = raw.endsWith("\n") ? eol : "";
  const serialized = JSON.stringify(next, null, indentation).replaceAll("\n", eol) + trailingEol;
  return Buffer.from(serialized, "utf8");
}

function detectIndentation(source: string): number | string {
  const match = source.match(/\r?\n([ \t]+)"/);
  if (!match) return 2;
  return match[1].includes("\t") ? "\t" : Math.min(match[1].length, 10);
}

function writeBackup(backupsDir: string, projectsFile: string, source: Buffer): string {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  assertSafePath(backupsDir);
  secureChmod(backupsDir, 0o700);
  const backup = path.join(
    backupsDir,
    `${path.basename(projectsFile)}.${timestamp()}.${randomBytes(6).toString("hex")}.bak`,
  );
  fs.writeFileSync(backup, source, { flag: "wx", mode: 0o600 });
  secureChmod(backup, 0o600);
  syncFile(backup);
  return backup;
}

function restoreBackup(projectsFile: string, backupFile: string): void {
  const source = readRegularFile(backupFile);
  const temporary = `${projectsFile}.${randomBytes(10).toString("hex")}.rollback.tmp`;
  try {
    fs.writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
    secureChmod(temporary, 0o600);
    syncFile(temporary);
    fs.renameSync(temporary, projectsFile);
    secureChmod(projectsFile, 0o600);
    if (!readRegularFile(projectsFile).equals(source)) throw new Error("El archivo restaurado no coincide con el respaldo.");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function noOpResult(counts: ContextMigrationCounts): ContextMigrationResult {
  return { state: "noop", applied: false, verified: true, backup: null, counts };
}

function assertExpectedVersion(expected: string, actual: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
    throw new Error("projects.json cambio desde el preview; repite la migracion para obtener una version vigente.");
  }
}

function parseRegistry(source: Buffer, projectsFile: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer ${projectsFile}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${projectsFile} debe contener un objeto JSON en la raiz.`);
  return parsed;
}

function readRegularFile(file: string): Buffer {
  assertSafePath(file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`No se pudo abrir ${file}: ${errorMessage(error)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} debe ser un archivo regular, no un symlink.`);
  return fs.readFileSync(file);
}

function assertSafePath(target: string): void {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Ruta con symlink no permitida: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) return;
  }
}

function releaseOwnedLock(descriptor: number, lockFile: string): void {
  try {
    const held = fs.fstatSync(descriptor);
    try {
      const current = fs.lstatSync(lockFile);
      if (held.dev === current.dev && held.ino === current.ino) fs.unlinkSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncFile(file: string): void {
  const descriptor = fs.openSync(file, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function hash(projectsFile: string, source: Buffer): string {
  return createHash("sha256")
    .update("malahor.context-migration.v1\0")
    .update(path.resolve(projectsFile))
    .update("\0")
    .update(source)
    .digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
