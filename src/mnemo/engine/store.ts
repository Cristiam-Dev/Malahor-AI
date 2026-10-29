import fs from "node:fs";
import path from "node:path";
import { openNativeDatabase, rowNumber, rowText, type SqlDatabase, type SqlRow, type SqlStatement, type SqlValue } from "./driver";
import { MemoryError, sqliteOperation } from "./errors";
import { createPrivateFile, existingDatabase, privateFile } from "./paths";
import { MEMORY_APPLICATION_ID, MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from "./schema";

export type StoreAccess = "create" | "read" | "write";

export class MemoryStore {
  private closed = false;
  private transactionActive = false;

  private constructor(readonly file: string, readonly access: StoreAccess, private readonly db: SqlDatabase) {}

  static open(file: string, access: StoreAccess = "read"): MemoryStore {
    const resolved = path.resolve(file);
    return sqliteOperation(() => {
      if (access === "create") createPrivateFile(resolved);
      else existingDatabase(resolved);
      const db = openNativeDatabase(resolved, access === "read");
      const store = new MemoryStore(resolved, access, db);
      try {
        db.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 250");
        if (store.get("PRAGMA foreign_keys")?.foreign_keys !== 1 || store.get("PRAGMA trusted_schema")?.trusted_schema !== 0) {
          throw new MemoryError("MEMORY_RUNTIME", "SQLite no habilita los controles de integridad/esquema requeridos.");
        }
        if (access === "create") store.transaction(() => db.exec(MEMORY_SCHEMA));
        store.validateFormat();
        if (access !== "read") {
          if (store.get("PRAGMA journal_mode = WAL")?.journal_mode !== "wal") throw new MemoryError("MEMORY_FORMAT", "Memoria requiere WAL.");
          db.exec("PRAGMA synchronous = FULL");
        }
        return store;
      } catch (error) {
        store.close();
        throw error;
      }
    });
  }

  get(sql: string, values: SqlValue[] = []): SqlRow | null {
    return this.statement(sql, (statement) => {
      const row = statement.get(...values);
      return row ? { ...row } : null;
    });
  }

  all(sql: string, values: SqlValue[] = []): SqlRow[] {
    return this.statement(sql, (statement) => statement.all(...values).map((row) => ({ ...row })));
  }

  run(sql: string, values: SqlValue[] = []): void {
    if (this.access === "read") throw new MemoryError("MEMORY_UNSUPPORTED", "Conexion de memoria de solo lectura.");
    this.statement(sql, (statement) => statement.run(...values));
  }

  transaction<T>(operation: () => T, write = true): T {
    if (this.transactionActive) throw new MemoryError("MEMORY_UNSUPPORTED", "No se permiten transacciones anidadas.");
    if (write && this.access === "read") throw new MemoryError("MEMORY_UNSUPPORTED", "Conexion de memoria de solo lectura.");
    return this.operation(() => {
      this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      this.transactionActive = true;
      try {
        const result = operation();
        if (result instanceof Promise) throw new MemoryError("MEMORY_UNSUPPORTED", "Las transacciones de memoria deben ser sincronicas.");
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.transactionActive = false;
      }
    });
  }

  integrity(): void {
    this.transaction(() => {
      if (this.get("PRAGMA integrity_check")?.integrity_check !== "ok" || this.all("PRAGMA foreign_key_check").length > 0) {
        throw new MemoryError("MEMORY_FORMAT", "Memoria no supera la comprobacion de integridad SQLite/FK.");
      }
      this.validateFormat();
      this.run("INSERT INTO observations_fts(observations_fts, rank) VALUES ('integrity-check', 1)");
    });
  }

  backup(destination: string): string {
    if (this.transactionActive) throw new MemoryError("MEMORY_UNSUPPORTED", "Backup requiere una conexion fuera de transaccion.");
    const target = path.resolve(destination);
    return this.operation(() => {
      createPrivateFile(target);
      try {
        this.statement("VACUUM INTO ?", (statement) => statement.run(target));
        privateFile(target);
        const copy = MemoryStore.open(target, "write");
        try { copy.integrity(); } finally { copy.close(); }
        return target;
      } catch (error) {
        for (const suffix of ["-shm", "-wal", ""]) {
          try { fs.unlinkSync(`${target}${suffix}`); } catch (cleanupError) {
            if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
              throw new MemoryError("MEMORY_SQLITE", "Backup fallo y su archivo provisional no pudo retirarse.", { cause: cleanupError });
            }
          }
        }
        throw error;
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private operation<T>(operation: () => T): T {
    if (this.closed) throw new MemoryError("MEMORY_CLOSED", "La conexion de memoria esta cerrada.");
    return sqliteOperation(operation);
  }

  private statement<T>(sql: string, operation: (statement: SqlStatement) => T): T {
    return this.operation(() => {
      const statement = this.db.prepare(sql);
      try { return operation(statement); } finally {
        // Bun necesita finalizar statements para cerrar realmente la conexion
        // y retirar WAL/SHM, sin esperar a un ciclo del garbage collector.
        statement.finalize?.();
      }
    });
  }

  private validateFormat(): void {
    if (rowNumber(this.get("PRAGMA application_id"), "application_id") !== MEMORY_APPLICATION_ID
      || rowNumber(this.get("PRAGMA user_version"), "user_version") !== MEMORY_SCHEMA_VERSION) {
      throw new MemoryError("MEMORY_FORMAT", "Formato/version de memoria no soportado; no se migra ni reinicia automaticamente.");
    }
    const required = ["memory_state", "scopes", "observations", "sessions", "pins", "relations", "observations_fts",
      "scopes_parent_depth", "scopes_immutable", "observations_fts_insert", "observations_fts_delete", "observations_fts_update"];
    const objects = new Set(this.all("SELECT name FROM sqlite_schema WHERE type IN ('table', 'trigger')").map((row) => rowText(row, "name")));
    if (required.some((name) => !objects.has(name))) throw new MemoryError("MEMORY_FORMAT", "Esquema de memoria incompleto.");
    const state = this.get(`SELECT *, (SELECT coalesce(max(id), 0) FROM observations) AS max_id,
      (SELECT coalesce(max(position), -1) FROM observations) AS observation_position,
      (SELECT coalesce(max(position), -1) FROM sessions) AS session_position FROM memory_state WHERE singleton = 1`);
    if (rowNumber(state, "next_observation_id") <= rowNumber(state, "max_id")
      || rowNumber(state, "next_observation_position") <= rowNumber(state, "observation_position")
      || rowNumber(state, "next_session_position") <= rowNumber(state, "session_position")) {
      throw new MemoryError("MEMORY_FORMAT", "Contadores de memoria inconsistentes.");
    }
    this.all("SELECT rowid FROM observations_fts WHERE observations_fts MATCH ? LIMIT 1", ['"capabilityprobe"']);
  }
}
