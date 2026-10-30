import fs from "node:fs";
import path from "node:path";

import type { MalahorPaths } from "./paths";
import { resolveCanonicalProjectKey, resolveProject, type ProjectAliases, type ProjectInfo } from "./project";

// Formato persistido heredado: solo lectura/preservacion hasta la migracion asistida de T-5.4.3.
// No usar estos valores para activar o instalar proveedores de contexto de codigo.
export type ContextLevel = "mnemo" | "mnemo+graphify" | "mnemo+graphify+obsidian";

export const CONTEXT_LEVELS: readonly ContextLevel[] = ["mnemo", "mnemo+graphify", "mnemo+graphify+obsidian"];
export const DEFAULT_CONTEXT_LEVEL: ContextLevel = "mnemo";

export interface ProjectContext {
  context: ContextLevel;
  roots?: string[];
  defaultRoot?: string;
}

export interface ProjectsFile {
  [canonicalKey: string]: ProjectContext;
}

export interface ContextTarget {
  name: string;
  canonicalKey: string;
  root: string;
  registeredRoots?: string[];
}

export interface RegisteredProjectRoot {
  canonicalKey: string;
  root: string;
}

export function resolveContextTarget(paths: MalahorPaths, aliases: ProjectAliases, override?: string): ContextTarget {
  if (override && override.trim()) {
    const canonicalKey = resolveCanonicalProjectKey(override, aliases);
    const registered = rootsForProject(paths.projectsFile, canonicalKey);
    return {
      name: override.trim(),
      canonicalKey,
      root: registered[0] ?? "",
      registeredRoots: registered,
    };
  }

  const project = resolveRegisteredProject(paths, aliases);
  return {
    name: project.name,
    canonicalKey: project.canonicalKey,
    root: project.root,
    registeredRoots: rootsForProject(paths.projectsFile, project.canonicalKey),
  };
}

export interface RegisteredProjectOptions {
  /** Proyecto explicito (acepta aliases) y tiene prioridad sobre toda inferencia. */
  override?: string;
  /** Raiz concreta ya resuelta por el caller. */
  preferredRoot?: string;
  /** Archivos de la operacion; permiten inferir el proyecto aunque el cwd sea otro. */
  targetPaths?: string[];
  /** Scope de memoria u otra pista de proyecto cuando no hay archivos objetivo. */
  projectHint?: string;
}

/**
 * Resuelve primero contra roots/defaultRoot registrados y solo usa cwd como
 * fallback. Esto permite trabajar desde una sesion abierta fuera del repo.
 */
export function resolveRegisteredProject(
  paths: MalahorPaths,
  aliases: ProjectAliases = {},
  options: RegisteredProjectOptions = {},
): ProjectInfo {
  const canonicalKey = options.override?.trim()
    ? resolveCanonicalProjectKey(options.override, aliases)
    : resolveProjectHint(paths, aliases, options.projectHint);
  const absoluteTargets = (options.targetPaths ?? [])
    .map((target) => path.resolve(paths.cwd, target));
  const registered = canonicalKey
    ? rootsForProject(paths.projectsFile, canonicalKey).map((root) => ({ canonicalKey, root }))
    : registeredProjectRoots(paths.projectsFile)
      .filter((entry) => (
        isWithinPath(paths.cwd, entry.root)
        || absoluteTargets.some((target) => isWithinPath(target, entry.root))
      ))
      .sort((left, right) => right.root.length - left.root.length);
  const root = options.preferredRoot ?? registered[0]?.root;

  if (root) {
    const resolved = resolveProject(root, aliases);
    return {
      ...resolved,
      canonicalKey: canonicalKey ?? registered[0]?.canonicalKey ?? resolved.canonicalKey,
      root,
    };
  }

  const fallback = resolveProject(paths.cwd, aliases);
  return canonicalKey ? { ...fallback, canonicalKey } : fallback;
}

function resolveProjectHint(paths: MalahorPaths, aliases: ProjectAliases, hint?: string): string | undefined {
  if (!hint?.trim()) return undefined;

  const projects = loadProjectsFile(paths.projectsFile);
  const normalized = resolveCanonicalProjectKey(hint, aliases);
  if (projects[normalized]) return normalized;

  // Los scopes de memoria son jerarquicos (proyecto/modulo/feature): si el
  // scope completo no esta registrado, usa su primer segmento.
  const rootSegment = hint.split("/")[0]?.trim();
  if (!rootSegment || rootSegment === hint) return normalized;
  const rootKey = resolveCanonicalProjectKey(rootSegment, aliases);
  return projects[rootKey] ? rootKey : normalized;
}

export function parseContextLevel(value: unknown): ContextLevel {
  if (typeof value !== "string" || !CONTEXT_LEVELS.includes(value as ContextLevel)) {
    throw new Error(`Nivel de contexto invalido: ${String(value)}. Consulta \`malahor-ai context help\`; los valores persistidos siguen en compatibilidad transitoria.`);
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
      const roots = readRoots(value.roots, `${filePath} en ${key}.roots`);
      const defaultRoot = readRoot(value.defaultRoot, `${filePath} en ${key}.defaultRoot`);
      result[key] = {
        context: parseContextLevel(value.context),
        ...(roots.length > 0 ? { roots } : {}),
        ...(defaultRoot ? { defaultRoot } : {}),
      };
    } catch (error) {
      throw new Error(`La configuracion ${filePath} en ${key}: ${(error as Error).message}`);
    }
  }

  return result;
}

export function levelForProject(projectsFile: string, canonicalKey: string): ContextLevel {
  return loadProjectsFile(projectsFile)[canonicalKey]?.context ?? DEFAULT_CONTEXT_LEVEL;
}

export function rootsForProject(projectsFile: string, canonicalKey: string): string[] {
  const entry = loadProjectsFile(projectsFile)[canonicalKey];
  if (!entry) return [];
  const roots = entry.roots ?? [];
  const preferred = entry.defaultRoot && roots.includes(entry.defaultRoot) ? [entry.defaultRoot] : [];
  return [...preferred, ...roots.filter((root) => !preferred.includes(root))];
}

export function registeredProjectRoots(projectsFile: string): RegisteredProjectRoot[] {
  const projects = loadProjectsFile(projectsFile);
  return Object.entries(projects).flatMap(([canonicalKey, entry]) => (
    (entry.roots ?? []).map((root) => ({ canonicalKey, root }))
  ));
}

export function registerProjectRoot(projectsFile: string, canonicalKey: string, root: string, dryRun: boolean): void {
  const current = loadProjectsFile(projectsFile);
  const existing = current[canonicalKey] ?? { context: DEFAULT_CONTEXT_LEVEL };
  const normalized = normalizeRoot(root);
  const roots = [...new Set([...(existing.roots ?? []), normalized])];
  const next: ProjectsFile = {
    ...current,
    [canonicalKey]: { ...existing, roots, defaultRoot: normalized },
  };

  writeProjectsFile(projectsFile, next, dryRun);
}

function writeProjectsFile(projectsFile: string, next: ProjectsFile, dryRun: boolean): void {
  if (dryRun) return;

  const dir = path.dirname(projectsFile);
  const tempPath = path.join(dir, `${path.basename(projectsFile)}.${process.pid}.${Date.now()}.tmp`);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  secureChmod(dir, 0o700);
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, projectsFile);
  secureChmod(projectsFile, 0o600);
}

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function readRoots(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`La configuracion ${key} debe ser una lista de strings.`);
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(normalizeRoot);
}

function readRoot(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`La configuracion ${key} debe ser un string.`);
  return normalizeRoot(value);
}

export function obsidianEnabled(level: ContextLevel): boolean {
  return level === "mnemo+graphify+obsidian";
}

export function contextLevelLabel(level: ContextLevel): string {
  if (level === "mnemo") return "memory";
  if (obsidianEnabled(level)) return "memory+code-context+obsidian (provider pending)";
  return "memory+code-context (provider pending)";
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows no soporta permisos POSIX; se ignora.
  }
}

function isWithinPath(value: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
