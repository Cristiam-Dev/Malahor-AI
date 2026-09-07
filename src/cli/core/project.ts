import fs from "node:fs";
import path from "node:path";

export type ProjectAliases = Record<string, string[]>;

export interface ProjectInfo {
  name: string;
  canonicalKey: string;
  graphKey: string;
  root: string;
  aliases: string[];
}

const BUILT_IN_PROJECT_ALIASES: ProjectAliases = {
  malahor: ["malaho", "MalaHor", "malahor ai", "malahor-ai", "malahor_ai", "malahorai"],
};

export function resolveProject(cwd = process.cwd(), aliases: ProjectAliases = {}): ProjectInfo {
  const root = findProjectRoot(cwd);
  const name = readPackageName(root) ?? path.basename(root);
  const canonicalKey = resolveCanonicalProjectKey(name, aliases);

  return {
    name,
    canonicalKey,
    graphKey: canonicalKey,
    root,
    aliases: aliasesForProject(canonicalKey, aliases),
  };
}

export function resolveCanonicalProjectKey(project: string, aliases: ProjectAliases = {}): string {
  const lookup = projectLookupKey(project);
  const allAliases = mergeAliases(BUILT_IN_PROJECT_ALIASES, aliases);

  for (const [canonical, values] of Object.entries(allAliases)) {
    const candidates = [canonical, ...values];
    if (candidates.some((candidate) => projectLookupKey(candidate) === lookup)) {
      return toCanonicalKey(canonical);
    }
  }

  return toCanonicalKey(project);
}

export function projectLookupKey(project: string): string {
  return project
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    if (fs.existsSync(path.join(current, "package.json")) || fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
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

function toCanonicalKey(value: string): string {
  return projectLookupKey(value) || "project";
}

function aliasesForProject(canonicalKey: string, aliases: ProjectAliases): string[] {
  const allAliases = mergeAliases(BUILT_IN_PROJECT_ALIASES, aliases);

  return Object.entries(allAliases)
    .filter(([canonical]) => toCanonicalKey(canonical) === canonicalKey)
    .flatMap(([, values]) => values);
}

function mergeAliases(base: ProjectAliases, extra: ProjectAliases): ProjectAliases {
  const merged: ProjectAliases = { ...base };

  for (const [canonical, values] of Object.entries(extra)) {
    merged[canonical] = [...(merged[canonical] ?? []), ...values];
  }

  return merged;
}
