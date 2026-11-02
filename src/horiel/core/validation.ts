import { createHash } from "node:crypto";

import { invalidInput } from "./errors";
import { MEMORY_TYPES, type MemoryProvenance, type MemoryType } from "./model";
import { parseScopePath } from "./scopes";

export const HORIEL_LIMITS = Object.freeze({
  titleCharacters: 160,
  titleBytes: 512,
  contentBytes: 65_536,
  tags: 20,
  tagBytes: 64,
  idempotencyCharacters: 128,
  sessionRefCharacters: 128,
  queryBytes: 1_024,
  queryTerms: 24,
  queryTermBytes: 64,
  pageSize: 50,
  budgetBytes: 262_144,
  checkpointItems: 50,
  checkpointItemBytes: 2_048,
});

export interface MemoryDraftInput {
  scope: string;
  type: MemoryType;
  title: string;
  content: string;
  tags?: readonly string[];
  idempotencyKey: string;
  provenance?: MemoryProvenance;
}

export interface ValidatedMemoryDraft {
  scope: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  idempotencyKey: string;
  provenance: MemoryProvenance;
}

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const SECRET_ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token|secret)\s*[:=]\s*["']?[^\s"']{8,}/i;
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/;

export function normalizeTags(values: readonly string[] = []): string[] {
  if (!Array.isArray(values) || values.length > HORIEL_LIMITS.tags) {
    return invalidInput("Memory tags exceed the supported limit.");
  }
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") return invalidInput("Memory tag must be text.");
    const tag = value.trim().normalize("NFC").toLocaleLowerCase("en-US");
    if (!tag || Buffer.byteLength(tag, "utf8") > HORIEL_LIMITS.tagBytes
      || /[\u0000-\u001f\u007f]/.test(tag)) {
      return invalidInput("Memory tag is invalid.");
    }
    normalized.add(tag);
  }
  if (normalized.size > HORIEL_LIMITS.tags) return invalidInput("Memory tags exceed the supported limit.");
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

export function validateMemoryDraft(input: MemoryDraftInput): ValidatedMemoryDraft {
  if (!input || typeof input !== "object") return invalidInput("Memory input is required.");
  const scope = parseScopePath(input.scope);
  const type = validateMemoryType(input.type);
  const title = validateBoundedText(input.title, "Memory title", 1, HORIEL_LIMITS.titleBytes,
    HORIEL_LIMITS.titleCharacters);
  const content = validateBoundedText(input.content, "Memory content", 1, HORIEL_LIMITS.contentBytes);
  assertSafeContent(`${title}\n${content}`);
  return {
    scope,
    type,
    title,
    content,
    tags: normalizeTags(input.tags),
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    provenance: validateProvenance(input.provenance ?? { source: "unknown" }),
  };
}

export function validateMemoryType(value: unknown): MemoryType {
  if (typeof value !== "string" || !MEMORY_TYPES.includes(value as MemoryType)) {
    return invalidInput("Memory type is not supported.");
  }
  return value as MemoryType;
}

export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > HORIEL_LIMITS.idempotencyCharacters
    || !/^[\x21-\x7e]+$/.test(value)) {
    return invalidInput("Idempotency key is invalid.");
  }
  return value;
}

export function validateSessionRef(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > HORIEL_LIMITS.sessionRefCharacters
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    return invalidInput("Session reference is invalid.");
  }
  return value;
}

export function validateProvenance(value: unknown): MemoryProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidInput("Memory provenance is invalid.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["source", "sessionRef", "externalRef"].includes(key))
    || typeof record.source !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(record.source)) {
    return invalidInput("Memory provenance is invalid.");
  }
  const result: MemoryProvenance = { source: record.source };
  if (record.sessionRef !== undefined) result.sessionRef = validateSessionRef(record.sessionRef);
  if (record.externalRef !== undefined) {
    result.externalRef = validateBoundedText(record.externalRef, "External provenance reference", 1, 512);
  }
  return result;
}

export function validateBoundedText(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
  maximumCharacters?: number,
): string {
  if (typeof value !== "string" || value !== value.normalize("NFC")) return invalidInput(`${label} is invalid.`);
  const bytes = Buffer.byteLength(value, "utf8");
  const characters = [...value].length;
  if (bytes < minimumBytes || bytes > maximumBytes
    || (maximumCharacters !== undefined && characters > maximumCharacters)
    || /\u0000/.test(value)) {
    return invalidInput(`${label} is outside the supported limit.`);
  }
  return value;
}

export function assertSafeContent(value: string): void {
  if (PRIVATE_KEY_PATTERN.test(value) || SECRET_ASSIGNMENT_PATTERN.test(value) || TOKEN_PATTERN.test(value)) {
    return invalidInput("Memory content contains a known sensitive credential shape.");
  }
}

export function validatePositiveVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalidInput("Memory version is invalid.");
  }
  return value;
}

export function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return invalidInput("Clock returned an invalid time.");
  return value.toISOString();
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidInput("Canonical value contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return invalidInput("Canonical value contains an unsupported member.");
}
