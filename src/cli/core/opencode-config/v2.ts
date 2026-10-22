import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import { digest, replaceAtomically, snapshot, writeExclusive, withConfigLock } from "./io";
import { nodeValue, readDocument } from "./jsonc";
import { backupsRoot, writeTransaction } from "./store";
import type { ConfigLocation, ConfigSnapshot, ConfigTransaction } from "./types";

export interface V2ConsolidationPlan {
  state: "missing" | "single" | "ready" | "blocked";
  directory: string;
  source?: ConfigSnapshot;
  target?: ConfigSnapshot;
  merged?: string;
  changes: string[];
  conflicts: string[];
  confirmation?: string;
  issue?: string;
}

export function previewV2Consolidation(location: ConfigLocation): V2ConsolidationPlan {
  const directory = path.resolve(location.opencodeDir);
  const sourcePath = path.join(directory, "opencode.json");
  const targetPath = path.join(directory, "opencode.jsonc");
  const source = snapshot(sourcePath);
  const target = snapshot(targetPath);

  if (!source || !target) {
    return { state: source || target ? "single" : "missing", directory, source, target, changes: [], conflicts: [] };
  }

  try {
    const merge = mergeV2Config(target.text, source.text);
    if (merge.conflicts.length > 0) {
      return { state: "blocked", directory, source, target, changes: merge.changes, conflicts: merge.conflicts, issue: "La consolidación V2 requiere revisión manual." };
    }

    const confirmation = `CONSOLIDATE-V2:${digest(JSON.stringify({ directory, source: source.hash, target: target.hash, merged: digest(merge.text) }))}`;
    return { state: "ready", directory, source, target, merged: merge.text, changes: merge.changes, conflicts: [], confirmation };
  } catch (error) {
    return { state: "blocked", directory, source, target, changes: [], conflicts: [], issue: error instanceof Error ? error.message : String(error) };
  }
}

export function applyV2Consolidation(location: ConfigLocation, confirmation: string): ConfigTransaction {
  const directory = path.resolve(location.opencodeDir);
  return withConfigLock(directory, () => {
    const plan = previewV2Consolidation(location);
    if (plan.state !== "ready" || !plan.source || !plan.target || !plan.merged || !plan.confirmation) {
      throw new Error(plan.issue ?? "No hay consolidación V2 aplicable.");
    }
    if (confirmation !== plan.confirmation) {
      throw new Error("El token de consolidación V2 no coincide con el estado actual; ejecuta el preview de nuevo.");
    }

    const sourceNow = snapshot(plan.source.path);
    const targetNow = snapshot(plan.target.path);
    if (sourceNow?.hash !== plan.source.hash || targetNow?.hash !== plan.target.hash) {
      throw new Error("La configuración cambió entre preview y aplicación; no se escribió nada.");
    }

    const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const transactionDirectory = path.join(backupsRoot(location), id);
    fs.mkdirSync(transactionDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(transactionDirectory, 0o700);
    const sourceBackup = path.join(transactionDirectory, "opencode.json.backup");
    const targetBackup = path.join(transactionDirectory, "opencode.jsonc.backup");
    writeExclusive(sourceBackup, plan.source.text);
    writeExclusive(targetBackup, plan.target.text);

    const transaction: ConfigTransaction = {
      version: 1,
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      directory,
      sourcePath: plan.source.path,
      targetPath: plan.target.path,
      disabledPath: `${plan.source.path}.disabled-${id}`,
      sourceHash: plan.source.hash,
      targetHash: plan.target.hash,
      mergedHash: digest(plan.merged),
      sourceMode: plan.source.mode,
      targetMode: plan.target.mode,
      state: "prepared",
    };
    writeTransaction(transactionDirectory, transaction);

    try {
      replaceAtomically(plan.target.path, plan.merged, id, plan.target.mode);
      if (snapshot(plan.target.path)?.hash !== transaction.mergedHash) throw new Error("La verificación de opencode.jsonc falló.");
      fs.renameSync(plan.source.path, transaction.disabledPath);
      if (snapshot(transaction.disabledPath)?.hash !== transaction.sourceHash) throw new Error("La verificación del archivo origen retirado falló.");
    } catch (error) {
      recoverV2(transaction, transactionDirectory);
      const failed = { ...transaction, state: "rolled-back" as const, updatedAt: Date.now(), note: (error as Error).message };
      writeTransaction(transactionDirectory, failed);
      throw new Error(`La consolidación V2 falló y se restauró el estado original: ${(error as Error).message}`);
    }

    const applied = { ...transaction, state: "applied" as const, updatedAt: Date.now() };
    writeTransaction(transactionDirectory, applied);
    return applied;
  });
}

function mergeV2Config(targetText: string, sourceText: string): { text: string; changes: string[]; conflicts: string[] } {
  const target = nodeValue(readDocument(targetText).root);
  const source = nodeValue(readDocument(sourceText).root);
  if (!isRecord(target) || !isRecord(source)) throw new Error("Las configuraciones V2 deben ser objetos JSONC.");

  const sourceMcp = recordValue(source.mcp);
  const sourceServers = sourceMcp ? recordValue(sourceMcp.servers) : undefined;
  if (!sourceServers) throw new Error("opencode.json no contiene mcp.servers; no se aplica consolidación V2 automática.");

  const targetMcp = recordValue(target.mcp) ?? {};
  const targetServers = recordValue(targetMcp.servers) ?? {};
  const targetLegacyKeys = Object.keys(targetMcp).filter((key) => key !== "mnemo" && key !== "servers");
  if (targetLegacyKeys.length > 0) {
    return { text: targetText, changes: [], conflicts: targetLegacyKeys.map((key) => `/mcp/${key}`) };
  }

  const mergedServers = { ...targetServers, ...sourceServers };
  const sourcePermission = recordValue(source.permission);
  const targetPermission = recordValue(target.permission);
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(sourcePermission ?? {})) {
    if (targetPermission?.[key] !== undefined && JSON.stringify(targetPermission[key]) !== JSON.stringify(value)) conflicts.push(`/permission/${key}`);
  }
  if (conflicts.length > 0) return { text: targetText, changes: [], conflicts };

  let text = targetText;
  const changes: string[] = [];
  text = setJsonc(text, ["mcp", "servers"], mergedServers);
  changes.push("/mcp/servers");
  if (targetMcp.mnemo !== undefined) {
    text = removeJsonc(text, ["mcp", "mnemo"]);
    changes.push("/mcp/mnemo");
  }
  if (sourcePermission) {
    text = setJsonc(text, ["permission"], { ...(targetPermission ?? {}), ...sourcePermission });
    changes.push("/permission");
  }

  for (const [key, value] of Object.entries(source)) {
    if (["$schema", "mcp", "permission"].includes(key)) continue;
    if (target[key] === undefined) {
      text = setJsonc(text, [key], value);
      changes.push(`/${key}`);
    } else if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
      conflicts.push(`/${key}`);
    }
  }
  if (conflicts.length > 0) return { text: targetText, changes: [], conflicts };
  readDocument(text);
  return { text, changes, conflicts: [] };
}

function setJsonc(text: string, location: string[], value: unknown): string {
  return applyEdits(text, modify(text, location, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
}

function removeJsonc(text: string, location: string[]): string {
  return applyEdits(text, modify(text, location, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
}

function recoverV2(transaction: ConfigTransaction, directory: string): void {
  try {
    const targetBackup = path.join(directory, "opencode.jsonc.backup");
    const sourceBackup = path.join(directory, "opencode.json.backup");
    const target = snapshot(targetBackup);
    const source = snapshot(sourceBackup);
    if (target) replaceAtomically(transaction.targetPath, target.text, `${transaction.id}-recover-target`, transaction.targetMode);
    if (!fs.existsSync(transaction.sourcePath) && source) fs.copyFileSync(source.path, transaction.sourcePath);
    if (fs.existsSync(transaction.disabledPath)) fs.unlinkSync(transaction.disabledPath);
  } catch {
    // La transacción queda registrada como rolled-back/recovery-required para revisión.
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return recordValue(value) !== undefined;
}
