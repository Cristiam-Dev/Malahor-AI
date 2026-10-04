import fs from "node:fs";
import path from "node:path";
import { backupFile } from "../core/backup";
import { loadConfig } from "../core/config";
import { isSandbox } from "../core/paths";
import { sanitizeMemoryContent } from "../../mnemo/sanitizer";
import { contextForProject, listProjects, loadDb, normalizeProject, saveDb, type MnemoDb, type Observation, type ObservationType, type SessionSummary } from "../../mnemo/db";

export interface MemoryOptions {
  action: string;
  args: string[];
  all: boolean;
  confirm: string | undefined;
  dryRun: boolean;
  yes: boolean;
}

export function runMemory(options: MemoryOptions): void {
  const config = loadConfig();
  const paths = config.paths;
  const action = options.action || "help";

  printHeader("malahor-ai memory");
  printLine(`Mnemo DB: ${paths.mnemoDb}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  switch (action) {
    case "list":
      assertArgCount(options.args, 0, "Uso: malahor-ai memory list");
      printProjects(paths.mnemoDb);
      return;
    case "inspect":
      assertArgCount(options.args, 1, "Uso: malahor-ai memory inspect <project>");
      printProjectContext(options.args[0], paths.mnemoDb);
      return;
    case "backup":
      assertArgCount(options.args, 0, "Uso: malahor-ai memory backup [--dry-run]");
      printBackup(paths.mnemoDb, paths.backupsDir, options.dryRun);
      return;
    case "reset":
      printReset(options, paths.mnemoDb, paths.backupsDir);
      return;
    case "restore":
      printRestore(options, paths.cwd, paths.mnemoDb, paths.backupsDir);
      return;
    case "help":
    case "--help":
    case "-h":
      printMemoryHelp();
      return;
    default:
      throw new Error(`Comando memory invalido: ${action}. Usa list, inspect, backup, reset o restore.`);
  }
}

function printProjects(dbPath: string): void {
  const projects = listProjects(dbPath);

  if (projects.length === 0) {
    printLine("Projects: none");
    return;
  }

  printLine("Projects:");
  for (const project of projects) {
    printLine(`- ${project.project} observations=${project.observations} latest=${project.latest}`);
  }
}

function printProjectContext(project: string | undefined, dbPath: string): void {
  if (!project) {
    throw new Error("Uso: malahor-ai memory inspect <project>");
  }

  const canonicalProject = normalizeProject(project);
  const context = contextForProject(canonicalProject, 8, dbPath);

  printLine(`Project: ${canonicalProject}`);
  printLine(context.latestSession ? `Latest session: ${context.latestSession.created_at}` : "Latest session: none");
  if (context.latestSession) {
    printLine(`Summary: ${oneLine(redact(context.latestSession.summary), 180)}`);
  }

  if (context.observations.length === 0) {
    printLine("Observations: none");
    return;
  }

  printLine("Observations:");
  for (const observation of context.observations) {
    printLine(`- #${observation.id} [${observation.type}] ${redact(observation.title)} (${observation.created_at})`);
    printLine(`  ${oneLine(redact(observation.content), 180)}`);
  }
}

function printBackup(dbPath: string, backupsDir: string, dryRun: boolean): void {
  const result = backupFile(dbPath, backupsDir, dryRun);

  if (!result.created) {
    printLine("Backup: skipped, Mnemo DB does not exist");
    return;
  }

  printLine(`Backup: ${dryRun ? "would create" : "created"}`);
  printLine(`Source: ${result.source}`);
  printLine(`Destination: ${result.destination}`);
}

function printReset(options: MemoryOptions, dbPath: string, backupsDir: string): void {
  if (options.all) {
    assertArgCount(options.args, 0, "Uso: malahor-ai memory reset --all --yes --confirm ALL");
    assertDestructiveConfirmation(options, "ALL");
    resetAll(dbPath, backupsDir, options.dryRun);
    return;
  }

  const project = options.args[0];
  assertArgCount(options.args, 1, "Uso: malahor-ai memory reset <project> --yes --confirm <project>");
  if (!project) {
    throw new Error("Uso: malahor-ai memory reset <project> --yes --confirm <project>");
  }

  const canonicalProject = normalizeProject(project);
  assertDestructiveConfirmation(options, canonicalProject);
  resetProject(canonicalProject, dbPath, backupsDir, options.dryRun);
}

function resetAll(dbPath: string, backupsDir: string, dryRun: boolean): void {
  const db = loadDb(dbPath);
  const observations = db.observations.length;
  const sessions = db.sessions.length;

  if (observations === 0 && sessions === 0) {
    printLine("Reset: skipped, Mnemo DB is already empty");
    return;
  }

  const backup = backupFile(dbPath, backupsDir, dryRun);
  if (!dryRun) {
    saveDb({ observations: [], sessions: [], nextId: 1 }, dbPath);
  }

  printLine(`Reset: ${dryRun ? "would reset all memory" : "all memory reset"}`);
  printLine(`Observations removed: ${observations}`);
  printLine(`Sessions removed: ${sessions}`);
  printLine(backup.created ? `Backup: ${backup.destination}` : "Backup: skipped, Mnemo DB does not exist");
}

function resetProject(project: string, dbPath: string, backupsDir: string, dryRun: boolean): void {
  const db = loadDb(dbPath);
  const next = {
    ...db,
    observations: db.observations.filter((observation) => observation.project !== project),
    sessions: db.sessions.filter((session) => session.project !== project),
  };
  const observationsRemoved = db.observations.length - next.observations.length;
  const sessionsRemoved = db.sessions.length - next.sessions.length;

  if (observationsRemoved === 0 && sessionsRemoved === 0) {
    printLine(`Reset: skipped, no memory found for ${project}`);
    return;
  }

  const backup = backupFile(dbPath, backupsDir, dryRun);
  if (!dryRun) {
    saveDb(next, dbPath);
  }

  printLine(`Reset: ${dryRun ? `would reset ${project}` : `${project} reset`}`);
  printLine(`Observations removed: ${observationsRemoved}`);
  printLine(`Sessions removed: ${sessionsRemoved}`);
  printLine(backup.created ? `Backup: ${backup.destination}` : "Backup: skipped, Mnemo DB does not exist");
}

function printRestore(options: MemoryOptions, cwd: string, dbPath: string, backupsDir: string): void {
  assertArgCount(options.args, 1, "Uso: malahor-ai memory restore <backup-file> --yes --confirm RESTORE");
  const source = options.args[0];
  if (!source) {
    throw new Error("Uso: malahor-ai memory restore <backup-file> --yes --confirm RESTORE");
  }

  assertDestructiveConfirmation(options, "RESTORE");
  const sourcePath = path.resolve(cwd, source);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Backup no encontrado: ${sourcePath}`);
  }

  assertPathInsideBackups(sourcePath, backupsDir);

  const restored = loadRestoreDbStrict(sourcePath);
  const backup = backupFile(dbPath, backupsDir, options.dryRun);

  if (!options.dryRun) {
    saveDb(restored, dbPath);
  }

  printLine(`Restore: ${options.dryRun ? "would restore" : "restored"}`);
  printLine(`Source: ${sourcePath}`);
  printLine(`Observations: ${restored.observations.length}`);
  printLine(`Sessions: ${restored.sessions.length}`);
  printLine(backup.created ? `Current DB backup: ${backup.destination}` : "Current DB backup: skipped, Mnemo DB does not exist");
}

function assertArgCount(args: string[], expected: number, usage: string): void {
  if (args.length !== expected) {
    throw new Error(usage);
  }
}

function assertPathInsideBackups(sourcePath: string, backupsDir: string): void {
  const sourceRealPath = fs.realpathSync(sourcePath);
  const backupsRealPath = fs.existsSync(backupsDir) ? fs.realpathSync(backupsDir) : path.resolve(backupsDir);
  const relative = path.relative(backupsRealPath, sourceRealPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Restore solo acepta backups dentro de ${backupsRealPath}`);
  }
}

function loadRestoreDbStrict(sourcePath: string): MnemoDb {
  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`Backup invalido: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup invalido: la raiz debe ser un objeto JSON.");
  }

  const observations = parseObservations(parsed.observations);
  const sessions = parseSessions(parsed.sessions);
  const nextId = parsed.nextId;
  const maxId = observations.reduce((max, observation) => Math.max(max, observation.id), 0);

  if (!Number.isInteger(nextId) || (nextId as number) <= 0) {
    throw new Error("Backup invalido: nextId debe ser un entero positivo.");
  }

  if ((nextId as number) <= maxId) {
    throw new Error("Backup invalido: nextId debe ser mayor que el mayor id de observacion.");
  }

  return { observations, sessions, nextId: nextId as number };
}

function parseObservations(value: unknown): Observation[] {
  if (!Array.isArray(value)) {
    throw new Error("Backup invalido: observations debe ser una lista.");
  }

  return value.map((item, index) => parseObservation(item, index));
}

function parseObservation(value: unknown, index: number): Observation {
  if (!isRecord(value)) {
    throw new Error(`Backup invalido: observations.${index} debe ser un objeto.`);
  }

  const type = value.type;
  if (!isObservationType(type)) {
    throw new Error(`Backup invalido: observations.${index}.type no es valido.`);
  }

  return {
    id: readPositiveInteger(value.id, `observations.${index}.id`),
    project: readNonEmptyString(value.project, `observations.${index}.project`),
    type,
    title: readString(value.title, `observations.${index}.title`),
    content: readString(value.content, `observations.${index}.content`),
    tags: readString(value.tags, `observations.${index}.tags`),
    created_at: readString(value.created_at, `observations.${index}.created_at`),
  };
}

function parseSessions(value: unknown): SessionSummary[] {
  if (!Array.isArray(value)) {
    throw new Error("Backup invalido: sessions debe ser una lista.");
  }

  return value.map((item, index) => parseSession(item, index));
}

function parseSession(value: unknown, index: number): SessionSummary {
  if (!isRecord(value)) {
    throw new Error(`Backup invalido: sessions.${index} debe ser un objeto.`);
  }

  return {
    project: readNonEmptyString(value.project, `sessions.${index}.project`),
    summary: readString(value.summary, `sessions.${index}.summary`),
    created_at: readString(value.created_at, `sessions.${index}.created_at`),
  };
}

function assertDestructiveConfirmation(options: MemoryOptions, expected: string): void {
  if (options.dryRun) return;

  if (!options.yes || options.confirm !== expected) {
    throw new Error(`Operacion destructiva bloqueada. Requiere --yes --confirm ${expected}`);
  }
}

function printMemoryHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai memory list
  malahor-ai memory inspect <project>
  malahor-ai memory backup [--dry-run]
  malahor-ai memory reset <project> --yes --confirm <project>
  malahor-ai memory reset --all --yes --confirm ALL
  malahor-ai memory restore <backup-file> --yes --confirm RESTORE
`);
}

function oneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function redact(value: string): string {
  return sanitizeMemoryContent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObservationType(value: unknown): value is ObservationType {
  return value === "decision" || value === "bug" || value === "pattern" || value === "architecture" || value === "learning" || value === "general";
}

function readPositiveInteger(value: unknown, key: string): number {
  if (Number.isInteger(value) && (value as number) > 0) {
    return value as number;
  }

  throw new Error(`Backup invalido: ${key} debe ser un entero positivo.`);
}

function readNonEmptyString(value: unknown, key: string): string {
  const result = readString(value, key);
  if (result.trim()) return result;
  throw new Error(`Backup invalido: ${key} no puede estar vacio.`);
}

function readString(value: unknown, key: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Backup invalido: ${key} debe ser string.`);
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
