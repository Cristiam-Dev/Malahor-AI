import fs from "node:fs";
import path from "node:path";
import { MemoryError } from "./errors";

export function privateDirectory(directory: string, create = false): void {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MemoryError("MEMORY_PATH", "La carpeta de memoria debe ser un directorio real.");
  if (process.getuid && stat.uid !== process.getuid()) throw new MemoryError("MEMORY_PATH", "La carpeta de memoria pertenece a otro usuario.");
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    throw new MemoryError("MEMORY_PATH", "La carpeta de memoria requiere permisos 0700.");
  }
}

export function privateFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new MemoryError("MEMORY_PATH", "Memoria solo acepta archivos regulares privados, sin enlaces.");
  }
  if (process.getuid && stat.uid !== process.getuid()) throw new MemoryError("MEMORY_PATH", "El archivo de memoria pertenece a otro usuario.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new MemoryError("MEMORY_PATH", "El archivo de memoria requiere permisos privados 0600.");
  }
}

export function existingDatabase(file: string): void {
  privateDirectory(path.dirname(file));
  privateFile(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) !== 16 || header.toString("utf8") !== "SQLite format 3\0") {
      throw new MemoryError("MEMORY_FORMAT", "La memoria no es una base SQLite valida; no se reinicializa.");
    }
  } finally {
    fs.closeSync(fd);
  }
  for (const suffix of ["-wal", "-shm"]) {
    try { privateFile(`${file}${suffix}`); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

export function createPrivateFile(file: string): void {
  privateDirectory(path.dirname(file), true);
  fs.closeSync(fs.openSync(file, "wx", 0o600));
}
