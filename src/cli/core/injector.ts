import fs from "node:fs";
import path from "node:path";
import type { MalahorExecutionPolicy, MalahorIntervention } from "./config";
import { stripJsonComments } from "./jsonc";
import type { MalahorPaths } from "./paths";

export { stripJsonComments } from "./jsonc";

export const MALAHOR_POLICY_FORMAT = 2;

// Whitelist agent-safe para `guiar`: nunca cierra la ruta de reparacion.
// Reglas OpenCode: ultima coincidencia gana; el comodin "*" va primero.
export const GUIAR_BASH_POLICY: Record<string, string> = {
  "*": "deny",
  "malahor-ai doctor*": "allow",
  "malahor-ai context*": "allow",
  "malahor-ai graphify*": "allow",
  "bun run src/cli/index.ts doctor*": "allow",
  "bun run src/cli/index.ts context*": "allow",
  "bun run src/cli/index.ts graphify*": "allow",
  "git status*": "allow",
  "git log*": "allow",
  "git diff*": "allow",
  "malahor-ai install*": "ask",
  "malahor-ai update*": "ask",
  "malahor-ai memory*": "ask",
  "malahor-ai obsidian*": "ask",
  "npx --yes malahor-ai*": "ask",
  "bun run src/cli/index.ts install*": "ask",
  "bun run src/cli/index.ts update*": "ask",
  "bun run src/cli/index.ts memory*": "ask",
  "bun run src/cli/index.ts obsidian*": "ask",
};

// Whitelist minima para `acompanar`: sin verificacion libre, pero con escape de reparacion.
export const ACOMPANAR_BASH_POLICY: Record<string, string> = {
  "*": "deny",
  "malahor-ai doctor*": "allow",
  "malahor-ai context*": "allow",
  "npx --yes malahor-ai doctor*": "allow",
  "malahor-ai install*": "ask",
  "malahor-ai update*": "ask",
};

export interface SyncOpenCodeConfigOptions {
  execution: MalahorExecutionPolicy;
  applyPolicy?: boolean;
  manageMcp?: boolean;
  verifyOnly?: boolean;
}

export interface OpenCodeConfig {
  [key: string]: unknown;
  mcp?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  compaction?: Record<string, unknown>;
}

interface OpenCodeAgentConfig extends Record<string, unknown> {
  permission?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export function syncOpenCodeConfig(paths: MalahorPaths, options: SyncOpenCodeConfigOptions, dryRun: boolean): OpenCodeConfig {
  const current = readOpenCodeConfig(paths.opencodeConfig);
  const next: OpenCodeConfig = {
    ...current,
    compaction: syncCompaction(asRecord(current.compaction)),
  };

  if (options.manageMcp !== false) {
    next.mcp = {
      ...(current.mcp ?? {}),
      mnemo: {
        type: "local",
        command: ["node", paths.mnemoIndex],
        enabled: true,
      },
    };
  }

  const syncedAgents = syncAgents(asRecord(current.agent), options);
  if (syncedAgents) {
    next.agent = syncedAgents;
  }

  if (!dryRun && options.verifyOnly !== true) {
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

export interface RemoveBuildPolicyResult {
  removed: boolean;
  cleaned: string[];
}

// Uninstall debe dejar el agente como estaba: quita los bloqueos y el marcador que escribio Malahor.
export function removeBuildPolicyConfig(paths: MalahorPaths, dryRun: boolean): RemoveBuildPolicyResult {
  const cleaned: string[] = [];
  const current = readOpenCodeConfig(paths.opencodeConfig);
  const agent = asRecord(current.agent);
  const build = agent ? asRecord(agent.build) : undefined;

  if (!build) {
    return { removed: false, cleaned };
  }

  if (!malahorOptions(build)) {
    return { removed: false, cleaned };
  }

  const nextBuild: OpenCodeAgentConfig = { ...build };
  const permission = { ...(asRecord(nextBuild.permission) ?? {}) };

  if (permission.edit === "deny") {
    delete permission.edit;
    cleaned.push("permission.edit");
  }
  if (permission.task === "deny") {
    delete permission.task;
    cleaned.push("permission.task");
  }
  if (permission.bash === "deny" || isMalahorBashPolicy(permission.bash)) {
    delete permission.bash;
    cleaned.push("permission.bash");
  }

  if (Object.keys(permission).length > 0) {
    nextBuild.permission = permission;
  } else {
    delete nextBuild.permission;
  }

  const options = { ...(asRecord(nextBuild.options) ?? {}) };
  if (options.malahor !== undefined) {
    delete options.malahor;
    cleaned.push("options.malahor");
  }
  if (Object.keys(options).length > 0) {
    nextBuild.options = options;
  } else {
    delete nextBuild.options;
  }

  const nextAgent = { ...agent } as Record<string, unknown>;
  if (Object.keys(nextBuild).length > 0) {
    nextAgent.build = nextBuild;
  } else {
    delete nextAgent.build;
  }

  const next: OpenCodeConfig = { ...current };
  if (Object.keys(nextAgent).length > 0) {
    next.agent = nextAgent;
  } else {
    delete next.agent;
  }

  if (!dryRun && fs.existsSync(paths.opencodeConfig)) {
    fs.writeFileSync(paths.opencodeConfig, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return { removed: true, cleaned };
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

export function isMalahorBashPolicy(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (record["*"] !== "deny") return false;

  return Object.keys(record).some((key) => key.startsWith("malahor-ai ") || key.startsWith("bun run src/cli/index.ts ") || key.startsWith("npx --yes malahor-ai"));
}

export function expectedBashPolicy(intervention: MalahorIntervention): Record<string, string> | undefined {
  if (intervention === "guiar") return GUIAR_BASH_POLICY;
  if (intervention === "acompanar") return ACOMPANAR_BASH_POLICY;
  return undefined;
}

function syncAgents(current: Record<string, unknown> | undefined, options: SyncOpenCodeConfigOptions): Record<string, unknown> | undefined {
  const next = { ...(current ?? {}) };
  next.build = applyBuildAgentConfig(asAgentConfig(current?.build), options.execution, options.applyPolicy ?? true);

  return next;
}

function syncCompaction(current: Record<string, unknown> | undefined): Record<string, unknown> {
  const keep = asRecord(current?.keep);
  const keepTokens = typeof keep?.tokens === "number" ? keep.tokens : 15000;
  const buffer = typeof current?.buffer === "number" ? current.buffer : 25000;

  return {
    ...(current ?? {}),
    auto: typeof current?.auto === "boolean" ? current.auto : true,
    keep: {
      ...(keep ?? {}),
      tokens: keepTokens,
    },
    buffer,
  };
}

function applyBuildAgentConfig(current: OpenCodeAgentConfig | undefined, execution: MalahorExecutionPolicy, applyPolicy: boolean): OpenCodeAgentConfig {
  const next = { ...(current ?? {}) };

  if (applyPolicy) {
    const permission = { ...(asRecord(next.permission) ?? {}) };

    if (execution.intervention === "ejecutar") {
      // Sin bloqueos: remover edit/task que Malahor escribe. La whitelist bash
      // legacy se conserva hasta T-5.1.7; ya no es la fuente de verdad.
      if (permission.edit === "deny") delete permission.edit;
      if (permission.task === "deny") delete permission.task;

      if (Object.keys(permission).length > 0) {
        next.permission = permission;
      } else {
        delete next.permission;
      }
    } else {
      // La autorizacion real vive en el motor de hooks/plugin. No escribimos
      // permission.bash: la whitelist legacy existente se reporta, no se borra.
      next.permission = {
        ...permission,
        edit: "deny",
        task: "deny",
      };
    }
  }

  next.options = {
    ...(asRecord(next.options) ?? {}),
    malahor: {
      ...(malahorOptions(next) ?? {}),
      execution,
      policyFormat: MALAHOR_POLICY_FORMAT,
    },
  };

  return next;
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
