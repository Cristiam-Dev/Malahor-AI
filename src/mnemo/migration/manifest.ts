import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { MemoryError } from "../engine/errors";
import { MEMORY_SCHEMA_VERSION } from "../engine/schema";
import { readPrivateFile, writePrivateJson } from "./files";
import type { MemoryMigrationManifest, ScopeMigrationMapping } from "./types";

export interface ManifestSnapshot {
  manifest: MemoryMigrationManifest;
  hash: string;
}

export function readMigrationManifest(file: string): ManifestSnapshot | null {
  if (!fs.existsSync(file)) return null;
  const bytes = readPrivateFile(file, 2 * 1024 * 1024);
  if (!isUtf8(bytes)) throw new MemoryError("MEMORY_FORMAT", "Manifiesto de migracion invalido: UTF-8 requerido.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new MemoryError("MEMORY_FORMAT", `Manifiesto de migracion invalido: ${(error as Error).message}`);
  }
  return { manifest: parseManifest(parsed), hash };
}

export function saveMigrationManifest(file: string, manifest: MemoryMigrationManifest, expectedHash: string | null): string {
  return writePrivateJson(file, manifest, expectedHash);
}

function parseManifest(value: unknown): MemoryMigrationManifest {
  const item = record(value, "manifiesto");
  const expected = ["artifacts", "backupHash", "backupPath", "destinationPath", "error", "mappings", "markerPath",
    "nextId", "observations", "recordsDigest", "schemaVersion", "sessions", "sourceHash", "sourcePath", "sourceSize",
    "stagingPath", "startedAt", "state", "transactionId", "verifiedAt", "version"];
  if (Object.keys(item).sort().join("\0") !== expected.sort().join("\0")) invalid("campos desconocidos o ausentes");
  if (item.version !== 1 || item.schemaVersion !== MEMORY_SCHEMA_VERSION) invalid("version no soportada");
  if (item.state !== "preparing" && item.state !== "verified" && item.state !== "failed") invalid("estado no soportado");
  const mappings = list(item.mappings, "mappings").map(parseMapping);
  const artifacts = list(item.artifacts, "artifacts").map((entry, index) => text(entry, `artifacts[${index}]`));
  const verifiedAt = item.verifiedAt === null ? null : timestamp(item.verifiedAt, "verifiedAt");
  const error = nullableText(item.error, "error");
  if (item.state === "preparing" && (verifiedAt !== null || error !== null)) invalid("estado preparing inconsistente");
  if (item.state === "verified" && (verifiedAt === null || error !== null)) invalid("estado verified inconsistente");
  if (item.state === "failed" && error === null) invalid("estado failed sin diagnostico");
  return {
    version: 1,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    state: item.state,
    transactionId: text(item.transactionId, "transactionId"),
    sourcePath: text(item.sourcePath, "sourcePath"),
    sourceHash: hash(item.sourceHash, "sourceHash"),
    sourceSize: nonNegativeInteger(item.sourceSize, "sourceSize"),
    destinationPath: text(item.destinationPath, "destinationPath"),
    markerPath: text(item.markerPath, "markerPath"),
    stagingPath: text(item.stagingPath, "stagingPath"),
    backupPath: text(item.backupPath, "backupPath"),
    backupHash: hash(item.backupHash, "backupHash"),
    recordsDigest: hash(item.recordsDigest, "recordsDigest"),
    observations: nonNegativeInteger(item.observations, "observations"),
    sessions: nonNegativeInteger(item.sessions, "sessions"),
    nextId: positiveInteger(item.nextId, "nextId"),
    mappings,
    startedAt: timestamp(item.startedAt, "startedAt"),
    verifiedAt,
    error,
    artifacts,
  };
}

function parseMapping(value: unknown, index: number): ScopeMigrationMapping {
  const item = record(value, `mappings[${index}]`);
  const expected = ["changed", "observations", "sessions", "source", "target"];
  if (Object.keys(item).sort().join("\0") !== expected.join("\0")) invalid(`mappings[${index}] invalido`);
  if (typeof item.changed !== "boolean") invalid(`mappings[${index}].changed invalido`);
  return {
    source: text(item.source, `mappings[${index}].source`),
    target: text(item.target, `mappings[${index}].target`),
    observations: nonNegativeInteger(item.observations, `mappings[${index}].observations`),
    sessions: nonNegativeInteger(item.sessions, `mappings[${index}].sessions`),
    changed: item.changed,
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${field} debe ser objeto`);
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field} debe ser lista`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) invalid(`${field} debe ser texto`);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return text(value, field);
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result))) {
    invalid(`${field} debe ser una fecha ISO UTC`);
  }
  return result;
}

function hash(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(`${field} debe ser sha256`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${field} debe ser entero no negativo`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const result = nonNegativeInteger(value, field);
  if (result < 1) invalid(`${field} debe ser positivo`);
  return result;
}

function invalid(message: string): never {
  throw new MemoryError("MEMORY_FORMAT", `Manifiesto de migracion invalido: ${message}.`);
}
