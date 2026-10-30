import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAudit } from "./audit";
import { normalizeHookResource } from "./resources";
import { sha256 } from "./security-policy";
import type { HookContext, HookResult } from "./types";

const DEFAULT_TTL_SECONDS = 300;
const TRUSTED_CHANNELS = new Set(["cli-tty", "opencode-ui", "host-ui"]);

export interface ApprovalRecord {
  nonce: string;
  operation: string;
  resources: string[];
  commandHash: string | null;
  memoryScope: string | null;
  client: string | null;
  project: string | null;
  policyHash: string;
  contractVersion: number;
  channel: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: string | null;
  /** Solo se devuelve al emisor; no forma parte del registro persistido. */
  auditWarning?: string;
}

export interface ApprovalGrantOptions {
  channel: string;
  ttlSeconds?: number;
  now?: Date;
}

export interface ApprovalConsumeOptions {
  channel?: string;
  now?: Date;
}

export interface ApprovalConsumeResult {
  ok: boolean;
  reason?: string;
  record?: ApprovalRecord;
}

export function grantApproval(context: HookContext, options: ApprovalGrantOptions): ApprovalRecord {
  const channel = options.channel.trim();
  assertTrustedChannel(context, channel);

  const binding = bindingForContext(context);
  const now = options.now ?? new Date();
  const ttlSeconds = effectiveTtlSeconds(context, options.ttlSeconds);
  const record: ApprovalRecord = {
    nonce: randomBytes(32).toString("hex"),
    ...binding,
    channel,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    consumedAt: null,
    consumedBy: null,
  };

  const directory = approvalsDirectory(context.malahorHome);
  ensurePrivateDirectory(directory);
  const filePath = approvalRecordPath(context.malahorHome, record.nonce);
  if (fs.existsSync(filePath)) {
    throw new Error("colision de nonce de aprobacion");
  }
  try {
    writeRecord(filePath, record);
  } catch (error) {
    invalidateRecord(filePath);
    throw error;
  }

  const audit: HookResult = {
    event: context.event,
    profile: context.profile,
    decision: "allow",
    policy: context.policyMeta,
    approvalRef: record.nonce,
    violations: [{
      id: "MAL-HOOK-APPROVAL-GRANT",
      decision: "allow",
      message: "Aprobacion humana emitida y vinculada a la operacion.",
      fix: "Consumela una sola vez en la operacion exacta; no la reutilices.",
    }],
  };
  const auditResult = writeAudit(context, audit);
  if (auditResult.required && !auditResult.ok) {
    invalidateRecord(filePath);
    throw new Error(`No se emitio la aprobacion: auditoria obligatoria no disponible: ${auditResult.error ?? "error desconocido"}`);
  }
  if (!auditResult.ok && !auditResult.skipped) {
    return { ...record, auditWarning: auditResult.error ?? "auditoria auxiliar no disponible" };
  }

  return record;
}

export function consumeApproval(
  nonce: string,
  context: HookContext,
  options: ApprovalConsumeOptions = {},
): ApprovalConsumeResult {
  if (!/^[a-f0-9]{64}$/.test(nonce)) {
    return { ok: false, reason: "nonce de aprobacion invalido" };
  }

  let binding: ReturnType<typeof bindingForContext>;
  try {
    binding = bindingForContext(context);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "no se pudo vincular la aprobacion" };
  }

  const directory = approvalsDirectory(context.malahorHome);
  const filePath = approvalRecordPath(context.malahorHome, nonce);
  const claimPath = `${filePath}.claimed`;

  try {
    ensurePrivateDirectory(directory);
    if (fs.existsSync(claimPath)) return { ok: false, reason: "aprobacion ya consumida" };
    if (!fs.existsSync(filePath)) return { ok: false, reason: "aprobacion no encontrada" };

    const record = readRecord(filePath);
    if (record.nonce !== nonce) return { ok: false, reason: "registro de aprobacion invalido" };
    if (!TRUSTED_CHANNELS.has(record.channel)) return { ok: false, reason: "canal de aprobacion no confiable" };
    if (record.consumedAt) return { ok: false, reason: "aprobacion ya consumida" };

    const now = options.now ?? new Date();
    const createdAt = Date.parse(record.createdAt);
    const expiresAt = Date.parse(record.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
      return { ok: false, reason: "vigencia de aprobacion invalida" };
    }
    const maxTtl = context.security?.approval?.maxTtlSeconds;
    if (maxTtl !== undefined && (!Number.isInteger(maxTtl) || maxTtl <= 0)) {
      return { ok: false, reason: "politica de aprobacion invalida" };
    }
    if (maxTtl !== undefined && expiresAt - createdAt > maxTtl * 1000) {
      return { ok: false, reason: "aprobacion excede el TTL maximo de la politica" };
    }
    if (expiresAt <= now.getTime()) return { ok: false, reason: "aprobacion expirada" };
    if (!sameBinding(record, binding)) return { ok: false, reason: "aprobacion no corresponde a la operacion actual" };

    let claimFd: number;
    try {
      claimFd = fs.openSync(claimPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { ok: false, reason: "aprobacion ya consumida" };
      }
      throw error;
    }

    try {
      record.consumedAt = now.toISOString();
      record.consumedBy = options.channel ?? null;
      writeRecord(filePath, record);
      return { ok: true, record };
    } finally {
      fs.closeSync(claimFd);
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "ledger de aprobaciones no disponible" };
  }
}

export function approvalsDirectory(malahorHome: string): string {
  return path.join(malahorHome, "approvals");
}

export function approvalRecordPath(malahorHome: string, nonce: string): string {
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("nonce de aprobacion invalido");
  return path.join(approvalsDirectory(malahorHome), `${nonce}.json`);
}

function bindingForContext(context: HookContext): Omit<ApprovalRecord, "nonce" | "channel" | "createdAt" | "expiresAt" | "consumedAt" | "consumedBy"> {
  if (!context.policyMeta) {
    throw new Error("la aprobacion requiere politica efectiva y hash");
  }

  const resources = [...new Set((context.targetPaths ?? []).map((target) => normalizeHookResource(context, target)))].sort();
  return {
    operation: context.event,
    resources,
    commandHash: context.command?.trim() ? sha256(context.command.trim()) : null,
    memoryScope: context.memoryScope ?? null,
    client: context.client ?? null,
    project: context.project ?? null,
    policyHash: context.policyMeta.policyHash,
    contractVersion: context.policyMeta.contractVersion,
  };
}

function sameBinding(record: ApprovalRecord, binding: ReturnType<typeof bindingForContext>): boolean {
  return record.operation === binding.operation
    && record.commandHash === binding.commandHash
    && record.memoryScope === binding.memoryScope
    && record.client === binding.client
    && record.project === binding.project
    && record.policyHash === binding.policyHash
    && record.contractVersion === binding.contractVersion
    && record.resources.length === binding.resources.length
    && record.resources.every((resource, index) => resource === binding.resources[index]);
}

function effectiveTtlSeconds(context: HookContext, requested: number | undefined): number {
  const ttl = requested ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error("TTL de aprobacion invalido");
  }

  const cap = context.security?.approval?.maxTtlSeconds;
  if (cap === undefined) return ttl;
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new Error("TTL maximo de aprobacion invalido en la politica");
  }
  return Math.min(ttl, cap);
}

function assertTrustedChannel(context: HookContext, channel: string): void {
  if (!TRUSTED_CHANNELS.has(channel)) {
    throw new Error("canal de aprobacion no confiable; se requiere TTY/UI humana");
  }

  const allowed = context.security?.approval?.allowedChannels;
  if (allowed !== undefined && !allowed.includes(channel)) {
    throw new Error(`canal de aprobacion no permitido por la politica: ${channel}`);
  }
}

function readRecord(filePath: string): ApprovalRecord {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("registro de aprobacion invalido");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("permisos de aprobacion inseguros");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`registro de aprobacion invalido: ${error instanceof Error ? error.message : "JSON invalido"}`);
  }
  if (!validRecord(parsed)) {
    throw new Error("registro de aprobacion invalido");
  }
  return parsed;
}

function invalidateRecord(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    return;
  } catch {
    // Si no se puede borrar, se crea un claim para impedir el consumo.
  }
  try {
    const fd = fs.openSync(`${filePath}.claimed`, "wx", 0o600);
    fs.closeSync(fd);
  } catch {
    // Sin permisos para invalidar, el fallo original sigue siendo fail-closed.
  }
}

function writeRecord(filePath: string, record: ApprovalRecord): void {
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
    secureChmod(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // El rename ya movio el temporal; no hay nada que limpiar.
    }
  }
}

function ensurePrivateDirectory(directory: string): void {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("directorio de aprobaciones invalido");
    }
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  secureChmod(directory, 0o700);
}

function validRecord(value: unknown): value is ApprovalRecord {
  if (!isRecord(value)) return false;
  return typeof value.nonce === "string"
    && /^[a-f0-9]{64}$/.test(value.nonce)
    && typeof value.operation === "string"
    && Array.isArray(value.resources)
    && value.resources.every((item) => typeof item === "string")
    && (typeof value.commandHash === "string" || value.commandHash === null)
    && (typeof value.memoryScope === "string" || value.memoryScope === null)
    && (typeof value.client === "string" || value.client === null)
    && (typeof value.project === "string" || value.project === null)
    && typeof value.policyHash === "string"
    && typeof value.contractVersion === "number"
    && typeof value.channel === "string"
    && typeof value.createdAt === "string"
    && typeof value.expiresAt === "string"
    && (typeof value.consumedAt === "string" || value.consumedAt === null)
    && (typeof value.consumedBy === "string" || value.consumedBy === null)
    && (value.auditWarning === undefined || typeof value.auditWarning === "string");
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows no soporta permisos POSIX; se ignora.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
