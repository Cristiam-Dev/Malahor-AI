import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveCanonicalProjectScope, type ProjectAliases } from "../../cli/core/project";
import type { MnemoDb, Observation, ObservationType, SessionSummary } from "../db";
import { MemoryError } from "../engine/errors";
import { canonicalScope } from "../engine/observations";
import { privateDirectory, privateFile } from "../engine/paths";
import type { LegacyMemorySnapshot, ObservationTypeMigrationCount, ScopeMigrationCount, ScopeMigrationMapping } from "./types";

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const OBSERVATION_KEYS = ["content", "created_at", "id", "project", "tags", "title", "type"];
const SESSION_KEYS = ["created_at", "project", "summary"];
const ROOT_KEYS = ["nextId", "observations", "sessions"];
const OBSERVATION_TYPES = new Set<ObservationType>(["decision", "bug", "pattern", "architecture", "learning", "general"]);

export function readLegacyMemorySnapshot(file: string, aliases: ProjectAliases): LegacyMemorySnapshot {
  const resolved = path.resolve(file);
  privateDirectory(path.dirname(resolved));
  privateFile(resolved);
  const { raw, mtimeMs } = readStableBytes(resolved, MAX_SOURCE_BYTES);
  if (raw.length === 0) throw formatError("el origen esta vacio");
  if (raw.length > MAX_SOURCE_BYTES) throw formatError(`el origen excede ${MAX_SOURCE_BYTES} bytes`);
  if (!isUtf8(raw)) throw formatError("el origen no es UTF-8 valido");

  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch (error) {
    throw formatError(`JSON invalido: ${(error as Error).message}`);
  }
  const source = record(parsed, "raiz");
  exactKeys(source, ROOT_KEYS, "raiz");
  const rawObservations = list(source.observations, "observations");
  const rawSessions = list(source.sessions, "sessions");
  const ids = new Set<number>();
  const mappingCounts = new Map<string, ScopeMigrationMapping>();
  const observations = rawObservations.map((value, index) => parseObservation(value, index, aliases, ids, mappingCounts));
  const sessions = rawSessions.map((value, index) => parseSession(value, index, aliases, mappingCounts));
  const nextId = safePositiveInteger(source.nextId, "nextId");
  const maxObservationId = observations.reduce((max, item) => Math.max(max, item.id), 0);
  if (nextId <= maxObservationId) throw formatError("nextId debe ser mayor que el mayor ID de observacion");
  const db = { observations, sessions, nextId };
  const mappings = [...mappingCounts.values()].sort((left, right) => left.source.localeCompare(right.source));
  return {
    path: resolved,
    raw,
    hash: digest(raw),
    size: raw.length,
    mtimeMs,
    db,
    recordsDigest: digest(JSON.stringify(db)),
    maxObservationId,
    mappings,
    aliasCollisions: aliasCollisions(mappings),
    counts: scopeCounts(db),
    typeCounts: observationTypeCounts(db),
  };
}

export function legacySessionIds(snapshot: LegacyMemorySnapshot): string[] {
  return snapshot.db.sessions.map((_, index) => `legacy:${snapshot.hash}:${index}`);
}

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readStableBytes(file: string, maximumBytes: number): { raw: Buffer; mtimeMs: number } {
  const pathStat = fs.lstatSync(file);
  if (pathStat.size > maximumBytes) throw formatError(`el origen excede ${maximumBytes} bytes`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.size !== pathStat.size
      || before.mtimeMs !== pathStat.mtimeMs || before.ctimeMs !== pathStat.ctimeMs
      || before.size > maximumBytes) {
      throw new MemoryError("MEMORY_BUSY", "El origen JSON cambio antes de la lectura; repite el preview.");
    }
    const raw = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new MemoryError("MEMORY_BUSY", "El origen JSON cambio durante la lectura; repite el preview.");
    }
    return { raw, mtimeMs: after.mtimeMs };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseObservation(value: unknown, index: number, aliases: ProjectAliases, ids: Set<number>,
  mappings: Map<string, ScopeMigrationMapping>): Observation {
  const item = record(value, `observations[${index}]`);
  exactKeys(item, OBSERVATION_KEYS, `observations[${index}]`);
  const id = safePositiveInteger(item.id, `observations[${index}].id`);
  if (ids.has(id)) throw formatError(`ID duplicado: ${id}`);
  ids.add(id);
  const sourceScope = nonEmptyText(item.project, `observations[${index}].project`);
  const project = canonical(sourceScope, aliases);
  countMapping(mappings, sourceScope, project, "observations");
  const type = text(item.type, `observations[${index}].type`) as ObservationType;
  if (!OBSERVATION_TYPES.has(type)) throw formatError(`tipo de observacion invalido en observations[${index}]`);
  return {
    id,
    project,
    type,
    title: text(item.title, `observations[${index}].title`),
    content: text(item.content, `observations[${index}].content`),
    tags: text(item.tags, `observations[${index}].tags`),
    created_at: nonEmptyText(item.created_at, `observations[${index}].created_at`),
  };
}

function parseSession(value: unknown, index: number, aliases: ProjectAliases,
  mappings: Map<string, ScopeMigrationMapping>): SessionSummary {
  const item = record(value, `sessions[${index}]`);
  exactKeys(item, SESSION_KEYS, `sessions[${index}]`);
  const sourceScope = nonEmptyText(item.project, `sessions[${index}].project`);
  const project = canonical(sourceScope, aliases);
  countMapping(mappings, sourceScope, project, "sessions");
  return {
    project,
    summary: text(item.summary, `sessions[${index}].summary`),
    created_at: nonEmptyText(item.created_at, `sessions[${index}].created_at`),
  };
}

function canonical(source: string, aliases: ProjectAliases): string {
  const target = resolveCanonicalProjectScope(source, aliases);
  canonicalScope(target, {});
  return target;
}

function countMapping(mappings: Map<string, ScopeMigrationMapping>, source: string, target: string,
  kind: "observations" | "sessions"): void {
  const key = `${source}\0${target}`;
  const current = mappings.get(key) ?? { source, target, observations: 0, sessions: 0, changed: source !== target };
  current[kind] += 1;
  mappings.set(key, current);
}

function aliasCollisions(mappings: ScopeMigrationMapping[]): Array<{ target: string; sources: string[] }> {
  const targets = new Map<string, Set<string>>();
  for (const mapping of mappings) {
    const sources = targets.get(mapping.target) ?? new Set<string>();
    sources.add(mapping.source);
    targets.set(mapping.target, sources);
  }
  return [...targets.entries()].filter(([, sources]) => sources.size > 1)
    .map(([target, sources]) => ({ target, sources: [...sources].sort() }))
    .sort((left, right) => left.target.localeCompare(right.target));
}

function scopeCounts(db: MnemoDb): ScopeMigrationCount[] {
  const counts = new Map<string, ScopeMigrationCount>();
  for (const item of db.observations) {
    const current = counts.get(item.project) ?? { scope: item.project, observations: 0, sessions: 0 };
    current.observations += 1;
    counts.set(item.project, current);
  }
  for (const item of db.sessions) {
    const current = counts.get(item.project) ?? { scope: item.project, observations: 0, sessions: 0 };
    current.sessions += 1;
    counts.set(item.project, current);
  }
  return [...counts.values()].sort((left, right) => left.scope.localeCompare(right.scope));
}

function observationTypeCounts(db: MnemoDb): ObservationTypeMigrationCount[] {
  const counts = new Map<ObservationType, number>();
  for (const item of db.observations) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => ({ type, count }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw formatError(`${field} debe ser un objeto`);
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw formatError(`${field} debe ser una lista`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: string[], field: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw formatError(`${field} no coincide con el esquema legado esperado`);
  }
}

function safePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw formatError(`${field} debe ser un entero positivo seguro`);
  return value as number;
}

function nonEmptyText(value: unknown, field: string): string {
  const result = text(value, field);
  if (!result.trim()) throw formatError(`${field} no puede estar vacio`);
  return result;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw formatError(`${field} debe ser texto sin NUL`);
  return value;
}

function formatError(message: string): MemoryError {
  return new MemoryError("MEMORY_FORMAT", `Origen JSON invalido: ${message}.`);
}
