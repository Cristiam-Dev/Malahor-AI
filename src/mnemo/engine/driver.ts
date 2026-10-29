import { createRequire } from "node:module";
import { MemoryError } from "./errors";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  get(...values: SqlValue[]): SqlRow | null | undefined;
  all(...values: SqlValue[]): SqlRow[];
  run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  finalize?(): void;
}

export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
  close(): void;
}

type DatabaseConstructor = new (file: string, options: Record<string, boolean>) => SqlDatabase;
const modules = { node: "node:sqlite", bun: "bun:sqlite" };
const requireNative = createRequire(import.meta.url);

export function openNativeDatabase(file: string, readonly: boolean): SqlDatabase {
  const runtime = process.versions.bun ? "bun" : "node";
  if (runtime === "node") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 18)) {
      throw new MemoryError("MEMORY_RUNTIME", "SQLite requiere Node >=22.18.0 con FTS5 o Bun compatible.");
    }
  }
  try {
    // La carga sincronica mantiene las APIs MCP existentes; el nombre variable evita
    // que Bun 1.2 resuelva node:sqlite incluso cuando ejecuta el driver de Bun.
    const native = requireNative(modules[runtime]) as { Database?: DatabaseConstructor; DatabaseSync?: DatabaseConstructor };
    const Constructor = runtime === "bun" ? native.Database : native.DatabaseSync;
    if (typeof Constructor !== "function") throw new Error("Driver SQLite no disponible");
    return runtime === "bun"
      ? new Constructor(file, { readonly, strict: true, create: false })
      : new Constructor(file, { readOnly: readonly, allowExtension: false });
  } catch (cause) {
    throw new MemoryError("MEMORY_RUNTIME", `No se pudo abrir SQLite con ${modules[runtime]}.`, { cause });
  }
}

export function rowNumber(row: SqlRow | null | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MemoryError("MEMORY_FORMAT", `Campo SQLite invalido: ${key}`);
  }
  return value;
}

export function rowText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new MemoryError("MEMORY_FORMAT", `Campo SQLite invalido: ${key}`);
  return value;
}
