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
  opencodeMdExists: boolean;
  commands: Record<string, boolean>;
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
    opencodeMdExists: fs.existsSync(paths.opencodeMd),
    commands: {
      node: commandExists("node"),
      bun: commandExists("bun"),
      pnpm: commandExists("pnpm"),
      python: commandExists("python3") || commandExists("python"),
      pip: commandExists("pip3") || commandExists("pip"),
      opencode: commandExists("opencode"),
      graphify: commandExists("graphify") || commandExists("graphifyy"),
    },
  };
}

export function commandExists(command: string): boolean {
  try {
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
