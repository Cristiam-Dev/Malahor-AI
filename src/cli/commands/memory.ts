import { loadConfig } from "../core/config";
import { isSandbox } from "../core/paths";
import { inspectProjectMemory } from "../../mnemo/admin";
import { backupMemory, previewMemoryRestore, restoreMemoryBackup } from "../../mnemo/admin-backup";
import { previewMemoryReset, resetMemory } from "../../mnemo/admin-reset";
import { listProjects, normalizeProject, searchObservations, type ObservationType } from "../../mnemo/db";
import { applyMemoryMigration, previewMemoryMigration } from "../../mnemo/migration";
import { sanitizeMemoryContent } from "../../mnemo/sanitizer";
import { memoryLocation } from "../../mnemo/storage";
import { memoryTree } from "../../mnemo/v2-tools";

export interface MemoryOptions {
  action: string;
  args: string[];
  all: boolean;
  confirm: string | undefined;
  dryRun: boolean;
  yes: boolean;
  apply?: boolean;
  approval?: string;
  subtree?: boolean;
  project?: string;
  type?: string;
  limit?: string;
}

export function runMemory(options: MemoryOptions): void {
  const config = loadConfig();
  const paths = config.paths;
  const action = options.action || "help";

  printHeader("malahor-ai memory");
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);
  if (action === "migrate") {
    printMigration(options, paths.mnemoDb, config.projects.aliases);
    return;
  }
  const location = memoryLocation(paths.mnemoDb);
  printLine(`Backend: ${location.backend}`);
  printLine(`Mnemo DB: ${location.file}`);

  switch (action) {
    case "list":
      assertArgCount(options.args, 0, "Uso: malahor-ai memory list");
      printProjects(paths.mnemoDb);
      return;
    case "tree":
      assertArgRange(options.args, 0, 1, "Uso: malahor-ai memory tree [prefix]");
      printTree(options.args[0]);
      return;
    case "search":
      printSearch(options);
      return;
    case "inspect":
      assertArgCount(options.args, 1, "Uso: malahor-ai memory inspect <project>");
      printProjectInspection(options.args[0], paths.mnemoDb);
      return;
    case "backup":
      assertArgCount(options.args, 0, "Uso: malahor-ai memory backup [--dry-run]");
      printBackup(paths.mnemoDb, paths.backupsDir, options.dryRun);
      return;
    case "reset":
      printReset(options, paths.mnemoDb);
      return;
    case "restore":
      printRestore(options, paths.mnemoDb);
      return;
    case "help":
    case "--help":
    case "-h":
      printMemoryHelp();
      return;
    default:
      throw new Error(`Comando memory invalido: ${action}. Usa list, tree, search, inspect, backup, migrate, reset o restore.`);
  }
}

function printMigration(options: MemoryOptions, source: string,
  aliases: ReturnType<typeof loadConfig>["projects"]["aliases"]): void {
  assertArgCount(options.args, 0, "Uso: malahor-ai memory migrate [--dry-run|--apply --yes --confirm <token>]");
  if (options.apply && options.dryRun) throw new Error("memory migrate no combina --apply con --dry-run.");
  const preview = previewMemoryMigration({ source, aliases });
  printLine(`Migration: ${preview.state}`);
  printLine(`Source: ${preview.source}`);
  printLine(`Destination: ${preview.destination}`);
  if (preview.sourceHash) printLine(`Snapshot sha256: ${preview.sourceHash}`);
  printLine(`Records: observations=${preview.observations} sessions=${preview.sessions} nextId=${preview.nextId ?? "unknown"}`);
  for (const count of preview.counts) {
    printLine(`- ${count.scope}: observations=${count.observations} sessions=${count.sessions}`);
  }
  for (const count of preview.typeCounts) printLine(`- type ${count.type}: observations=${count.count}`);
  for (const mapping of preview.mappings.filter((item) => item.changed)) {
    printLine(`Alias: ${mapping.source} -> ${mapping.target} (${mapping.observations} observations, ${mapping.sessions} sessions)`);
  }
  for (const warning of preview.warnings) printLine(`Warning: ${warning}`);
  if (preview.issue) printLine(`Blocked: ${preview.issue}`);
  if (!options.apply) {
    if (preview.confirmation) {
      printLine(`Token: ${preview.confirmation}`);
      printLine("Para aplicar: malahor-ai memory migrate --apply --yes --confirm <token>");
    }
    printLine("Plan: pause JSON writers -> exact backup -> staged SQLite import -> full verification -> atomic marker.");
    printLine("Before marker: JSON remains active and failed SQLite artifacts are isolated.");
    printLine("After marker: SQLite remains active; automatic rollback is disabled to preserve new writes.");
    printLine("Preview only: no se escribio ningun archivo.");
    if (preview.state === "blocked") process.exitCode = 1;
    return;
  }
  if (!options.yes || !options.confirm) {
    throw new Error("memory migrate --apply requiere --yes --confirm <token> obtenido del preview.");
  }
  const result = applyMemoryMigration(options.confirm, { source, aliases, approval: options.approval });
  printLine(result.applied ? "Result: imported and activated"
    : result.resumed ? "Result: verified import activated" : "Result: already active; no-op");
  if (result.backup) printLine(`Legacy backup: ${result.backup}`);
  if (result.databaseHash) printLine(`SQLite sha256: ${result.databaseHash}`);
  printLine("Rollback automatic: disabled after activation; preserve post-migration writes.");
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

function printTree(prefix: string | undefined): void {
  const entries = memoryTree(prefix ?? "");
  if (entries.length === 0) {
    printLine("Scopes: none");
    return;
  }
  printLine(prefix ? `Scopes under ${normalizeProject(prefix)}:` : "Scopes:");
  const baseDepth = prefix ? entries[0].depth : 0;
  for (const entry of entries) {
    printLine(`${"  ".repeat(entry.depth - baseDepth)}- ${entry.path} observations=${entry.observations} sessions=${entry.sessions}`);
  }
}

function printSearch(options: MemoryOptions): void {
  assertArgRange(options.args, 1, Number.MAX_SAFE_INTEGER,
    "Uso: malahor-ai memory search <query...> [--project <scope>] [--subtree] [--type <type>] [--limit <n>]");
  const query = options.args.join(" ").trim();
  const project = options.project?.trim() ?? "";
  if (options.subtree && !project) throw new Error("memory search --subtree requiere --project <scope>.");
  const type = parseObservationType(options.type);
  const limit = parseLimit(options.limit, 5);
  const observations = searchObservations(query, project, type ?? "", limit, options.subtree === true);
  if (observations.length === 0) {
    printLine("Results: none");
    return;
  }
  printLine(`Results: ${observations.length}`);
  for (const observation of observations) {
    printLine(`- #${observation.id} ${observation.project} [${observation.type}] ${redact(observation.title)} (${observation.created_at})`);
    printLine(`  ${oneLine(redact(observation.content), 180)}`);
    if (observation.tags) printLine(`  tags: ${oneLine(redact(observation.tags), 180)}`);
  }
}

function printProjectInspection(project: string | undefined, dbPath: string): void {
  if (!project) throw new Error("Uso: malahor-ai memory inspect <project>");
  const inspection = inspectProjectMemory(project, dbPath);
  printLine(`Project: ${inspection.project}`);
  printLine(`Exact records: observations=${inspection.observations} sessions=${inspection.sessions}`);
  printLine(`Latest: ${inspection.latest ?? "none"}`);
  printLine(`Children: ${inspection.childScopes.length}`);
  for (const child of inspection.childScopes) printLine(`- ${child}`);
  printLine(`Confirmation: ${inspection.requiresConfirmation}`);
  printLine(`Note: ${inspection.note}`);
  if (inspection.recentObservations.length === 0) printLine("Recent observations: none");
  else {
    printLine("Recent observations:");
    for (const observation of inspection.recentObservations) {
      printLine(`- #${observation.id} [${observation.type}] ${redact(observation.title)} (${observation.created_at})`);
      if (observation.tags) printLine(`  tags: ${oneLine(redact(observation.tags), 180)}`);
    }
  }
  if (inspection.recentSessions.length === 0) printLine("Recent sessions: none");
  else {
    printLine("Recent sessions:");
    for (const session of inspection.recentSessions) {
      printLine(`- ${session.created_at}: ${oneLine(redact(session.summary), 180)}`);
    }
  }
}

function printBackup(dbPath: string, backupsDir: string, dryRun: boolean): void {
  const result = backupMemory(dbPath, dryRun, backupsDir);
  if (!result.created) {
    printLine("Backup: skipped, Mnemo DB does not exist");
    return;
  }
  printLine(`Backup: ${dryRun ? "would create" : "created"}`);
  printLine(`Source: ${result.source}`);
  printLine(`Destination: ${result.destination}`);
}

function printReset(options: MemoryOptions, dbPath: string): void {
  let scope: string | null;
  if (options.all) {
    assertArgCount(options.args, 0, "Uso: malahor-ai memory reset --all --yes --confirm ALL");
    scope = null;
  } else {
    assertArgCount(options.args, 1, "Uso: malahor-ai memory reset <project> --yes --confirm <project>");
    scope = normalizeProject(options.args[0]!);
  }
  const preview = previewMemoryReset(scope, dbPath);
  printLine(`Reset target: ${preview.all ? "all memory" : preview.scope}`);
  printLine(`Impact: observations=${preview.observations} sessions=${preview.sessions} pins=${preview.pins} relations=${preview.relations}`);
  for (const child of preview.childScopes) printLine(`Child preserved: ${child}`);
  printLine(`Confirmation: ${preview.requiresConfirmation}`);
  printLine(`Note: ${preview.note}`);
  if (options.dryRun) {
    printLine(preview.canReset ? "Reset: preview only; a consistent backup would be created first." : "Reset: skipped, target is already empty");
    return;
  }
  assertDestructiveConfirmation(options, preview.requiresConfirmation);
  const result = resetMemory(scope, options.confirm!, dbPath, { harness: "cli", approval: options.approval });
  if (!result.reset) {
    printLine("Reset: skipped, target is already empty");
    return;
  }
  printLine(`Reset: ${result.all ? "all memory reset" : `${result.scope} reset`}`);
  printLine(`Observations removed: ${result.removedObservations}`);
  printLine(`Sessions removed: ${result.removedSessions}`);
  printLine(result.backup.created ? `Backup: ${result.backup.destination}` : "Backup: skipped");
}

function printRestore(options: MemoryOptions, dbPath: string): void {
  assertArgCount(options.args, 1, "Uso: malahor-ai memory restore <backup-file> --yes --confirm RESTORE");
  const source = options.args[0]!;
  const preview = previewMemoryRestore(source, dbPath);
  printLine(`Restore source: ${preview.backup}`);
  printLine(`Backup backend: ${preview.backend}`);
  printLine(`Backup sha256: ${preview.sha256}`);
  printLine(`Records: observations=${preview.observations} sessions=${preview.sessions} pins=${preview.pins} relations=${preview.relations}`);
  printLine(`Next ID: ${preview.nextId}`);
  printLine(`Confirmation: ${preview.requiresConfirmation}`);
  if (options.dryRun) {
    printLine("Restore: preview only; current memory would be backed up before the transactional restore.");
    return;
  }
  assertDestructiveConfirmation(options, preview.requiresConfirmation);
  const result = restoreMemoryBackup(source, options.confirm!, dbPath, { harness: "cli", approval: options.approval });
  printLine("Restore: restored");
  printLine(`Current DB backup: ${result.currentBackup.destination ?? "skipped"}`);
}

function assertArgCount(args: string[], expected: number, usage: string): void {
  if (args.length !== expected) throw new Error(usage);
}

function assertArgRange(args: string[], minimum: number, maximum: number, usage: string): void {
  if (args.length < minimum || args.length > maximum) throw new Error(usage);
}

function assertDestructiveConfirmation(options: MemoryOptions, expected: string): void {
  if (!options.yes || options.confirm !== expected) {
    throw new Error(`Operacion destructiva bloqueada. Requiere --yes --confirm ${expected}`);
  }
}

function parseObservationType(value: string | undefined): ObservationType | undefined {
  if (!value) return undefined;
  const allowed: ObservationType[] = ["decision", "bug", "pattern", "architecture", "learning", "general"];
  if (allowed.includes(value as ObservationType)) return value as ObservationType;
  throw new Error(`Tipo de observacion invalido: ${value}`);
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
  throw new Error("--limit debe ser un entero entre 1 y 100.");
}

function printMemoryHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai memory list
  malahor-ai memory tree [prefix]
  malahor-ai memory search <query...> [--project <scope>] [--subtree] [--type <type>] [--limit <n>]
  malahor-ai memory inspect <project>
  malahor-ai memory backup [--dry-run]
  malahor-ai memory migrate [--dry-run]
  malahor-ai memory migrate --apply --yes --confirm <token>
  malahor-ai memory reset <project> [--dry-run | --yes --confirm <project>]
  malahor-ai memory reset --all [--dry-run | --yes --confirm ALL]
  malahor-ai memory restore <backup-file> [--dry-run | --yes --confirm RESTORE]
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

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
