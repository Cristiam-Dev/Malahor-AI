import path from "node:path";

import { resolveProject } from "../cli/core/project";
import type { CompactionStorage } from "./compaction";

export interface EventDomain {
  subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
}

export interface EventCaptureOptions {
  cwd: string;
  captureSubagentsOptIn: boolean;
  resolveSessionDirectory?: (sessionID: string) => Promise<string | undefined>;
  onError?: (message: string) => void;
}

export interface EventCaptureRegistration {
  ok: boolean;
  cleanup: () => void;
  done: Promise<void>;
}

const SESSION_LIFECYCLE_EVENTS = new Set([
  "session.created",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.deleted",
  "session.forked",
  "session.tool.success",
  "session.tool.failed",
]);

export function startEventCapture(
  domain: EventDomain,
  storage: CompactionStorage,
  options: EventCaptureOptions,
): EventCaptureRegistration {
  const controller = new AbortController();

  try {
    const stream = domain.subscribe({ signal: controller.signal });
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
      return { ok: false, cleanup: () => controller.abort(), done: Promise.resolve() };
    }

    const done = consumeEvents(stream, storage, options).catch((error) => {
      options.onError?.(error instanceof Error ? error.message : String(error));
    });
    return { ok: true, cleanup: () => controller.abort(), done };
  } catch (error) {
    options.onError?.(error instanceof Error ? error.message : String(error));
    return { ok: false, cleanup: () => controller.abort(), done: Promise.resolve() };
  }
}

async function consumeEvents(
  stream: AsyncIterable<unknown>,
  storage: CompactionStorage,
  options: EventCaptureOptions,
): Promise<void> {
  for await (const event of stream) {
    const record = await eventRecord(event, options);
    if (!record) continue;

    try {
      await storage.set(record.key, record.value);
    } catch (error) {
      options.onError?.(`persistencia de evento degradada: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function eventRecord(
  value: unknown,
  options: EventCaptureOptions,
): Promise<{ key: string; value: Record<string, unknown> } | null> {
  const event = recordValue(value);
  if (!event || typeof event.type !== "string" || !SESSION_LIFECYCLE_EVENTS.has(event.type)) return null;

  const data = recordValue(event.data) ?? {};
  const sessionID = stringValue(data.sessionID) ?? stringValue(event.aggregateID);
  if (!sessionID) return null;

  const parentID = stringValue(data.parentID);
  const agent = stringValue(data.agent);
  const subagent = Boolean(parentID) || Boolean(agent?.startsWith("malahor-"));
  if (subagent && !options.captureSubagentsOptIn) return null;

  const directory = stringValue(recordValue(data.location)?.directory)
    ?? stringValue(recordValue(event.location)?.directory)
    ?? await resolveDirectory(sessionID, options);
  const project = resolveProject(directory).canonicalKey;
  const eventID = stringValue(event.id) ?? stringValue(event.seq) ?? `${event.type}:${sessionID}:${event.created ?? Date.now()}`;
  const key = `session/events/${encodeURIComponent(project)}/${encodeURIComponent(eventID)}`;

  return {
    key,
    value: {
      schema: 1,
      kind: "session.event",
      type: event.type,
      eventID,
      sessionID,
      project,
      ...(agent ? { agent } : {}),
      ...(parentID ? { parentID } : {}),
      subagent,
      occurredAt: new Date(timestampValue(event.created) ?? Date.now()).toISOString(),
      status: statusForEvent(event.type),
    },
  };
}

async function resolveDirectory(sessionID: string, options: EventCaptureOptions): Promise<string> {
  if (options.resolveSessionDirectory) {
    try {
      const directory = await options.resolveSessionDirectory(sessionID);
      if (directory) return path.resolve(directory);
    } catch {
      // La captura es auxiliar; el cwd de la instancia es el fallback seguro.
    }
  }
  return path.resolve(options.cwd);
}

function statusForEvent(type: string): string {
  if (type.endsWith(".succeeded") || type.endsWith(".success") || type === "session.idle") return "succeeded";
  if (type.endsWith(".failed")) return "failed";
  if (type.endsWith(".interrupted")) return "interrupted";
  return "observed";
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
