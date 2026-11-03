import fs from "node:fs";
import path from "node:path";
import { hookResourceAuditIdentity } from "./resources";
import { sha256 } from "./security-policy";
import type { HookContext, HookDecision, HookResult } from "./types";

const AUDIT_VERSION = 1;
const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_RETENTION_DAYS = 30;
const ENGINE_VERSION = process.env.MALAHOR_ENGINE_VERSION ?? "0.1.1";

export interface AuditEntry {
  auditVersion: 1;
  timestamp: string;
  decision: HookDecision;
  event: string;
  operation: string;
  client: string | null;
  project: string | null;
  policyVersion: string;
  policyHash: string;
  ruleIds: string[];
  approvalRef: string | null;
  resourceRefs: string[];
  host: string;
  engineVersion: string;
}

export type CodeModeAuditPhase = "execution.before" | "execution.after" | "call.before" | "call.after";

export interface CodeModeAuditInput {
  phase: CodeModeAuditPhase;
  sessionID: string;
  messageID: string;
  executionRef: string;
  programHash: string;
  decision: "allow" | "deny" | "error" | "completed" | "cancelled";
  tool?: string;
  index?: number;
  inputHash?: string;
  outputHash?: string;
  ruleIds?: string[];
  resultClass?: string;
  quota?: string;
  inputBytes?: number;
  outputBytes?: number;
  callCount?: number;
  redacted?: boolean;
}

export interface CodeModeAuditEntry {
  auditVersion: 1;
  kind: "code-mode";
  timestamp: string;
  phase: CodeModeAuditPhase;
  sessionRef: string;
  messageRef: string;
  executionRef: string;
  programRef: string;
  project: string | null;
  policyVersion: string;
  policyHash: string;
  decision: CodeModeAuditInput["decision"];
  tool: string | null;
  index: number | null;
  inputRef: string | null;
  outputRef: string | null;
  ruleIds: string[];
  resultClass: string | null;
  quota: string | null;
  inputBytes: number;
  outputBytes: number;
  callCount: number;
  redacted: boolean;
  host: string;
  engineVersion: string;
}

export interface AuditOptions {
  enabled?: boolean;
  required?: boolean;
  now?: Date;
  maxFiles?: number;
  retentionDays?: number;
}

export interface AuditWriteResult {
  ok: boolean;
  skipped: boolean;
  required: boolean;
  path: string;
  error?: string;
}

export function writeAudit(context: HookContext, result: HookResult, options: AuditOptions = {}): AuditWriteResult {
  const policyRequired = context.security?.audit?.required === true || context.security?.audit?.failClosedIfUnavailable === true;
  const required = policyRequired || options.required === true || context.audit?.required === true;
  const enabled = required || (options.enabled ?? context.audit?.enabled ?? true);
  const filePath = auditFilePath(context.malahorHome, context.security?.audit?.path, context.cwd);

  if (!enabled) return { ok: true, skipped: true, required, path: filePath };
  return appendAuditRecord(context, buildAuditEntry(context, result, options.now ?? new Date()), options, required);
}

/** Auditoria A4: solo refs/hash y clases; nunca codigo, argumentos, contenido ni rutas. */
export function writeCodeModeAudit(
  context: HookContext,
  input: CodeModeAuditInput,
  options: AuditOptions = {},
): AuditWriteResult {
  const now = options.now ?? new Date();
  const policy = context.policyMeta;
  const entry: CodeModeAuditEntry = {
    auditVersion: AUDIT_VERSION,
    kind: "code-mode",
    timestamp: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    phase: input.phase,
    sessionRef: auditRef(input.sessionID),
    messageRef: auditRef(input.messageID),
    executionRef: auditRef(input.executionRef),
    programRef: hashRef(input.programHash),
    project: context.project ?? null,
    policyVersion: policy?.policyVersion ?? "unknown",
    policyHash: policy?.policyHash ? hashRef(policy.policyHash) : "sha256:unknown",
    decision: input.decision,
    tool: input.tool ?? null,
    index: safeCount(input.index),
    inputRef: input.inputHash ? hashRef(input.inputHash) : null,
    outputRef: input.outputHash ? hashRef(input.outputHash) : null,
    ruleIds: [...new Set(input.ruleIds ?? [])].sort(),
    resultClass: safeAuditLabel(input.resultClass),
    quota: safeAuditLabel(input.quota),
    inputBytes: safeCount(input.inputBytes) ?? 0,
    outputBytes: safeCount(input.outputBytes) ?? 0,
    callCount: safeCount(input.callCount) ?? 0,
    redacted: input.redacted === true,
    host: auditHost(),
    engineVersion: ENGINE_VERSION,
  };
  return appendAuditRecord(context, entry, { ...options, required: true }, true);
}

export function approvalRefForAudit(nonce: string): string {
  return `sha256:${sha256(nonce)}`;
}

export function auditFilePath(malahorHome: string, overridePath?: string, cwd = process.cwd()): string {
  if (overridePath) {
    const expanded = overridePath.startsWith("~/") ? path.join(process.env.HOME ?? "", overridePath.slice(2)) : overridePath;
    return path.resolve(cwd, expanded);
  }
  return path.join(malahorHome, "audit", "security.jsonl");
}

function auditFilePrefix(filePath: string): string {
  const base = path.basename(filePath);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : base;
}

export function buildAuditEntry(context: HookContext, result: HookResult, now: Date = new Date()): AuditEntry {
  const policy = result.policy ?? context.policyMeta;
  const resourceRefs = [...new Set((context.targetPaths ?? []).map((target) => `sha256:${sha256(hookResourceAuditIdentity(context, target))}`))].sort();
  const policyHash = policy?.policyHash ? `sha256:${policy.policyHash}` : "sha256:unknown";

  return {
    auditVersion: AUDIT_VERSION,
    timestamp: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    decision: result.decision,
    event: context.event,
    operation: operationForEvent(context.event),
    client: context.client ?? null,
    project: context.project ?? null,
    policyVersion: policy?.policyVersion ?? "unknown",
    policyHash,
    ruleIds: [...new Set(result.violations.map((violation) => violation.id))].sort(),
    approvalRef: result.approvalRef ? approvalRefForAudit(result.approvalRef) : null,
    resourceRefs,
    host: auditHost(),
    engineVersion: ENGINE_VERSION,
  };
}

function appendAuditRecord(
  context: HookContext,
  entry: AuditEntry | CodeModeAuditEntry,
  options: AuditOptions,
  required: boolean,
): AuditWriteResult {
  const filePath = auditFilePath(context.malahorHome, context.security?.audit?.path, context.cwd);
  try {
    const directory = path.dirname(filePath);
    const directoryMode = parseMode(context.security?.audit?.directoryMode, 0o700);
    const fileMode = parseMode(context.security?.audit?.fileMode, 0o600);
    const prefix = auditFilePrefix(filePath);
    ensureAuditDirectory(directory, directoryMode, context.malahorHome);
    rotateIfNeeded(filePath, directory, options.now ?? new Date(), fileMode, prefix);
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: fileMode, flag: "a" });
    secureChmod(filePath, fileMode);
    pruneAuditFiles(
      directory,
      options.maxFiles ?? context.security?.audit?.maxFiles ?? DEFAULT_MAX_FILES,
      options.retentionDays ?? context.security?.audit?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      options.now ?? new Date(),
      path.basename(filePath),
      prefix,
    );
    return { ok: true, skipped: false, required, path: filePath };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      required,
      path: filePath,
      error: error instanceof Error ? error.message : "fallo de auditoria",
    };
  }
}

function auditRef(value: string): string {
  return `sha256:${sha256(value)}`;
}

function hashRef(value: string): string {
  return `sha256:${/^[a-f0-9]{64}$/.test(value) ? value : sha256(value)}`;
}

function safeCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeAuditLabel(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null;
}

function operationForEvent(event: string): string {
  const base = event.replace(/\.(before|preview|apply)$/, "");
  return base.startsWith("git.") ? base.slice(4) : base;
}

function auditHost(): string {
  if (process.env.WSL_DISTRO_NAME) return "wsl";
  return process.platform;
}

function ensureAuditDirectory(directory: string, mode: number, managedRoot: string): void {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("directorio de auditoria invalido");
    }
    // No cambiamos permisos de directorios administrados fuera de ~/.malahor;
    // hacerlo sobre /var/log o similar seria destructivo.
    if (isWithin(directory, managedRoot)) secureChmod(directory, mode);
  } else {
    fs.mkdirSync(directory, { recursive: true, mode });
    secureChmod(directory, mode);
  }
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rotateIfNeeded(filePath: string, directory: string, now: Date, fileMode: number, prefix: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("archivo de auditoria invalido");
  }
  if (stat.size < MAX_AUDIT_BYTES) return;

  const base = path.join(directory, `${prefix}.${now.toISOString().replace(/[:.]/g, "-")}`);
  let rotated = `${base}.jsonl`;
  let suffix = 1;
  while (fs.existsSync(rotated)) {
    rotated = `${base}.${suffix}.jsonl`;
    suffix += 1;
  }
  fs.renameSync(filePath, rotated);
  secureChmod(rotated, fileMode);
}

function pruneAuditFiles(directory: string, maxFiles: number, retentionDays: number, now: Date, activeName: string, prefix: string): void {
  const keep = Math.max(1, maxFiles);
  const cutoff = now.getTime() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(directory)
    .filter((name) => name !== activeName && name.startsWith(`${prefix}.`) && name.endsWith(".jsonl"))
    .map((name) => {
      const filePath = path.join(directory, name);
      const stat = fs.statSync(filePath);
      return { filePath, mtime: stat.mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime);

  for (const [index, entry] of entries.entries()) {
    if (index >= keep - 1 || entry.mtime < cutoff) {
      fs.unlinkSync(entry.filePath);
    }
  }
}

function parseMode(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const normalized = value.startsWith("0o") ? value.slice(2) : value;
  const parsed = Number.parseInt(normalized, 8);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 0o777) {
    throw new Error(`modo de auditoria invalido: ${value}`);
  }
  return parsed;
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows no soporta permisos POSIX; se ignora.
  }
}
