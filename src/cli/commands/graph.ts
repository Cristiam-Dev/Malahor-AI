import { loadConfig, type MalahorConfig } from "../core/config";
import {
  findGraphifyCommand,
  graphifyStatus,
  graphifyVersion,
  installGraphifyVenv,
  runGraphify,
} from "../core/graphify";
import { isSandbox, type MalahorPaths } from "../core/paths";
import { resolveProject } from "../core/project";

export interface GraphOptions {
  action: string;
  dryRun: boolean;
}

export function runGraph(options: GraphOptions): void {
  const config = loadConfig();
  const paths = config.paths;

  switch (options.action) {
    case "status":
      runGraphifyStatus(paths, options);
      return;
    case "install":
      runGraphifyInstall(paths, options);
      return;
    case "verify":
      runGraphifyVerify(paths, options);
      return;
    case "generate":
    case "help":
      if (options.action === "help") {
        printGraphHelp();
        return;
      }
      runGraphGenerate(config, paths, options);
      return;
    default:
      throw new Error(`Comando graph invalido: ${options.action}. Usa generate, status, install o verify.`);
  }
}

function runGraphGenerate(config: MalahorConfig, paths: MalahorPaths, options: GraphOptions): void {
  const project = resolveProject(paths.cwd, config.projects.aliases);
  const result = runGraphify(paths, project, { dryRun: options.dryRun });

  printHeader("malahor-ai graph");
  printLine(`Mode: ${config.mode}`);
  printLine(`Project: ${project.name}`);
  printLine(`Project root: ${project.root}`);
  printLine(`Canonical key: ${project.canonicalKey}`);
  printLine(`Graph key: ${project.graphKey}`);
  printLine(`Config file: ${paths.configFile}`);
  printLine(`Malahor home: ${paths.malahorHome}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);
  printLine(`Graphify command: ${result.command ?? "not found"}`);
  printLine(`GRAPHIFY_OUT: ${result.outputDir}`);
  printLine(`Graph file: ${result.graphFile}`);
  printLine(`Status: ${options.dryRun ? "planned" : "generated"}`);
}

function runGraphifyStatus(paths: MalahorPaths, options: GraphOptions): void {
  const status = graphifyStatus(paths);

  printHeader("malahor-ai graphify status");
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Fuente: ${status.source}`);
  printLine(`Comando: ${status.command ?? "ninguno"}`);
  printLine(`Version: ${status.version ?? "desconocida"}`);
  printLine(`Python: ${status.python ?? "no encontrado (requerido para graphify install)"}`);
  printLine(`Venv aislado: ${status.venvDir}`);

  if (status.source === "missing") {
    printLine("Estado: degraded");
    printLine("Reparacion: `malahor-ai graphify install` (crea un venv aislado, no instala global)");
  } else {
    printLine("Estado: ok");
  }
}

function runGraphifyInstall(paths: MalahorPaths, options: GraphOptions): void {
  printHeader("malahor-ai graphify install");
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  const existing = findGraphifyCommand(paths);
  if (existing && !options.dryRun) {
    printLine(`Graphify ya disponible: ${existing}`);
    printLine("Resultado: unchanged");
    return;
  }

  const result = installGraphifyVenv(paths, options.dryRun);

  if (result.ok) {
    printLine(`Venv: ${paths.malahorHome}/tools/graphify`);
    printLine(`Comando: ${result.command ?? "(dry-run)"}`);
    printLine("Resultado: installed (aislado, no global)");
    return;
  }

  printLine(`Resultado: degraded`);
  printLine(`Motivo: ${result.error}`);
  printLine("Nota: install/bootstrap no se rompen por esto; Graphify queda opcional.");
}

function runGraphifyVerify(paths: MalahorPaths, options: GraphOptions): void {
  printHeader("malahor-ai graphify verify");
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  const status = graphifyStatus(paths);

  if (status.source === "missing") {
    printLine("Verificacion: degraded (Graphify no esta instalado; corre `malahor-ai graphify install`)");
    return;
  }

  printLine(`Fuente: ${status.source}`);
  printLine(`Comando: ${status.command}`);
  const version = status.command ? graphifyVersion(status.command) : null;
  printLine(`Version: ${version ?? "el binario no respondio --version"}`);
  printLine(`Verificacion: ${version ? "ok" : "degraded"}`);
}

function printGraphHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai graph [--dry-run]
  malahor-ai graphify status
  malahor-ai graphify install [--dry-run]
  malahor-ai graphify verify [--dry-run]

Notas:
  graph genera el grafo externo en ~/.malahor/graphs/<graphKey>.
  graphify install crea un venv aislado en ~/.malahor/tools/graphify; nunca instala global.
  Si Graphify falla, la instalacion degrada sin romperse: el grafo es opcional.
`);
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
