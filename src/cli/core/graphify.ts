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

export interface GraphifyStatus {
  source: "system" | "venv" | "missing";
  command: string | null;
  venvDir: string;
  python: string | null;
  version: string | null;
}

export interface GraphifyInstallResult {
  ok: boolean;
  command: string | null;
  error: string | null;
}

export function resolveGraphOutput(paths: MalahorPaths, project: ProjectInfo): string {
  return path.join(paths.graphsDir, project.graphKey);
}

export function graphifyVenvDir(paths: MalahorPaths): string {
  return path.join(paths.malahorHome, "tools", "graphify");
}

export function graphifyVenvCommand(paths: MalahorPaths): string | null {
  const venv = graphifyVenvDir(paths);
  const binDir = process.platform === "win32" ? path.join(venv, "Scripts") : path.join(venv, "bin");
  const names = process.platform === "win32" ? ["graphifyy.exe", "graphify.exe", "graphifyy", "graphify"] : ["graphifyy", "graphify"];

  for (const name of names) {
    const candidate = path.join(binDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

export function graphifyPythonCommand(): string | null {
  if (commandExists("python3")) return "python3";
  if (commandExists("python")) return "python";
  return null;
}

// Orden: binario del sistema primero, luego el venv aislado de Malahor.
export function findGraphifyCommand(paths?: MalahorPaths): string | null {
  if (commandExists("graphify")) return "graphify";
  if (commandExists("graphifyy")) return "graphifyy";
  if (paths) return graphifyVenvCommand(paths);
  return null;
}

export function graphifyVersion(command: string): string | null {
  try {
    const out = execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

export function graphifyStatus(paths: MalahorPaths): GraphifyStatus {
  const python = graphifyPythonCommand();
  const system = commandExists("graphify") ? "graphify" : commandExists("graphifyy") ? "graphifyy" : null;
  const venvCommand = graphifyVenvCommand(paths);

  if (system) {
    return { source: "system", command: system, venvDir: graphifyVenvDir(paths), python, version: graphifyVersion(system) };
  }
  if (venvCommand) {
    return { source: "venv", command: venvCommand, venvDir: graphifyVenvDir(paths), python, version: graphifyVersion(venvCommand) };
  }

  return { source: "missing", command: null, venvDir: graphifyVenvDir(paths), python, version: null };
}

// Instalacion en venv aislado dentro de ~/.malahor; nunca global salvo pedido explicito.
// Nunca lanza: el caller degrada a "Graphify: degraded" sin romper install/bootstrap.
export function installGraphifyVenv(paths: MalahorPaths, dryRun: boolean): GraphifyInstallResult {
  const venvDir = graphifyVenvDir(paths);
  const python = graphifyPythonCommand();

  if (!python) {
    return { ok: false, command: null, error: "python3 no esta disponible en PATH. Instala Python 3 y corre `malahor-ai graphify install`." };
  }

  if (dryRun) {
    return { ok: true, command: `${venvDir} (dry-run)`, error: null };
  }

  try {
    if (!fs.existsSync(venvDir)) {
      fs.mkdirSync(path.dirname(venvDir), { recursive: true });
      execFileSync(python, ["-m", "venv", venvDir], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    }

    const pip = process.platform === "win32" ? path.join(venvDir, "Scripts", "pip.exe") : path.join(venvDir, "bin", "pip");
    execFileSync(pip, ["install", "graphifyy"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

    const command = graphifyVenvCommand(paths);
    if (!command) {
      return { ok: false, command: null, error: "pip instalo graphifyy pero no se encontro el binario en el venv. Verifica `python3 -m venv --help` (en Debian/Ubuntu puede faltar el paquete python3-venv)." };
    }

    return { ok: true, command, error: null };
  } catch (error) {
    const detail = (error as { stderr?: string; message?: string }).stderr ?? (error as Error).message ?? "error desconocido";
    return { ok: false, command: null, error: detail.trim().split("\n").slice(-3).join(" / ").slice(0, 400) };
  }
}

export function runGraphify(paths: MalahorPaths, project: ProjectInfo, options: GraphifyRunOptions): GraphifyRunResult {
  const command = findGraphifyCommand(paths);
  const outputDir = resolveGraphOutput(paths, project);
  const graphFile = path.join(outputDir, "graph.json");

  if (options.dryRun) {
    return { command, outputDir, graphFile };
  }

  if (!command) {
    throw new Error("Graphify no esta instalado. Corre `malahor-ai graphify install` (crea un venv aislado) o instala `graphifyy` con pip.");
  }

  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync(command, ["."], {
    cwd: project.root,
    env: { ...process.env, GRAPHIFY_OUT: outputDir },
    stdio: "inherit",
  });

  return { command, outputDir, graphFile };
}
