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
    this.transaction(() => this.assertIntegrity());
  }

  verifyReadOnly(): void {
    this.transaction(() => {
      if (this.get("PRAGMA integrity_check")?.integrity_check !== "ok" || this.all("PRAGMA foreign_key_check").length > 0) {
        throw new MemoryError("MEMORY_FORMAT", "Memoria no supera la comprobacion de integridad SQLite/FK.");
      }
      this.validateFormat();
    }, false);
  }

  restore(source: string): void {
    if (this.access === "read") throw new MemoryError("MEMORY_UNSUPPORTED", "Restore requiere conexion de escritura.");
    if (this.transactionActive) throw new MemoryError("MEMORY_UNSUPPORTED", "Restore requiere una conexion fuera de transaccion.");
    const resolved = path.resolve(source);
    existingDatabase(resolved);
    this.run("ATTACH DATABASE ? AS restore_source", [resolved]);
    try {
      this.transaction(() => {
        this.assertAttachedFormat();
        this.run("DELETE FROM relations");
        this.run("DELETE FROM pins");
        this.run("DELETE FROM observations");
        this.run("DELETE FROM sessions");
        for (const row of this.all("SELECT path FROM scopes WHERE path <> 'global' ORDER BY depth DESC, path DESC")) {
          this.run("DELETE FROM scopes WHERE path = ?", [rowText(row, "path")]);
        }
        this.run(`INSERT INTO scopes(path, parent_path, depth)
          SELECT path, parent_path, depth FROM restore_source.scopes WHERE path <> 'global' ORDER BY depth, path`);
        this.run(`INSERT INTO observations(id, scope_path, type, title, content, tags, created_at, position)
          SELECT id, scope_path, type, title, content, tags, created_at, position FROM restore_source.observations ORDER BY position`);
        this.run(`INSERT INTO sessions(id, scope_path, summary, created_at, position)
          SELECT id, scope_path, summary, created_at, position FROM restore_source.sessions ORDER BY position`);
        this.run(`INSERT INTO pins(observation_id, created_at)
          SELECT observation_id, created_at FROM restore_source.pins ORDER BY observation_id`);
        this.run(`INSERT INTO relations(source_id, target_id, kind, created_at)
          SELECT source_id, target_id, kind, created_at FROM restore_source.relations ORDER BY source_id, target_id, kind`);
        this.run(`UPDATE memory_state SET
          next_observation_id = (SELECT next_observation_id FROM restore_source.memory_state WHERE singleton = 1),
          next_observation_position = (SELECT next_observation_position FROM restore_source.memory_state WHERE singleton = 1),
          next_session_position = (SELECT next_session_position FROM restore_source.memory_state WHERE singleton = 1)
          WHERE singleton = 1`);
        this.assertRestoreMatchesSource();
        this.assertIntegrity();
      });
    } finally {
      this.run("DETACH DATABASE restore_source");
    }
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
        try {
          copy.integrity();
          copy.seal();
        } finally { copy.close(); }
        if (fs.existsSync(`${target}-wal`) || fs.existsSync(`${target}-shm`)) {
          throw new MemoryError("MEMORY_SQLITE", "El backup SQLite conserva WAL/SHM despues de sellarse.");
        }
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

  checkpoint(): void {
    if (this.access === "read") throw new MemoryError("MEMORY_UNSUPPORTED", "Checkpoint requiere conexion de escritura.");
    if (this.transactionActive) throw new MemoryError("MEMORY_UNSUPPORTED", "Checkpoint requiere una conexion fuera de transaccion.");
    const result = this.get("PRAGMA wal_checkpoint(TRUNCATE)");
    if (result && "busy" in result && rowNumber(result, "busy") !== 0) {
      throw new MemoryError("MEMORY_BUSY", "SQLite no pudo cerrar el WAL provisional.");
    }
  }

  seal(): void {
    if (this.access === "read") throw new MemoryError("MEMORY_UNSUPPORTED", "Sellar SQLite requiere conexion de escritura.");
    if (this.transactionActive) throw new MemoryError("MEMORY_UNSUPPORTED", "Sellar SQLite requiere una conexion fuera de transaccion.");
    this.checkpoint();
    if (this.get("PRAGMA journal_mode = DELETE")?.journal_mode !== "delete") {
      throw new MemoryError("MEMORY_SQLITE", "SQLite no pudo sellar el backup sin WAL.");
    }
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

  private assertAttachedFormat(): void {
    if (rowNumber(this.get("PRAGMA restore_source.application_id"), "application_id") !== MEMORY_APPLICATION_ID
      || rowNumber(this.get("PRAGMA restore_source.user_version"), "user_version") !== MEMORY_SCHEMA_VERSION
      || this.get("PRAGMA restore_source.integrity_check")?.integrity_check !== "ok"
      || this.all("PRAGMA restore_source.foreign_key_check").length > 0) {
      throw new MemoryError("MEMORY_FORMAT", "El backup SQLite no supera formato/integridad/FK.");
    }
  }

  private assertRestoreMatchesSource(): void {
    const tables: Array<[string, string]> = [
      ["memory_state", "singleton, next_observation_id, next_observation_position, next_session_position"],
      ["scopes", "path, parent_path, depth"],
      ["observations", "id, scope_path, type, title, content, tags, created_at, position"],
      ["sessions", "id, scope_path, summary, created_at, position"],
      ["pins", "observation_id, created_at"],
      ["relations", "source_id, target_id, kind, created_at"],
    ];
    for (const [table, columns] of tables) {
      const difference = this.get(`SELECT 1 AS mismatch FROM (
        SELECT 1 FROM (
          SELECT ${columns} FROM main.${table} EXCEPT SELECT ${columns} FROM restore_source.${table}
        )
        UNION ALL
        SELECT 1 FROM (
          SELECT ${columns} FROM restore_source.${table} EXCEPT SELECT ${columns} FROM main.${table}
        )
      ) LIMIT 1`);
      if (difference) throw new MemoryError("MEMORY_FORMAT", `Restore SQLite no reprodujo la tabla ${table}.`);
    }
  }

  private assertIntegrity(): void {
    if (this.get("PRAGMA integrity_check")?.integrity_check !== "ok" || this.all("PRAGMA foreign_key_check").length > 0) {
      throw new MemoryError("MEMORY_FORMAT", "Memoria no supera la comprobacion de integridad SQLite/FK.");
    }
    this.validateFormat();
    this.run("INSERT INTO observations_fts(observations_fts, rank) VALUES ('integrity-check', 1)");
  }
}
