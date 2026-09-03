import fs from "node:fs";
import path from "node:path";
import type { MalahorPaths } from "./paths";

export type OpenCodeBuildAutonomy = "advise" | "execute";

export interface OpenCodeModelSelection {
  model: string;
  variant?: string;
}

export interface SyncOpenCodeConfigOptions {
  planningModel?: OpenCodeModelSelection;
  executionModel?: OpenCodeModelSelection;
  buildAutonomy?: OpenCodeBuildAutonomy;
}

export interface OpenCodeConfig {
  [key: string]: unknown;
  mcp?: Record<string, unknown>;
  agent?: Record<string, unknown>;
}

interface OpenCodeAgentConfig extends Record<string, unknown> {
  model?: string;
  variant?: string;
  permission?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export function syncOpenCodeConfig(paths: MalahorPaths, options: SyncOpenCodeConfigOptions, dryRun: boolean): OpenCodeConfig {
  const current = readOpenCodeConfig(paths.opencodeConfig);
  const next: OpenCodeConfig = {
    ...current,
    mcp: {
      ...(current.mcp ?? {}),
      mnemo: {
        type: "local",
        command: ["node", paths.mnemoIndex],
        enabled: true,
      },
    },
  };

  const syncedAgents = syncAgents(asRecord(current.agent), options);
  if (syncedAgents) {
    next.agent = syncedAgents;
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(paths.opencodeConfig), { recursive: true });
    fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return next;
}

export function removeMnemoConfig(paths: MalahorPaths, dryRun: boolean): OpenCodeConfig {
  const current = readOpenCodeConfig(paths.opencodeConfig);
  const next: OpenCodeConfig = { ...current };

  if (current.mcp) {
    const remainingMcp = { ...current.mcp };
    delete remainingMcp.mnemo;
    if (Object.keys(remainingMcp).length > 0) {
      next.mcp = remainingMcp;
    } else {
      delete next.mcp;
    }
  }

  if (!dryRun && fs.existsSync(paths.opencodeConfig)) {
    fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return next;
}

export function readOpenCodeConfig(filePath: string): OpenCodeConfig {
  if (!fs.existsSync(filePath)) {
    return { $schema: "https://opencode.ai/config.json" };
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return { $schema: "https://opencode.ai/config.json" };

  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as OpenCodeConfig;
    }
  } catch (error) {
    throw new Error(`No se pudo leer ${filePath}: ${(error as Error).message}`);
  }

  throw new Error(`La configuracion ${filePath} no contiene un objeto JSON valido.`);
}

function syncAgents(current: Record<string, unknown> | undefined, options: SyncOpenCodeConfigOptions): Record<string, unknown> | undefined {
  const next = { ...(current ?? {}) };
  let touched = current !== undefined;

  if (options.planningModel) {
    next.plan = applyModelSelection(asAgentConfig(current?.plan), options.planningModel);
    touched = true;
  }

  if (options.executionModel || options.buildAutonomy) {
    next.build = applyBuildAgentConfig(asAgentConfig(current?.build), options.executionModel, options.buildAutonomy);
    touched = true;
  }

  return touched ? next : undefined;
}

function applyBuildAgentConfig(
  current: OpenCodeAgentConfig | undefined,
  model: OpenCodeModelSelection | undefined,
  autonomy: OpenCodeBuildAutonomy | undefined,
): OpenCodeAgentConfig {
  const next = model ? applyModelSelection(current, model) : { ...(current ?? {}) };

  if (!autonomy) {
    return next;
  }

  if (autonomy === "advise") {
    next.permission = {
      ...(asRecord(next.permission) ?? {}),
      edit: "deny",
      bash: "deny",
      task: "deny",
    };
  } else if (currentBuildAutonomy(next) === "advise") {
    const permission = { ...(asRecord(next.permission) ?? {}) };

    if (permission.edit === "deny") delete permission.edit;
    if (permission.bash === "deny") delete permission.bash;
    if (permission.task === "deny") delete permission.task;

    if (Object.keys(permission).length > 0) {
      next.permission = permission;
    } else {
      delete next.permission;
    }
  }

  next.options = {
    ...(asRecord(next.options) ?? {}),
    malahor: {
      ...(malahorOptions(next) ?? {}),
      buildAutonomy: autonomy,
    },
  };

  return next;
}

function applyModelSelection(current: OpenCodeAgentConfig | undefined, model: OpenCodeModelSelection): OpenCodeAgentConfig {
  const next: OpenCodeAgentConfig = {
    ...(current ?? {}),
    model: model.model,
  };

  if (model.variant) {
    next.variant = model.variant;
  } else {
    delete next.variant;
  }

  return next;
}

function currentBuildAutonomy(agent: OpenCodeAgentConfig): OpenCodeBuildAutonomy | undefined {
  const value = malahorOptions(agent)?.buildAutonomy;
  return value === "advise" || value === "execute" ? value : undefined;
}

function malahorOptions(agent: OpenCodeAgentConfig): Record<string, unknown> | undefined {
  const options = asRecord(agent.options);
  return options ? asRecord(options.malahor) : undefined;
}

function asAgentConfig(value: unknown): OpenCodeAgentConfig | undefined {
  const object = asRecord(value);
  return object ? { ...object } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        output += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inString && current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (!inString && current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += current;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (current === "\\") {
      escaped = true;
      continue;
    }

    if (current === '"') {
      inString = !inString;
    }
  }

  return output;
}
