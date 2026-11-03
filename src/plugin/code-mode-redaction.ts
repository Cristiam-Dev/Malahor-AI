import path from "node:path";

import { redactPayloadSecrets } from "../cli/core/hooks/secret-scan";

export type CodeModeJson = null | boolean | number | string | CodeModeJson[] | { [key: string]: CodeModeJson };

export type BoundaryFailureCode = "INVALID_INPUT" | "QUOTA_EXCEEDED" | "REDACTION_UNSAFE";

export interface BoundaryLimits {
  maxDepth: number;
  maxProperties: number;
  maxItems: number;
  maxBytes: number;
}

export interface BoundarySanitizeOptions {
  limits: BoundaryLimits;
  projectRoot?: string;
  redactSecrets?: boolean;
  dropHostMetadata?: boolean;
  dropDangerousKeys?: boolean;
  truncate?: boolean;
}

export interface BoundarySanitizeResult {
  value: CodeModeJson;
  bytes: number;
  redacted: boolean;
  redactions: string[];
  truncated: boolean;
}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HOST_METADATA_KEYS = new Set([
  "attachment", "attachments", "cause", "metadata", "stack", "stderr", "stdout",
]);

export class CodeModeBoundaryError extends Error {
  constructor(readonly code: BoundaryFailureCode, message: string) {
    super(message);
    this.name = "CodeModeBoundaryError";
  }
}

export function sanitizeCodeModeBoundary(
  input: unknown,
  options: BoundarySanitizeOptions,
): BoundarySanitizeResult {
  validateLimits(options.limits);
  const state = {
    redactions: new Set<string>(),
    seen: new WeakSet<object>(),
    budget: { used: 0, maximum: options.limits.maxBytes },
  };
  let value: CodeModeJson;
  try {
    value = copyBoundaryValue(input, options, state, 0);
  } catch (error) {
    if (!(error instanceof CodeModeBoundaryError) || error.code !== "QUOTA_EXCEEDED" || !options.truncate) throw error;
    state.redactions.add("output-limit");
    const bounded: CodeModeJson = { truncated: true, value: "<truncated:output-limit>" };
    const serialized = JSON.stringify(bounded);
    return {
      value: bounded,
      bytes: Buffer.byteLength(serialized, "utf8"),
      redacted: true,
      redactions: [...state.redactions].sort(),
      truncated: true,
    };
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Resultado no serializable.");
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > options.limits.maxBytes) {
    throw new CodeModeBoundaryError("QUOTA_EXCEEDED", "La frontera excede su limite de bytes.");
  }

  return {
    value,
    bytes,
    redacted: state.redactions.size > 0,
    redactions: [...state.redactions].sort(),
    truncated: false,
  };
}

export function canonicalCodeModeJson(value: CodeModeJson): string {
  return JSON.stringify(sortJson(value));
}

export function codeModeUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function safeCodeModeMessage(value: unknown, fallback = "La operacion confinada fallo."): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ").trim();
  return cleaned ? cleaned.slice(0, 240) : fallback;
}

function copyBoundaryValue(
  value: unknown,
  options: BoundarySanitizeOptions,
  state: { redactions: Set<string>; seen: WeakSet<object>; budget: { used: number; maximum: number } },
  depth: number,
): CodeModeJson {
  if (depth > options.limits.maxDepth) {
    throw new CodeModeBoundaryError("REDACTION_UNSAFE", "La frontera excede la profundidad JSON permitida.");
  }
  if (value === null) {
    consumeBudget(state.budget, 4);
    return value;
  }
  if (typeof value === "boolean") {
    consumeBudget(state.budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Numero no finito en la frontera.");
    consumeBudget(state.budget, Buffer.byteLength(JSON.stringify(value), "utf8"));
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > options.limits.maxBytes) {
      throw new CodeModeBoundaryError("QUOTA_EXCEEDED", "La cadena excede el limite de la frontera.");
    }
    const sanitized = sanitizeString(value, options, state.redactions);
    consumeBudget(state.budget, Buffer.byteLength(JSON.stringify(sanitized), "utf8"));
    return sanitized;
  }
  if (typeof value !== "object") {
    throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Valor no JSON en la frontera.");
  }
  if (value instanceof Error) {
    if (!options.dropHostMetadata) throw new CodeModeBoundaryError("INVALID_INPUT", "Los objetos Error no son entradas validas.");
    state.redactions.add("error-detail");
    return copyBoundaryValue({ error: safeCodeModeMessage(value.message) }, options, state, depth + 1);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) {
    throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Bytes, fechas u objetos ambientales no cruzan la frontera.");
  }
  if (state.seen.has(value)) throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Referencia circular en la frontera.");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > options.limits.maxItems) {
        throw new CodeModeBoundaryError("QUOTA_EXCEEDED", "La coleccion excede el limite permitido.");
      }
      consumeBudget(state.budget, 2 + Math.max(0, value.length - 1));
      return value.map((item) => copyBoundaryValue(item, options, state, depth + 1));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Objeto no plano en la frontera.");
    }
    const keys = Object.keys(value);
    if (keys.length > options.limits.maxProperties) {
      throw new CodeModeBoundaryError("QUOTA_EXCEEDED", "El objeto excede el limite de propiedades.");
    }
    const output: Record<string, CodeModeJson> = Object.create(null) as Record<string, CodeModeJson>;
    consumeBudget(state.budget, 2);
    let retained = 0;
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) {
        if (!options.dropDangerousKeys) throw new CodeModeBoundaryError("INVALID_INPUT", "Clave peligrosa en la frontera.");
        state.redactions.add("dangerous-key");
        continue;
      }
      if (options.dropHostMetadata && HOST_METADATA_KEYS.has(key.toLowerCase())) {
        state.redactions.add("host-metadata");
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Accessor no permitido en la frontera.");
      }
      if (retained > 0) consumeBudget(state.budget, 1);
      consumeBudget(state.budget, Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
      const item = descriptor.value;
      output[key] = copyBoundaryValue(item, options, state, depth + 1);
      retained += 1;
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function consumeBudget(budget: { used: number; maximum: number }, bytes: number): void {
  budget.used += bytes;
  if (budget.used > budget.maximum) {
    throw new CodeModeBoundaryError("QUOTA_EXCEEDED", "La frontera excede su limite de bytes.");
  }
}

function sanitizeString(
  input: string,
  options: BoundarySanitizeOptions,
  redactions: Set<string>,
): string {
  let value = input;
  const controls = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
  if (controls !== value) {
    redactions.add("control-character");
    value = controls;
  }

  if (options.projectRoot) {
    const roots = new Set([
      path.resolve(options.projectRoot),
      path.resolve(options.projectRoot).replaceAll("\\", "/"),
    ]);
    for (const root of roots) {
      if (root && value.includes(root)) {
        value = value.split(root).join("<project-root>");
        redactions.add("project-root");
      }
    }
  }

  if (options.redactSecrets !== false) {
    const redacted = redactPayloadSecrets(value);
    if (redacted.kinds.length > 0) {
      for (const kind of redacted.kinds) redactions.add(kind);
      value = redacted.value;
    }
  }
  return value;
}

function sortJson(value: CodeModeJson): CodeModeJson {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, CodeModeJson> = Object.create(null) as Record<string, CodeModeJson>;
  for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key]!);
  return output;
}

function validateLimits(limits: BoundaryLimits): void {
  for (const value of [limits.maxDepth, limits.maxProperties, limits.maxItems, limits.maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CodeModeBoundaryError("REDACTION_UNSAFE", "Limites de frontera invalidos.");
    }
  }
}
