import fs from "node:fs";
import path from "node:path";

import {
  formatDocsOpenCommand,
  normalizeDocsRootInput,
  openDocsClient,
  parseDocsClient,
} from "../../docs/client";
import {
  applyDocsMove,
  checkDocsProject,
  initializeDocsProject,
  previewDocsMove,
  resolveDocsProject,
  type DocsResolution,
} from "../../docs/resolver";
import { loadConfig, type MalahorConfig } from "../core/config";
import { saveDocsClient } from "../core/config-write";
import { setProjectDocsPath } from "../core/context";
import { resolvePackagePaths } from "../core/package";
import { isSandbox } from "../core/paths";

export interface DocsOptions {
  action: string;
  args: string[];
  project?: string;
  path?: string;
  app?: string;
  dryRun: boolean;
  apply: boolean;
  yes: boolean;
}

export function runDocs(options: DocsOptions): void {
  const action = options.action || "status";
  if (["help", "--help", "-h"].includes(action)) {
    printDocsHelp();
    return;
  }
  validateActionOptions(action, options);
  const config = loadConfig();
  const paths = config.paths;

  printHeader("malahor-ai docs");
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  if (action === "client") {
    printClient(config, options);
    return;
  }

  const inputPath = options.path ? normalizeDocsRootInput(options.path) : undefined;
  const resolution = resolveDocsProject(paths, config.projects.aliases, options.project, inputPath);
  printResolution(resolution);

  switch (action) {
    case "path":
      assertNoArgs(options.args, "Uso: malahor-ai docs path [--project <key>]");
      return;
    case "status":
      assertNoArgs(options.args, "Uso: malahor-ai docs status [--project <key>]");
      printLine(`Initialized: ${resolution.initialized ? "yes" : "no"}`);
      printLine(`MCP runtime: ${fs.existsSync(paths.docsIndex) ? paths.docsIndex : "missing"}`);
      printLine(`Human client: ${config.docs.client}`);
      return;
    case "init": {
      assertNoArgs(options.args, "Uso: malahor-ai docs init [--project <key>] [--path <externa>] [--dry-run]");
      assertSafeRootChange(config, options, resolution);
      const template = path.join(resolvePackagePaths(paths.cwd).assetsDir, "vault-template");
      const result = initializeDocsProject(resolution, template, options.dryRun);
      if (options.path) {
        setProjectDocsPath(
          paths.projectsFile,
          resolution.project,
          resolution.source === "override" ? resolution.projectRoot : undefined,
          options.dryRun,
        );
        printLine(`Override: ${options.dryRun ? "would register" : "registered"}`);
      }
      printLine(`Created: ${result.created.length}`);
      printLine(`Kept: ${result.kept.length}`);
      return;
    }
    case "check": {
      assertNoArgs(options.args, "Uso: malahor-ai docs check [--project <key>]");
      const issues = checkDocsProject(resolution);
      if (issues.length === 0) {
        printLine("Check: OK");
        return;
      }
      for (const issue of issues) printLine(`${issue.severity.toUpperCase()} ${issue.code} ${issue.path}: ${issue.message}`);
      if (issues.some((issue) => issue.severity === "error")) process.exitCode = 1;
      return;
    }
    case "open": {
      if (options.args.length > 1) {
        throw new Error("Uso: malahor-ai docs open [ruta-relativa] [--project <key>] [--app system|vscode|obsidian] [--dry-run]");
      }
      const opened = openDocsClient(resolution, {
        path: options.args[0],
        app: options.app,
        configuredClient: config.docs.client,
        dryRun: options.dryRun,
      });
      printLine(`Requested client: ${opened.requestedClient}`);
      printLine(`Opened with: ${opened.client}`);
      if (opened.fallback) {
        printLine(`Fallback: ${opened.fallback.from} no disponible; se uso system (${opened.fallback.reason})`);
      }
      printLine(`Open: ${formatDocsOpenCommand(opened)}`);
      if (opened.requestedClient === "obsidian") {
        printLine("Si Obsidian aun no conoce esta carpeta como vault, abre la raiz documental manualmente una sola vez.");
      }
      return;
    }
    case "move": {
      if (options.args.length !== 1) throw new Error("Uso: malahor-ai docs move <origen> [--project <key>] [--apply --yes]");
      const preview = previewDocsMove(options.args[0]!, resolution);
      printLine(`Move preview: ${preview.entries.length} Markdown(s); el origen se conserva.`);
      for (const entry of preview.entries) printLine(`- ${entry.status}: ${entry.relativePath}`);
      if (!options.apply) {
        printLine("Preview only. Repite con --apply --yes para copiar y verificar.");
        return;
      }
      if (!options.yes) throw new Error("Aplicar docs move requiere --yes despues de revisar el preview.");
      if (options.dryRun) throw new Error("docs move no acepta --dry-run junto con --apply; sin --apply ya es preview.");
      const result = applyDocsMove(preview);
      printLine(`Copied and verified: ${result.copied.length}`);
      printLine(`Already identical: ${result.kept.length}`);
      printLine("Source: kept");
      return;
    }
    default:
      throw new Error(`Comando docs invalido: ${action}. Usa path, status, init, check, open, client o move.`);
  }
}

function printClient(config: MalahorConfig, options: DocsOptions): void {
  if (options.args.length === 0 || (options.args.length === 1 && ["get", "status"].includes(options.args[0]!))) {
    printLine(`Config file: ${config.paths.configFile}`);
    printLine(`Documentation client: ${config.docs.client}`);
    printLine("Precedence: --app > docs.client > system");
    return;
  }
  const values = options.args[0] === "set" ? options.args.slice(1) : options.args;
  if (values.length !== 1) {
    throw new Error("Uso: malahor-ai docs client [get|status|system|vscode|obsidian] [--dry-run]");
  }
  const client = parseDocsClient(values[0]);
  saveDocsClient(config, client, options.dryRun);
  printLine(`Config file: ${config.paths.configFile}`);
  printLine(`Documentation client: ${options.dryRun ? `would set ${client}` : client}`);
  printLine("No se instalaron ni configuraron aplicaciones externas.");
}

function assertSafeRootChange(config: MalahorConfig, options: DocsOptions, requested: DocsResolution): void {
  if (!options.path) return;
  const current = resolveDocsProject(config.paths, config.projects.aliases, options.project);
  if (current.initialized && !samePath(current.projectRoot, requested.projectRoot)) {
    throw new Error("La raiz documental actual ya contiene un proyecto inicializado. Cambiarla requiere preview y migracion; docs init no abandona contenido existente.");
  }
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function validateActionOptions(action: string, options: DocsOptions): void {
  if (options.path !== undefined && action !== "init") throw new Error("--path solo se admite con `docs init`.");
  if (options.app !== undefined && action !== "open") throw new Error("--app solo se admite con `docs open`.");
  if (options.apply && action !== "move") throw new Error("--apply solo se admite con `docs move`.");
  if (options.yes && action !== "move") throw new Error("--yes solo se admite con `docs move`.");
  if (action === "move" && options.yes && !options.apply) throw new Error("--yes requiere --apply en `docs move`.");
}

function printResolution(resolution: DocsResolution): void {
  printLine(`Project: ${resolution.project}`);
  printLine(`Project docs: ${resolution.projectRoot}`);
  printLine(`Vault root: ${resolution.vaultRoot}`);
  printLine(`Source: ${resolution.source}`);
}

function printDocsHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai docs path [--project <key>]
  malahor-ai docs status [--project <key>]
  malahor-ai docs init [--project <key>] [--path <externa>] [--dry-run]
  malahor-ai docs check [--project <key>]
  malahor-ai docs open [ruta-relativa] [--project <key>] [--app system|vscode|obsidian] [--dry-run]
  malahor-ai docs client [get|status|system|vscode|obsidian] [--dry-run]
  malahor-ai docs move <origen> [--project <key>] [--apply --yes]

Reglas:
  - Sin override, usa MALAHOR_HOME/vault/projects/<clave-canonica>/.
  - --path acepta rutas absolutas del runtime y, bajo WSL, rutas Windows convertibles con wslpath.
  - El cliente global es system por defecto; --app solo lo reemplaza para una apertura.
  - open solo admite paths relativos existentes dentro del proyecto documental.
  - El MCP docs es la unica via de escritura para agentes; no hay fallback al repo.
  - move copia Markdown, verifica hashes y conserva el origen; nunca sobrescribe.
`);
}

function assertNoArgs(args: string[], usage: string): void {
  if (args.length !== 0) throw new Error(usage);
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
