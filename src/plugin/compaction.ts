export const MALAHOR_COMPACTION_MARKER = "<!-- malahor-compaction-protocol:v1 -->";

export interface CompactionStorage {
  set: (key: string, value: Record<string, unknown>) => Promise<void>;
}

export interface CompactionOptions {
  cwd: string;
  resolveSessionDirectory?: (sessionID: string) => Promise<string | undefined>;
}

export async function checkpointBeforeCompaction(
  input: Record<string, unknown>,
  storage: CompactionStorage,
  options: CompactionOptions,
): Promise<{ ok: boolean; key?: string; reason?: string }> {
  const sessionID = stringValue(input.sessionID);
  if (!sessionID) return { ok: false, reason: "sessionID ausente" };

  const directory = await resolveDirectory(sessionID, options);
  const messageCount = Array.isArray(input.messages) ? input.messages.length : 0;
  const value = {
    schema: 1,
    kind: "compaction.pending",
    sessionID,
    directory,
    messageCount,
    createdAt: new Date().toISOString(),
    memoryTool: "mem_session_summary",
    status: "pending",
  };
  const key = `compaction/${sessionID}`;

  try {
    await storage.set(key, value);
    return { ok: true, key };
  } catch (error) {
    return { ok: false, key, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function injectCompactionInstructions(input: Record<string, unknown>): boolean {
  const system = Array.isArray(input.system) ? input.system : [];
  if (system.some((part) => isTextPart(part) && part.text.includes(MALAHOR_COMPACTION_MARKER))) return false;

  const instructions = `${MALAHOR_COMPACTION_MARKER}
CHECKPOINT DE COMPACTACIÓN MALAHOR
- Antes de continuar después de esta compactación, guarda un mem_session_summary en el scope activo.
- Incluye objetivo, estado, decisiones, archivos relevantes, validaciones, bloqueos y próximo paso exacto.
- No persistas secretos, tokens, passwords, PII innecesaria ni llaves privadas.
- No afirmes que la memoria fue guardada hasta que mem_session_summary confirme éxito.`;
  const last = system.at(-1);
  if (isTextPart(last)) {
    last.text = `${last.text}\n\n${instructions}`;
  } else {
    system.push({ type: "text", text: instructions });
  }

  input.system = system;
  return true;
}

async function resolveDirectory(sessionID: string, options: CompactionOptions): Promise<string> {
  if (options.resolveSessionDirectory) {
    try {
      const directory = await options.resolveSessionDirectory(sessionID);
      if (directory) return directory;
    } catch {
      // El checkpoint es auxiliar; usa el cwd de la instancia sin bloquear compaction.
    }
  }
  return options.cwd;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "text"
    && typeof (value as Record<string, unknown>).text === "string";
}
