import fs from "node:fs";
import { loadConfig } from "../core/config";
import {
  CONTEXT_LEVELS,
  graphifyEnabled,
  levelForProject,
  obsidianEnabled,
  parseContextLevel,
  resolveContextTarget,
  saveProjectContext,
  withGraphify,
  withObsidian,
  type ContextLevel,
} from "../core/context";
import { isSandbox, type MalahorPaths } from "../core/paths";
import type { ProjectAliases } from "../core/project";
import { detectStack } from "../core/stack";
import { artifactPaths, resolveObsidianMode } from "./obsidian";

export interface ContextOptions {
  action: string;
  args: string[];
  dryRun: boolean;
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
    case "set":
      assertArgCount(options.args, 1, "Uso: malahor-ai context set mnemo|mnemo+graphify|mnemo+graphify+obsidian [--project <key>] [--dry-run]");
      printSet(paths, config.projects.aliases, options);
      return;
    case "obsidian":
      assertArgCount(options.args, 1, "Uso: malahor-ai context obsidian on|off [--project <key>] [--dry-run]");
      printObsidianToggle(paths, config.projects.aliases, options);
      return;
    case "graphify":
      assertArgCount(options.args, 1, "Uso: malahor-ai context graphify on|off [--project <key>] [--dry-run]");
      printGraphifyToggle(paths, config.projects.aliases, options);
      return;
    case "help":
    case "--help":
    case "-h":
      printContextHelp();
      return;
    default:
      throw new Error(`Comando context invalido: ${action}. Usa status, detect, set, obsidian o graphify.`);
  }
}

function printStatus(paths: MalahorPaths, aliases: ProjectAliases, override: string | undefined): void {
  const target = resolveContextTarget(paths, aliases, override);
  const level = levelForProject(paths.projectsFile, target.canonicalKey);

  printLine("Status:");
  printLine(`- Project: ${target.name}`);
  printLine(`- Canonical key: ${target.canonicalKey}`);
  printLine(`- Context level: ${level}`);
  printLine("- Mnemo: enabled (always)");
  printLine(`- Graphify: ${graphifyEnabled(level) ? "enabled" : "disabled"}`);
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

function printSet(paths: MalahorPaths, aliases: ProjectAliases, options: ContextOptions): void {
  const target = resolveContextTarget(paths, aliases, options.project);
  const nextLevel = parseContextLevel(options.args[0]);
  applyLevel(paths, target, nextLevel, options.dryRun, []);
}

function printObsidianToggle(paths: MalahorPaths, aliases: ProjectAliases, options: ContextOptions): void {
  const target = resolveContextTarget(paths, aliases, options.project);
  const enabled = parseToggle(options.args[0], "obsidian");
  const current = levelForProject(paths.projectsFile, target.canonicalKey);
  const next = withObsidian(current, enabled);
  const notes: string[] = [];

  if (enabled && !graphifyEnabled(current)) {
    notes.push("Graphify queda habilitado porque Obsidian requiere el nivel completo.");
  }
  if (enabled && !isBridgeConfigured(paths)) {
    notes.push("Tip: ejecuta `malahor-ai obsidian setup` para configurar el puente Obsidian.");
  }

  applyLevel(paths, target, next, options.dryRun, notes);
}

function printGraphifyToggle(paths: MalahorPaths, aliases: ProjectAliases, options: ContextOptions): void {
  const target = resolveContextTarget(paths, aliases, options.project);
  const enabled = parseToggle(options.args[0], "graphify");
  const current = levelForProject(paths.projectsFile, target.canonicalKey);
  const next = withGraphify(current, enabled);
  const notes: string[] = [];

  if (!enabled && obsidianEnabled(current)) {
    notes.push("Obsidian queda deshabilitado porque requiere Graphify.");
  }

  applyLevel(paths, target, next, options.dryRun, notes);
}

function applyLevel(paths: MalahorPaths, target: { canonicalKey: string }, next: ContextLevel, dryRun: boolean, notes: string[]): void {
  const current = levelForProject(paths.projectsFile, target.canonicalKey);

  printLine(`Project: ${target.canonicalKey}`);
  printLine(`Context: ${current} -> ${next}`);
  for (const note of notes) {
    printLine(`Note: ${note}`);
  }

  if (current === next) {
    printLine("Result: unchanged");
    return;
  }

  saveProjectContext(paths.projectsFile, target.canonicalKey, next, dryRun);
  printLine(`Result: ${dryRun ? "would set" : "set"} ${next}`);
}

function parseToggle(value: string | undefined, name: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`Valor ${name} invalido: ${String(value)}. Usa on u off.`);
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
  malahor-ai context set <nivel> [--project <key>] [--dry-run]
  malahor-ai context obsidian on|off [--project <key>] [--dry-run]
  malahor-ai context graphify on|off [--project <key>] [--dry-run]

Niveles:
  mnemo                      Solo memoria Mnemo
  mnemo+graphify             Mnemo + Graphify (default)
  mnemo+graphify+obsidian    Suma Obsidian MCP

Reglas:
  Mnemo siempre esta activo.
  Obsidian on requiere Graphify; Obsidian off lo deja en mnemo+graphify.
  Graphify off deshabilita tambien Obsidian.

Detect:
  context detect lee manifiestos del proyecto (package.json, pom.xml, pyproject.toml,
  go.mod, Dockerfile, workflows) y sugiere skills de especialidad first-party.
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
