import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MalahorPaths } from "./paths";

export const MALAHOR_COMMIT_SKILL_ID = "git-commit-text";
export const MALAHOR_SKILL_MANIFEST = ".malahor-managed.json";

const MANIFEST_VERSION = 1;
const MANAGED_MARKER = "# malahor-managed";
const PORTABLE_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface SkillManifestEntry {
  id: string;
  sha256: string;
}

interface SkillManifest {
  version: 1;
  files: SkillManifestEntry[];
}

interface CatalogEntry {
  id: string;
  content: string;
  sha256: string;
}

export interface OpenCodeSkillsSyncResult {
  source: string;
  destination: string;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  preserved: number;
}

export interface OpenCodeSkillsRemovalResult {
  destination: string;
  removed: number;
  preserved: number;
}

export function openCodeSkillsDir(paths: MalahorPaths): string {
  return paths.opencodeSkillsDir;
}

export function managedSkillsManifestPath(paths: MalahorPaths): string {
  return path.join(openCodeSkillsDir(paths), MALAHOR_SKILL_MANIFEST);
}

export function syncOpenCodeSkills(
  sourceDir: string,
  paths: MalahorPaths,
  dryRun: boolean,
): OpenCodeSkillsSyncResult {
  const catalog = readCatalog(sourceDir);
  const destination = openCodeSkillsDir(paths);
  assertSafeSkillsRoot(destination);
  const manifestState = readManifest(managedSkillsManifestPath(paths));
  if (manifestState.kind === "invalid") {
    throw new Error(`El manifiesto de skills gestionadas es invalido: ${managedSkillsManifestPath(paths)}`);
  }

  const previous = new Map((manifestState.manifest?.files ?? []).map((entry) => [entry.id, entry]));
  const desired = new Set(catalog.map((entry) => entry.id));
  const next = new Map<string, SkillManifestEntry>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  let preserved = 0;

  for (const entry of catalog) {
    const directory = path.join(destination, entry.id);
    const target = path.join(directory, "SKILL.md");
    const previousEntry = previous.get(entry.id);
    if (!safeSkillDirectory(directory)) {
      preserved += 1;
      if (previousEntry) next.set(entry.id, previousEntry);
      continue;
    }
    const existingHash = regularFileHash(target);

    if (existingHash === null && fs.existsSync(target)) {
      preserved += 1;
      continue;
    }

    if (existingHash === undefined) {
      if (!safeSkillDirectoryForCreate(directory)) {
        preserved += 1;
        continue;
      }
      created += 1;
      if (!dryRun) writeManagedSkill(target, entry.content);
      next.set(entry.id, { id: entry.id, sha256: entry.sha256 });
      continue;
    }

    const previouslyManaged = previousEntry?.sha256 === existingHash && hasManagedMarker(target);
    const adoptable = existingHash === entry.sha256
      && fs.readFileSync(target, "utf8").includes(MANAGED_MARKER);

    if (!previouslyManaged && !adoptable) {
      preserved += 1;
      if (previousEntry) next.set(entry.id, previousEntry);
      continue;
    }

    if (existingHash === entry.sha256) {
      unchanged += 1;
    } else {
      updated += 1;
      if (!dryRun) writeManagedSkill(target, entry.content);
    }
    next.set(entry.id, { id: entry.id, sha256: entry.sha256 });
  }

  for (const previousEntry of previous.values()) {
    if (desired.has(previousEntry.id)) continue;
    const directory = path.join(destination, previousEntry.id);
    const target = path.join(directory, "SKILL.md");
    if (!safeSkillDirectory(directory)) {
      preserved += 1;
      continue;
    }
    const existingHash = regularFileHash(target);
    if (existingHash !== previousEntry.sha256 || !hasManagedMarker(target)) {
      if (existingHash !== undefined) preserved += 1;
      continue;
    }
    removed += 1;
    if (!dryRun) {
      fs.unlinkSync(target);
      removeDirectoryIfEmpty(directory);
    }
  }

  if (!dryRun) {
    fs.mkdirSync(destination, { recursive: true });
    writeManifest(managedSkillsManifestPath(paths), {
      version: MANIFEST_VERSION,
      files: [...next.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  return {
    source: sourceDir,
    destination,
    total: catalog.length,
    created,
    updated,
    unchanged,
    removed,
    preserved,
  };
}

export function removeOpenCodeSkills(
  paths: MalahorPaths,
  dryRun: boolean,
): OpenCodeSkillsRemovalResult {
  const destination = openCodeSkillsDir(paths);
  assertSafeSkillsRoot(destination);
  const manifestPath = managedSkillsManifestPath(paths);
  const state = readManifest(manifestPath);
  if (state.kind !== "valid" || !state.manifest) {
    return { destination, removed: 0, preserved: 0 };
  }

  let removed = 0;
  let preserved = 0;
  for (const entry of state.manifest.files) {
    const directory = path.join(destination, entry.id);
    const target = path.join(directory, "SKILL.md");
    if (!safeSkillDirectory(directory)) {
      preserved += 1;
      continue;
    }
    const currentHash = regularFileHash(target);
    if (currentHash === undefined) continue;
    if (currentHash !== entry.sha256 || !hasManagedMarker(target)) {
      preserved += 1;
      continue;
    }
    removed += 1;
    if (!dryRun) {
      fs.unlinkSync(target);
      removeDirectoryIfEmpty(directory);
    }
  }

  if (!dryRun) {
    fs.unlinkSync(manifestPath);
    removeDirectoryIfEmpty(destination);
  }
  return { destination, removed, preserved };
}

export function openCodeSkillsProblems(sourceDir: string, paths: MalahorPaths): string[] {
  let catalog: CatalogEntry[];
  try {
    catalog = readCatalog(sourceDir);
  } catch (error) {
    return [(error as Error).message];
  }

  try {
    assertSafeSkillsRoot(openCodeSkillsDir(paths));
  } catch (error) {
    return [(error as Error).message];
  }
  const state = readManifest(managedSkillsManifestPath(paths));
  if (state.kind !== "valid" || !state.manifest) {
    return [`Manifiesto de skills gestionadas falta o es invalido: ${managedSkillsManifestPath(paths)}`];
  }

  const managed = new Map(state.manifest.files.map((entry) => [entry.id, entry.sha256]));
  const problems: string[] = [];
  for (const entry of catalog) {
    const directory = path.join(openCodeSkillsDir(paths), entry.id);
    if (!safeSkillDirectory(directory)) {
      problems.push(`Directorio de skill OpenCode inseguro: ${entry.id}`);
      continue;
    }
    const target = path.join(directory, "SKILL.md");
    const actual = regularFileHash(target);
    if (actual !== entry.sha256 || managed.get(entry.id) !== entry.sha256) {
      problems.push(`Skill OpenCode gestionada falta o difiere: ${entry.id}`);
    }
  }
  return problems;
}

function readCatalog(sourceDir: string): CatalogEntry[] {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`No existe directorio de skills gestionadas: ${sourceDir}`);
  }
  const sourceStat = fs.lstatSync(sourceDir);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`El catalogo de skills debe ser un directorio real: ${sourceDir}`);
  }

  const entries = markdownFiles(sourceDir).map((source) => {
    const relative = path.relative(sourceDir, source);
    const id = portableSkillId(relative);
    const content = renderSkill(id, fs.readFileSync(source, "utf8"));
    return { id, content, sha256: sha256(content) };
  });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(`Colision de ID en el catalogo de skills: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  if (!ids.has(MALAHOR_COMMIT_SKILL_ID)) {
    throw new Error(`Falta la skill canonica ${MALAHOR_COMMIT_SKILL_ID} en ${sourceDir}`);
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`El catalogo de skills no admite symlinks: ${absolute}`);
    }
    if (entry.isDirectory()) {
      files.push(...markdownFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolute);
    }
  }
  return files;
}

function portableSkillId(relative: string): string {
  const id = relative
    .replaceAll("\\", "/")
    .replace(/\.md$/i, "")
    .split("/")
    .join("-");
  if (!PORTABLE_SKILL_ID.test(id) || [...id].length > 64) {
    throw new Error(`ID de skill no portable para OpenCode: ${id}`);
  }
  return id;
}

function renderSkill(id: string, source: string): string {
  const normalizedSource = source.replaceAll("\r\n", "\n").trimEnd();
  const description = skillDescription(normalizedSource);
  const normalized = normalizedSource.replace(/^#\s+.*$/m, `# ${id}`);
  return [
    "---",
    MANAGED_MARKER,
    `name: ${id}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    normalized,
    "",
  ].join("\n");
}

function skillDescription(source: string): string {
  const lines = source.split("\n");
  const heading = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (heading < 0) throw new Error("Una skill gestionada no contiene titulo H1.");
  const title = lines[heading]?.replace(/^#\s+/, "").trim() ?? "skill";
  let index = heading + 1;
  while (index < lines.length && !lines[index]?.trim()) index += 1;
  const paragraph: string[] = [];
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line || /^#{1,6}\s/.test(line) || /^[-*+]\s/.test(line)) break;
    paragraph.push(line);
    index += 1;
  }
  const description = paragraph.join(" ").trim();
  return description || `Skill gestionada de Malahor: ${title}.`;
}

function safeSkillDirectoryForCreate(directory: string): boolean {
  if (!safeSkillDirectory(directory)) return false;
  try {
    return fs.readdirSync(directory).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function safeSkillDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function assertSafeSkillsRoot(directory: string): void {
  let safe = true;
  try {
    const stat = fs.lstatSync(directory);
    safe = stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    safe = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!safe) {
    throw new Error(`El directorio global de skills no es un destino seguro: ${directory}`);
  }
}

function writeManagedSkill(target: string, content: string): void {
  const directory = path.dirname(target);
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`El destino de la skill no es un directorio seguro: ${directory}`);
    }
  } else {
    fs.mkdirSync(directory, { recursive: true });
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

function removeDirectoryIfEmpty(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
}

function readManifest(file: string):
  | { kind: "missing"; manifest: null }
  | { kind: "valid"; manifest: SkillManifest }
  | { kind: "invalid"; manifest: null } {
  if (!fs.existsSync(file)) return { kind: "missing", manifest: null };
  try {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
      return { kind: "invalid", manifest: null };
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.files)) {
      return { kind: "invalid", manifest: null };
    }
    const files: SkillManifestEntry[] = [];
    const seen = new Set<string>();
    for (const value of parsed.files) {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.sha256 !== "string") {
        return { kind: "invalid", manifest: null };
      }
      if (!PORTABLE_SKILL_ID.test(value.id) || [...value.id].length > 64
        || !/^[a-f0-9]{64}$/.test(value.sha256) || seen.has(value.id)) {
        return { kind: "invalid", manifest: null };
      }
      seen.add(value.id);
      files.push({ id: value.id, sha256: value.sha256 });
    }
    return { kind: "valid", manifest: { version: MANIFEST_VERSION, files } };
  } catch {
    return { kind: "invalid", manifest: null };
  }
}

function writeManifest(file: string, manifest: SkillManifest): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function regularFileHash(file: string): string | null | undefined {
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return sha256(fs.readFileSync(file));
}

function hasManagedMarker(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile()
      && !fs.lstatSync(file).isSymbolicLink()
      && fs.readFileSync(file, "utf8").includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
