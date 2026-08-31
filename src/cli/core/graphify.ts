import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commandExists } from "./detector";
import type { MalahorPaths } from "./paths";
import type { ProjectInfo } from "./project";

export interface GraphifyRunOptions {
  dryRun: boolean;
}

export interface GraphifyRunResult {
  command: string | null;
  outputDir: string;
  graphFile: string;
}

export function resolveGraphOutput(paths: MalahorPaths, project: ProjectInfo): string {
  return path.join(paths.graphsDir, project.graphKey);
}

export function findGraphifyCommand(): string | null {
  if (commandExists("graphify")) return "graphify";
  if (commandExists("graphifyy")) return "graphifyy";
  return null;
}

export function runGraphify(paths: MalahorPaths, project: ProjectInfo, options: GraphifyRunOptions): GraphifyRunResult {
  const command = findGraphifyCommand();
  const outputDir = resolveGraphOutput(paths, project);
  const graphFile = path.join(outputDir, "graph.json");

  if (options.dryRun) {
    return { command, outputDir, graphFile };
  }

  if (!command) {
    throw new Error("Graphify no esta instalado. Instala `graphifyy` con pip antes de generar grafos.");
  }

  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync(command, ["."], {
    cwd: project.root,
    env: { ...process.env, GRAPHIFY_OUT: outputDir },
    stdio: "inherit",
  });

  return { command, outputDir, graphFile };
}
