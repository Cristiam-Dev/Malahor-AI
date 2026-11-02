export const HORIEL_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "conflict",
  "busy",
  "unavailable",
  "capability_missing",
  "unsafe_path",
  "integrity_failed",
  "future_schema",
  "budget_exceeded",
  "confirmation_mismatch",
] as const;

export type HorielErrorCode = typeof HORIEL_ERROR_CODES[number];

export class HorielError extends Error {
  readonly code: HorielErrorCode;

  constructor(code: HorielErrorCode, message: string) {
    super(message);
    this.name = "HorielError";
    this.code = code;
  }
}

export function invalidInput(message: string): never {
  throw new HorielError("invalid_input", message);
}

export function normalizeStoreError(error: unknown): HorielError {
  if (error instanceof HorielError) return error;
  return new HorielError("unavailable", "Horiel store operation is unavailable.");
}

export async function storeOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeStoreError(error);
  }
}
