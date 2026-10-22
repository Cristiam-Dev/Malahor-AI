import fs from "node:fs";
import path from "node:path";

import { backupFile, type BackupResult } from "./backup";
import type { OpenCodeHostKind } from "./detector";
import type { MalahorPaths } from "./paths";

// El agente se crea con un archivo Markdown porque la API V2 de agentes no
// expone `add` en su editor: el plugin puede leer/actualizar/eliminar, no crear.
// El marcador va como comentario YAML para no contaminar el system prompt.
export const MALAHOR_AGENT_FILE = "malahor.md";
export const MALAHOR_AGENT_MARKER = "# malahor-managed";

export type AgentState = "managed" | "foreign" | "missing";

export type AgentSyncAction =
  | "created"
  | "refreshed"
  | "unchanged"
  | "kept-foreign"
  | "skipped-unknown-host";

export interface AgentSyncResult {
  action: AgentSyncAction;
  host: OpenCodeHostKind;
  source: string | null;
  destination: string;
  backup: BackupResult | null;
}

export interface AgentRemovalResult {
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
}

export function malahorAgentPath(paths: MalahorPaths): string {
  return path.join(paths.opencodeDir, "agents", MALAHOR_AGENT_FILE);
}

export function malahorAgentAssetPath(assetsDir: string, host: OpenCodeHostKind): string | null {
  if (host === "unknown") return null;
  return path.join(assetsDir, "opencode", "agents", host, MALAHOR_AGENT_FILE);
}

export function agentState(filePath: string): AgentState {
  if (!fs.existsSync(filePath)) return "missing";

  try {
    return fs.readFileSync(filePath, "utf8").includes(MALAHOR_AGENT_MARKER) ? "managed" : "foreign";
  } catch {
    return "foreign";
  }
}

export function syncManagedAgent(
  assetsDir: string,
  paths: MalahorPaths,
  host: OpenCodeHostKind,
  dryRun: boolean,
): AgentSyncResult {
  const destination = malahorAgentPath(paths);
  const source = malahorAgentAssetPath(assetsDir, host);

  // No se adivina el formato: un frontmatter V2 en V1 (o al reves) ignora las
  // reglas de delegacion y dejaria al primario sin el contrato esperado.
  if (!source) {
    return { action: "skipped-unknown-host", host, source: null, destination, backup: null };
  }

  if (!fs.existsSync(source)) {
    throw new Error(`No existe asset de agente ${host}: ${source}`);
  }

  const assetContent = fs.readFileSync(source, "utf8");
  const state = agentState(destination);

  if (state === "foreign") {
    return { action: "kept-foreign", host, source, destination, backup: null };
  }

  if (state === "managed" && fs.readFileSync(destination, "utf8") === assetContent) {
    return { action: "unchanged", host, source, destination, backup: null };
  }

  const backup = state === "managed" ? backupFile(destination, paths.backupsDir, dryRun) : null;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  return {
    action: state === "managed" ? "refreshed" : "created",
    host,
    source,
    destination,
    backup,
  };
}

export function describeAgentSync(result: AgentSyncResult, dryRun: boolean): string {
  switch (result.action) {
    case "created":
      return `Agente malahor: ${dryRun ? "would install" : "installed"} (${result.host})`;
    case "refreshed":
      return `Agente malahor: ${dryRun ? "would refresh" : "refreshed"} (${result.host})`;
    case "unchanged":
      return "Agente malahor: up to date";
    case "kept-foreign":
      return "Agente malahor: kept (no gestionado por Malahor; no se toca)";
    case "skipped-unknown-host":
      return "Agente malahor: skipped (OpenCode host desconocido; no se adivina V1/V2)";
  }
}

export function removeManagedAgent(paths: MalahorPaths, dryRun: boolean): AgentRemovalResult {
  const destination = malahorAgentPath(paths);
  const state = agentState(destination);

  if (state !== "managed") {
    return { state, destination, backup: null, removed: false };
  }

  const backup = backupFile(destination, paths.backupsDir, dryRun);

  if (!dryRun) {
    fs.unlinkSync(destination);
    removeEmptyAgentsDir(paths);
  }

  return { state, destination, backup, removed: true };
}

export function describeAgentRemoval(result: AgentRemovalResult, dryRun: boolean): string {
  if (result.removed) {
    return `Agente malahor: ${dryRun ? "would remove" : "removed"}`;
  }

  return result.state === "foreign"
    ? "Agente malahor: kept (no gestionado por Malahor; no se toca)"
    : "Agente malahor: nothing to remove";
}

// Verificacion de contrato acotada a nuestros assets. No sustituye al host:
// evita cerrar una instalacion con un agente sin modo primario o sin la
// restriccion de delegacion que exige T-5.2.5.
export function readAgentContract(filePath: string): AgentContract {
  const content = fs.readFileSync(filePath, "utf8");
  const frontmatter = extractFrontmatter(content);
  const mode = /^mode:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? null;

  const delegationDenyAll =
    /action:\s*subagent\s+resource:\s*["']?\*["']?\s+effect:\s*deny/.test(frontmatter)
    || /task:\s+["']?\*["']?:\s*deny/.test(frontmatter);
  const delegationAllowManaged =
    /action:\s*subagent\s+resource:\s*["']?malahor-\*["']?\s+effect:\s*allow/.test(frontmatter)
    || /["']?malahor-\*["']?:\s*allow/.test(frontmatter);
  const questionAllowed =
    /action:\s*question\s+resource:\s*["']?\*["']?\s+effect:\s*allow/.test(frontmatter)
    || /question:\s*allow/.test(frontmatter);

  return { mode, delegationDenyAll, delegationAllowManaged, questionAllowed };
}

export function agentContractProblems(filePath: string): string[] {
  const problems: string[] = [];
  const contract = readAgentContract(filePath);

  if (contract.mode !== "primary") problems.push("mode no es primary");
  if (!contract.delegationDenyAll) problems.push("falta deny de delegacion");
  if (!contract.delegationAllowManaged) problems.push("falta allow de malahor-*");
  if (!contract.questionAllowed) problems.push("falta allow de question");

  return problems;
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
