import fs from "node:fs";
import path from "node:path";

import type { MalahorPaths } from "./paths";
import { resolveCanonicalProjectKey, resolveProject, type ProjectAliases } from "./project";

export type ContextLevel = "mnemo" | "mnemo+graphify" | "mnemo+graphify+obsidian";

export const CONTEXT_LEVELS: readonly ContextLevel[] = ["mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"];
export const DEFAULT_CONTEXT_LEVEL: ContextLevel = "mnemo+graphify";

export interface ProjectContext {
  context: ContextLevel;
}

export interface ProjectsFile {
  [canonicalKey: string]: ProjectContext;
}

export interface ContextTarget {
  name: string;
  canonicalKey: string;
  root: string;
}

export function resolveContextTarget(paths: MalahorPaths, aliases: ProjectAliases, override?: string): ContextTarget {
  if (override && override.trim()) {
    return {
      name: override.trim(),
      canonicalKey: resolveCanonicalProjectKey(override, aliases),
      root: "",
    };
  }

  const project = resolveProject(paths.cwd, aliases);
  return { name: project.name, canonicalKey: project.canonicalKey, root: project.root };
}

export function parseContextLevel(value: unknown): ContextLevel {
  if (typeof value !== "string" || !CONTEXT_LEVELS.includes(value as ContextLevel)) {
    throw new Error(`Nivel de contexto invalido: ${String(value)}. Usa ${CONTEXT_LEVELS.join(", ")}.`);
  }

  return value as ContextLevel;
}

export function loadProjectsFile(filePath: string): ProjectsFile {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`No se pudo leer ${filePath}: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`La configuracion ${filePath} no contiene un objeto JSON valido.`);
  }

  const result: ProjectsFile = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      throw new Error(`La configuracion ${filePath} en ${key} debe ser un objeto.`);
    }

    try {
      result[key] = { context: parseContextLevel(value.context) };
    } catch (error) {
      throw new Error(`La configuracion ${filePath} en ${key}: ${(error as Error).message}`);
    }
  }

  return result;
}

export function levelForProject(projectsFile: string, canonicalKey: string): ContextLevel {
  return loadProjectsFile(projectsFile)[canonicalKey]?.context ?? DEFAULT_CONTEXT_LEVEL;
}

export function saveProjectContext(projectsFile: string, canonicalKey: string, context: ContextLevel, dryRun: boolean): void {
  const current = loadProjectsFile(projectsFile);
  const next: ProjectsFile = { ...current, [canonicalKey]: { context } };

  if (dryRun) return;

  const dir = path.dirname(projectsFile);
  const tempPath = path.join(dir, `${path.basename(projectsFile)}.${process.pid}.${Date.now()}.tmp`);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  secureChmod(dir, 0o700);
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, projectsFile);
  secureChmod(projectsFile, 0o600);
}

export function graphifyEnabled(level: ContextLevel): boolean {
  return level !== "mnemo";
}

export function obsidianEnabled(level: ContextLevel): boolean {
  return level === "mnemo+graphify+obsidian";
}

export function withObsidian(level: ContextLevel, enabled: boolean): ContextLevel {
  if (enabled) return "mnemo+graphify+obsidian";
  return level === "mnemo+graphify+obsidian" ? "mnemo+graphify" : level;
}

export function withGraphify(level: ContextLevel, enabled: boolean): ContextLevel {
  if (enabled) return level === "mnemo" ? "mnemo+graphify" : level;
  return "mnemo";
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows no soporta permisos POSIX; se ignora.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
