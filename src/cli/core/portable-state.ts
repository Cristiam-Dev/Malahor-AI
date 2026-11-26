import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  loadProjectsFile,
  parseContextLevel,
  writeProjectsFile,
  type ContextLevel,
  type ProjectsFile,
} from "./context";
import { detectPayloadSecretKinds } from "./hooks/secret-scan";
import { portablePayloadDigest } from "./portable-package";
import {
  applyStagedPortableMemory,
  capturePortableMemory,
  portableMemoryFingerprint,
  rollbackPortableMemory,
  stagePortableMemory,
  validatePortableMemorySnapshot,
  type CapturedPortableMemory,
  type PortableMemoryApplyResult,
  type PortableMemorySnapshot,
} from "../../mnemo/portable-transfer";
import { memoryV2Paths } from "../../mnemo/storage";
import { removeIfPresent } from "../../mnemo/migration/files";

const PORTABLE_FORMAT = "malahor-portable-v1" as const;
const PROJECTS_FORMAT = "malahor-projects-v1" as const;
const PORTABLE_VERSION = 1 as const;
const MAX_PROJECTS_FILE_BYTES = 4 * 1024 * 1024;
const JOURNAL_FILE = "portable-import-journal.json";
const EXCLUDED_SECTIONS = [
  "assets",
  "backups",
  "codegraph",
  "config",
  "credentials",
  "fts5",
  "logs",
  "opencode",
  "policies",
  "secrets",
  "skills",
  "vault",
] as const;

export interface PortableProjectEntry {
  key: string;
  context: ContextLevel;
  roots: string[];
  defaultRoot: string | null;
  docsPath: string | null;
}

export interface PortableProjectsSnapshot {
  format: typeof PROJECTS_FORMAT;
  schemaVersion: typeof PORTABLE_VERSION;
  projects: PortableProjectEntry[];
}

export interface CapturedPortableProjects {
  snapshot: PortableProjectsSnapshot;
  fingerprint: string;
  raw: string | null;
}

export interface PortablePayload {
  format: typeof PORTABLE_FORMAT;
  schemaVersion: typeof PORTABLE_VERSION;
  manifest: {
    createdAt: string;
    sourceBackend: "json" | "sqlite";
    memorySha256: string;
    projectsSha256: string;
    included: ["mnemo", "projects"];
    excluded: string[];
    counts: {
      scopes: number;
      observations: number;
      sessions: number;
      pins: number;
      relations: number;
      projects: number;
    };
  };
  memory: PortableMemorySnapshot;
  projects: PortableProjectsSnapshot;
}

export interface PortableImportDirectives {
  mappings: ReadonlyMap<string, string>;
  replaceProjects: ReadonlySet<string>;
}

export type PortableProjectDisposition = "same" | "absent" | "conflict" | "replace";

export interface PortableProjectDecision {
  key: string;
  disposition: PortableProjectDisposition;
}

export interface PortableProjectsImportPreview {
  sourceFingerprint: string;
  destinationFingerprint: string;
  mappingsFingerprint: string;
  nextFingerprint: string;
  unmappedPaths: string[];
  conflicts: string[];
  decisions: PortableProjectDecision[];
  canApply: boolean;
  currentRaw: string | null;
  next: ProjectsFile;
}

export interface PortableExportPreview {
  destination: string;
  payloadFingerprint: string;
  sourceMemoryFingerprint: string;
  sourceProjectsFingerprint: string;
  plaintextBytes: number;
  requiresConfirmation: string;
}

export interface PortableImportPreview {
  packageSha256: string;
  payloadFingerprint: string;
  destinationMemoryFingerprint: string;
  targetMemoryFingerprint: string;
  projects: PortableProjectsImportPreview;
  previewToken: string;
  requiresConfirmation: string;
  previousMemoryBackend: "json" | "sqlite";
  canApply: boolean;
  blockers: string[];
}

export interface PortableImportApplyOptions {
  packageSha256: string;
  payload: PortablePayload;
  directives: PortableImportDirectives;
  projectsFile: string;
  legacyMemoryFile: string;
  backupsDirectory: string;
  malahorHome: string;
  expectedPreviewToken: string;
  failAfter?: "memory" | "projects";
}

export interface PortableImportApplyResult {
  applied: true;
  memory: PortableMemoryApplyResult;
  projectsChanged: boolean;
  projectsBackup: string | null;
  publishedMemoryFingerprint: string;
  publishedProjectsFingerprint: string;
}

interface PortableImportJournal {
  version: 1;
  transactionId: string;
  state: "prepared" | "memory-applied" | "projects-applied" | "recovery-required";
  packageSha256: string;
  previewToken: string;
  legacyMemoryFile: string;
  projectsFile: string;
  stagingFile: string;
  previousMemoryBackend: "json" | "sqlite";
  originalMemoryFingerprint: string;
  targetMemoryFingerprint: string;
  originalProjectsFingerprint: string;
  targetProjectsFingerprint: string;
  projectsBackup: string | null;
  projectsOriginallyPresent: boolean;
  memoryResult: PortableMemoryApplyResult | null;
  error: string | null;
}

export function capturePortableProjects(projectsFile: string): CapturedPortableProjects {
  const resolved = path.resolve(projectsFile);
  const raw = readOptionalRegularText(resolved, MAX_PROJECTS_FILE_BYTES);
  const projects = loadProjectsFile(resolved);
  const snapshot: PortableProjectsSnapshot = {
    format: PROJECTS_FORMAT,
    schemaVersion: PORTABLE_VERSION,
    projects: Object.entries(projects)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => ({
        key,
        context: entry.context,
        roots: [...(entry.roots ?? [])],
        defaultRoot: entry.defaultRoot ?? null,
        docsPath: entry.docs?.path ?? null,
      })),
  };
  validatePortableProjectsSnapshot(snapshot);
  return { snapshot, fingerprint: portablePayloadDigest(snapshot), raw };
}

export function validatePortableProjectsSnapshot(value: unknown): PortableProjectsSnapshot {
  const root = exactRecord(value, ["format", "projects", "schemaVersion"], "Registro portable de proyectos invalido.");
  if (root.format !== PROJECTS_FORMAT || root.schemaVersion !== PORTABLE_VERSION || !Array.isArray(root.projects)) {
    throw new Error("Formato portable de proyectos no soportado.");
  }
  const seen = new Set<string>();
  const projects = root.projects.map((value) => {
    const item = exactRecord(
      value,
      ["context", "defaultRoot", "docsPath", "key", "roots"],
      "Entrada portable de proyecto invalida.",
    );
    const key = portableProjectKey(item.key);
    if (seen.has(key)) throw new Error(`El paquete repite el proyecto ${key}.`);
    seen.add(key);
    const context = parseContextLevel(item.context);
    if (!Array.isArray(item.roots)) throw new Error(`Las roots de ${key} son invalidas.`);
    const roots = item.roots.map((root) => sourceAbsolutePath(root, `${key}.roots`));
    if (new Set(roots).size !== roots.length) throw new Error(`El proyecto ${key} repite roots.`);
    const defaultRoot = item.defaultRoot === null
      ? null
      : sourceAbsolutePath(item.defaultRoot, `${key}.defaultRoot`);
    if (defaultRoot !== null && !roots.includes(defaultRoot)) {
      throw new Error(`El defaultRoot de ${key} no pertenece a sus roots.`);
    }
    const docsPath = item.docsPath === null
      ? null
      : sourceAbsolutePath(item.docsPath, `${key}.docsPath`);
    return { key, context, roots, defaultRoot, docsPath };
  });
  return {
    format: PROJECTS_FORMAT,
    schemaVersion: PORTABLE_VERSION,
    projects: projects.sort((left, right) => left.key.localeCompare(right.key)),
  };
}

export function createPortablePayload(
  memoryValue: PortableMemorySnapshot,
  projectsValue: PortableProjectsSnapshot,
  createdAt = new Date().toISOString(),
): PortablePayload {
  const memory = validatePortableMemorySnapshot(memoryValue);
  const projects = validatePortableProjectsSnapshot(projectsValue);
  const timestamp = validTimestamp(createdAt, "manifest.createdAt");
  return {
    format: PORTABLE_FORMAT,
    schemaVersion: PORTABLE_VERSION,
    manifest: {
      createdAt: timestamp,
      sourceBackend: memory.sourceBackend,
      memorySha256: portableMemoryFingerprint(memory),
      projectsSha256: portablePayloadDigest(projects),
      included: ["mnemo", "projects"],
      excluded: [...EXCLUDED_SECTIONS],
      counts: {
        scopes: memory.scopes.length,
        observations: memory.observations.length,
        sessions: memory.sessions.length,
        pins: memory.pins.length,
        relations: memory.relations.length,
        projects: projects.projects.length,
      },
    },
    memory,
    projects,
  };
}

export function validatePortablePayload(value: unknown): PortablePayload {
  const root = exactRecord(
    value,
    ["format", "manifest", "memory", "projects", "schemaVersion"],
    "Payload portable invalido.",
  );
  if (root.format !== PORTABLE_FORMAT || root.schemaVersion !== PORTABLE_VERSION) {
    throw new Error("Version portable no soportada.");
  }
  const memory = validatePortableMemorySnapshot(root.memory);
  const projects = validatePortableProjectsSnapshot(root.projects);
  const manifest = exactRecord(
    root.manifest,
    ["counts", "createdAt", "excluded", "included", "memorySha256", "projectsSha256", "sourceBackend"],
    "Manifest portable invalido.",
  );
  const counts = exactRecord(
    manifest.counts,
    ["observations", "pins", "projects", "relations", "scopes", "sessions"],
    "Conteos del manifest portable invalidos.",
  );
  const included = stringArray(manifest.included, "manifest.included");
  const excluded = stringArray(manifest.excluded, "manifest.excluded");
  const expectedCounts = {
    scopes: memory.scopes.length,
    observations: memory.observations.length,
    sessions: memory.sessions.length,
    pins: memory.pins.length,
    relations: memory.relations.length,
    projects: projects.projects.length,
  };
  if (manifest.sourceBackend !== memory.sourceBackend
    || manifest.memorySha256 !== portableMemoryFingerprint(memory)
    || manifest.projectsSha256 !== portablePayloadDigest(projects)
    || JSON.stringify(included) !== JSON.stringify(["mnemo", "projects"])
    || JSON.stringify(excluded) !== JSON.stringify(EXCLUDED_SECTIONS)
    || Object.entries(expectedCounts).some(([key, count]) => counts[key] !== count)) {
    throw new Error("El manifest portable no coincide con su contenido.");
  }
  return {
    format: PORTABLE_FORMAT,
    schemaVersion: PORTABLE_VERSION,
    manifest: {
      createdAt: validTimestamp(manifest.createdAt, "manifest.createdAt"),
      sourceBackend: memory.sourceBackend,
      memorySha256: manifest.memorySha256 as string,
      projectsSha256: manifest.projectsSha256 as string,
      included: ["mnemo", "projects"],
      excluded,
      counts: expectedCounts,
    },
    memory,
    projects,
  };
}

export function portableSecretFindings(payloadValue: unknown): string[] {
  const payload = validatePortablePayload(payloadValue);
  return detectPayloadSecretKinds(JSON.stringify(payload));
}

export function parsePortableImportDirectives(values: string[]): PortableImportDirectives {
  const mappings = new Map<string, string>();
  const replaceProjects = new Set<string>();
  for (const value of values) {
    if (value.startsWith("replace:")) {
      const key = portableProjectKey(value.slice("replace:".length));
      if (replaceProjects.has(key)) throw new Error(`Estrategia replace repetida para ${key}.`);
      replaceProjects.add(key);
      continue;
    }
    const mapping = value.startsWith("map:") ? value.slice("map:".length) : value;
    const separator = mapping.indexOf("=");
    if (separator <= 0 || separator === mapping.length - 1) {
      throw new Error(`Directiva portable invalida: ${value}. Usa map:<origen>=<destino> o replace:<proyecto>.`);
    }
    const source = sourceAbsolutePath(mapping.slice(0, separator), "mapping.source");
    if (mappings.has(source)) throw new Error(`Mapping repetido para ${source}.`);
    mappings.set(source, existingDirectory(mapping.slice(separator + 1)));
  }
  return { mappings, replaceProjects };
}

export function previewPortableProjectsImport(
  snapshotValue: unknown,
  projectsFile: string,
  directives: PortableImportDirectives,
): PortableProjectsImportPreview {
  const snapshot = validatePortableProjectsSnapshot(snapshotValue);
  const current = capturePortableProjects(projectsFile);
  const currentProjects = loadProjectsFile(projectsFile);
  const sourcePaths = new Set(snapshot.projects.flatMap((project) => [
    ...project.roots,
    ...(project.docsPath ? [project.docsPath] : []),
  ]));
  const unknownMappings = [...directives.mappings.keys()].filter((source) => !sourcePaths.has(source));
  if (unknownMappings.length > 0) throw new Error(`Mappings sin hint de origen: ${unknownMappings.join(", ")}.`);
  const unknownReplacements = [...directives.replaceProjects]
    .filter((key) => !snapshot.projects.some((project) => project.key === key));
  if (unknownReplacements.length > 0) {
    throw new Error(`Replace sin proyecto de origen: ${unknownReplacements.join(", ")}.`);
  }
  const unmappedPaths = [...sourcePaths].filter((source) => !directives.mappings.has(source)).sort();
  const destinations = [...directives.mappings.values()];
  if (new Set(destinations).size !== destinations.length) {
    throw new Error("Dos hints de origen no pueden mapearse al mismo directorio destino.");
  }

  const next: ProjectsFile = { ...currentProjects };
  const conflicts: string[] = [];
  const decisions: PortableProjectDecision[] = [];
  for (const project of snapshot.projects) {
    const mapped = mappedProject(project, directives.mappings);
    const existing = currentProjects[project.key];
    if (!existing) {
      next[project.key] = mapped;
      decisions.push({ key: project.key, disposition: "absent" });
      continue;
    }
    if (sameProject(existing, mapped)) {
      if (directives.replaceProjects.has(project.key)) {
        throw new Error(`El proyecto ${project.key} ya coincide; replace seria una intencion obsoleta.`);
      }
      decisions.push({ key: project.key, disposition: "same" });
      continue;
    }
    if (!directives.replaceProjects.has(project.key)) {
      conflicts.push(project.key);
      decisions.push({ key: project.key, disposition: "conflict" });
      continue;
    }
    next[project.key] = mapped;
    decisions.push({ key: project.key, disposition: "replace" });
  }
  const mappingsFingerprint = portablePayloadDigest({
    mappings: [...directives.mappings.entries()].sort(([left], [right]) => left.localeCompare(right)),
    replaceProjects: [...directives.replaceProjects].sort(),
  });
  return {
    sourceFingerprint: portablePayloadDigest(snapshot),
    destinationFingerprint: rawFingerprint(current.raw),
    mappingsFingerprint,
    nextFingerprint: portablePayloadDigest(next),
    unmappedPaths,
    conflicts,
    decisions,
    canApply: unmappedPaths.length === 0 && conflicts.length === 0,
    currentRaw: current.raw,
    next,
  };
}

export function previewPortableExport(
  payloadValue: unknown,
  destination: string,
  source: { memoryFingerprint: string; projectsFingerprint: string },
): PortableExportPreview {
  const payload = validatePortablePayload(payloadValue);
  const resolved = safePackageDestination(destination);
  const payloadFingerprint = portablePayloadDigest(payload);
  const token = portablePayloadDigest({
    operation: "export",
    destination: resolved,
    payloadFingerprint,
    memory: source.memoryFingerprint,
    projects: source.projectsFingerprint,
  });
  return {
    destination: resolved,
    payloadFingerprint,
    sourceMemoryFingerprint: source.memoryFingerprint,
    sourceProjectsFingerprint: source.projectsFingerprint,
    plaintextBytes: Buffer.byteLength(JSON.stringify(payload)),
    requiresConfirmation: `EXPORT:${token.slice(0, 16).toUpperCase()}`,
  };
}

export function previewPortableImport(
  payloadValue: unknown,
  options: {
    packageSha256: string;
    directives: PortableImportDirectives;
    projectsFile: string;
    legacyMemoryFile: string;
    malahorHome: string;
  },
): PortableImportPreview {
  const payload = validatePortablePayload(payloadValue);
  if (!/^[a-f0-9]{64}$/.test(options.packageSha256)) throw new Error("Huella del paquete portable invalida.");
  const blockers: string[] = [];
  if (fs.existsSync(portableImportJournalPath(options.malahorHome))) {
    blockers.push("Existe un journal de importacion pendiente; recuperalo antes de iniciar otro import.");
  }
  const memory = capturePortableMemory(options.legacyMemoryFile);
  const projects = previewPortableProjectsImport(payload.projects, options.projectsFile, options.directives);
  if (!projects.canApply) blockers.push("Faltan mappings o estrategias explicitas para conflictos de proyectos.");
  const targetMemoryFingerprint = portableMemoryFingerprint({ ...payload.memory, sourceBackend: "sqlite" });
  const previewToken = portablePayloadDigest({
    operation: "import",
    packageSha256: options.packageSha256,
    payloadFingerprint: portablePayloadDigest(payload),
    destinationMemoryFingerprint: memory.fingerprint,
    targetMemoryFingerprint,
    destinationProjectsFingerprint: projects.destinationFingerprint,
    targetProjectsFingerprint: projects.nextFingerprint,
    mappingsFingerprint: projects.mappingsFingerprint,
    projectsFile: path.resolve(options.projectsFile),
    legacyMemoryFile: path.resolve(options.legacyMemoryFile),
  });
  return {
    packageSha256: options.packageSha256,
    payloadFingerprint: portablePayloadDigest(payload),
    destinationMemoryFingerprint: memory.fingerprint,
    targetMemoryFingerprint,
    projects,
    previewToken,
    requiresConfirmation: `IMPORT:${previewToken.slice(0, 16).toUpperCase()}`,
    previousMemoryBackend: memory.backend,
    canApply: blockers.length === 0,
    blockers,
  };
}

export function applyPortableImport(options: PortableImportApplyOptions): PortableImportApplyResult {
  const payload = validatePortablePayload(options.payload);
  const preview = previewPortableImport(payload, options);
  if (!preview.canApply) throw new Error(preview.blockers.join(" "));
  if (preview.previewToken !== options.expectedPreviewToken) {
    throw new Error("El paquete, el destino o los mappings cambiaron desde el preview.");
  }
  const journalPath = portableImportJournalPath(options.malahorHome);
  if (fs.existsSync(journalPath)) throw new Error("Existe un journal portable pendiente.");

  const transactionId = `${Date.now().toString(36)}-${randomUUID()}`;
  const stagingDirectory = path.join(options.malahorHome, "portable");
  ensurePrivateDirectory(stagingDirectory);
  ensurePrivateDirectory(options.backupsDirectory);
  const stagingFile = path.join(stagingDirectory, `.memory-${transactionId}.sqlite`);
  const projectsBackup = backupProjectsFile(
    options.projectsFile,
    options.backupsDirectory,
    transactionId,
    preview.projects.currentRaw,
  );
  stagePortableMemory(payload.memory, stagingFile);

  let journal: PortableImportJournal = {
    version: 1,
    transactionId,
    state: "prepared",
    packageSha256: options.packageSha256,
    previewToken: preview.previewToken,
    legacyMemoryFile: path.resolve(options.legacyMemoryFile),
    projectsFile: path.resolve(options.projectsFile),
    stagingFile,
    previousMemoryBackend: preview.previousMemoryBackend,
    originalMemoryFingerprint: preview.destinationMemoryFingerprint,
    targetMemoryFingerprint: preview.targetMemoryFingerprint,
    originalProjectsFingerprint: preview.projects.destinationFingerprint,
    targetProjectsFingerprint: preview.projects.nextFingerprint,
    projectsBackup,
    projectsOriginallyPresent: preview.projects.currentRaw !== null,
    memoryResult: null,
    error: null,
  };
  writeJournal(journalPath, journal, null);

  let memoryResult: PortableMemoryApplyResult | undefined;
  let projectsChanged = false;
  try {
    memoryResult = applyStagedPortableMemory(
      payload.memory,
      stagingFile,
      options.legacyMemoryFile,
      options.backupsDirectory,
      preview.destinationMemoryFingerprint,
    );
    journal = { ...journal, state: "memory-applied", memoryResult };
    writeJournal(journalPath, journal, journalFingerprint("prepared", journal));
    if (options.failAfter === "memory") throw new Error("Fallo sintetico despues de memoria.");

    const currentProjects = capturePortableProjects(options.projectsFile);
    if (currentProjects.fingerprint !== preview.projects.sourceFingerprint
      && rawFingerprint(currentProjects.raw) !== preview.projects.destinationFingerprint) {
      throw new Error("projects.json cambio desde el preview.");
    }
    projectsChanged = portablePayloadDigest(loadProjectsFile(options.projectsFile))
      !== portablePayloadDigest(preview.projects.next);
    if (projectsChanged) {
      writeProjectsFile(options.projectsFile, preview.projects.next, false, preview.projects.currentRaw);
    }
    const publishedProjects = capturePortableProjects(options.projectsFile);
    if (portablePayloadDigest(loadProjectsFile(options.projectsFile))
      !== portablePayloadDigest(preview.projects.next)) {
      throw new Error("projects.json publicado no coincide con el estado portable preparado.");
    }
    journal = { ...journal, state: "projects-applied" };
    writeJournal(journalPath, journal, journalFingerprint("memory-applied", journal));
    if (options.failAfter === "projects") throw new Error("Fallo sintetico despues de proyectos.");

    const publishedMemory = capturePortableMemory(options.legacyMemoryFile);
    if (publishedMemory.fingerprint !== preview.targetMemoryFingerprint) {
      throw new Error("La memoria publicada cambio antes de completar el import.");
    }
    removeIfPresent(journalPath);
    removeSqliteArtifacts(stagingFile);
    return {
      applied: true,
      memory: memoryResult,
      projectsChanged,
      projectsBackup,
      publishedMemoryFingerprint: publishedMemory.fingerprint,
      publishedProjectsFingerprint: publishedProjects.fingerprint,
    };
  } catch (error) {
    const failures: string[] = [];
    try {
      restoreProjectsFromBackup(journal);
    } catch (rollbackError) {
      failures.push(`projects.json: ${message(rollbackError)}`);
    }
    if (memoryResult) {
      try {
        rollbackPortableMemory(memoryResult, options.legacyMemoryFile);
      } catch (rollbackError) {
        failures.push(`memoria: ${message(rollbackError)}`);
      }
    }
    removeSqliteArtifacts(stagingFile);
    if (failures.length === 0) {
      removeIfPresent(journalPath);
      throw error;
    }
    const recovery = { ...journal, state: "recovery-required" as const, memoryResult: memoryResult ?? null,
      error: `${message(error)}; rollback incompleto: ${failures.join("; ")}` };
    forceWriteJournal(journalPath, recovery);
    throw new Error(recovery.error);
  }
}

export function recoverPortableImport(malahorHome: string): void {
  const journalPath = portableImportJournalPath(malahorHome);
  const journal = readJournal(journalPath);
  if (!journal) return;
  restoreProjectsFromBackup(journal);
  const current = capturePortableMemory(journal.legacyMemoryFile);
  if (journal.memoryResult) {
    if (current.fingerprint === journal.memoryResult.publishedFingerprint) {
      rollbackPortableMemory(journal.memoryResult, journal.legacyMemoryFile);
    } else if (current.fingerprint !== journal.originalMemoryFingerprint) {
      throw new Error("La memoria no coincide con el estado original ni con el import pendiente; recovery bloqueado.");
    }
  } else if (journal.previousMemoryBackend === "json") {
    const paths = memoryV2Paths(journal.legacyMemoryFile);
    removeIfPresent(paths.marker);
    removeSqliteArtifacts(paths.database);
  } else if (current.fingerprint !== journal.originalMemoryFingerprint) {
    throw new Error("El import SQLite se interrumpio antes de registrar su backup; recovery manual requerido.");
  }
  removeSqliteArtifacts(journal.stagingFile);
  removeIfPresent(journalPath);
}

export function portableImportJournalPath(malahorHome: string): string {
  return path.join(path.resolve(malahorHome), "portable", JOURNAL_FILE);
}

export function portableImportHookCommand(preview: PortableImportPreview): string {
  return `memory portable import ${preview.previewToken}`;
}

export function portableExportHookCommand(preview: PortableExportPreview): string {
  return `memory portable export ${preview.requiresConfirmation.slice("EXPORT:".length).toLowerCase()}`;
}

function mappedProject(
  project: PortableProjectEntry,
  mappings: ReadonlyMap<string, string>,
): ProjectsFile[string] {
  const roots = project.roots.flatMap((root) => {
    const mapped = mappings.get(root);
    return mapped ? [mapped] : [];
  });
  const defaultRoot = project.defaultRoot ? mappings.get(project.defaultRoot) : undefined;
  const docsPath = project.docsPath ? mappings.get(project.docsPath) : undefined;
  return {
    context: project.context,
    ...(roots.length > 0 ? { roots } : {}),
    ...(defaultRoot ? { defaultRoot } : {}),
    ...(docsPath ? { docs: { path: docsPath } } : {}),
  };
}

function sameProject(left: ProjectsFile[string], right: ProjectsFile[string]): boolean {
  return portablePayloadDigest(left) === portablePayloadDigest(right);
}

function safePackageDestination(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Destino portable invalido.");
  const resolved = path.resolve(value);
  if (path.extname(resolved).toLowerCase() !== ".mhpkg") {
    throw new Error("El paquete portable debe usar extension .mhpkg.");
  }
  const parent = path.dirname(resolved);
  existingDirectory(parent);
  if (fs.existsSync(resolved)) throw new Error("El destino portable ya existe; no se sobrescribe.");
  return resolved;
}

function existingDirectory(value: string): string {
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`El mapping debe apuntar a un directorio real: ${resolved}`);
  }
  const canonical = fs.realpathSync(resolved);
  if (canonical !== resolved) throw new Error(`El mapping no puede atravesar symlinks: ${resolved}`);
  return canonical;
}

function portableProjectKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
    throw new Error("Clave canonica de proyecto portable invalida.");
  }
  return value;
}

function sourceAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`${label} debe ser una ruta absoluta portable.`);
  }
  return path.normalize(value);
}

function rawFingerprint(raw: string | null): string {
  return createHash("sha256").update(raw === null ? "<absent>" : raw).digest("hex");
}

function backupProjectsFile(
  projectsFile: string,
  backupsDirectory: string,
  transactionId: string,
  expectedRaw: string | null,
): string | null {
  const current = readOptionalRegularText(projectsFile, MAX_PROJECTS_FILE_BYTES);
  if (current !== expectedRaw) throw new Error("projects.json cambio antes del backup.");
  if (current === null) return null;
  const destination = path.join(backupsDirectory, `projects-portable-${transactionId}.json`);
  writeExclusive(destination, Buffer.from(current, "utf8"));
  if (readOptionalRegularText(destination, MAX_PROJECTS_FILE_BYTES) !== current) {
    removeIfPresent(destination);
    throw new Error("El backup de projects.json no coincide con el origen.");
  }
  return destination;
}

function restoreProjectsFromBackup(journal: PortableImportJournal): void {
  const current = readOptionalRegularText(journal.projectsFile, MAX_PROJECTS_FILE_BYTES);
  const fingerprint = rawFingerprint(current);
  if (fingerprint === journal.originalProjectsFingerprint) return;
  const parsedFingerprint = current === null
    ? portablePayloadDigest({})
    : portablePayloadDigest(loadProjectsFile(journal.projectsFile));
  if (fingerprint !== journal.targetProjectsFingerprint && parsedFingerprint !== journal.targetProjectsFingerprint) {
    throw new Error("projects.json cambio despues del import; rollback no sobrescribe cambios nuevos.");
  }
  if (!journal.projectsOriginallyPresent) {
    removeIfPresent(journal.projectsFile);
    return;
  }
  if (!journal.projectsBackup) throw new Error("Falta el backup de projects.json.");
  const backup = readOptionalRegularText(journal.projectsBackup, MAX_PROJECTS_FILE_BYTES);
  if (backup === null || rawFingerprint(backup) !== journal.originalProjectsFingerprint) {
    throw new Error("El backup de projects.json no supera la verificacion.");
  }
  writeRawAtomic(journal.projectsFile, backup, current);
}

function writeRawAtomic(file: string, raw: string, expectedCurrent: string | null): void {
  const current = readOptionalRegularText(file, MAX_PROJECTS_FILE_BYTES);
  if (current !== expectedCurrent) throw new Error("El archivo cambio durante el rollback.");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeExclusive(temporary, Buffer.from(raw, "utf8"));
  try {
    loadProjectsFile(temporary);
    fs.renameSync(temporary, file);
    secureChmod(file, 0o600);
    fsyncDirectory(path.dirname(file));
  } finally {
    removeIfPresent(temporary);
  }
}

function writeJournal(file: string, journal: PortableImportJournal, expected: string | null): void {
  const current = readOptionalRegularText(file, 1024 * 1024);
  if (expected === null && current !== null) throw new Error("Ya existe un journal portable.");
  if (expected !== null && (current === null
    || createHash("sha256").update(current).digest("hex") !== expected)) {
    throw new Error("El journal portable cambio durante el import.");
  }
  writeRawAtomicJson(file, journal, current);
}

function forceWriteJournal(file: string, journal: PortableImportJournal): void {
  const current = readOptionalRegularText(file, 1024 * 1024);
  writeRawAtomicJson(file, journal, current);
}

function writeRawAtomicJson(file: string, value: unknown, expectedCurrent: string | null): void {
  ensurePrivateDirectory(path.dirname(file));
  const current = readOptionalRegularText(file, 1024 * 1024);
  if (current !== expectedCurrent) throw new Error("El journal cambio antes de escribirse.");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeExclusive(temporary, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
  try {
    fs.renameSync(temporary, file);
    secureChmod(file, 0o600);
    fsyncDirectory(path.dirname(file));
  } finally {
    removeIfPresent(temporary);
  }
}

function journalFingerprint(expectedState: PortableImportJournal["state"], journal: PortableImportJournal): string {
  const previous = { ...journal, state: expectedState };
  if (expectedState === "prepared") previous.memoryResult = null;
  if (expectedState !== "recovery-required") previous.error = null;
  const raw = `${JSON.stringify(previous, null, 2)}\n`;
  return createHash("sha256").update(raw).digest("hex");
}

function readJournal(file: string): PortableImportJournal | null {
  const raw = readOptionalRegularText(file, 1024 * 1024);
  if (raw === null) return null;
  const value = JSON.parse(raw) as unknown;
  const item = exactRecord(value, [
    "error", "legacyMemoryFile", "memoryResult", "originalMemoryFingerprint",
    "originalProjectsFingerprint", "packageSha256", "previewToken", "previousMemoryBackend",
    "projectsBackup", "projectsFile", "projectsOriginallyPresent", "stagingFile", "state",
    "targetMemoryFingerprint", "targetProjectsFingerprint", "transactionId", "version",
  ], "Journal portable invalido.");
  if (item.version !== 1 || typeof item.transactionId !== "string"
    || !["prepared", "memory-applied", "projects-applied", "recovery-required"].includes(String(item.state))
    || (item.previousMemoryBackend !== "json" && item.previousMemoryBackend !== "sqlite")
    || typeof item.legacyMemoryFile !== "string" || typeof item.projectsFile !== "string"
    || typeof item.stagingFile !== "string" || typeof item.projectsOriginallyPresent !== "boolean") {
    throw new Error("Journal portable no soportado.");
  }
  return value as PortableImportJournal;
}

function readOptionalRegularText(file: string, maximumBytes: number): string | null {
  const resolved = path.resolve(file);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error(`Archivo portable inseguro o demasiado grande: ${resolved}`);
  }
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameStat(before, opened)) throw new Error(`El archivo cambio antes de leerse: ${resolved}`);
    const raw = fs.readFileSync(descriptor, "utf8");
    if (!sameStat(opened, fs.fstatSync(descriptor))) throw new Error(`El archivo cambio durante la lectura: ${resolved}`);
    return raw;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusive(file: string, bytes: Buffer): void {
  ensurePrivateDirectory(path.dirname(file));
  const descriptor = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  secureChmod(file, 0o600);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Directorio portable inseguro: ${directory}`);
  secureChmod(directory, 0o700);
}

function removeSqliteArtifacts(file: string): void {
  for (const suffix of ["-wal", "-shm", ""]) removeIfPresent(`${file}${suffix}`);
}

function exactRecord(value: unknown, keys: string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} debe ser una lista de strings.`);
  }
  return value as string[];
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} es invalido.`);
  }
  return value;
}

function sameStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
