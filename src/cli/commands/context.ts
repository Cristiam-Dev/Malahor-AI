import { createInterface } from "node:readline/promises";
import path from "node:path";
import { loadConfig } from "../core/config";
import { statusCodegraph } from "../core/codegraph-index";
import { applyContextMigration, previewContextMigration } from "../core/context-migration";
import { assertContextMigrationWriteAllowed } from "../core/context-migration-hooks";
import {
  codegraphEnabled,
  contextLevelLabel,
  legacyContextLevel,
  levelForProject,
  registerProjectRoot,
  resolveContextTarget,
} from "../core/context";
import {
  describeProjectDocsOnboarding,
  persistProjectDocsOnboarding,
  prepareProjectDocsOnboarding,
} from "../core/docs-onboarding";
import { isSandbox, type MalahorPaths } from "../core/paths";
import { resolveCanonicalProjectKey, type ProjectAliases } from "../core/project";
import { detectStack } from "../core/stack";
import { saveSessionSummary } from "../../mnemo/db";
import { contextForProject } from "../../mnemo/context";
import { initializeDocsProject, resolveDocsProject } from "../../docs/resolver";

export interface ContextOptions {
  action: string;
  args: string[];
  dryRun: boolean;
  limit: string | undefined;
  project: string | undefined;
  apply?: boolean;
  yes?: boolean;
  approval?: string;
  docsPath?: string;
}

export function runContext(options: ContextOptions): void | Promise<void> {
  const config = loadConfig();
  const paths = config.paths;
  const action = options.action || "help";
  if (options.docsPath && action !== "register") throw new Error("--docs-path solo se admite con `context register`.");

  printHeader("malahor-ai context");
  printLine(`Projects file: ${paths.projectsFile}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  switch (action) {
    case "status":
      assertArgCount(options.args, 0, "Uso: malahor-ai context status [--project <key>]");
      printStatus(paths, config.projects.aliases, options.project, config.docs.client);
      return;
    case "detect":
      assertArgCount(options.args, 0, "Uso: malahor-ai context detect [--project <key>]");
      printDetect(paths, config.projects.aliases, options.project);
      return;
    case "recover":
    case "capsule":
      assertArgCount(options.args, 0, "Uso: malahor-ai context recover [--project <key>] [--limit <n>]");
      printContextCapsule(paths, config.projects.aliases, options.project, parseLimit(options.limit));
      return;
    case "save":
      printContextSave(paths, config.projects.aliases, options);
      return;
    case "register":
      return printRegister(paths, config.projects.aliases, options);
    case "migrate":
      assertArgCount(options.args, 0, "Uso: malahor-ai context migrate [--apply] [--yes] [--approval <evidencia-hook>]");
      return printMigration(paths, options);
    case "help":
    case "--help":
    case "-h":
      printContextHelp();
      return;
    default:
      throw new Error(`Comando context invalido: ${action}. Usa status, detect, recover, capsule, save, register o migrate.`);
  }
}

function printStatus(paths: MalahorPaths, aliases: ProjectAliases, override: string | undefined, docsClient: string): void {
  const target = resolveContextTarget(paths, aliases, override);
  const level = levelForProject(paths.projectsFile, target.canonicalKey);

  printLine("Status:");
  printLine(`- Project: ${target.name}`);
  printLine(`- Canonical key: ${target.canonicalKey}`);
  printLine(`- Active root: ${target.root || "not registered"}`);
  printLine(`- Registered roots: ${target.registeredRoots?.length ? target.registeredRoots.join(", ") : "none"}`);
  printLine(`- Context level: ${contextLevelLabel(level)}`);
  printLine("- Memory: enabled (always)");
  printLine(`- Code context: ${codeContextStatus(paths, target.canonicalKey, target.root, level)}`);
  printLine(`- Documentation: ${docsStatus(paths, aliases, target.canonicalKey)}`);
  printLine(`- Documentation client: ${docsClient} (fallback: system)`);
  printLine("- Obsidian: optional human client; not a managed context provider or storage backend");
  if (legacyContextLevel(level)) printLine("- Migration: nivel legacy preservado; usa `malahor-ai context migrate` para previsualizar una conversion con backup.");
}

function codeContextStatus(paths: MalahorPaths, project: string, root: string, level: ReturnType<typeof levelForProject>): string {
  if (!codegraphEnabled(level)) return "disabled";
  if (!root) return "degradado: falta raiz registrada; memoria y lecturas dirigidas disponibles";
  const status = statusCodegraph(paths, project, root);
  return status.startsWith("{")
    ? "available (symgraph con indice gestionado, MCP solo lectura)"
    : `degradado: ${status}`;
}

function printDetect(paths: MalahorPaths, aliases: ProjectAliases, override: string | undefined): void {
  const target = resolveContextTarget(paths, aliases, override);
  const root = target.root || paths.cwd;
  const detection = detectStack(root);

  printLine("Stack detect:");
  printLine(`- Project: ${target.name}`);
  printLine(`- Root: ${root}`);
  if (detection.signals.length === 0) {
    printLine("- Signals: none");
  } else {
    for (const item of detection.signals) {
      printLine(`- ${item.signal} (${item.evidence})`);
    }
  }
  printLine(`Suggested skills: ${detection.skills.length > 0 ? detection.skills.join(", ") : "none"}`);
}

function printContextCapsule(paths: MalahorPaths, aliases: ProjectAliases, override: string | undefined, limit: number): void {
  const target = resolveContextTarget(paths, aliases, override);
  const root = target.root || paths.cwd;
  const level = levelForProject(paths.projectsFile, target.canonicalKey);
  const detection = detectStack(root);
  const memory = contextForProject(target.canonicalKey, limit, paths.mnemoDb);

  printLine("Context Capsule:");
  printLine(`- Project: ${target.name}`);
  printLine(`- Canonical key: ${target.canonicalKey}`);
  printLine(`- Root: ${root}`);
  printLine(`- Context level: ${contextLevelLabel(level)}`);
  printLine(`- Code context: ${codegraphEnabled(level) ? "configured by level (use only when index is managed)" : "disabled"}`);
  printLine(`- Documentation: ${docsStatus(paths, aliases, target.canonicalKey)}`);
  printLine(`- Stack signals: ${detection.signals.length > 0 ? detection.signals.map((item) => item.signal).join(", ") : "none"}`);
  printLine(`- Suggested skills: ${detection.skills.length > 0 ? detection.skills.join(", ") : "none"}`);
  printLine(`- Memory scopes: ${memory.scopeChain.join(" → ")}`);
  printLine("");
  printLine("Latest session:");
  printLine(memory.latestSession ? `- ${compactText(memory.latestSession.summary, 900)}` : "- none");
  printLine("");
  printLine("Recent memory:");
  if (memory.observations.length === 0) {
    printLine("- none");
  } else {
    for (const observation of memory.observations) {
      printLine(`- #${observation.id} [${observation.project}] [${observation.type}] ${observation.title}: ${compactText(observation.content, 520)}`);
    }
  }
  printLine("");
  printLine("Recovery protocol:");
  printLine("- Use this capsule first; do not dump full files or full memory unless needed.");
  printLine("- Orden: proyecto canonico -> memoria mem_* -> CodeGraph solo habilitado y gestionado -> docs_* -> lecturas dirigidas.");
  printLine("- Sin indice CodeGraph gestionado, degrada a lecturas dirigidas; no instales ni indexes automaticamente.");
  printLine("- Lee solo Markdown necesario mediante docs_*; Obsidian es un cliente humano, no otro storage.");
  printLine("- Keep the working summary under ~1500 tokens and proceed with the next concrete action.");
}

function printContextSave(paths: MalahorPaths, aliases: ProjectAliases, options: ContextOptions): void {
  const target = resolveContextTarget(paths, aliases, options.project);
  const root = target.root || paths.cwd;
  const level = levelForProject(paths.projectsFile, target.canonicalKey);
  const summary = options.args.join(" ").trim() || `Checkpoint manual. Root: ${root}. Context level: ${level}. Completar con objetivo, decisiones, archivos modificados, validaciones y proximo paso si se invoca desde un agente.`;

  if (!options.dryRun) {
    saveSessionSummary(target.canonicalKey, summary, paths.mnemoDb);
  }

  printLine("Context save:");
  printLine(`- Project: ${target.canonicalKey}`);
  printLine(`- Result: ${options.dryRun ? "would save" : "saved"}`);
  printLine(`- Summary: ${compactText(summary, 900)}`);
}

async function printRegister(paths: MalahorPaths, aliases: ProjectAliases, options: ContextOptions): Promise<void> {
  const requested = options.project ?? options.args[0];
  const roots = options.project ? options.args : options.args.slice(1);
  if (!requested || roots.length === 0) {
    throw new Error("Uso: malahor-ai context register <project> <root> [<root> ...] [--docs-path <externa>] [--yes] [--dry-run]");
  }

  const canonicalKey = resolveCanonicalProjectKey(requested, aliases);
  const docsChoice = await prepareProjectDocsOnboarding({
    paths,
    aliases,
    project: canonicalKey,
    codeRoots: roots,
    explicitPath: options.docsPath,
    yes: Boolean(options.yes),
    dryRun: options.dryRun,
  });
  for (const root of roots) {
    registerProjectRoot(paths.projectsFile, canonicalKey, root, options.dryRun);
    printLine(`- ${options.dryRun ? "would register" : "registered"}: ${canonicalKey} -> ${root}`);
  }
  persistProjectDocsOnboarding(paths, docsChoice, options.dryRun);
  const initialized = initializeDocsProject(
    docsChoice.resolution,
    path.join(paths.assetsDir, "vault-template"),
    options.dryRun,
  );
  printLine(`Default root: ${roots.at(-1)}`);
  printLine(`Documentation: ${describeProjectDocsOnboarding(docsChoice, options.dryRun)}`);
  printLine(`Docs skeleton: ${options.dryRun ? "would initialize" : "initialized"} (${initialized.created.length} created, ${initialized.kept.length} kept)`);
}

async function printMigration(paths: MalahorPaths, options: ContextOptions): Promise<void> {
  if (options.dryRun && options.apply) throw new Error("context migrate no acepta --dry-run junto con --apply; sin --apply ya es preview.");
  if (!options.apply && (options.yes || options.approval)) {
    throw new Error("El preview de context migrate no acepta --yes ni --approval.");
  }

  const preview = previewContextMigration({
    projectsFile: paths.projectsFile,
    backupsDir: paths.backupsDir,
  });
  printLine(`Migration: ${preview.state}`);
  printLine(`- Entries: ${preview.counts.entries}`);
  printLine(`- Legacy: ${preview.counts.legacy}`);
  printLine(`- Modern: ${preview.counts.modern}`);
  printLine(`- Unknown: ${preview.counts.unknown}`);
  printLine(`- Without context: ${preview.counts.withoutContext}`);
  printLine("Mappings:");
  for (const mapping of preview.mappings) {
    printLine(`- ${mapping.from} -> ${mapping.to}: ${mapping.count}`);
  }
  if (preview.changes.length > 0) {
    printLine("Changes:");
    for (const change of preview.changes) printLine(`- ${change.project}: ${change.from} -> ${change.to}`);
  }

  if (!options.apply) {
    printLine("Preview only: no files changed.");
    if (preview.state === "ready") printLine("To apply: malahor-ai context migrate --apply --yes");
    return;
  }
  if (preview.state === "noop") {
    printLine("Result: no legacy entries; no files changed.");
    return;
  }
  if (!options.yes) await confirmMigrationInTerminal();

  const env = process.env;
  const cwd = process.cwd();
  const result = applyContextMigration({
    projectsFile: paths.projectsFile,
    backupsDir: paths.backupsDir,
    expectedVersion: preview.version,
    approval: options.approval,
    ports: {
      assertWriteAllowed: (request) => assertContextMigrationWriteAllowed(request, env, cwd),
      checkpoint: () => undefined,
    },
  });
  printLine(`Result: migrated ${result.counts.migrated} entries`);
  printLine(`Verified: ${result.verified ? "yes" : "no"}`);
  printLine(`Backup: ${result.backup ?? "none"}`);
}

async function confirmMigrationInTerminal(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Aplicar la migracion sin TTY requiere --yes; los guardrails siguen vigentes.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("¿Migrar los niveles legacy de projects.json? [s/N]: ")).trim().toLowerCase();
    if (!["s", "si", "sí", "y", "yes"].includes(answer)) throw new Error("Migracion cancelada.");
  } finally {
    prompt.close();
  }
}

function parseLimit(value: string | undefined): number {
  if (!value) return 8;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 20) return parsed;
  throw new Error("--limit debe ser un entero entre 1 y 20.");
}

function compactText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function docsStatus(paths: MalahorPaths, aliases: ProjectAliases, project: string): string {
  try {
    const docs = resolveDocsProject(paths, aliases, project);
    return `${docs.initialized ? "available" : "not initialized"} (${docs.source}: ${docs.projectRoot})`;
  } catch (error) {
    return `degradado: ${(error as Error).message}`;
  }
}

function printContextHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai context status [--project <key>]
  malahor-ai context detect [--project <key>]
  malahor-ai context recover [--project <key>] [--limit <n>]
  malahor-ai context capsule [--project <key>] [--limit <n>]
  malahor-ai context save [summary...] [--project <key>] [--dry-run]
  malahor-ai context register <project> <root> [<root> ...] [--docs-path <externa>] [--yes] [--dry-run]
  malahor-ai context migrate [--apply] [--yes] [--approval <evidencia-hook>]

Reglas:
  La memoria siempre esta activa.
  Proyectos nuevos: memory+codegraph por defecto (instalacion e indexado requieren consentimiento).
  Niveles activos: memory, memory+codegraph. La documentacion externa docs_* siempre se resuelve aparte.
  Sufijos +obsidian y niveles mnemo* se leen por compatibilidad; Obsidian ya no habilita storage/contexto.
  Niveles mnemo* heredados NO activan CodeGraph hasta migrarlos.
  context migrate previsualiza sin escribir; --apply confirma, respalda y verifica.

Detect:
  context detect lee manifiestos del proyecto (package.json, pom.xml, pyproject.toml,
  go.mod, Dockerfile, workflows) y sugiere skills de especialidad first-party.

Recovery:
  context recover/capsule genera una capsula corta con proyecto, nivel, stack,
  ultima sesion y memoria reciente. Usalo antes/despues de compactar.
  context save guarda un checkpoint breve en la memoria local.
  context register ofrece vault gestionado o carpeta externa en TTY; --yes/no-TTY usa el vault gestionado.
`);
}

function assertArgCount(args: string[], expected: number, usage: string): void {
  if (args.length !== expected) {
    throw new Error(usage);
  }
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
