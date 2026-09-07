import fs from "node:fs";
import path from "node:path";

import type { ProjectAliases } from "./project";
import { type MalahorPaths, resolvePaths } from "./paths";
import { stripJsonComments } from "./injector";

export type MalahorMode = "assistant" | "executor";
export type MalahorIntervention = "ejecutar" | "guiar" | "acompanar";

export interface MalahorExecutionPolicy {
  intervention: MalahorIntervention;
  verification: boolean;
}

export interface MalahorConfig {
  mode: MalahorMode;
  paths: MalahorPaths;
  execution: MalahorExecutionPolicy;
  projects: {
    aliases: ProjectAliases;
  };
}

interface ConfigFile {
  mode?: unknown;
  execution?: unknown;
  projects?: unknown;
  paths?: unknown;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): MalahorConfig {
  const defaultPaths = resolvePaths(env, cwd);
  const fileConfig = readConfigFile(defaultPaths.configFile);
  const executionConfig = readOptionalObject(fileConfig.execution, "execution");
  const projectsConfig = readOptionalObject(fileConfig.projects, "projects");
  const paths = resolvePaths({ ...resolvePathEnv(env, fileConfig), MALAHOR_CONFIG: defaultPaths.configFile }, cwd);

  return {
    mode: resolveMode(env.MALAHOR_MODE ?? fileConfig.mode),
    paths,
    execution: resolveExecutionPolicy(env, executionConfig),
    projects: {
      aliases: readProjectAliases(projectsConfig?.aliases),
    },
  };
}

export function resolveMode(value: unknown = process.env.MALAHOR_MODE): MalahorMode {
  if (value === undefined || value === null || value === "") {
    return "assistant";
  }

  if (value === "assistant" || value === "executor") {
    return value;
  }

  throw new Error(`Modo Malahor invalido: ${String(value)}. Usa "assistant" o "executor".`);
}

export function formatExecutionPolicy(value: MalahorExecutionPolicy): string {
  return `${value.intervention}, verification=${value.verification ? "enabled" : "disabled"}`;
}

export function saveExecutionPolicy(config: MalahorConfig, dryRun: boolean): boolean {
  const current = readConfigFile(config.paths.configFile);
  const next: ConfigFile = {
    ...current,
    mode: current.mode ?? config.mode,
    execution: config.execution,
  };

  if (!dryRun) {
    fs.mkdirSync(path.dirname(config.paths.configFile), { recursive: true });
    fs.writeFileSync(config.paths.configFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return true;
}

function readConfigFile(filePath: string): ConfigFile {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ConfigFile;
    }
  } catch (error) {
    throw new Error(`No se pudo leer ${filePath}: ${(error as Error).message}`);
  }

  throw new Error(`La configuracion ${filePath} no contiene un objeto JSON valido.`);
}

function resolvePathEnv(env: NodeJS.ProcessEnv, config: ConfigFile): NodeJS.ProcessEnv {
  const pathConfig = readOptionalObject(config.paths, "paths");

  return {
    ...env,
    MALAHOR_HOME: env.MALAHOR_HOME ?? readOptionalString(pathConfig?.malahorHome, "paths.malahorHome"),
    MALAHOR_OPENCODE_DIR: env.MALAHOR_OPENCODE_DIR ?? readOptionalString(pathConfig?.opencodeDir, "paths.opencodeDir"),
  };
}

function resolveExecutionPolicy(env: NodeJS.ProcessEnv, config: Record<string, unknown> | undefined): MalahorExecutionPolicy {
  const intervention = readIntervention(
    env.MALAHOR_EXECUTION_INTERVENTION ?? config?.intervention,
    "execution.intervention",
  );
  const verification = readOptionalBoolean(
    env.MALAHOR_EXECUTION_VERIFICATION ?? config?.verification,
    "execution.verification",
  );

  return {
    intervention,
    verification: intervention === "acompanar" ? false : verification ?? true,
  };
}

function readIntervention(value: unknown, key: string): MalahorIntervention {
  if (value === undefined || value === null || value === "") {
    return "guiar";
  }

  if (value === "ejecutar" || value === "guiar" || value === "acompanar") {
    return value;
  }

  throw new Error(`La configuracion ${key} debe ser "ejecutar", "guiar" o "acompanar".`);
}

function readProjectAliases(value: unknown): ProjectAliases {
  if (value === undefined || value === null) {
    return {};
  }

  const aliases = readOptionalObject(value, "projects.aliases") ?? {};
  const result: ProjectAliases = {};

  for (const [canonical, rawAliases] of Object.entries(aliases)) {
    const parsedAliases = readStringList(rawAliases, `projects.aliases.${canonical}`);
    if (canonical.trim() && parsedAliases.length > 0) {
      result[canonical.trim()] = parsedAliases;
    }
  }

  return result;
}

function readOptionalObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`La configuracion ${key} debe ser un objeto.`);
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`La configuracion ${key} debe ser un string.`);
}

function readStringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`La configuracion ${key} debe ser una lista de strings.`);
  }

  return value.map((item, index) => readOptionalString(item, `${key}.${index}`)).filter((item): item is string => Boolean(item));
}

function readOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") return true;
  if (value === "false") return false;

  throw new Error(`La configuracion ${key} debe ser boolean.`);
}
