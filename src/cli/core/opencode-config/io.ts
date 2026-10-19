import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConfigSnapshot } from "./types";

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function snapshot(filePath: string): ConfigSnapshot | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("No se pudo inspeccionar el archivo de configuracion.");
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) {
    throw new Error("Archivo inseguro: enlace, tipo no regular o limite de 2 MiB excedido.");
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("El archivo cambio durante la lectura.");
    const bytes = fs.readFileSync(fd);
    if (!isUtf8(bytes)) throw new Error("La configuracion no es UTF-8 valido.");
    const after = fs.fstatSync(fd);
    if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.size !== opened.size) {
      throw new Error("El archivo cambio durante la lectura.");
    }
    const text = bytes.toString("utf8");
    return { path: filePath, text, hash: digest(text), mode: after.mode & 0o777, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

export function assertRealDirectory(directory: string): void {
  let existing = path.resolve(directory);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (fs.realpathSync(existing) !== existing) throw new Error("Directorio con enlace no autorizado; usa su ruta real.");
}

export function writeExclusive(filePath: string, text: string): void {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function replaceAtomically(filePath: string, text: string, transactionId: string, mode?: number): void {
  const staged = `${filePath}.${transactionId}.tmp`;
  writeExclusive(staged, text);
  try {
    if (snapshot(staged)?.hash !== digest(text)) throw new Error("No se pudo verificar el archivo provisional.");
    if (mode !== undefined) fs.chmodSync(staged, mode);
    fs.renameSync(staged, filePath);
  } finally {
    if (fs.existsSync(staged)) fs.unlinkSync(staged);
  }
}

export function withConfigLock<T>(directory: string, operation: () => T): T {
  assertRealDirectory(directory);
  const lock = path.join(directory, ".malahor-config-consolidation.lock");
  try {
    writeExclusive(lock, `${process.pid}\n`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`Hay una consolidacion en curso o un lock abandonado (${lock}); revisa el estado antes de continuar.`);
    }
    if (code === "ENOENT") {
      throw new Error(`No existe el directorio de configuracion (${directory}); nada que consolidar.`);
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    fs.unlinkSync(lock);
  }
}
