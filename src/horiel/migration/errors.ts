export const HORIEL_MIGRATION_ERROR_CODES = [
  "invalid_input",
  "boundary",
  "source_invalid",
  "blocked",
  "preview_mismatch",
  "manifest_invalid",
  "verification_failed",
  "fault_injected",
  "busy",
  "integrity_failed",
] as const;

export type HorielMigrationErrorCode = typeof HORIEL_MIGRATION_ERROR_CODES[number];

export class HorielMigrationError extends Error {
  readonly code: HorielMigrationErrorCode;

  constructor(code: HorielMigrationErrorCode, message: string) {
    super(message);
    this.name = "HorielMigrationError";
    this.code = code;
  }
}

export function migrationFailure(code: HorielMigrationErrorCode, message: string): never {
  throw new HorielMigrationError(code, message);
}

export function normalizeMigrationFailure(
  error: unknown,
  fallback: HorielMigrationErrorCode,
  message: string,
): HorielMigrationError {
  if (error instanceof HorielMigrationError) return error;
  return new HorielMigrationError(fallback, message);
}
