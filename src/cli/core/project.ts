import fs from "node:fs";
import path from "node:path";

export interface ProjectInfo {
  name: string;
  graphKey: string;
  root: string;
}

export function resolveProject(cwd = process.cwd()): ProjectInfo {
  const name = readPackageName(cwd) ?? path.basename(cwd);

  return {
    name,
    graphKey: toGraphKey(name),
    root: cwd,
  };
}

function readPackageName(cwd: string): string | null {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof parsed.name === "string" && parsed.name.trim()) {
      return parsed.name.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function toGraphKey(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
}
