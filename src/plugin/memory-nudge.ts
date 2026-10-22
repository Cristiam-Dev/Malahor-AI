import path from "node:path";

import { resolveProject } from "../cli/core/project";
import type { CompactionStorage } from "./compaction";

export const MALAHOR_MEMORY_NUDGE_MARKER = "<!-- malahor-memory-nudge:v1 -->";
export const DEFAULT_MEMORY_STALE_MINUTES = 15;

export interface MemoryNudgeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  resolveSessionDirectory?: (sessionID: string) => Promise<string | undefined>;
  now?: () => number;
  staleMinutes?: number;
}

export async function maybeInjectMemoryNudge(
  input: Record<string, unknown>,
  storage: CompactionStorage,
  options: MemoryNudgeOptions,
): Promise<{ ok: boolean; injected: boolean; reason?: string }> {
  if (typeof storage.get !== "function") return { ok: false, injected: false, reason: "ctx.storage.get no disponible" };

  const sessionID = stringValue(input.sessionID);
  if (!sessionID) return { ok: false, injected: false, reason: "sessionID ausente" };

  const now = options.now ?? Date.now;
  const timestamp = now();
  const directory = await resolveDirectory(sessionID, options);
  const project = resolveProject(directory).canonicalKey;
  const thresholdMs = staleMinutes(options) * 60_000;
  const sessionKey = `memory/nudge/${encodeURIComponent(sessionID)}`;
  const freshnessKey = `memory/freshness/${encodeURIComponent(project)}`;

  try {
    const [sessionRecord, freshnessRecord] = await Promise.all([
      storage.get(sessionKey),
      storage.get(freshnessKey),
    ]);
    const session = recordValue(sessionRecord);
    const freshness = recordValue(freshnessRecord);
    const startedAt = timestampValue(session?.startedAt) ?? timestamp;
    const lastNudgedAt = timestampValue(session?.lastNudgedAt);
    const lastPersistedAt = timestampValue(freshness?.lastPersistedAt);
    const reference = Math.max(startedAt, lastPersistedAt ?? 0);

    if (!lastNudgedAt && !session) {
      await storage.set(sessionKey, { schema: 1, sessionID, project, startedAt: new Date(timestamp).toISOString() });
    }

    if (timestamp - reference < thresholdMs || (lastNudgedAt !== undefined && timestamp - lastNudgedAt < thresholdMs)) {
      return { ok: true, injected: false };
    }

    const injected = injectMemoryNudge(input, staleMinutes(options));
    if (!injected) return { ok: true, injected: false };

    await storage.set(sessionKey, {
      schema: 1,
      sessionID,
      project,
      startedAt: new Date(startedAt).toISOString(),
      lastNudgedAt: new Date(timestamp).toISOString(),
    });
    return { ok: true, injected: true };
  } catch (error) {
    return { ok: false, injected: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function markMemoryPersisted(
  input: Record<string, unknown>,
  storage: CompactionStorage,
  options: MemoryNudgeOptions,
): Promise<{ ok: boolean; marked: boolean; reason?: string }> {
  const tool = stringValue(input.tool)?.toLowerCase() ?? "";
  if (input.status !== "completed" || !isMemoryPersistenceTool(tool)) return { ok: true, marked: false };

  const sessionID = stringValue(input.sessionID);
  if (!sessionID) return { ok: false, marked: false, reason: "sessionID ausente" };
  const directory = await resolveDirectory(sessionID, options);
  const project = resolveProject(directory).canonicalKey;
  const now = (options.now ?? Date.now)();
  const key = `memory/freshness/${encodeURIComponent(project)}`;

  try {
    await storage.set(key, {
      schema: 1,
      project,
      lastPersistedAt: new Date(now).toISOString(),
      source: tool,
    });
    return { ok: true, marked: true };
  } catch (error) {
    return { ok: false, marked: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function injectMemoryNudge(input: Record<string, unknown>, minutes: number): boolean {
  const system = Array.isArray(input.system) ? input.system : [];
  if (system.some((part) => isTextPart(part) && part.text.includes(MALAHOR_MEMORY_NUDGE_MARKER))) return false;

  const instructions = `${MALAHOR_MEMORY_NUDGE_MARKER}
RECORDATORIO DE MEMORIA MALAHOR
La memoria operativa lleva más de ${minutes} minutos sin persistencia confirmada.
Antes de continuar, guarda un mem_session_summary con objetivo, estado, decisiones, validaciones, bloqueos y próximo paso exacto. No guardes secretos ni PII innecesaria.`;
  const last = system.at(-1);
  if (isTextPart(last)) last.text = `${last.text}\n\n${instructions}`;
  else system.push({ type: "text", text: instructions });
  input.system = system;
  return true;
}

export function isMemoryPersistenceTool(tool: string): boolean {
  return tool.includes("mem_session_summary") || tool.includes("mem_save");
}

function staleMinutes(options: MemoryNudgeOptions): number {
  const configured = options.staleMinutes ?? Number(options.env?.MALAHOR_MEMORY_STALE_MINUTES);
  if (!Number.isFinite(configured)) return DEFAULT_MEMORY_STALE_MINUTES;
  return Math.min(24 * 60, Math.max(1, Math.floor(configured)));
}

async function resolveDirectory(sessionID: string, options: MemoryNudgeOptions): Promise<string> {
  if (options.resolveSessionDirectory) {
    try {
      const directory = await options.resolveSessionDirectory(sessionID);
      if (directory) return path.resolve(directory);
    } catch {
      // El nudge es auxiliar; usa el cwd de la instancia.
    }
  }
  return path.resolve(options.cwd);
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  const record = recordValue(value);
  return record?.type === "text" && typeof record.text === "string";
}
