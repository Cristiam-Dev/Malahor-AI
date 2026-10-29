import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../cli/core/config";
import { dbPath } from "../db";
import { MemoryError } from "../engine";
import { MEMORY_SCHEMA_VERSION } from "../engine/schema";
import { memoryLocation } from "../storage";
import { hashPrivateFile, migrationPaths, type MemoryMigrationPaths } from "./files";
import { readMigrationManifest, type ManifestSnapshot } from "./manifest";
import { digest, readLegacyMemorySnapshot } from "./snapshot";
import type {
  LegacyMemorySnapshot,
  MemoryMigrationManifest,
  MemoryMigrationOptions,
  MemoryMigrationPreview,
  MemoryMigrationState,
} from "./types";
import { inspectMigrationDatabase } from "./verify";

export interface MigrationInspection {
  preview: MemoryMigrationPreview;
  paths: MemoryMigrationPaths;
  snapshot: LegacyMemorySnapshot | null;
  manifest: ManifestSnapshot | null;
}

export function inspectMigration(options: MemoryMigrationOptions): MigrationInspection {
  const source = options.source ?? dbPath();
  const aliases = options.aliases ?? loadConfig().projects.aliases;
  const paths = migrationPaths(source);
  let snapshot: LegacyMemorySnapshot | null = null;
  let manifest: ManifestSnapshot | null = null;
  try {
    snapshot = readLegacyMemorySnapshot(paths.source, aliases);
    const active = memoryLocation(paths.source).backend === "sqlite";
    manifest = readMigrationManifest(paths.manifest);
    if (manifest) assertManifestSafe(manifest.manifest, paths);
    return classifyMigration(paths, snapshot, manifest, active);
  } catch (error) {
    return {
      paths,
      snapshot,
      manifest,
      preview: blockedPreview(paths, snapshot, manifest, errorMessage(error)),
    };
  }
}

export function assertActionable(preview: MemoryMigrationPreview, confirm: string): void {
  if (preview.state === "blocked") throw new MemoryError("MEMORY_ACTIVATION", preview.issue ?? "Migracion bloqueada.");
  if (!preview.confirmation || confirm !== preview.confirmation) {
    throw new MemoryError("MEMORY_INPUT", `Confirmacion invalida. Usa exactamente: ${preview.confirmation ?? "<nuevo preview>"}`);
  }
}

export function backupMatches(manifest: MemoryMigrationManifest): boolean {
  try { return hashPrivateFile(manifest.backupPath) === manifest.backupHash; } catch { return false; }
}

function classifyMigration(paths: MemoryMigrationPaths, snapshot: LegacyMemorySnapshot,
  manifest: ManifestSnapshot | null, active: boolean): MigrationInspection {
  const warnings = snapshot.aliasCollisions.length > 0
    ? [`${snapshot.aliasCollisions.length} scope(s) canonico(s) reciben mas de un scope de origen; no se deduplican registros.`]
    : [];
  const destinationExists = pathExists(paths.destination);
  if (active) return classifyActive(paths, snapshot, manifest, warnings, destinationExists);
  if (manifest && !manifestMatches(manifest.manifest, paths, snapshot)) {
    warnings.push("El origen o el mapeo de aliases cambio desde el intento anterior; sus artefactos se aislaran antes de importar el snapshot nuevo.");
    return inspection(paths, snapshot, manifest, "retryable", warnings, false);
  }
  if (destinationExists) return classifyDestination(paths, snapshot, manifest, warnings);
  if (manifest) {
    warnings.push("Se encontro una migracion interrumpida; sus artefactos se conservaran aislados al reintentar.");
    return inspection(paths, snapshot, manifest, "retryable", warnings, false);
  }
  return inspection(paths, snapshot, null, "ready", warnings, false);
}

function classifyActive(paths: MemoryMigrationPaths, snapshot: LegacyMemorySnapshot, manifest: ManifestSnapshot | null,
  warnings: string[], destinationExists: boolean): MigrationInspection {
  if (!destinationExists) throw new MemoryError("MEMORY_ACTIVATION", "El marcador esta activo pero falta db.sqlite.");
  if (!manifest || !manifestPathsMatch(manifest.manifest, paths)) {
    throw new MemoryError("MEMORY_ACTIVATION", "SQLite esta activo pero no existe procedencia verificable para este snapshot.");
  }
  if (manifest.manifest.state !== "verified") {
    throw new MemoryError("MEMORY_ACTIVATION", "SQLite esta activo pero el manifiesto no confirma una importacion verificada.");
  }
  const database = inspectMigrationDatabase(paths.destination, snapshot);
  if (!backupMatches(manifest.manifest)) warnings.push("El backup legado falta o no coincide; la recuperacion requiere revision manual.");
  if (manifest.manifest.sourceHash !== snapshot.hash || manifest.manifest.recordsDigest !== snapshot.recordsDigest) {
    warnings.push("El JSON retenido o el mapeo de aliases cambio despues de activar SQLite; no se reimporta.");
  }
  if (database.postMigrationChanges) warnings.push("SQLite contiene cambios posteriores a la importacion; rollback automatico bloqueado.");
  return inspection(paths, snapshot, manifest, "active", warnings,
    database.postMigrationChanges || manifest.manifest.recordsDigest !== snapshot.recordsDigest);
}

function classifyDestination(paths: MemoryMigrationPaths, snapshot: LegacyMemorySnapshot,
  manifest: ManifestSnapshot | null, warnings: string[]): MigrationInspection {
  if (!manifest || !manifestMatches(manifest.manifest, paths, snapshot)) {
    throw new MemoryError("MEMORY_ACTIVATION", "El destino SQLite ya existe sin manifiesto coincidente; no se sobrescribe ni mezcla.");
  }
  let database;
  try {
    database = inspectMigrationDatabase(paths.destination, snapshot);
  } catch (error) {
    if (manifest.manifest.state !== "preparing" && manifest.manifest.state !== "failed") throw error;
    warnings.push(`El destino interrumpido no es verificable y sera aislado: ${errorMessage(error)}`);
    return inspection(paths, snapshot, manifest, "retryable", warnings, false);
  }
  if (database.exact && backupMatches(manifest.manifest)) {
    return inspection(paths, snapshot, manifest, "resumable", warnings, false);
  }
  if (manifest.manifest.state === "preparing" || manifest.manifest.state === "failed") {
    warnings.push("El destino interrumpido sera aislado antes de reintentar; no se sobrescribe.");
    return inspection(paths, snapshot, manifest, "retryable", warnings, false);
  }
  throw new MemoryError("MEMORY_FORMAT", "El destino verificado ya no coincide con el snapshot; revision manual requerida.");
}

function inspection(paths: MemoryMigrationPaths, snapshot: LegacyMemorySnapshot, manifest: ManifestSnapshot | null,
  state: MemoryMigrationState, warnings: string[], postMigrationChanges: boolean): MigrationInspection {
  const confirmation = state === "active" || state === "blocked" ? null
    : confirmationFor(state, paths, snapshot, manifest?.hash ?? null);
  return {
    paths,
    snapshot,
    manifest,
    preview: {
      state,
      source: paths.source,
      destination: paths.destination,
      marker: paths.marker,
      manifest: paths.manifest,
      sourceHash: snapshot.hash,
      recordsDigest: snapshot.recordsDigest,
      observations: snapshot.db.observations.length,
      sessions: snapshot.db.sessions.length,
      nextId: snapshot.db.nextId,
      maxObservationId: snapshot.maxObservationId,
      counts: snapshot.counts,
      typeCounts: snapshot.typeCounts,
      mappings: snapshot.mappings,
      aliasCollisions: snapshot.aliasCollisions,
      confirmation,
      issue: null,
      warnings,
      postMigrationChanges,
      rollbackAutomatic: false,
      manifestHash: manifest?.hash ?? null,
    },
  };
}

function manifestMatches(manifest: MemoryMigrationManifest, paths: MemoryMigrationPaths,
  snapshot: LegacyMemorySnapshot): boolean {
  return manifestPathsMatch(manifest, paths)
    && manifest.sourceHash === snapshot.hash
    && manifest.sourceSize === snapshot.size
    && manifest.backupHash === snapshot.hash
    && manifest.recordsDigest === snapshot.recordsDigest
    && manifest.observations === snapshot.db.observations.length
    && manifest.sessions === snapshot.db.sessions.length
    && manifest.nextId === snapshot.db.nextId
    && JSON.stringify(manifest.mappings) === JSON.stringify(snapshot.mappings);
}

function manifestPathsMatch(manifest: MemoryMigrationManifest, paths: MemoryMigrationPaths): boolean {
  return manifest.schemaVersion === MEMORY_SCHEMA_VERSION
    && manifest.sourcePath === paths.source
    && manifest.destinationPath === paths.destination
    && manifest.markerPath === paths.marker;
}

function assertManifestSafe(manifest: MemoryMigrationManifest, paths: MemoryMigrationPaths): void {
  const transaction = /^[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!transaction.test(manifest.transactionId)) {
    throw new MemoryError("MEMORY_FORMAT", "El manifiesto contiene un identificador de transaccion invalido.");
  }
  if (!manifestPathsMatch(manifest, paths)) {
    throw new MemoryError("MEMORY_ACTIVATION", "El manifiesto pertenece a otra ruta de memoria.");
  }
  const expectedStaging = `${paths.destination}.staging-${manifest.transactionId}`;
  const expectedBackup = path.join(paths.backupsDirectory,
    `memory-legacy-${manifest.sourceHash.slice(0, 12)}-${manifest.transactionId}.json`);
  if (manifest.stagingPath !== expectedStaging || manifest.backupPath !== expectedBackup
    || manifest.backupHash !== manifest.sourceHash) {
    throw new MemoryError("MEMORY_FORMAT", "Las rutas o el hash de respaldo del manifiesto no son validos.");
  }
  const mappingKeys = new Set<string>();
  let mappedObservations = 0;
  let mappedSessions = 0;
  for (const mapping of manifest.mappings) {
    const key = `${mapping.source}\0${mapping.target}`;
    if (mappingKeys.has(key) || mapping.changed !== (mapping.source !== mapping.target)
      || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(mapping.target)) {
      throw new MemoryError("MEMORY_FORMAT", "El manifiesto contiene un mapeo de aliases inconsistente.");
    }
    mappingKeys.add(key);
    mappedObservations += mapping.observations;
    mappedSessions += mapping.sessions;
  }
  if (mappedObservations !== manifest.observations || mappedSessions !== manifest.sessions) {
    throw new MemoryError("MEMORY_FORMAT", "Los conteos del manifiesto no coinciden con su mapeo de aliases.");
  }
  for (const artifact of manifest.artifacts) {
    const resolved = path.resolve(artifact);
    const confined = isInside(resolved, paths.memoryDirectory) || isInside(resolved, paths.backupsDirectory);
    if (artifact !== resolved || !confined || [paths.source, paths.marker, paths.manifest].includes(resolved)) {
      throw new MemoryError("MEMORY_FORMAT", "El manifiesto contiene un artefacto fuera de las carpetas de migracion.");
    }
  }
}

function blockedPreview(paths: MemoryMigrationPaths, snapshot: LegacyMemorySnapshot | null,
  manifest: ManifestSnapshot | null, issue: string): MemoryMigrationPreview {
  return {
    state: "blocked",
    source: paths.source,
    destination: paths.destination,
    marker: paths.marker,
    manifest: paths.manifest,
    sourceHash: snapshot?.hash ?? null,
    recordsDigest: snapshot?.recordsDigest ?? null,
    observations: snapshot?.db.observations.length ?? 0,
    sessions: snapshot?.db.sessions.length ?? 0,
    nextId: snapshot?.db.nextId ?? null,
    maxObservationId: snapshot?.maxObservationId ?? null,
    counts: snapshot?.counts ?? [],
    typeCounts: snapshot?.typeCounts ?? [],
    mappings: snapshot?.mappings ?? [],
    aliasCollisions: snapshot?.aliasCollisions ?? [],
    confirmation: null,
    issue,
    warnings: [],
    postMigrationChanges: false,
    rollbackAutomatic: false,
    manifestHash: manifest?.hash ?? null,
  };
}

function confirmationFor(state: MemoryMigrationState, paths: MemoryMigrationPaths, snapshot: LegacyMemorySnapshot,
  manifestHash: string | null): string {
  const token = digest(JSON.stringify({ state, source: snapshot.hash, records: snapshot.recordsDigest,
    destination: paths.destination, manifest: manifestHash, schema: MEMORY_SCHEMA_VERSION }));
  return `MIGRATE_MEMORY:${token}`;
}

function isInside(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathExists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
