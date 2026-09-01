import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MalahorPackagePaths {
  root: string;
  assetsDir: string;
  mnemoBuild: string;
}

export function resolvePackagePaths(cwd = process.cwd(), moduleUrl = import.meta.url): MalahorPackagePaths {
  const root = findPackageRoot(cwd) ?? findPackageRoot(path.dirname(fileURLToPath(moduleUrl)));

  if (!root) {
    throw new Error("No se pudo resolver el paquete malahor-ai.");
  }

  return {
    root,
    assetsDir: path.join(root, "assets"),
    mnemoBuild: path.join(root, "dist", "mnemo", "index.js"),
  };
}

function findPackageRoot(start: string): string | null {
  let current = path.resolve(start);

  for (let depth = 0; depth < 6; depth += 1) {
    const packageJson = path.join(current, "package.json");
    const assetsDir = path.join(current, "assets");

    if (fs.existsSync(packageJson) && fs.existsSync(assetsDir) && hasPackageName(packageJson)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function hasPackageName(packageJson: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as { name?: unknown }).name === "malahor-ai";
  } catch {
    return false;
  }
}
