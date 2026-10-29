import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../cli/core/config";
import { MemoryEngine, MemoryError } from "./engine";
import { privateDirectory, privateFile } from "./engine/paths";
import { MEMORY_SCHEMA_VERSION } from "./engine/schema";
import { dbPath } from "./json-store";

export type MemoryLocation = { backend: "json" | "sqlite"; file: string; marker: string };

export function memoryLocation(legacyFile = dbPath()): MemoryLocation {
  const directory = path.join(path.dirname(path.dirname(legacyFile)), "memory");
  const marker = path.join(directory, "active.json");
  let raw: string;
  try {
    privateDirectory(directory);
    privateFile(marker);
    if (fs.statSync(marker).size > 4096) throw new MemoryError("MEMORY_ACTIVATION", "Marcador de memoria demasiado grande.");
    raw = fs.readFileSync(marker, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { backend: "json", file: legacyFile, marker };
    }
    throw new MemoryError("MEMORY_ACTIVATION", "No se puede verificar el marcador de memoria; no se vuelve al JSON.", { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (cause) {
    throw new MemoryError("MEMORY_ACTIVATION", "Marcador de memoria invalido; no se vuelve al JSON.", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "backend,schemaVersion,version"
    || !("version" in parsed && parsed.version === 1 && "backend" in parsed && parsed.backend === "sqlite"
      && "schemaVersion" in parsed && parsed.schemaVersion === MEMORY_SCHEMA_VERSION)) {
    throw new MemoryError("MEMORY_ACTIVATION", "Marcador de memoria no soportado; requiere migracion verificada.");
  }
  return { backend: "sqlite", file: path.join(directory, "db.sqlite"), marker };
}

export function withMemoryStorage<T>(legacyFile: string, access: "read" | "write", handlers: {
  json: (file: string) => T;
  sqlite: (engine: MemoryEngine) => T;
}): T {
  const location = memoryLocation(legacyFile);
  if (location.backend === "json") return handlers.json(location.file);
  const engine = MemoryEngine.open(location.file, { access, aliases: loadConfig().projects.aliases });
  try { return handlers.sqlite(engine); } finally { engine.close(); }
}

export function assertJsonMemory(legacyFile = dbPath()): void {
  if (memoryLocation(legacyFile).backend !== "json") {
    throw new MemoryError("MEMORY_UNSUPPORTED", "Operacion administrativa pendiente de adaptacion SQLite (T-5.3.5); no se escribe al JSON retenido.");
  }
}

export function withSqliteMemory<T>(access: "read" | "write", operation: (engine: MemoryEngine) => T,
  legacyFile = dbPath()): T {
  return withMemoryStorage(legacyFile, access, {
    json: () => { throw new MemoryError("MEMORY_UNSUPPORTED", "Esta operacion requiere memoria v2 activada mediante el migrador verificado."); },
    sqlite: operation,
  });
}
