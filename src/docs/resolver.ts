import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  loadProjectsFile,
  resolveContextTarget,
  type ProjectsFile,
} from "../cli/core/context";
import type { MalahorPaths } from "../cli/core/paths";
import type { ProjectAliases } from "../cli/core/project";

export const DOCS_PROJECT_AREAS = ["Product", "Design", "SDD", "Discovery"] as const;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export interface DocsResolution {
  project: string;
  projectRoot: string;
  vaultRoot: string;
  source: "default" | "override";
  initialized: boolean;
}

export interface DocsInitResult {
  created: string[];
  kept: string[];
  dryRun: boolean;
}

export interface DocsCheckIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface DocsMoveEntry {
  source: string;
  destination: string;
  relativePath: string;
  sourceVersion: string;
  status: "copy" | "identical" | "conflict";
}

export interface DocsMovePreview {
  project: string;
  projectRoot: string;
  source: string;
  entries: DocsMoveEntry[];
}

export function resolveDocsProject(
  paths: MalahorPaths,
  aliases: ProjectAliases = {},
  requestedProject?: string,
  pathOverride?: string,
): DocsResolution {
  const target = resolveContextTarget(paths, aliases, requestedProject);
  const projects = loadProjectsFile(paths.projectsFile);
  return resolveDocsConfiguration(paths, target.canonicalKey, projects, pathOverride);
}

/** Resuelve y valida docs antes de persistir el alta de un proyecto. */
export function resolveDocsProjectForRegistration(
  paths: MalahorPaths,
  aliases: ProjectAliases,
  requestedProject: string,
  codeRoots: string[],
  pathOverride?: string,
): DocsResolution {
  const target = resolveContextTarget(paths, aliases, requestedProject);
  const projects = loadProjectsFile(paths.projectsFile);
  const existing = projects[target.canonicalKey] ?? { context: "memory+codegraph" as const };
  const normalizedRoots = codeRoots.map(canonicalPlannedPath);
  const defaultRoot = normalizedRoots.at(-1);
  if (!defaultRoot) throw new Error("El alta documental requiere al menos una raiz de codigo.");
  const roots = [...new Set([...(existing.roots ?? []), ...normalizedRoots])];
  const planned: ProjectsFile = {
    ...projects,
    [target.canonicalKey]: { ...existing, roots, defaultRoot },
  };
  return resolveDocsConfiguration(paths, target.canonicalKey, planned, pathOverride);
}

function resolveDocsConfiguration(
  paths: MalahorPaths,
  canonicalKey: string,
  projects: ProjectsFile,
  pathOverride?: string,
): DocsResolution {
  const entry = projects[canonicalKey];
  if (!entry || !entry.roots?.length) {
    throw new Error(`El proyecto ${canonicalKey} no esta registrado con una raiz de codigo.`);
  }
  assertProjectKey(canonicalKey);
  const caseCollision = Object.keys(projects).find((key) => key !== canonicalKey
    && key.toLowerCase() === canonicalKey.toLowerCase());
  if (caseCollision) throw new Error(`Las claves ${canonicalKey} y ${caseCollision} colisionan en filesystems sin distincion de mayusculas.`);

  const configured = pathOverride?.trim() || entry.docs?.path;
  const plannedVaultRoot = path.resolve(paths.vaultDir);
  assertNoSymlinkComponents(plannedVaultRoot);
  const vaultRoot = canonicalPlannedPath(plannedVaultRoot);
  const plannedDefaultRoot = path.join(vaultRoot, "projects", canonicalKey);
  assertNoSymlinkComponents(plannedDefaultRoot);
  const defaultRoot = canonicalPlannedPath(plannedDefaultRoot);
  const plannedConfiguredRoot = configured ? path.resolve(configured) : undefined;
  if (plannedConfiguredRoot) assertNoSymlinkComponents(plannedConfiguredRoot);
  const configuredRoot = plannedConfiguredRoot ? canonicalPlannedPath(plannedConfiguredRoot) : undefined;
  const source = configuredRoot && !samePath(configuredRoot, defaultRoot) ? "override" : "default";
  const projectRoot = source === "override" ? configuredRoot! : defaultRoot;
  const repositoryRoots = Object.values(projects).flatMap((project) => project.roots ?? []);
  assertExternalDocsRoot(projectRoot, repositoryRoots);
  if (source === "default") {
    assertExternalDocsRoot(vaultRoot, repositoryRoots);
  } else {
    assertExternalOverride(projectRoot, paths.malahorHome, vaultRoot);
  }
  assertIsolatedProjectRoot(projectRoot, canonicalKey, projects, vaultRoot);

  return {
    project: canonicalKey,
    projectRoot,
    vaultRoot,
    source,
    initialized: secureDirectoryExists(projectRoot),
  };
}

export function initializeDocsProject(
  resolution: DocsResolution,
  templateRoot: string | undefined,
  dryRun: boolean,
): DocsInitResult {
  const created: string[] = [];
  const kept: string[] = [];
  assertNoSymlinkComponents(resolution.projectRoot);
  if (resolution.source === "default") {
    const expected = path.join(resolution.vaultRoot, "projects", resolution.project);
    if (!samePath(resolution.projectRoot, expected)) throw new Error("Resolucion documental default inconsistente.");
    assertNoSymlinkComponents(resolution.vaultRoot);
  }

  if (resolution.source === "default" && templateRoot && fs.existsSync(templateRoot)) {
    copyMissingTree(templateRoot, resolution.vaultRoot, resolution.vaultRoot, dryRun, created, kept);
  }

  ensureDirectory(resolution.projectRoot, resolution.projectRoot, dryRun, created, kept);
  const readme = path.join(resolution.projectRoot, "README.md");
  writeIfMissing(readme, projectReadme(resolution.project), resolution.projectRoot, dryRun, created, kept);
  for (const area of DOCS_PROJECT_AREAS) {
    ensureDirectory(path.join(resolution.projectRoot, area), resolution.projectRoot, dryRun, created, kept);
  }

  return { created, kept, dryRun };
}

export function checkDocsProject(resolution: DocsResolution): DocsCheckIssue[] {
  const issues: DocsCheckIssue[] = [];
  if (!fs.existsSync(resolution.projectRoot)) {
    return [{
      severity: "error",
      code: "root-missing",
      path: resolution.projectRoot,
      message: "La raiz documental no existe; ejecuta `malahor-ai docs init`.",
    }];
  }
  const rootStat = fs.lstatSync(resolution.projectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return [{ severity: "error", code: "root-type", path: resolution.projectRoot, message: "La raiz documental debe ser un directorio real, no un symlink." }];
  }
  try { assertNoSymlinkComponents(resolution.projectRoot); }
  catch (error) {
    return [{ severity: "error", code: "root-symlink", path: resolution.projectRoot, message: (error as Error).message }];
  }

  const casePaths = new Map<string, string>();
  walkMarkdown(resolution.projectRoot, (file) => {
    const relative = portableRelative(resolution.projectRoot, file);
    const folded = relative.toLowerCase();
    const previous = casePaths.get(folded);
    if (previous && previous !== relative) {
      issues.push({ severity: "error", code: "case-collision", path: relative, message: `Colisiona con ${previous} en filesystems sin distincion de mayusculas.` });
    } else {
      casePaths.set(folded, relative);
    }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      issues.push({ severity: "error", code: "symlink", path: relative, message: "Los symlinks no forman parte del vault gestionado." });
      return;
    }
    if (stat.size > MAX_MARKDOWN_BYTES) {
      issues.push({ severity: "error", code: "size", path: relative, message: "El Markdown excede 2 MiB." });
      return;
    }
    let content: string;
    try { content = decodeUtf8(fs.readFileSync(file), relative); }
    catch (error) {
      issues.push({ severity: "error", code: "utf8", path: relative, message: (error as Error).message });
      return;
    }
    if (!hasFrontmatter(content)) {
      issues.push({ severity: "warning", code: "frontmatter", path: relative, message: "No contiene frontmatter YAML inicial y cerrado." });
    }
    for (const link of markdownLinks(content)) {
      if (/^file:/i.test(link)) {
        issues.push({ severity: "error", code: "absolute-link", path: relative, message: `Enlace file: no portable: ${link}` });
        continue;
      }
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link)) continue;
      const clean = decodeLink(link.split(/[?#]/, 1)[0] ?? "");
      if (!clean) continue;
      if (clean.includes("\\") || path.isAbsolute(clean) || /^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith("\\\\")) {
        issues.push({ severity: "error", code: "absolute-link", path: relative, message: `Enlace no portable: ${link}` });
        continue;
      }
      const target = path.resolve(path.dirname(file), clean);
      if (!isWithin(target, resolution.projectRoot)) {
        issues.push({ severity: "error", code: "link-escape", path: relative, message: `Enlace fuera del proyecto documental: ${link}` });
      } else if (pathUsesSymlink(resolution.projectRoot, target)) {
        issues.push({ severity: "error", code: "link-symlink", path: relative, message: `Enlace mediante symlink no permitido: ${link}` });
      } else if (!fs.existsSync(target) && !fs.existsSync(`${target}.md`)) {
        issues.push({ severity: "warning", code: "broken-link", path: relative, message: `Enlace relativo no resuelto: ${link}` });
      }
    }
  }, issues);
  return issues;
}

export function previewDocsMove(sourcePath: string, resolution: DocsResolution): DocsMovePreview {
  if (!secureDirectoryExists(resolution.projectRoot)) {
    throw new Error("El proyecto documental no esta inicializado. Ejecuta `malahor-ai docs init`.");
  }
  assertNoSymlinkComponents(resolution.projectRoot);
  const source = canonicalExistingPath(sourcePath);
  const stat = fs.lstatSync(source);
  const files = stat.isDirectory() ? markdownFiles(source) : [source];
  if (!stat.isDirectory() && path.extname(source).toLowerCase() !== ".md") {
    throw new Error("docs move solo acepta archivos Markdown o directorios.");
  }
  const existingCases = markdownFiles(resolution.projectRoot)
    .reduce((map, file) => map.set(portableRelative(resolution.projectRoot, file).toLowerCase(), portableRelative(resolution.projectRoot, file)), new Map<string, string>());
  const plannedCases = new Map<string, string>();
  const entries = files.map((file) => {
    validateMarkdownFile(file);
    const relativePath = normalizePortableRelative(stat.isDirectory() ? portableRelative(source, file) : path.basename(file));
    const folded = relativePath.toLowerCase();
    const duplicate = plannedCases.get(folded);
    if (duplicate) throw new Error(`Rutas fuente no portables por colision de mayusculas: ${duplicate} y ${relativePath}.`);
    plannedCases.set(folded, relativePath);
    const destination = path.resolve(resolution.projectRoot, ...relativePath.split("/"));
    if (!isWithin(destination, resolution.projectRoot)) throw new Error(`Destino fuera del vault: ${relativePath}`);
    assertSafeDestination(destination, resolution.projectRoot);
    const existingCase = existingCases.get(folded);
    if (existingCase && existingCase !== relativePath) {
      throw new Error(`El destino ${relativePath} colisiona con ${existingCase} en filesystems sin distincion de mayusculas.`);
    }
    const sourceVersion = fileVersion(file);
    let status: DocsMoveEntry["status"] = "copy";
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink() || !fs.statSync(destination).isFile()) {
        throw new Error(`Destino inseguro o no regular: ${relativePath}`);
      }
      status = fileVersion(destination) === sourceVersion ? "identical" : "conflict";
    }
    return { source: file, destination, relativePath, sourceVersion, status };
  });
  return { project: resolution.project, projectRoot: resolution.projectRoot, source, entries };
}

export function applyDocsMove(preview: DocsMovePreview): { copied: string[]; kept: string[] } {
  const projectRoot = canonicalExistingPath(preview.projectRoot);
  if (!fs.statSync(projectRoot).isDirectory()) throw new Error("La raiz documental del preview ya no es un directorio.");
  const evaluated = preview.entries.map((entry) => revalidateMoveEntry(entry, projectRoot));
  const destinations = new Set<string>();
  for (const entry of evaluated) {
    const folded = entry.relativePath.toLowerCase();
    if (destinations.has(folded)) throw new Error(`El preview contiene destinos duplicados: ${entry.relativePath}`);
    destinations.add(folded);
  }
  const conflicts = evaluated.filter((entry) => entry.status === "conflict");
  if (conflicts.length > 0) throw new Error(`Hay ${conflicts.length} conflicto(s); no se copio nada.`);
  const copied: string[] = [];
  const kept: string[] = [];
  const created: DocsMoveEntry[] = [];
  try {
    for (const entry of evaluated) {
      if (entry.status === "identical") {
        kept.push(entry.relativePath);
        continue;
      }
      const content = fs.readFileSync(entry.source);
      if (versionBuffer(content) !== entry.sourceVersion) throw new Error(`El origen cambio desde el preview: ${entry.source}`);
      try {
        atomicCreate(entry.destination, content);
        created.push(entry);
      } catch (error) {
        const destinationStat = fs.existsSync(entry.destination) ? fs.lstatSync(entry.destination) : undefined;
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && destinationStat?.isFile()
          && !destinationStat.isSymbolicLink() && fileVersion(entry.destination) === entry.sourceVersion) {
          kept.push(entry.relativePath);
          continue;
        }
        throw error;
      }
      if (fileVersion(entry.destination) !== entry.sourceVersion) throw new Error(`Fallo la verificacion de copia: ${entry.relativePath}`);
      copied.push(entry.relativePath);
    }
  } catch (error) {
    rollbackCreated(created);
    throw error;
  }
  return { copied, kept };
}

export function assertExternalDocsRoot(candidate: string, repositoryRoots: string[]): void {
  const root = canonicalPlannedPath(candidate);
  if (isSandboxPath(root)) return;
  const containingRepository = repositoryAncestor(root);
  if (containingRepository) {
    throw new Error(`La raiz documental debe estar fuera de repositorios: ${root} esta dentro de ${containingRepository}.`);
  }
  for (const repository of repositoryRoots) {
    const codeRoot = canonicalPlannedPath(repository);
    if (isWithin(root, codeRoot) || isWithin(codeRoot, root)) {
      throw new Error(`La raiz documental debe estar fuera de repositorios: ${root} entra en conflicto con ${codeRoot}.`);
    }
  }
}

function isSandboxPath(value: string): boolean {
  return path.resolve(value).split(path.sep).includes(".sandbox");
}

function assertProjectKey(value: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`Clave canonica no portable para el vault: ${value}`);
  }
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`No existe el origen: ${resolved}`);
  assertNoSymlinkComponents(resolved);
  const canonical = fs.realpathSync(resolved);
  if (!samePath(canonical, resolved)) throw new Error(`Ruta mediante symlink no permitida: ${resolved}`);
  return canonical;
}

function canonicalPlannedPath(value: string): string {
  const resolved = path.resolve(value);
  let current = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const canonical = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return path.resolve(canonical, ...suffix);
}

function copyMissingTree(
  source: string,
  destination: string,
  destinationRoot: string,
  dryRun: boolean,
  created: string[],
  kept: string[],
): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`Template symlink no permitido: ${source}`);
  if (sourceStat.isDirectory()) {
    ensureDirectory(destination, destinationRoot, dryRun, created, kept);
    for (const name of fs.readdirSync(source).sort()) {
      copyMissingTree(path.join(source, name), path.join(destination, name), destinationRoot, dryRun, created, kept);
    }
    return;
  }
  if (!sourceStat.isFile()) return;
  if (path.extname(source).toLowerCase() !== ".md") throw new Error(`El template documental solo admite Markdown: ${source}`);
  validateMarkdownFile(source);
  assertSafeDestination(destination, destinationRoot);
  if (fs.existsSync(destination)) {
    if (fs.lstatSync(destination).isSymbolicLink() || !fs.statSync(destination).isFile()) {
      throw new Error(`Destino de template inseguro: ${destination}`);
    }
    kept.push(destination);
    return;
  }
  created.push(destination);
  if (!dryRun) atomicCreate(destination, fs.readFileSync(source));
}

function ensureDirectory(target: string, root: string, dryRun: boolean, created: string[], kept: string[]): void {
  assertSafeDestination(target, root);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Se esperaba un directorio real: ${target}`);
    kept.push(target);
    return;
  }
  created.push(target);
  if (!dryRun) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(target);
  }
}

function writeIfMissing(target: string, content: string, root: string, dryRun: boolean, created: string[], kept: string[]): void {
  assertSafeDestination(target, root);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isFile()) throw new Error(`Se esperaba un archivo regular: ${target}`);
    kept.push(target);
    return;
  }
  created.push(target);
  if (!dryRun) atomicCreate(target, Buffer.from(content, "utf8"));
}

function projectReadme(project: string): string {
  return `---\nproject: ${JSON.stringify(project)}\ntype: project-index\n---\n\n# ${project}\n\nDocumentacion canonica del proyecto.\n`;
}

function walkMarkdown(root: string, visit: (file: string) => void, issues: DocsCheckIssue[] = [], base = root): void {
  const names = new Map<string, string>();
  for (const name of fs.readdirSync(root).sort()) {
    const target = path.join(root, name);
    const relative = portableRelative(base, target);
    const previous = names.get(name.toLowerCase());
    if (previous && previous !== name) {
      issues.push({ severity: "error", code: "case-collision", path: relative, message: `Colisiona con ${previous} en el mismo directorio.` });
      continue;
    }
    names.set(name.toLowerCase(), name);
    try { validatePortableSegment(name); }
    catch (error) {
      issues.push({ severity: "error", code: "portable-path", path: relative, message: (error as Error).message });
      continue;
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      issues.push({ severity: "error", code: "symlink", path: relative, message: "Symlink no permitido." });
    } else if (stat.isDirectory()) {
      walkMarkdown(target, visit, issues, base);
    } else if (stat.isFile() && path.extname(name).toLowerCase() === ".md") {
      visit(target);
    }
  }
}

function markdownFiles(root: string): string[] {
  const result: string[] = [];
  const issues: DocsCheckIssue[] = [];
  walkMarkdown(root, (file) => result.push(file), issues);
  const unsafe = issues.find((issue) => issue.severity === "error");
  if (unsafe) throw new Error(`${unsafe.path}: ${unsafe.message}`);
  return result.sort();
}

function markdownLinks(content: string): string[] {
  return [...content.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] ?? "");
}

function decodeLink(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function portableRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function fileVersion(file: string): string {
  return versionBuffer(fs.readFileSync(file));
}

function atomicCreate(target: string, content: Buffer): void {
  assertNoSymlinkComponents(path.dirname(target));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    fsyncDirectory(path.dirname(target));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function assertExternalOverride(projectRoot: string, malahorHome: string, vaultRoot: string): void {
  const home = canonicalPlannedPath(malahorHome);
  if (isWithin(projectRoot, home) || isWithin(home, projectRoot)
    || isWithin(projectRoot, vaultRoot) || isWithin(vaultRoot, projectRoot)) {
    throw new Error(`El override documental debe ser externo a MALAHOR_HOME: ${projectRoot}`);
  }
}

function assertIsolatedProjectRoot(
  projectRoot: string,
  project: string,
  projects: ProjectsFile,
  vaultRoot: string,
): void {
  for (const [otherProject, entry] of Object.entries(projects)) {
    if (otherProject === project) continue;
    assertProjectKey(otherProject);
    const otherRoot = canonicalPlannedPath(entry.docs?.path ?? path.join(vaultRoot, "projects", otherProject));
    if (isWithin(projectRoot, otherRoot) || isWithin(otherRoot, projectRoot)) {
      throw new Error(`Las raices documentales de ${project} y ${otherProject} se solapan: ${projectRoot} / ${otherRoot}.`);
    }
  }
}

function secureDirectoryExists(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  assertNoSymlinkComponents(target);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`La raiz documental no es un directorio real: ${target}`);
  if (!samePath(fs.realpathSync(target), path.resolve(target))) throw new Error(`La raiz documental usa un symlink: ${target}`);
  return true;
}

function repositoryAncestor(target: string): string | undefined {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

function revalidateMoveEntry(entry: DocsMoveEntry, projectRoot: string): DocsMoveEntry {
  if (!/^[a-f0-9]{64}$/.test(entry.sourceVersion)) throw new Error(`Version fuente invalida: ${entry.relativePath}`);
  const relativePath = normalizePortableRelative(entry.relativePath);
  const destination = path.join(projectRoot, ...relativePath.split("/"));
  if (!samePath(destination, entry.destination) || !isWithin(destination, projectRoot)) {
    throw new Error(`El destino del preview no coincide con la raiz documental: ${entry.relativePath}`);
  }
  const source = canonicalExistingPath(entry.source);
  validateMarkdownFile(source);
  if (fileVersion(source) !== entry.sourceVersion) throw new Error(`El origen cambio desde el preview: ${entry.source}`);
  assertSafeDestination(destination, projectRoot);
  let status: DocsMoveEntry["status"] = "copy";
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Destino inseguro o no regular: ${relativePath}`);
    status = fileVersion(destination) === entry.sourceVersion ? "identical" : "conflict";
  }
  return { source, destination, relativePath, sourceVersion: entry.sourceVersion, status };
}

function rollbackCreated(entries: DocsMoveEntry[]): void {
  for (const entry of entries.reverse()) {
    try {
      if (!fs.existsSync(entry.destination)) continue;
      const stat = fs.lstatSync(entry.destination);
      if (!stat.isSymbolicLink() && stat.isFile() && fileVersion(entry.destination) === entry.sourceVersion) {
        fs.unlinkSync(entry.destination);
      }
    } catch {
      // Conserva cualquier copia que ya no podamos atribuir con seguridad a esta operacion.
    }
  }
}

function validateMarkdownFile(file: string): void {
  assertNoSymlinkComponents(file);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`No es un Markdown regular: ${file}`);
  if (path.extname(file).toLowerCase() !== ".md") throw new Error(`Solo se permiten archivos .md: ${file}`);
  if (stat.size > MAX_MARKDOWN_BYTES) throw new Error(`El Markdown excede 2 MiB: ${file}`);
  decodeUtf8(fs.readFileSync(file), file);
}

function normalizePortableRelative(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/")
    || /^[A-Za-z]:/.test(value) || value.startsWith("//") || value.endsWith("/") || value.includes("//")) {
    throw new Error(`Ruta Markdown no portable: ${value}`);
  }
  if (Buffer.byteLength(value, "utf8") > 4096) throw new Error(`Ruta Markdown demasiado larga: ${value}`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error(`Traversal no permitido: ${value}`);
  for (const segment of segments) validatePortableSegment(segment);
  if (!segments.at(-1)!.toLowerCase().endsWith(".md")) throw new Error(`Solo se permiten archivos .md: ${value}`);
  return segments.join("/");
}

function validatePortableSegment(segment: string): void {
  if (!segment || /[\u0000-\u001f\u007f<>:"\\|?*]/u.test(segment) || /[ .]$/.test(segment)) {
    throw new Error(`Segmento de ruta no portable: ${JSON.stringify(segment)}.`);
  }
  const base = segment.split(".", 1)[0] ?? "";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) throw new Error(`Nombre reservado de Windows: ${segment}.`);
  if (Buffer.byteLength(segment, "utf8") > 255) throw new Error(`Segmento de ruta demasiado largo: ${segment}.`);
}

function assertSafeDestination(target: string, root: string): void {
  if (!isWithin(target, root)) throw new Error(`Destino fuera de la raiz documental: ${target}`);
  assertNoSymlinkComponents(target);
  const relative = path.relative(path.resolve(root), path.resolve(target));
  assertNoCaseCollisions(root, relative ? relative.split(path.sep) : []);
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

function pathUsesSymlink(root: string, target: string): boolean {
  const candidates = [target, `${target}.md`];
  for (const candidate of candidates) {
    if (!isWithin(candidate, root)) return true;
    const relative = path.relative(root, candidate);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (!fs.existsSync(current)) break;
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    }
  }
  return false;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`El Markdown no es UTF-8 valido: ${label}`);
  }
}

function hasFrontmatter(content: string): boolean {
  return /^---\n[\s\S]*?\n---(?:\n|$)/.test(content);
}

function versionBuffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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

function isWithin(value: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
