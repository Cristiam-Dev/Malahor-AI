import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface PlanningAuthority {
  readonly fingerprint: string;
  sign(payload: string): string;
  verify(payload: string, proof: unknown): boolean;
}

const KEY_FILE = "planning.key";
const KEY_BYTES = 32;

export function createPlanningAuthority(secret: Uint8Array): PlanningAuthority {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== KEY_BYTES) {
    throw new Error(`La autoridad de planeacion requiere ${KEY_BYTES} bytes.`);
  }
  const key = Buffer.from(secret);
  const fingerprint = createHash("sha256").update(key).digest("hex");
  return {
    fingerprint,
    sign: (payload) => createHmac("sha256", key).update(payload).digest("hex"),
    verify: (payload, proof) => {
      if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
      const expected = createHmac("sha256", key).update(payload).digest();
      return timingSafeEqual(expected, Buffer.from(proof, "hex"));
    },
  };
}

export function createEphemeralPlanningAuthority(): PlanningAuthority {
  return createPlanningAuthority(randomBytes(KEY_BYTES));
}

export function planningKeyPath(secretsDirectory: string): string {
  return path.join(path.resolve(secretsDirectory), KEY_FILE);
}

export function loadPlanningAuthority(secretsDirectory: string): PlanningAuthority {
  const directory = path.resolve(secretsDirectory);
  ensurePrivateDirectory(directory);
  const file = planningKeyPath(directory);
  if (!fs.existsSync(file)) createKey(file);
  return createPlanningAuthority(readKey(file));
}

function createKey(file: string): void {
  const content = `${randomBytes(KEY_BYTES).toString("hex")}\n`;
  try {
    const descriptor = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    secureChmod(file, 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

function readKey(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("La clave de planeacion debe ser un archivo regular privado, sin enlaces.");
  }
  assertOwned(stat, "La clave de planeacion pertenece a otro usuario.");
  assertPrivateMode(stat, 0o077, "La clave de planeacion requiere permisos privados.");
  if (stat.size > 256) throw new Error("La clave de planeacion tiene un formato invalido.");
  const value = fs.readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}\n?$/.test(value)) throw new Error("La clave de planeacion tiene un formato invalido.");
  return Buffer.from(value.trim(), "hex");
}

function ensurePrivateDirectory(directory: string): void {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("El directorio de secretos de planeacion debe ser un directorio real.");
  }
  assertOwned(stat, "El directorio de secretos de planeacion pertenece a otro usuario.");
  assertPrivateMode(stat, 0o077, "El directorio de secretos de planeacion requiere permisos privados.");
  secureChmod(directory, 0o700);
}

function assertOwned(stat: fs.Stats, message: string): void {
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(message);
}

function assertPrivateMode(stat: fs.Stats, mask: number, message: string): void {
  if (process.platform !== "win32" && (stat.mode & mask) !== 0) throw new Error(message);
}

function secureChmod(target: string, mode: number): void {
  try { fs.chmodSync(target, mode); }
  catch (error) { if (process.platform !== "win32") throw error; }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
