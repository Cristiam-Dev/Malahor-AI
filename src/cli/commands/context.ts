import fs from "node:fs";
import { loadConfig } from "../core/config";
import {
  contextLevelLabel,
  levelForProject,
  obsidianEnabled,
  registerProjectRoot,
  resolveContextTarget,
} from "../core/context";
import { isSandbox, type MalahorPaths } from "../core/paths";
import { resolveCanonicalProjectKey, type ProjectAliases } from "../core/project";
import { detectStack } from "../core/stack";
import { saveSessionSummary } from "../../mnemo/db";
import { contextForProject } from "../../mnemo/context";
import { artifactPaths, resolveObsidianMode } from "./obsidian";

export interface ContextOptions {
  action: string;
  args: string[];
  dryRun: boolean;
  limit: string | undefined;
  project: string | undefined;
}

export function runContext(options: ContextOptions): void {
  const config = loadConfig();
  const paths = config.paths;
  const action = options.action || "help";

  printHeader("malahor-ai context");
  printLine(`Projects file: ${paths.projectsFile}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  switch (action) {
    case "status":
      assertArgCount(options.args, 0, "Uso: malahor-ai context status [--project <key>]");
      printStatus(paths, config.projects.aliases, options.project);
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
      printRegister(paths, config.projects.aliases, options);
      return;
    case "help":
    case "--help":
    case "-h":
      printContextHelp();
      return;
    default:
      throw new Error(`Comando context invalido: ${action}. Usa status, detect, recover, capsule, save o register.`);
  }
}

function printStatus(paths: MalahorPaths, aliases: ProjectAliases, override: string | undefined): void {
  const target = resolveContextTarget(paths, aliases, override);
  const level = levelForProject(paths.projectsFile, target.canonicalKey);

  printLine("Status:");
  printLine(`- Project: ${target.name}`);
  printLine(`- Canonical key: ${target.canonicalKey}`);
  printLine(`- Active root: ${target.root || "not registered"}`);
  printLine(`- Registered roots: ${target.registeredRoots?.length ? target.registeredRoots.join(", ") : "none"}`);
  printLine(`- Context level: ${contextLevelLabel(level)}`);
  printLine("- Memory: enabled (always)");
  printLine(`- Code context: ${level === "mnemo" ? "disabled" : "provider pending"}`);
  printLine(`- Obsidian: ${obsidianEnabled(level) ? "enabled" : "disabled"}`);
  printLine(`- Obsidian bridge: ${bridgeLabel(paths)}`);
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
  printLine("- If code structure is needed, use the configured code-context capability when available; otherwise use targeted searches.");
  printLine("- If product/PM context is needed and Obsidian is enabled, read only the target note(s).");
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

function printRegister(paths: MalahorPaths, aliases: ProjectAliases, options: ContextOptions): void {
  const requested = options.project ?? options.args[0];
  const roots = options.project ? options.args : options.args.slice(1);
  if (!requested || roots.length === 0) {
    throw new Error("Uso: malahor-ai context register <project> <root> [<root> ...] [--dry-run]");
  }

  const canonicalKey = resolveCanonicalProjectKey(requested, aliases);
  for (const root of roots) {
    registerProjectRoot(paths.projectsFile, canonicalKey, root, options.dryRun);
    printLine(`- ${options.dryRun ? "would register" : "registered"}: ${canonicalKey} -> ${root}`);
  }
  printLine(`Default root: ${roots.at(-1)}`);
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

function isBridgeConfigured(paths: MalahorPaths): boolean {
  const mode = resolveObsidianMode(paths);
  const { secretFile, scriptFile } = artifactPaths(paths, mode);
  return fs.existsSync(secretFile) && fs.existsSync(scriptFile);
}

function bridgeLabel(paths: MalahorPaths): string {
  const mode = resolveObsidianMode(paths);
  return isBridgeConfigured(paths) ? `configured (${mode})` : `not configured (${mode})`;
}

function printContextHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai context status [--project <key>]
  malahor-ai context detect [--project <key>]
  malahor-ai context recover [--project <key>] [--limit <n>]
  malahor-ai context capsule [--project <key>] [--limit <n>]
  malahor-ai context save [summary...] [--project <key>] [--dry-run]
  malahor-ai context register <project> <root> [<root> ...] [--dry-run]

Reglas:
  La memoria siempre esta activa.
  Los niveles persistidos existentes solo se leen hasta su migracion asistida.
  La reconfiguracion de niveles se incorporara con esa migracion.

Detect:
  context detect lee manifiestos del proyecto (package.json, pom.xml, pyproject.toml,
  go.mod, Dockerfile, workflows) y sugiere skills de especialidad first-party.

Recovery:
  context recover/capsule genera una capsula corta con proyecto, nivel, stack,
  ultima sesion y memoria reciente. Usalo antes/despues de compactar.
  context save guarda un checkpoint breve en la memoria local.
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
