import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { MalahorPaths } from "./paths";

export const MALAHOR_COMMAND_FILES = [
  "recuperar-contexto.md",
  "malahor-contexto.md",
  "guardar-contexto.md",
  "compactar-seguro.md",
  "malahor-bootstrap.md",
  "malahor-actualizar.md",
  "malahor-doctor.md",
  "malahor-reparar.md",
  "malahor-commit.md",
] as const;

const COMMAND_MANIFEST = ".malahor-managed.json";
const COMMAND_MANIFEST_VERSION = 1;

interface CommandManifest {
  version: 1;
  files: Array<{ name: string; sha256: string }>;
}

export function managedCommandsManifestPath(paths: MalahorPaths): string {
  return path.join(paths.opencodeDir, "commands", COMMAND_MANIFEST);
}

export function syncOpenCodeCommands(
  sourceDir: string,
  paths: MalahorPaths,
  dryRun: boolean,
): { source: string; destination: string; files: number; removed: number; preserved: number } {
  const destination = path.join(paths.opencodeDir, "commands");

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`No existe directorio de comandos OpenCode: ${sourceDir}`);
  }

  for (const file of MALAHOR_COMMAND_FILES) {
    if (!fs.existsSync(path.join(sourceDir, file))) {
      throw new Error(`No existe comando OpenCode gestionado: ${path.join(sourceDir, file)}`);
    }
  }

  const previous = readManifest(managedCommandsManifestPath(paths));
  const desired = new Set<string>(MALAHOR_COMMAND_FILES);
  let removed = 0;
  let preserved = 0;
  if (previous) {
    for (const entry of previous.files) {
      if (desired.has(entry.name)) continue;
      const stale = path.join(destination, entry.name);
      if (!fs.existsSync(stale)) continue;
      if (regularFileHash(stale) !== entry.sha256) {
        preserved += 1;
        continue;
      }
      removed += 1;
      if (!dryRun) fs.unlinkSync(stale);
    }
  }

  if (!dryRun) {
    fs.mkdirSync(destination, { recursive: true });
    for (const file of MALAHOR_COMMAND_FILES) {
      fs.copyFileSync(path.join(sourceDir, file), path.join(destination, file));
    }
    writeManifest(managedCommandsManifestPath(paths), {
      version: COMMAND_MANIFEST_VERSION,
      files: MALAHOR_COMMAND_FILES.map((name) => ({
        name,
        sha256: requiredFileHash(path.join(destination, name)),
      })),
    });
  }

  return { source: sourceDir, destination, files: MALAHOR_COMMAND_FILES.length, removed, preserved };
}

export function removeOpenCodeCommands(paths: MalahorPaths, dryRun: boolean): number {
  const destination = path.join(paths.opencodeDir, "commands");
  const manifestPath = managedCommandsManifestPath(paths);
  const manifest = readManifest(manifestPath);
  const candidates = manifest?.files ?? MALAHOR_COMMAND_FILES.map((name) => ({ name, sha256: null }));
  let removed = 0;

  for (const entry of candidates) {
    const filePath = path.join(destination, entry.name);
    if (!fs.existsSync(filePath)) continue;
    if (entry.sha256 !== null && regularFileHash(filePath) !== entry.sha256) continue;
    removed += 1;
    if (!dryRun) fs.unlinkSync(filePath);
  }

  if (!dryRun && fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  return removed;
}

function readManifest(file: string): CommandManifest | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(parsed) || parsed.version !== COMMAND_MANIFEST_VERSION || !Array.isArray(parsed.files)) return null;
    const files: CommandManifest["files"] = [];
    const seen = new Set<string>();
    for (const entry of parsed.files) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.sha256 !== "string") return null;
      if (!safeName(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.name)) return null;
      seen.add(entry.name);
      files.push({ name: entry.name, sha256: entry.sha256 });
    }
    return { version: COMMAND_MANIFEST_VERSION, files };
  } catch {
    return null;
  }
}

function writeManifest(file: string, manifest: CommandManifest): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function regularFileHash(file: string): string | null {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requiredFileHash(file: string): string {
  const digest = regularFileHash(file);
  if (!digest) throw new Error(`El comando gestionado no es un archivo regular: ${file}`);
  return digest;
}

function safeName(name: string): boolean {
  return name.length > 0 && path.basename(name) === name && name !== "." && name !== "..";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
