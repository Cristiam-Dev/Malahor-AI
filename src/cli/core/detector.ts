import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { MalahorPaths } from "./paths";

export interface DetectionResult {
  platform: NodeJS.Platform;
  arch: string;
  isWsl: boolean;
  nodeVersion: string;
  nodeMajor: number;
  opencodeConfigExists: boolean;
  agentsMdExists: boolean;
  commands: Record<string, boolean>;
}

export type OpenCodeHostKind = "v1" | "v2" | "unknown";

export interface OpenCodeHostInfo {
  kind: OpenCodeHostKind;
  version: string | null;
  error?: string;
}

export interface DetectOpenCodeHostOptions {
  env?: NodeJS.ProcessEnv;
  runVersion?: (binary: string, cwd: string) => string;
}

// Version del host, no de la config: el CLI puede ser V2 aunque el directorio
// conserve restos V1. Un fallo de lectura no se adivina; queda "unknown".
export function detectOpenCodeHost(paths: MalahorPaths, options: DetectOpenCodeHostOptions = {}): OpenCodeHostInfo {
  const env = options.env ?? process.env;
  const binary = env.MALAHOR_OPENCODE_BIN?.trim() || "opencode";

  try {
    const output = (options.runVersion ?? ((command, cwd) => defaultOpenCodeVersion(command, cwd, env)))(binary, paths.cwd);
    const version = parseOpenCodeVersion(output);

    if (!version) {
      return { kind: "unknown", version: null, error: "no se pudo parsear la version de `opencode --version`" };
    }

    return { kind: hostKindForVersion(version), version };
  } catch (error) {
    return { kind: "unknown", version: null, error: (error as Error).message };
  }
}

export function parseOpenCodeVersion(output: string): string | null {
  const match = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1] ?? null;
}

export function hostKindForVersion(version: string): OpenCodeHostKind {
  const major = Number(version.split(".")[0]);
  if (major === 2) return "v2";
  if (major === 1) return "v1";
  return "unknown";
}

function defaultOpenCodeVersion(binary: string, cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(binary, ["--version"], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
}

export function detectEnvironment(paths: MalahorPaths): DetectionResult {
  const nodeVersion = process.versions.node;

  return {
    platform: process.platform,
    arch: os.arch(),
    isWsl: detectWsl(),
    nodeVersion,
    nodeMajor: Number(nodeVersion.split(".")[0] ?? 0),
    opencodeConfigExists: fs.existsSync(paths.opencodeConfig),
    agentsMdExists: fs.existsSync(paths.agentsMd),
    commands: {
      node: commandExists("node"),
      bun: commandExists("bun"),
      pnpm: commandExists("pnpm"),
      npm: commandExists("npm"),
      python: commandExists("python3") || commandExists("python"),
      pip: commandExists("pip3") || commandExists("pip"),
      opencode: commandExists(process.env.MALAHOR_OPENCODE_BIN?.trim() || "opencode"),
      graphify: commandExists("graphify") || commandExists("graphifyy"),
    },
  };
}

export function commandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      return true;
    }

    execFileSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectWsl(): boolean {
  if (process.platform !== "linux") return false;

  const release = os.release().toLowerCase();
  if (release.includes("microsoft") || release.includes("wsl")) return true;

  try {
    const version = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("microsoft") || version.includes("wsl");
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
