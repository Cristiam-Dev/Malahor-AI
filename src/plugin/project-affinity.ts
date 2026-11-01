import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../cli/core/config";
import { registeredProjectRoots, rootsForProject } from "../cli/core/context";
import {
  projectLookupKey,
  resolveCanonicalProjectKey,
  resolveProject,
  type ProjectAliases,
} from "../cli/core/project";
import type { ResolvedSessionProject, SessionProjectHints } from "../cli/core/hooks/plugin-adapter";

export const PROJECT_AFFINITY_MARKER = "<!-- malahor-project-affinity:v1 -->";

export interface ProjectAffinityStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
}

export interface ProjectAffinityOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  storage: ProjectAffinityStorage;
  resolveSessionHints?: (sessionID: string) => Promise<SessionProjectHints | undefined>;
  resolvePlanProject?: (sessionID: string) => Promise<string | undefined>;
  locationProject?: string;
  now?: () => number;
}

export interface ProjectAffinityResolver {
  resolveSessionProject(sessionID: string, hints?: SessionProjectHints): Promise<ResolvedSessionProject | undefined>;
  observePrompt(input: Record<string, unknown>): Promise<ResolvedSessionProject | undefined>;
  injectContext(input: Record<string, unknown>): Promise<boolean>;
}

interface RegisteredProject {
  canonicalKey: string;
  roots: string[];
  names: string[];
}

interface AffinityRecord {
  schema: 1;
  sessionID: string;
  canonicalKey?: string;
  pending?: {
    kind: "ambiguous" | "conflict";
    candidates: string[];
    target?: string;
    clarificationAsked?: boolean;
  };
  updatedAt: string;
}

export function createProjectAffinityResolver(options: ProjectAffinityOptions): ProjectAffinityResolver {
  const resolveSessionProject = async (
    sessionID: string,
    hints: SessionProjectHints = {},
  ): Promise<ResolvedSessionProject | undefined> => {
    if (!validSessionID(sessionID)) return undefined;
    const registry = loadRegistry(options);
    if (registry.projects.length === 0) return undefined;
    const record = await readRecord(options.storage, sessionID);
    const current = record?.canonicalKey
      ? findProject(registry.projects, record.canonicalKey)
      : undefined;

    if (current && !record?.pending) {
      const conflicting = strongestCandidate(hints, registry.projects, registry.aliases, options.cwd);
      if (conflicting && conflicting.canonicalKey !== current.canonicalKey) {
        await writePending(options, sessionID, current.canonicalKey, "conflict", [current.canonicalKey, conflicting.canonicalKey], conflicting.canonicalKey);
        return undefined;
      }
      return resolved(current);
    }

    const direct = strongestCandidate(hints, registry.projects, registry.aliases, options.cwd);
    if (direct && (!current || direct.canonicalKey === current.canonicalKey)) {
      return bind(options, sessionID, direct);
    }

    const planProject = await options.resolvePlanProject?.(sessionID);
    const planned = planProject
      ? candidateFromHint(planProject, registry.projects, registry.aliases)
      : undefined;
    if (planned && !current) return bind(options, sessionID, planned);

    const sessionHints = await options.resolveSessionHints?.(sessionID);
    const located = sessionHints && strongestCandidate(sessionHints, registry.projects, registry.aliases, options.cwd);
    if (located && !current) return bind(options, sessionID, located);

    const host = options.locationProject
      ? candidateFromHint(options.locationProject, registry.projects, registry.aliases)
      : candidateFromPaths([options.cwd], registry.projects, options.cwd);
    if (host && !current) return bind(options, sessionID, host);
    if (!current && registry.projects.length === 1) return bind(options, sessionID, registry.projects[0]!);

    if (!record?.pending) {
      await writePending(options, sessionID, current?.canonicalKey, current ? "conflict" : "ambiguous",
        current ? [current.canonicalKey] : registry.projects.map((item) => item.canonicalKey));
    }
    return undefined;
  };

  const observePrompt = async (input: Record<string, unknown>): Promise<ResolvedSessionProject | undefined> => {
    const sessionID = stringValue(input.sessionID);
    if (!sessionID || !validSessionID(sessionID)) return undefined;
    const registry = loadRegistry(options);
    if (registry.projects.length === 0) return undefined;
    const record = await readRecord(options.storage, sessionID);
    const text = promptText(input);
    const promptCandidate = candidateFromText(text, registry.projects);
    const selected = promptCandidate ?? candidateFromPaths(promptPaths(input), registry.projects, options.cwd);

    if (record?.pending?.kind === "conflict" && record.pending.target && affirmative(text)) {
      const target = findProject(registry.projects, record.pending.target);
      if (target) return bind(options, sessionID, target);
    }
    if (selected) {
      if (!record?.canonicalKey || record.canonicalKey === selected.canonicalKey
        || record.pending?.kind === "ambiguous" || explicitSwitch(text)) {
        return bind(options, sessionID, selected);
      }
      await writePending(options, sessionID, record.canonicalKey, "conflict",
        [record.canonicalKey, selected.canonicalKey], selected.canonicalKey);
      return undefined;
    }

    return resolveSessionProject(sessionID);
  };

  const injectContext = async (input: Record<string, unknown>): Promise<boolean> => {
    const sessionID = stringValue(input.sessionID);
    if (!sessionID || !validSessionID(sessionID)) return false;
    const system = Array.isArray(input.system) ? input.system : [];
    if (system.some((part) => isTextPart(part) && part.text.includes(PROJECT_AFFINITY_MARKER))) return false;

    let project: ResolvedSessionProject | undefined;
    try {
      project = await resolveSessionProject(sessionID);
    } catch {
      // La mediacion protegida falla cerrada; el contexto solo explica como recuperarse.
    }
    const record = await readRecord(options.storage, sessionID).catch(() => undefined);
    const instruction = project
      ? `${PROJECT_AFFINITY_MARKER}\nProyecto activo: ${project.canonicalKey}. Raiz autorizada: ${project.root}. Usa la clave canonica para memoria, docs y contexto; no infieras otro proyecto desde cwd.`
      : clarificationInstruction(record);
    appendSystemText(system, instruction);
    input.system = system;

    if (!project && record?.pending && !record.pending.clarificationAsked) {
      await options.storage.set(projectAffinityKey(sessionID), {
        ...record,
        pending: { ...record.pending, clarificationAsked: true },
        updatedAt: timestamp(options),
      });
    }
    return true;
  };

  return { resolveSessionProject, observePrompt, injectContext };
}

export function projectAffinityKey(sessionID: string): string {
  if (!validSessionID(sessionID)) throw new Error("ID de sesion no evaluable para afinidad de proyecto.");
  return `project-affinity/v1/sessions/${sessionID}`;
}

function loadRegistry(options: ProjectAffinityOptions): { projects: RegisteredProject[]; aliases: ProjectAliases } {
  const config = loadConfig({ ...options.env ?? process.env, MALAHOR_OPENCODE_DETECT: "0" }, options.cwd);
  const keys = [...new Set(registeredProjectRoots(config.paths.projectsFile).map((item) => item.canonicalKey))];
  const projects = keys.map((canonicalKey) => {
    const roots = rootsForProject(config.paths.projectsFile, canonicalKey);
    const names = new Set<string>([canonicalKey]);
    for (const root of roots) {
      const info = resolveProject(root, config.projects.aliases);
      names.add(info.name);
      names.add(path.basename(root));
      for (const alias of info.aliases) names.add(alias);
    }
    for (const [key, values] of Object.entries(config.projects.aliases)) {
      if (resolveCanonicalProjectKey(key, config.projects.aliases) !== canonicalKey) continue;
      values.forEach((value) => names.add(value));
    }
    return { canonicalKey, roots, names: [...names].map(projectLookupKey).filter(Boolean) };
  }).filter((project) => project.roots.length > 0);
  return { projects, aliases: config.projects.aliases };
}

function strongestCandidate(
  hints: SessionProjectHints,
  projects: RegisteredProject[],
  aliases: ProjectAliases,
  fallback: string,
): RegisteredProject | undefined {
  if (hints.projectHint) {
    const explicit = candidateFromHint(hints.projectHint, projects, aliases);
    if (explicit) return explicit;
  }
  const targeted = candidateFromPaths(hints.targetPaths ?? [], projects, hints.directory ?? fallback);
  if (targeted) return targeted;
  return hints.directory ? candidateFromPaths([hints.directory], projects, fallback) : undefined;
}

function candidateFromHint(
  hint: string,
  projects: RegisteredProject[],
  aliases: ProjectAliases,
): RegisteredProject | undefined {
  const byPath = candidateFromPaths([hint], projects, process.cwd());
  if (byPath) return byPath;
  const canonicalKey = resolveCanonicalProjectKey(hint, aliases);
  return findProject(projects, canonicalKey);
}

function candidateFromPaths(values: string[], projects: RegisteredProject[], base: string): RegisteredProject | undefined {
  const matches = new Set<string>();
  for (const value of values) {
    const filePath = normalizedPath(value, base);
    if (!filePath) continue;
    for (const project of projects) {
      if (project.roots.some((root) => inside(filePath, root))) matches.add(project.canonicalKey);
    }
  }
  return matches.size === 1 ? findProject(projects, [...matches][0]!) : undefined;
}

function candidateFromText(text: string, projects: RegisteredProject[]): RegisteredProject | undefined {
  const normalized = projectLookupKey(text);
  if (!normalized) return undefined;
  const matches = projects.filter((project) => project.names.some((name) => (
    normalized === name || normalized.startsWith(`${name}-`) || normalized.endsWith(`-${name}`)
      || normalized.includes(`-${name}-`)
  )));
  return matches.length === 1 ? matches[0] : undefined;
}

async function bind(
  options: ProjectAffinityOptions,
  sessionID: string,
  project: RegisteredProject,
): Promise<ResolvedSessionProject> {
  await options.storage.set(projectAffinityKey(sessionID), {
    schema: 1,
    sessionID,
    canonicalKey: project.canonicalKey,
    updatedAt: timestamp(options),
  });
  return resolved(project);
}

async function writePending(
  options: ProjectAffinityOptions,
  sessionID: string,
  canonicalKey: string | undefined,
  kind: "ambiguous" | "conflict",
  candidates: string[],
  target?: string,
): Promise<void> {
  await options.storage.set(projectAffinityKey(sessionID), {
    schema: 1,
    sessionID,
    ...(canonicalKey ? { canonicalKey } : {}),
    pending: { kind, candidates: [...new Set(candidates)].sort(), ...(target ? { target } : {}) },
    updatedAt: timestamp(options),
  });
}

async function readRecord(storage: ProjectAffinityStorage, sessionID: string): Promise<AffinityRecord | undefined> {
  const value = await storage.get(projectAffinityKey(sessionID));
  if (!isRecord(value) || value.schema !== 1 || value.sessionID !== sessionID) return undefined;
  const canonicalKey = stringValue(value.canonicalKey);
  const pendingValue = isRecord(value.pending) ? value.pending : undefined;
  const kind = pendingValue?.kind === "ambiguous" || pendingValue?.kind === "conflict" ? pendingValue.kind : undefined;
  const candidates = Array.isArray(pendingValue?.candidates)
    ? pendingValue.candidates.filter((item): item is string => typeof item === "string") : [];
  return {
    schema: 1,
    sessionID,
    ...(canonicalKey ? { canonicalKey } : {}),
    ...(kind ? { pending: {
      kind,
      candidates,
      ...(stringValue(pendingValue?.target) ? { target: stringValue(pendingValue?.target) } : {}),
      ...(pendingValue?.clarificationAsked === true ? { clarificationAsked: true } : {}),
    } } : {}),
    updatedAt: stringValue(value.updatedAt) ?? new Date(0).toISOString(),
  };
}

function clarificationInstruction(record: AffinityRecord | undefined): string {
  const pending = record?.pending;
  const candidates = pending?.candidates.join(", ") || "ninguno registrado";
  if (pending?.clarificationAsked) {
    return `${PROJECT_AFFINITY_MARKER}\nProyecto aun no resuelto. Ya se solicito una aclaracion; no repitas la pregunta. Espera una respuesta inequívoca entre: ${candidates}. No ejecutes operaciones protegidas.`;
  }
  if (pending?.kind === "conflict") {
    return `${PROJECT_AFFINITY_MARKER}\nAfinidad de proyecto en conflicto. Pregunta UNA sola vez si debe conservarse ${record?.canonicalKey} o cambiar explicitamente a ${pending.target}. No ejecutes operaciones protegidas hasta resolverlo.`;
  }
  return `${PROJECT_AFFINITY_MARKER}\nProyecto ambiguo. Pregunta UNA sola vez cual proyecto usar entre: ${candidates}. La respuesta fijara la afinidad de esta sesion. No pidas claves tecnicas ni ejecutes operaciones protegidas antes de resolverlo.`;
}

function promptText(input: Record<string, unknown>): string {
  const prompt = isRecord(input.prompt) ? input.prompt : undefined;
  return [stringValue(prompt?.text), stringValue(input.text), stringValue(input.message)].filter(Boolean).join("\n");
}

function promptPaths(input: Record<string, unknown>): string[] {
  const output: string[] = [];
  collectPaths(input.prompt, output, 0);
  collectPaths(input.files, output, 0);
  collectPaths(input.attachments, output, 0);
  return [...new Set(output)];
}

function collectPaths(value: unknown, output: string[], depth: number): void {
  if (depth > 4 || output.length > 100) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPaths(item, output, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (["path", "filePath", "file_path", "directory", "cwd", "workdir", "uri"].includes(key) && typeof item === "string") {
      output.push(item);
    } else if (typeof item === "object") collectPaths(item, output, depth + 1);
  }
}

function normalizedPath(value: string, base: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let plain = trimmed;
  if (trimmed.startsWith("file:")) {
    try {
      plain = fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  if (!path.isAbsolute(plain) && !plain.includes("/") && !plain.includes("\\")) return undefined;
  return path.resolve(base, plain);
}

function resolved(project: RegisteredProject): ResolvedSessionProject {
  return { canonicalKey: project.canonicalKey, root: project.roots[0]! };
}

function findProject(projects: RegisteredProject[], canonicalKey: string): RegisteredProject | undefined {
  return projects.find((project) => project.canonicalKey === canonicalKey);
}

function explicitSwitch(text: string): boolean {
  return /\b(cambia|cambiar|usa|usar|vincula|vincular|asigna|asignar|switch)\b/i.test(text);
}

function affirmative(text: string): boolean {
  return /^(?:si|sí|yes|confirmo|de acuerdo)[.!\s]*$/i.test(text.trim());
}

function appendSystemText(system: unknown[], text: string): void {
  const last = system.at(-1);
  if (isTextPart(last)) last.text = `${last.text}\n\n${text}`;
  else system.push({ type: "text", text });
}

function inside(value: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function timestamp(options: ProjectAffinityOptions): string {
  return new Date((options.now ?? Date.now)()).toISOString();
}

function validSessionID(value: string): boolean {
  return /^ses[A-Za-z0-9_-]{1,128}$/.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
