import fs from "node:fs";
import path from "node:path";

import { backupFile, type BackupResult } from "./backup";
import type { OpenCodeHostKind } from "./detector";
import type { MalahorPaths } from "./paths";

// Los agentes se crean con archivos Markdown porque la API V2 de agentes no
// expone `add` en su editor: el plugin puede leer/actualizar/eliminar, no crear.
// El marcador va como comentario YAML para no contaminar el system prompt.
export const MALAHOR_AGENT_FILE = "malahor.md";
export const MALAHOR_AGENT_MARKER = "# malahor-managed";

export const MALAHOR_AGENT_IDS = ["malahor", "malahor-diagnostico", "malahor-testing"] as const;

export type MalahorAgentId = (typeof MALAHOR_AGENT_IDS)[number];

export const MALAHOR_AGENTS: Record<
  MalahorAgentId,
  { label: string; mode: "primary" | "subagent" }
> = {
  malahor: { label: "Agente malahor", mode: "primary" },
  "malahor-diagnostico": { label: "Subagente malahor-diagnostico", mode: "subagent" },
  "malahor-testing": { label: "Subagente malahor-testing", mode: "subagent" },
};

export type AgentState = "managed" | "foreign" | "missing";

export type AgentSyncAction =
  | "created"
  | "refreshed"
  | "unchanged"
  | "kept-foreign"
  | "skipped-unknown-host";

export interface AgentSyncResult {
  agent: MalahorAgentId;
  action: AgentSyncAction;
  host: OpenCodeHostKind;
  source: string | null;
  destination: string;
  backup: BackupResult | null;
}

export interface AgentRemovalResult {
  agent: MalahorAgentId;
  state: AgentState;
  destination: string;
  backup: BackupResult | null;
  removed: boolean;
}

export interface AgentContract {
  mode: string | null;
  delegationDenyAll: boolean;
  delegationAllowManaged: boolean;
  questionAllowed: boolean;
  editDenyAll: boolean;
  shellDenyAll: boolean;
  hasEditAllow: boolean;
  hasShellAllow: boolean;
}

interface V2Rule {
  action: string;
  resource: string;
  effect: string;
}

interface V1Rule {
  pattern: string;
  effect: string;
}

interface V1Block {
  scalar: string | null;
  rules: V1Rule[];
}

export function agentFileName(agentId: MalahorAgentId): string {
  return `${agentId}.md`;
}

export function malahorAgentPath(paths: MalahorPaths, agentId: MalahorAgentId = "malahor"): string {
  return path.join(paths.opencodeDir, "agents", agentFileName(agentId));
}

export function malahorAgentAssetPath(
  assetsDir: string,
  host: OpenCodeHostKind,
  agentId: MalahorAgentId = "malahor",
): string | null {
  if (host === "unknown") return null;
  return path.join(assetsDir, "opencode", "agents", host, agentFileName(agentId));
}

export function agentState(filePath: string): AgentState {
  if (!fs.existsSync(filePath)) return "missing";

  try {
    return fs.readFileSync(filePath, "utf8").includes(MALAHOR_AGENT_MARKER) ? "managed" : "foreign";
  } catch {
    return "foreign";
  }
}

export function assertAgentAssets(assetsDir: string, host: OpenCodeHostKind): void {
  if (host === "unknown") return;

  const missing = MALAHOR_AGENT_IDS
    .map((agentId) => malahorAgentAssetPath(assetsDir, host, agentId))
    .filter((source): source is string => source !== null && !fs.existsSync(source));

  if (missing.length > 0) {
    throw new Error(`No existen assets de agente ${host}: ${missing.join(", ")}`);
  }
}

export function syncManagedAgent(
  assetsDir: string,
  paths: MalahorPaths,
  host: OpenCodeHostKind,
  dryRun: boolean,
  agentId: MalahorAgentId = "malahor",
): AgentSyncResult {
  const destination = malahorAgentPath(paths, agentId);
  const source = malahorAgentAssetPath(assetsDir, host, agentId);

  // No se adivina el formato: un frontmatter V2 en V1 (o al reves) ignora las
  // reglas de delegacion y dejaria al primario sin el contrato esperado.
  if (!source) {
    return {
      agent: agentId,
      action: "skipped-unknown-host",
      host,
      source: null,
      destination,
      backup: null,
    };
  }

  if (!fs.existsSync(source)) {
    throw new Error(`No existe asset de agente ${agentId} (${host}): ${source}`);
  }

  const assetContent = fs.readFileSync(source, "utf8");
  const state = agentState(destination);

  if (state === "foreign") {
    return { agent: agentId, action: "kept-foreign", host, source, destination, backup: null };
  }

  if (state === "managed" && fs.readFileSync(destination, "utf8") === assetContent) {
    return { agent: agentId, action: "unchanged", host, source, destination, backup: null };
  }

  const backup = state === "managed" ? backupFile(destination, paths.backupsDir, dryRun) : null;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  return {
    agent: agentId,
    action: state === "managed" ? "refreshed" : "created",
    host,
    source,
    destination,
    backup,
  };
}

export function syncManagedAgents(
  assetsDir: string,
  paths: MalahorPaths,
  host: OpenCodeHostKind,
  dryRun: boolean,
): AgentSyncResult[] {
  // Comprobar todos los assets antes de escribir evita dejar una instalacion a
  // medias si falta el asset de uno de los especialistas.
  assertAgentAssets(assetsDir, host);
  return MALAHOR_AGENT_IDS.map((agentId) =>
    syncManagedAgent(assetsDir, paths, host, dryRun, agentId),
  );
}

export function describeAgentSync(result: AgentSyncResult, dryRun: boolean): string {
  const label = MALAHOR_AGENTS[result.agent].label;

  switch (result.action) {
    case "created":
      return `${label}: ${dryRun ? "would install" : "installed"} (${result.host})`;
    case "refreshed":
      return `${label}: ${dryRun ? "would refresh" : "refreshed"} (${result.host})`;
    case "unchanged":
      return `${label}: up to date`;
    case "kept-foreign":
      return `${label}: kept (no gestionado por Malahor; no se toca)`;
    case "skipped-unknown-host":
      return `${label}: skipped (OpenCode host desconocido; no se adivina V1/V2)`;
  }
}

export function removeManagedAgent(
  paths: MalahorPaths,
  dryRun: boolean,
  agentId: MalahorAgentId = "malahor",
): AgentRemovalResult {
  const destination = malahorAgentPath(paths, agentId);
  const state = agentState(destination);

  if (state !== "managed") {
    return { agent: agentId, state, destination, backup: null, removed: false };
  }

  const backup = backupFile(destination, paths.backupsDir, dryRun);

  if (!dryRun) {
    fs.unlinkSync(destination);
    removeEmptyAgentsDir(paths);
  }

  return { agent: agentId, state, destination, backup, removed: true };
}

export function removeManagedAgents(paths: MalahorPaths, dryRun: boolean): AgentRemovalResult[] {
  return MALAHOR_AGENT_IDS.map((agentId) => removeManagedAgent(paths, dryRun, agentId));
}

export function describeAgentRemoval(result: AgentRemovalResult, dryRun: boolean): string {
  const label = MALAHOR_AGENTS[result.agent].label;

  if (result.removed) {
    return `${label}: ${dryRun ? "would remove" : "removed"}`;
  }

  return result.state === "foreign"
    ? `${label}: kept (no gestionado por Malahor; no se toca)`
    : `${label}: nothing to remove`;
}

// Verificacion de contrato acotada a nuestros assets. No sustituye al host:
// evita cerrar una instalacion con un agente sin el modo, la delegacion o el
// aislamiento de permisos que exige T-5.2.5.
export function readAgentContract(filePath: string): AgentContract {
  const content = fs.readFileSync(filePath, "utf8");
  return contractFromFrontmatter(extractFrontmatter(content));
}

export function agentContractProblems(
  filePath: string,
  agentId: MalahorAgentId = "malahor",
): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  const frontmatter = extractFrontmatter(content);
  const contract = contractFromFrontmatter(frontmatter);
  const problems: string[] = [];
  const expectedMode = MALAHOR_AGENTS[agentId].mode;

  if (contract.mode !== expectedMode) problems.push(`mode no es ${expectedMode}`);
  if (!contract.delegationDenyAll) problems.push("falta deny de delegacion");

  if (agentId === "malahor") {
    if (!contract.delegationAllowManaged) problems.push("falta allow de malahor-*");
    if (!contract.questionAllowed) problems.push("falta allow de question");
    return problems;
  }

  if (contract.delegationAllowManaged) problems.push("especialista no debe permitir malahor-*");
  if (contract.questionAllowed) problems.push("especialista no debe permitir question");
  if (!contract.editDenyAll) problems.push("falta deny de edit");
  if (!contract.shellDenyAll) problems.push("falta deny de shell");

  if (agentId === "malahor-diagnostico") {
    if (contract.hasEditAllow) problems.push("diagnostico no debe permitir edit");
    if (!contract.hasShellAllow) problems.push("falta allow de shell de verificacion");
  }

  if (agentId === "malahor-testing") {
    if (!contract.hasEditAllow) problems.push("falta allow acotado de edit");
    if (!contract.hasShellAllow) problems.push("falta allow de shell de tests");

    for (const glob of ["**/*.test.*", "**/__tests__/**", "**/tests/**"]) {
      if (!hasAllowedEditResource(frontmatter, glob)) {
        problems.push(`falta allow de edit para ${glob}`);
      }
    }
  }

  return problems;
}

function contractFromFrontmatter(frontmatter: string): AgentContract {
  const mode = /^mode:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? null;
  const v2 = parseV2Rules(frontmatter);
  const v1 = parseV1Permissions(frontmatter);

  const v2Has = (action: string, resource: string, effect: string): boolean =>
    v2.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect);

  const v1Has = (key: string, pattern: string, effect: string): boolean => {
    const block = v1.get(key);
    if (!block) return false;
    return block.scalar === effect
      || block.rules.some((rule) => rule.pattern === pattern && rule.effect === effect);
  };

  const v1AnyAllow = (key: string): boolean => {
    const block = v1.get(key);
    if (!block) return false;
    return block.scalar === "allow" || block.rules.some((rule) => rule.effect === "allow");
  };

  const v2AnyAllow = (action: string): boolean =>
    v2.some((rule) => rule.action === action && rule.effect === "allow");

  return {
    mode,
    delegationDenyAll: v2Has("subagent", "*", "deny") || v1Has("task", "*", "deny"),
    delegationAllowManaged:
      v2Has("subagent", "malahor-*", "allow") || v1Has("task", "malahor-*", "allow"),
    questionAllowed:
      v2Has("question", "*", "allow")
      || v1Has("question", "*", "allow")
      || v1.get("question")?.scalar === "allow",
    editDenyAll: v2Has("edit", "*", "deny") || v1Has("edit", "*", "deny"),
    shellDenyAll: v2Has("shell", "*", "deny") || v1Has("bash", "*", "deny"),
    hasEditAllow: v2AnyAllow("edit") || v1AnyAllow("edit"),
    hasShellAllow: v2AnyAllow("shell") || v1AnyAllow("bash"),
  };
}

function hasAllowedEditResource(frontmatter: string, glob: string): boolean {
  const v2 = parseV2Rules(frontmatter);
  if (v2.some((rule) => rule.action === "edit" && rule.resource === glob && rule.effect === "allow")) {
    return true;
  }

  const block = parseV1Permissions(frontmatter).get("edit");
  return block?.rules.some((rule) => rule.pattern === glob && rule.effect === "allow") ?? false;
}

function parseV2Rules(frontmatter: string): V2Rule[] {
  const rules: V2Rule[] = [];
  let current: Partial<V2Rule> | null = null;
  let inPermissions = false;
  let permissionsIndent = 0;

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (/^permissions:\s*$/.test(trimmed)) {
      inPermissions = true;
      permissionsIndent = indent;
      current = null;
      continue;
    }

    if (!inPermissions) continue;

    if (indent <= permissionsIndent) {
      inPermissions = false;
      current = null;
      continue;
    }

    if (trimmed.startsWith("- action:")) {
      if (current) rules.push(finishV2Rule(current));
      current = { action: parseScalar(trimmed.slice("- action:".length)) };
      continue;
    }

    if (!current) continue;

    if (trimmed.startsWith("resource:")) {
      current.resource = parseScalar(trimmed.slice("resource:".length));
    } else if (trimmed.startsWith("effect:")) {
      current.effect = parseScalar(trimmed.slice("effect:".length));
    }
  }

  if (current) rules.push(finishV2Rule(current));
  return rules;
}

function parseV1Permissions(frontmatter: string): Map<string, V1Block> {
  const blocks = new Map<string, V1Block>();
  let inPermission = false;
  let permissionIndent = 0;
  let currentKey: string | null = null;
  let currentIndent = 0;

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (/^permission:\s*$/.test(trimmed)) {
      inPermission = true;
      permissionIndent = indent;
      currentKey = null;
      continue;
    }

    if (!inPermission) continue;

    if (indent <= permissionIndent) {
      inPermission = false;
      currentKey = null;
      continue;
    }

    const keyMatch = /^([A-Za-z_][\w-]*):(?:\s*(.*))?$/.exec(trimmed);
    if (keyMatch && indent === permissionIndent + 2) {
      currentKey = keyMatch[1];
      currentIndent = indent;
      const block = blocks.get(currentKey) ?? { scalar: null, rules: [] };
      const value = keyMatch[2]?.trim();
      if (value) block.scalar = parseScalar(value);
      blocks.set(currentKey, block);
      continue;
    }

    const ruleMatch = /^["']?(.+?)["']?:\s*(allow|ask|deny)\s*$/.exec(trimmed);
    if (currentKey && ruleMatch && indent > currentIndent) {
      const block = blocks.get(currentKey) ?? { scalar: null, rules: [] };
      block.rules.push({ pattern: ruleMatch[1], effect: ruleMatch[2] });
      blocks.set(currentKey, block);
    }
  }

  return blocks;
}

function finishV2Rule(rule: Partial<V2Rule>): V2Rule {
  return {
    action: rule.action ?? "",
    resource: rule.resource ?? "",
    effect: rule.effect ?? "",
  };
}

function parseScalar(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function removeEmptyAgentsDir(paths: MalahorPaths): void {
  const directory = path.dirname(malahorAgentPath(paths));

  try {
    if (fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
  } catch {
    // El retiro del archivo ya se hizo; un directorio vacio no es un fallo.
  }
}

function extractFrontmatter(content: string): string {
  if (!content.startsWith("---")) return "";

  const end = content.indexOf("\n---", 3);
  return end === -1 ? "" : content.slice(3, end);
}
