import fs from "node:fs";

import { type MalahorPaths, resolvePaths } from "./paths";
import { stripJsonComments } from "./injector";

export type MalahorMode = "assistant" | "executor";
export type MalahorBuildAutonomy = "advise" | "execute";

export interface MalahorModelSelection {
  model: string;
  variant?: string;
}

export interface MalahorConfig {
  mode: MalahorMode;
  paths: MalahorPaths;
  models: {
    planning?: MalahorModelSelection;
    execution?: MalahorModelSelection;
  };
  autonomy: {
    build?: MalahorBuildAutonomy;
  };
}

interface ConfigFile {
  mode?: unknown;
  models?: unknown;
  autonomy?: unknown;
  paths?: unknown;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): MalahorConfig {
  const defaultPaths = resolvePaths(env, cwd);
  const fileConfig = readConfigFile(defaultPaths.configFile);
  const modelsConfig = readOptionalObject(fileConfig.models, "models");
  const autonomyConfig = readOptionalObject(fileConfig.autonomy, "autonomy");
  const paths = resolvePaths({ ...resolvePathEnv(env, fileConfig), MALAHOR_CONFIG: defaultPaths.configFile }, cwd);

  return {
    mode: resolveMode(env.MALAHOR_MODE ?? fileConfig.mode),
    paths,
    models: {
      planning: readModelSelection(modelsConfig?.planning, "models.planning"),
      execution: readModelSelection(modelsConfig?.execution, "models.execution"),
    },
    autonomy: {
      build: readBuildAutonomy(autonomyConfig?.build),
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

export function formatModelSelection(value?: MalahorModelSelection): string {
  if (!value) return "not configured";
  return value.variant ? `${value.model} (${value.variant})` : value.model;
}

export function formatBuildAutonomy(value?: MalahorBuildAutonomy): string {
  return value ?? "not configured";
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

function readBuildAutonomy(value: unknown): MalahorBuildAutonomy | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "advise" || value === "execute") {
    return value;
  }

  throw new Error(`La configuracion autonomy.build debe ser "advise" o "execute".`);
}

function readModelSelection(value: unknown, key: string): MalahorModelSelection | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "string") {
    return { model: value };
  }

  const config = readOptionalObject(value, key);
  if (!config) return undefined;

  const model = readRequiredString(config.model, `${key}.model`);
  const variant = readOptionalString(config.variant, `${key}.variant`);

  return variant ? { model, variant } : { model };
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

function readRequiredString(value: unknown, key: string): string {
  const parsed = readOptionalString(value, key);
  if (parsed) return parsed;
  throw new Error(`La configuracion ${key} es obligatoria.`);
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
