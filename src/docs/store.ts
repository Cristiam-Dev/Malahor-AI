import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DocsResolution } from "./resolver";

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 50;

export interface DocsReadResult {
  path: string;
  content: string;
  version: string;
  size: number;
}

export interface DocsWriteOptions {
  ifMatch?: string;
  ifNoneMatch?: "*";
}

export function listDocs(resolution: DocsResolution, relativePath = ""): Array<{ path: string; type: "file" | "directory" }> {
  const normalized = normalizeRelative(relativePath, true);
  const directory = resolveRelative(resolution.projectRoot, normalized, { directory: true, mustExist: true });
  return fs.readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Symlink no permitido: ${joinPortable(normalized, entry.name)}`);
      if (entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))) {
        validatePortableSegment(entry.name);
      }
      return entry;
    })
    .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".md")))
    .map((entry) => ({
      path: joinPortable(normalized, entry.name),
      type: entry.isDirectory() ? "directory" as const : "file" as const,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function readDoc(resolution: DocsResolution, relativePath: string): DocsReadResult {
  const file = resolveRelative(resolution.projectRoot, relativePath, { markdown: true, mustExist: true });
  const bytes = readRegularBytes(file, relativePath);
  const content = decodeUtf8(bytes, relativePath);
  return { path: normalizeRelative(relativePath, false), content, version: versionOf(bytes), size: bytes.length };
}

export function searchDocs(resolution: DocsResolution, query: string, limit = 20): Array<{ path: string; matches: number; preview: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("La busqueda no puede estar vacia.");
  if (!Number.isFinite(limit)) throw new Error("El limite de busqueda debe ser un numero finito.");
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_RESULTS);
  const results: Array<{ path: string; matches: number; preview: string }> = [];
  assertRoot(resolution.projectRoot, false);
  walk(resolution.projectRoot, "", (relative) => {
    if (results.length >= bounded) return;
    const read = readDoc(resolution, relative);
    const haystack = read.content.toLowerCase();
    let cursor = 0;
    let matches = 0;
    while ((cursor = haystack.indexOf(needle, cursor)) >= 0) {
      matches += 1;
      cursor += Math.max(needle.length, 1);
    }
    if (matches === 0) return;
    const at = haystack.indexOf(needle);
    const start = Math.max(0, at - 80);
    const end = Math.min(read.content.length, at + needle.length + 120);
    results.push({ path: relative, matches, preview: read.content.slice(start, end).replace(/\s+/g, " ").trim() });
  });
  return results;
}

export function writeDoc(
  resolution: DocsResolution,
  relativePath: string,
  content: string,
  options: DocsWriteOptions,
): DocsReadResult {
  validateContent(content);
  validateWriteOptions(options);
  const inspected = inspectRelative(resolution.projectRoot, relativePath, true);
  const exists = inspected.exists;
  let expectedVersion: string | undefined;
  if (exists) {
    const current = readDoc(resolution, relativePath);
    if (!options.ifMatch) throw new Error("Sobrescribir requiere ifMatch con la version leida.");
    if (options.ifMatch !== current.version) throw new Error("Version conflict: el archivo cambio desde la lectura.");
    if (options.ifNoneMatch === "*") throw new Error("ifNoneMatch=* exige que el archivo no exista.");
    expectedVersion = current.version;
  } else if (options.ifNoneMatch !== "*") {
    throw new Error("Crear requiere ifNoneMatch='*'.");
  }
  const file = resolveRelative(resolution.projectRoot, relativePath, { markdown: true, createParents: true });
  atomicWriteText(file, content, { createOnly: !exists, expectedVersion });
  return readDoc(resolution, relativePath);
}

export function appendDoc(
  resolution: DocsResolution,
  relativePath: string,
  content: string,
  options: DocsWriteOptions,
): DocsReadResult {
  validateContent(content);
  validateWriteOptions(options);
  if (inspectRelative(resolution.projectRoot, relativePath, true).exists) {
    const current = readDoc(resolution, relativePath);
    return writeDoc(resolution, relativePath, `${current.content}${content}`, { ifMatch: options.ifMatch });
  }
  return writeDoc(resolution, relativePath, content, { ifNoneMatch: options.ifNoneMatch });
}

export function moveDoc(
  resolution: DocsResolution,
  sourcePath: string,
  destinationPath: string,
  ifMatch: string,
): DocsReadResult {
  validateWriteOptions({ ifMatch });
  const normalizedSource = normalizeRelative(sourcePath, false);
  const normalizedDestination = normalizeRelative(destinationPath, false);
  if (normalizedSource.toLowerCase() === normalizedDestination.toLowerCase()) {
    throw new Error("El origen y el destino no pueden coincidir ni diferir solo por mayusculas.");
  }
  const source = resolveRelative(resolution.projectRoot, normalizedSource, { markdown: true, mustExist: true });
  const current = readDoc(resolution, normalizedSource);
  if (!ifMatch || current.version !== ifMatch) throw new Error("Version conflict: el origen cambio desde la lectura.");
  if (inspectRelative(resolution.projectRoot, normalizedDestination, true).exists) throw new Error("El destino ya existe; move no sobrescribe.");
  const destination = resolveRelative(resolution.projectRoot, normalizedDestination, { markdown: true, createParents: true });
  if (readDoc(resolution, normalizedSource).version !== ifMatch) throw new Error("Version conflict: el origen cambio antes de moverlo.");
  const sourceIdentity = fs.lstatSync(source);
  if (!sourceIdentity.isFile()) throw new Error("El origen no es un archivo regular.");
  let published = false;
  try {
    assertNoSymlinkComponents(path.dirname(destination));
    fs.linkSync(source, destination);
    published = true;
    const linkedIdentity = fs.lstatSync(destination);
    const currentIdentity = fs.lstatSync(source);
    if (linkedIdentity.dev !== sourceIdentity.dev || linkedIdentity.ino !== sourceIdentity.ino
      || currentIdentity.dev !== sourceIdentity.dev || currentIdentity.ino !== sourceIdentity.ino
      || versionOf(readRegularBytes(source, normalizedSource)) !== ifMatch
      || versionOf(readRegularBytes(destination, normalizedDestination)) !== ifMatch) {
      throw new Error("Version conflict: el origen cambio durante el movimiento.");
    }
    fs.unlinkSync(source);
    if (versionOf(readRegularBytes(destination, normalizedDestination)) !== ifMatch) {
      restoreMovedSource(source, destination);
      throw new Error("Version conflict: el destino cambio durante el movimiento.");
    }
  } catch (error) {
    if (published && fs.existsSync(source) && fs.existsSync(destination)) {
      try { fs.unlinkSync(destination); } catch { /* conserva ambas copias antes que perder datos */ }
    }
    throw error;
  }
  fsyncDirectory(path.dirname(destination));
  return readDoc(resolution, normalizedDestination);
}

export function versionOf(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveRelative(
  root: string,
  relativePath: string,
  options: { markdown?: boolean; directory?: boolean; mustExist?: boolean; createParents?: boolean } = {},
): string {
  const normalized = normalizeRelative(relativePath, options.directory === true);
  if (options.markdown && !normalized.toLowerCase().endsWith(".md")) throw new Error("Solo se permiten archivos .md.");
  assertRoot(root, options.createParents === true);
  const segments = normalized ? normalized.split("/") : [];
  assertNoCaseCollisions(root, segments);
  let current = root;
  const walkUntil = options.directory ? segments.length : Math.max(segments.length - 1, 0);
  for (let index = 0; index < walkUntil; index += 1) {
    current = path.join(current, segments[index]!);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink no permitido: ${segments.slice(0, index + 1).join("/")}`);
      if (!stat.isDirectory()) throw new Error(`No es un directorio: ${segments.slice(0, index + 1).join("/")}`);
    } else if (options.createParents) {
      fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Directorio inseguro: ${segments.slice(0, index + 1).join("/")}`);
    } else {
      throw new Error(`No existe el directorio: ${segments.slice(0, index + 1).join("/")}`);
    }
  }
  const target = segments.length === 0 ? root : path.join(root, ...segments);
  if (!isWithin(target, root)) throw new Error("La ruta escapa de la raiz documental.");
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("El destino es un symlink.");
  if (options.mustExist && !fs.existsSync(target)) throw new Error(`No existe: ${normalized || "."}`);
  return target;
}

function inspectRelative(root: string, relativePath: string, markdown: boolean): { path: string; exists: boolean } {
  const normalized = normalizeRelative(relativePath, false);
  if (markdown && !normalized.toLowerCase().endsWith(".md")) throw new Error("Solo se permiten archivos .md.");
  assertNoSymlinkComponents(root);
  if (!fs.existsSync(root)) {
    const target = path.join(root, ...normalized.split("/"));
    if (!isWithin(target, root)) throw new Error("La ruta escapa de la raiz documental.");
    return { path: target, exists: false };
  }
  assertRoot(root, false);
  const segments = normalized.split("/");
  assertNoCaseCollisions(root, segments);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]!);
    if (!fs.existsSync(current)) return { path: path.join(root, ...segments), exists: false };
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlink no permitido: ${segments.slice(0, index + 1).join("/")}`);
    if (!stat.isDirectory()) throw new Error(`No es un directorio: ${segments.slice(0, index + 1).join("/")}`);
  }
  const target = path.join(root, ...segments);
  if (!isWithin(target, root)) throw new Error("La ruta escapa de la raiz documental.");
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("El destino es un symlink.");
  return { path: target, exists: fs.existsSync(target) };
}

function normalizeRelative(value: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Ruta documental invalida.");
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("//")) {
    throw new Error("La ruta debe ser relativa y usar separadores '/'.");
  }
  if (value && (value.endsWith("/") || value.includes("//"))) throw new Error("La ruta debe estar en forma canonica, sin separadores repetidos ni finales.");
  if (Buffer.byteLength(value, "utf8") > 4096) throw new Error("La ruta documental es demasiado larga.");
  const segments = value ? value.split("/") : [];
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error("Traversal no permitido.");
  for (const segment of segments) validatePortableSegment(segment);
  const normalized = segments.join("/");
  if (!normalized && !allowEmpty) throw new Error("La ruta no puede estar vacia.");
  return normalized;
}

function assertRoot(root: string, create: boolean): void {
  assertNoSymlinkComponents(root);
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("La raiz documental no es un directorio real.");
    if (!samePath(fs.realpathSync(root), root)) throw new Error("La raiz documental usa un symlink.");
    return;
  }
  if (!create) throw new Error("La raiz documental no esta inicializada.");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(fs.realpathSync(root), root)) {
    throw new Error("La raiz documental creada no es un directorio real confinado.");
  }
}

function walk(root: string, relative: string, visit: (relativePath: string) => void): void {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink no permitido: ${joinPortable(relative, entry.name)}`);
    if (entry.isDirectory() || (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))) validatePortableSegment(entry.name);
    const child = joinPortable(relative, entry.name);
    if (entry.isDirectory()) walk(root, child, visit);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) visit(child);
  }
}

function validateContent(content: string): void {
  if (typeof content !== "string" || content.includes("\0")) throw new Error("Contenido Markdown invalido.");
  if (Buffer.byteLength(content, "utf8") > MAX_MARKDOWN_BYTES) throw new Error(`El Markdown excede ${MAX_MARKDOWN_BYTES} bytes.`);
}

function atomicWriteText(
  target: string,
  content: string,
  options: { createOnly: boolean; expectedVersion?: string },
): void {
  assertNoSymlinkComponents(path.dirname(target));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(path.dirname(target));
  const temporary = temporaryPath(target);
  let descriptor: number | undefined;
  try {
    let mode = 0o600;
    if (!options.createOnly && fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Version conflict: el destino ya no es un archivo regular.");
      mode = stat.mode & 0o777;
    }
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertNoSymlinkComponents(path.dirname(target));
    if (options.createOnly) {
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      if (!options.expectedVersion || !fs.existsSync(target)) throw new Error("Version conflict: el archivo ya no existe.");
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Version conflict: el archivo fue reemplazado por un symlink.");
      const current = readRegularBytes(target, target);
      decodeUtf8(current, target);
      if (versionOf(current) !== options.expectedVersion) throw new Error("Version conflict: el archivo cambio antes de publicar.");
      fs.renameSync(temporary, target);
    }
    fsyncDirectory(path.dirname(target));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readRegularBytes(file: string, label: string): Buffer {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`No es un archivo Markdown regular: ${label}`);
    if (stat.size > MAX_MARKDOWN_BYTES) throw new Error(`El archivo excede ${MAX_MARKDOWN_BYTES} bytes.`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function restoreMovedSource(source: string, destination: string): void {
  if (fs.existsSync(source) || !fs.existsSync(destination)) return;
  try {
    fs.linkSync(destination, source);
    fs.unlinkSync(destination);
  } catch {
    // El dato queda en destino antes que arriesgar una perdida adicional.
  }
}

function temporaryPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Algunos filesystems/Windows no permiten fsync sobre directorios.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateWriteOptions(options: DocsWriteOptions): void {
  if (options.ifMatch && options.ifNoneMatch) throw new Error("ifMatch e ifNoneMatch son mutuamente excluyentes.");
  if (options.ifMatch && !/^[a-f0-9]{64}$/.test(options.ifMatch)) throw new Error("ifMatch debe ser una version SHA-256 valida.");
}

function validatePortableSegment(segment: string): void {
  if (!segment || /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(segment) || /[ .]$/.test(segment)) {
    throw new Error(`Segmento de ruta no portable: ${JSON.stringify(segment)}.`);
  }
  const base = segment.split(".", 1)[0] ?? "";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    throw new Error(`Nombre reservado de Windows: ${segment}.`);
  }
  if (Buffer.byteLength(segment, "utf8") > 255) throw new Error(`Segmento de ruta demasiado largo: ${segment}.`);
}

function assertNoSymlinkComponents(target: string): void {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Ruta con symlink no permitida: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) return;
  }
}

function assertNoCaseCollisions(root: string, segments: string[]): void {
  let current = root;
  for (const segment of segments) {
    if (!fs.existsSync(current) || !fs.lstatSync(current).isDirectory()) return;
    const collision = fs.readdirSync(current).find((name) => name.toLowerCase() === segment.toLowerCase() && name !== segment);
    if (collision) throw new Error(`Ruta no portable: ${segment} colisiona con ${collision} por mayusculas/minusculas.`);
    current = path.join(current, segment);
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`El Markdown no es UTF-8 valido: ${label}`);
  }
}

function joinPortable(left: string, right: string): string {
  return left ? `${left}/${right}` : right;
}

function isWithin(value: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}
