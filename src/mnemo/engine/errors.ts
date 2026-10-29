export type MemoryErrorCode = "MEMORY_INPUT" | "MEMORY_RUNTIME" | "MEMORY_FORMAT" | "MEMORY_PATH"
  | "MEMORY_BUSY" | "MEMORY_SQLITE" | "MEMORY_CLOSED" | "MEMORY_ACTIVATION" | "MEMORY_UNSUPPORTED";

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryError";
  }
}

export function sqliteOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    const busy = error instanceof Error && /database (?:is )?(?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message);
    throw new MemoryError(busy ? "MEMORY_BUSY" : "MEMORY_SQLITE",
      busy ? "Memoria ocupada; reintenta la operacion completa." : "Fallo SQLite; no se cambia al JSON ni se reinicializa la base.", { cause: error });
  }
}
