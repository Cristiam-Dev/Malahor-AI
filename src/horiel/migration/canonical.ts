import { createHash } from "node:crypto";
import fs from "node:fs";

import { migrationFailure } from "./errors";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return migrationFailure("invalid_input", "Canonical migration data is invalid.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      const member = record[key];
      if (member === undefined) return migrationFailure("invalid_input", "Canonical migration data is invalid.");
      return `${JSON.stringify(key)}:${canonicalJson(member)}`;
    }).join(",")}}`;
  }
  return migrationFailure("invalid_input", "Canonical migration data is invalid.");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function sha256File(target: string): string {
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

export function deterministicId(
  prefix: "mem" | "chk" | "rel" | "store",
  migrationId: string,
  kind: string,
  sourceKey: string,
): string {
  const entropy = sha256Text(`${migrationId}\u0000${kind}\u0000${sourceKey}`).slice(0, 32);
  return `${prefix}_${entropy}`;
}

export function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function fsyncFile(target: string): void {
  const descriptor = fs.openSync(target, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function fsyncDirectory(target: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(target, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
