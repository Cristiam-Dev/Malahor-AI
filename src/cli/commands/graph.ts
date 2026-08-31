import { loadConfig } from "../core/config";
import { runGraphify } from "../core/graphify";
import { isSandbox } from "../core/paths";
import { resolveProject } from "../core/project";

export interface GraphOptions {
  dryRun: boolean;
}

export function runGraph(options: GraphOptions): void {
  const config = loadConfig();
  const paths = config.paths;
  const project = resolveProject(paths.cwd);
  const result = runGraphify(paths, project, options);

  printHeader("malahor-ai graph");
  printLine(`Mode: ${config.mode}`);
  printLine(`Project: ${project.name}`);
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

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
