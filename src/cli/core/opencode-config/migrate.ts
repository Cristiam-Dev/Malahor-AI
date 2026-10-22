import path from "node:path";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import { isMalahorBashPolicy } from "../injector";
import type { MalahorPaths } from "../paths";
import { backupFile } from "../backup";
import { digest, replaceAtomically, snapshot, withConfigLock } from "./io";
import { nodeValue, readDocument } from "./jsonc";

export interface ConfigMigrationFinding {
  path: string;
  removable: boolean;
  reason: string;
}

export interface ConfigMigrationPlan {
  state: "missing" | "clean" | "ready" | "blocked";
  path: string;
  hash?: string;
  findings: ConfigMigrationFinding[];
  confirmation?: string;
  issue?: string;
}

export interface ConfigMigrationResult {
  removed: string[];
  backup: string | null;
}

const DEFAULT_COMPACTION = {
  auto: true,
  keep: { tokens: 15000 },
  buffer: 25000,
};

export function previewV2ConfigMigration(paths: MalahorPaths): ConfigMigrationPlan {
  const filePath = paths.opencodeConfig;
  const current = snapshot(filePath);
  if (!current) return { state: "missing", path: filePath, findings: [] };

  try {
    const findings = collectFindings(current.text, paths);
    const removable = findings.filter((finding) => finding.removable);
    const reviewOnly = findings.filter((finding) => !finding.removable);
    if (removable.length === 0) {
      return {
        state: reviewOnly.length > 0 ? "blocked" : "clean",
        path: filePath,
        hash: current.hash,
        findings,
        issue: reviewOnly.length > 0 ? "Hay entradas legacy que requieren revision manual; no se eliminan automaticamente." : undefined,
      };
    }

    const confirmation = `MIGRATE-V2:${digest(JSON.stringify({ hash: current.hash, paths: removable.map((finding) => finding.path) }))}`;
    return { state: "ready", path: filePath, hash: current.hash, findings, confirmation };
  } catch (error) {
    return {
      state: "blocked",
      path: filePath,
      findings: [],
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyV2ConfigMigration(paths: MalahorPaths, confirmation: string): ConfigMigrationResult {
  return withConfigLock(paths.opencodeDir, () => {
    const plan = previewV2ConfigMigration(paths);
    if (plan.state !== "ready" || !plan.confirmation || !plan.hash) {
      throw new Error(plan.issue ?? "No hay restos V2 de Malahor migrables.");
    }
    if (confirmation !== plan.confirmation) {
      throw new Error("El token de migracion no coincide con el estado actual; ejecuta `malahor-ai config migrate` de nuevo.");
    }

    const current = snapshot(plan.path);
    if (!current || current.hash !== plan.hash) {
      throw new Error("La configuracion cambio entre preview y aplicacion; no se escribio nada.");
    }

    const removable = plan.findings.filter((finding) => finding.removable).map((finding) => finding.path);
    const migrated = removePaths(current.text, removable);
    const backup = backupFile(plan.path, paths.backupsDir, false);
    const transactionID = `migrate-v2-${Date.now().toString(36)}`;
    replaceAtomically(plan.path, migrated, transactionID, current.mode);

    const after = snapshot(plan.path);
    if (!after || after.text !== migrated) {
      throw new Error("La verificacion posterior a la migracion fallo.");
    }

    return { removed: removable, backup: backup.destination };
  });
}

function collectFindings(raw: string, paths: MalahorPaths): ConfigMigrationFinding[] {
  const document = readDocument(raw);
  const value = nodeValue(document.root);
  if (!isRecord(value)) return [];

  const findings: ConfigMigrationFinding[] = [];
  const mcp = recordValue(value.mcp);
  const mnemo = mcp ? recordValue(mcp.mnemo) : undefined;
  if (isMalahorMnemo(mnemo, paths)) {
    findings.push({ path: "/mcp/mnemo", removable: true, reason: "MCP Mnemo legacy gestionado ahora por ctx.mcp.transform." });
  }

  const build = recordValue(recordValue(value.agent)?.build);
  const marker = recordValue(recordValue(build?.options)?.malahor);
  if (marker) {
    findings.push({ path: "/agent/build/options/malahor", removable: true, reason: "Marcador de política V2 legacy gestionado ahora por el plugin." });
    const permission = recordValue(build?.permission);
    if (permission?.edit === "deny") findings.push({ path: "/agent/build/permission/edit", removable: true, reason: "Bloqueo edit escrito por Malahor." });
    if (permission?.task === "deny") findings.push({ path: "/agent/build/permission/task", removable: true, reason: "Bloqueo task escrito por Malahor." });
    if (permission?.bash === "deny" || isMalahorBashPolicy(permission?.bash)) {
      findings.push({ path: "/agent/build/permission/bash", removable: true, reason: "Whitelist/bash legacy sustituida por hooks runtime." });
    }
  }

  const permission = recordValue(value.permission);
  if (permission && Object.keys(permission).length === 1 && permission.external_directory === "deny") {
    findings.push({
      path: "/permission",
      removable: true,
      reason: "Deny global legacy de external_directory generado por el setup antiguo de Obsidian; OpenCode V2 conserva sus defaults nativos.",
    });
  }

  const compaction = recordValue(value.compaction);
  if (compaction && isDefaultCompaction(compaction)) {
    findings.push({ path: "/compaction", removable: true, reason: "Defaults de compaction escritos por Malahor; el hook runtime los sustituye." });
  } else if (compaction) {
    findings.push({ path: "/compaction", removable: false, reason: "Compaction contiene valores no atribuibles inequívocamente a Malahor; revisión manual." });
  }

  return findings;
}

function removePaths(raw: string, paths: string[]): string {
  let text = raw;
  for (const pointer of [...paths].sort((left, right) => right.split("/").length - left.split("/").length)) {
    const location = pointer.split("/").slice(1).map(unescapePointer);
    text = applyEdits(text, modify(text, location, undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    }));
  }
  readDocument(text);
  return text;
}

function isMalahorMnemo(value: Record<string, unknown> | undefined, paths: MalahorPaths): boolean {
  if (!value || value.type !== "local" || !Array.isArray(value.command)) return false;
  return value.command
    .filter((item): item is string => typeof item === "string")
    .some((item) => path.resolve(paths.opencodeDir, item) === path.resolve(paths.mnemoIndex));
}

function isDefaultCompaction(value: Record<string, unknown>): boolean {
  return JSON.stringify(value) === JSON.stringify(DEFAULT_COMPACTION);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return recordValue(value) !== undefined;
}

function unescapePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}
