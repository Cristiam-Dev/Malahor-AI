import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const MAGIC = Buffer.from("MHPKG001", "ascii");
const VERSION = 1;
const KDF_SCRYPT = 1;
const N_LOG2 = 17;
const SCRYPT_N = 2 ** N_LOG2;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 44;

export const PORTABLE_MAX_PLAINTEXT_BYTES = 256 * 1024 * 1024;
export const PORTABLE_MAX_PACKAGE_BYTES = 260 * 1024 * 1024;

export class PortablePackageError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortablePackageError";
  }
}

export interface PortablePackageDescriptor {
  path: string;
  sha256: string;
  bytes: number;
}

export interface OpenedPortablePackage<T> extends PortablePackageDescriptor {
  value: T;
}

export function portablePayloadDigest(value: unknown): string {
  return createHash("sha256").update(canonicalPortableJson(value)).digest("hex");
}

export function encryptPortablePayload(value: unknown, passphrase: string | Buffer): Buffer {
  const plaintext = Buffer.from(canonicalPortableJson(value), "utf8");
  if (plaintext.length > PORTABLE_MAX_PLAINTEXT_BYTES) {
    throw new PortablePackageError("PORTABLE_SIZE", "El payload portable excede el limite de 256 MiB.");
  }
  const compressed = deflateRawSync(plaintext, { level: 9 });
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = createHeader(salt, nonce);
  const password = normalizedPassphrase(passphrase);
  let key: Buffer | undefined;
  try {
    key = scryptSync(password, salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    });
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const result = Buffer.concat([header, encrypted, cipher.getAuthTag()]);
    if (result.length > PORTABLE_MAX_PACKAGE_BYTES) {
      throw new PortablePackageError("PORTABLE_SIZE", "El paquete portable excede el limite admitido.");
    }
    return result;
  } finally {
    key?.fill(0);
    password.fill(0);
    plaintext.fill(0);
    compressed.fill(0);
  }
}

export function decryptPortablePayload<T = unknown>(bytes: Buffer, passphrase: string | Buffer): T {
  if (bytes.length < HEADER_BYTES + TAG_BYTES || bytes.length > PORTABLE_MAX_PACKAGE_BYTES) {
    throw new PortablePackageError("PORTABLE_FORMAT", "El paquete portable tiene un tamano invalido.");
  }
  const header = Buffer.from(bytes.subarray(0, HEADER_BYTES));
  const { salt, nonce } = parseHeader(header);
  const ciphertext = bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const password = normalizedPassphrase(passphrase);
  let key: Buffer | undefined;
  let compressed: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    key = scryptSync(password, salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    });
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(header);
      decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new PortablePackageError(
        "PORTABLE_AUTH",
        "No se pudo autenticar el paquete; la passphrase o el contenido no son validos.",
      );
    }
    try {
      plaintext = inflateRawSync(compressed, { maxOutputLength: PORTABLE_MAX_PLAINTEXT_BYTES });
    } catch (cause) {
      throw new PortablePackageError("PORTABLE_FORMAT", "El payload cifrado no se puede descomprimir de forma segura.", { cause });
    }
    if (plaintext.length > PORTABLE_MAX_PLAINTEXT_BYTES) {
      throw new PortablePackageError("PORTABLE_SIZE", "El payload portable excede el limite de 256 MiB.");
    }
    try {
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch (cause) {
      throw new PortablePackageError("PORTABLE_FORMAT", "El payload portable no contiene JSON valido.", { cause });
    }
  } finally {
    key?.fill(0);
    password.fill(0);
    compressed?.fill(0);
    plaintext?.fill(0);
  }
}

export function writePortablePackage(
  destination: string,
  value: unknown,
  passphrase: string | Buffer,
): PortablePackageDescriptor {
  const target = safeNewPackagePath(destination);
  const bytes = encryptPortablePayload(value, passphrase);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);

    const verification = readRegularFile(temporary);
    if (!verification.equals(bytes)) {
      throw new PortablePackageError("PORTABLE_WRITE", "El paquete provisional no coincide con los bytes cifrados.");
    }
    const verifiedValue = decryptPortablePayload(verification, passphrase);
    if (canonicalPortableJson(verifiedValue) !== canonicalPortableJson(value)) {
      throw new PortablePackageError("PORTABLE_WRITE", "El paquete provisional no reproduce el payload esperado.");
    }

    try {
      fs.linkSync(temporary, target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PortablePackageError("PORTABLE_EXISTS", "El destino del paquete ya existe; no se sobrescribe.");
      }
      throw cause;
    }
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(target));
    const published = readRegularFile(target);
    if (!published.equals(bytes)) {
      throw new PortablePackageError("PORTABLE_WRITE", "El paquete publicado no coincide con el provisional.");
    }
    return { path: target, sha256: sha256(published), bytes: published.length };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    bytes.fill(0);
  }
}

export function openPortablePackage<T = unknown>(
  packagePath: string,
  passphrase: string | Buffer,
): OpenedPortablePackage<T> {
  const resolved = path.resolve(packagePath);
  const bytes = readRegularFile(resolved);
  try {
    return {
      path: resolved,
      sha256: sha256(bytes),
      bytes: bytes.length,
      value: decryptPortablePayload<T>(bytes, passphrase),
    };
  } finally {
    bytes.fill(0);
  }
}

export function readPortablePackageBytes(packagePath: string): Buffer {
  return readRegularFile(path.resolve(packagePath));
}

function createHeader(salt: Buffer, nonce: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[8] = VERSION;
  header[9] = KDF_SCRYPT;
  header[10] = N_LOG2;
  header[11] = SCRYPT_R;
  header[12] = SCRYPT_P;
  salt.copy(header, 16);
  nonce.copy(header, 32);
  return header;
}

function parseHeader(header: Buffer): { salt: Buffer; nonce: Buffer } {
  if (header.length !== HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)
    || header[8] !== VERSION || header[9] !== KDF_SCRYPT || header[10] !== N_LOG2
    || header[11] !== SCRYPT_R || header[12] !== SCRYPT_P
    || header.subarray(13, 16).some((value) => value !== 0)) {
    throw new PortablePackageError("PORTABLE_FORMAT", "La cabecera del paquete no es compatible.");
  }
  return {
    salt: Buffer.from(header.subarray(16, 32)),
    nonce: Buffer.from(header.subarray(32, 44)),
  };
}

function normalizedPassphrase(value: string | Buffer): Buffer {
  const password = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (password.length < 12 || password.length > 1024 || password.includes(0)) {
    password.fill(0);
    throw new PortablePackageError(
      "PORTABLE_PASSPHRASE",
      "La passphrase debe tener entre 12 y 1024 bytes y no contener NUL.",
    );
  }
  return password;
}

function safeNewPackagePath(destination: string): string {
  if (typeof destination !== "string" || !destination.trim() || destination.includes("\0")) {
    throw new PortablePackageError("PORTABLE_PATH", "El destino del paquete es invalido.");
  }
  const target = path.resolve(destination);
  if (path.extname(target).toLowerCase() !== ".mhpkg") {
    throw new PortablePackageError("PORTABLE_PATH", "El paquete debe usar la extension .mhpkg.");
  }
  const parent = path.dirname(target);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PortablePackageError("PORTABLE_PATH", "El directorio destino debe ser real y no un symlink.");
  }
  if (fs.realpathSync(parent) !== parent) {
    throw new PortablePackageError("PORTABLE_PATH", "El directorio destino no puede atravesar symlinks.");
  }
  if (fs.existsSync(target)) {
    throw new PortablePackageError("PORTABLE_EXISTS", "El destino del paquete ya existe; no se sobrescribe.");
  }
  return target;
}

function readRegularFile(file: string): Buffer {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < HEADER_BYTES + TAG_BYTES || before.size > PORTABLE_MAX_PACKAGE_BYTES) {
    throw new PortablePackageError("PORTABLE_PATH", "El paquete debe ser un archivo regular, privado y acotado.");
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) {
      throw new PortablePackageError("PORTABLE_BUSY", "El paquete cambio antes de abrirse.");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new PortablePackageError("PORTABLE_BUSY", "El paquete cambio durante la lectura.");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalPortableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new PortablePackageError("PORTABLE_FORMAT", "El payload contiene un numero no finito.");
      return input;
    }
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input !== "object") {
      throw new PortablePackageError("PORTABLE_FORMAT", "El payload contiene un valor no serializable.");
    }
    if (seen.has(input)) throw new PortablePackageError("PORTABLE_FORMAT", "El payload contiene una referencia circular.");
    seen.add(input);
    const record = input as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) {
        throw new PortablePackageError("PORTABLE_FORMAT", "El payload contiene un campo undefined.");
      }
      normalized[key] = normalize(record[key]);
    }
    seen.delete(input);
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
