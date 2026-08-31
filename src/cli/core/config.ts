import fs from "node:fs";

import { type MalahorPaths, resolvePaths } from "./paths";
import { stripJsonComments } from "./injector";

export type MalahorMode = "assistant" | "executor";

export interface MalahorConfig {
  mode: MalahorMode;
  paths: MalahorPaths;
}

interface ConfigFile {
  mode?: unknown;
  paths?: {
    malahorHome?: unknown;
    opencodeDir?: unknown;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): MalahorConfig {
  const defaultPaths = resolvePaths(env, cwd);
  const fileConfig = readConfigFile(defaultPaths.configFile);
  const paths = resolvePaths({ ...resolvePathEnv(env, fileConfig), MALAHOR_CONFIG: defaultPaths.configFile }, cwd);

  return {
    mode: resolveMode(env.MALAHOR_MODE ?? fileConfig.mode),
    paths,
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
  const pathConfig = typeof config.paths === "object" && config.paths !== null ? config.paths : undefined;

  return {
    ...env,
    MALAHOR_HOME: env.MALAHOR_HOME ?? readOptionalString(pathConfig?.malahorHome, "paths.malahorHome"),
    MALAHOR_OPENCODE_DIR: env.MALAHOR_OPENCODE_DIR ?? readOptionalString(pathConfig?.opencodeDir, "paths.opencodeDir"),
  };
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
