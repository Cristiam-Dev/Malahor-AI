import fs from "node:fs";

import { assertSafeSourceFile } from "./boundary";
import { migrationFailure, normalizeMigrationFailure } from "./errors";
import type {
  MigrationSourceSnapshot,
  SourceObservation,
  SourceSession,
} from "./model";

const OBSERVATION_KEYS = ["content", "created_at", "id", "project", "tags", "title", "type"];
const SESSION_KEYS = ["created_at", "project", "summary"];
const ROOT_KEYS = ["nextId", "observations", "sessions"];
const MEMORY_TYPES = new Set(["decision", "bug", "pattern", "architecture", "learning", "general"]);

export function readJsonMigrationSource(filePath: string): MigrationSourceSnapshot {
  assertSafeSourceFile(filePath);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw normalizeMigrationFailure(error, "source_invalid", "Mnemo JSON source is invalid.");
  }
  const root = exactRecord(value, ROOT_KEYS, "Mnemo JSON source is invalid.");
  if (!Array.isArray(root.observations) || !Array.isArray(root.sessions)
    || !Number.isSafeInteger(root.nextId) || Number(root.nextId) < 1) {
    return migrationFailure("source_invalid", "Mnemo JSON source is invalid.");
  }

  const seen = new Set<number>();
  const observations: SourceObservation[] = root.observations.map((member, position) => {
    const record = exactRecord(member, OBSERVATION_KEYS, "Mnemo JSON observation is invalid.");
    const id = Number(record.id);
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)
      || typeof record.project !== "string" || typeof record.type !== "string"
      || !MEMORY_TYPES.has(record.type) || typeof record.title !== "string"
      || typeof record.content !== "string" || typeof record.tags !== "string"
      || typeof record.created_at !== "string") {
      return migrationFailure("source_invalid", "Mnemo JSON observation is invalid.");
    }
    seen.add(id);
    return {
      stableKey: `json:observation:${id}`,
      id,
      scope: record.project,
      type: record.type as SourceObservation["type"],
      title: record.title,
      content: record.content,
      tags: record.tags,
      createdAt: record.created_at,
      position,
    };
  });
  if (Number(root.nextId) <= Math.max(0, ...observations.map(({ id }) => id))) {
    return migrationFailure("source_invalid", "Mnemo JSON counter is invalid.");
  }

  const sessions: SourceSession[] = root.sessions.map((member, position) => {
    const record = exactRecord(member, SESSION_KEYS, "Mnemo JSON session is invalid.");
    if (typeof record.project !== "string" || typeof record.summary !== "string"
      || typeof record.created_at !== "string") {
      return migrationFailure("source_invalid", "Mnemo JSON session is invalid.");
    }
    return {
      stableKey: `json:session:${position}`,
      scope: record.project,
      summary: record.summary,
      createdAt: record.created_at,
      position,
    };
  });

  const scopePaths = [...new Set([
    "global",
    ...observations.map(({ scope }) => scope),
    ...sessions.map(({ scope }) => scope),
  ])].sort((left, right) => left.localeCompare(right));
  return {
    backend: "json",
    state: {
      nextObservationId: Number(root.nextId),
      nextObservationPosition: observations.length,
      nextSessionPosition: sessions.length,
    },
    scopes: scopePaths.map((scope) => {
      const segments = scope.split("/");
      return {
        path: scope,
        parentPath: segments.length === 1 ? null : segments.slice(0, -1).join("/"),
        depth: Math.max(0, segments.length - 1),
      };
    }),
    observations,
    sessions,
    pins: [],
    relations: [],
  };
}

function exactRecord(value: unknown, keys: string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return migrationFailure("source_invalid", message);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    return migrationFailure("source_invalid", message);
  }
  return record;
}
