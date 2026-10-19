import fs from "node:fs";
import path from "node:path";

import { backupFile, type BackupResult } from "./backup";

// Marca de gestion: distingue un archivo escrito por Malahor de uno propio del usuario.
// El archivo ajeno jamas se pisa ni se retira (ver install/update/uninstall/doctor).
export const MALAHOR_MANAGED_MARKER = "<!-- malahor-managed";

export type InstructionsState = "managed" | "foreign" | "missing";

export interface InstructionsSyncResult {
  action: "created" | "refreshed" | "unchanged" | "kept-foreign";
  destination: string;
  backup: BackupResult | null;
}

export function instructionsState(filePath: string): InstructionsState {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }

  try {
    return fs.readFileSync(filePath, "utf8").includes(MALAHOR_MANAGED_MARKER) ? "managed" : "foreign";
  } catch {
    return "foreign";
  }
}

export function syncManagedInstructions(assetPath: string, destination: string, backupsDir: string, dryRun: boolean): InstructionsSyncResult {
  const assetContent = fs.readFileSync(assetPath, "utf8");
  const state = instructionsState(destination);

  if (state === "foreign") {
    return { action: "kept-foreign", destination, backup: null };
  }

  if (state === "managed" && fs.readFileSync(destination, "utf8") === assetContent) {
    return { action: "unchanged", destination, backup: null };
  }

  const backup = state === "managed" ? backupFile(destination, backupsDir, dryRun) : null;

  if (!dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(assetPath, destination);
  }

  return { action: state === "managed" ? "refreshed" : "created", destination, backup };
}

export function describeInstructionsSync(result: InstructionsSyncResult, dryRun: boolean): string {
  switch (result.action) {
    case "created":
      return `AGENTS.md: ${dryRun ? "would install" : "installed"} (gestionado por Malahor)`;
    case "refreshed":
      return `AGENTS.md: ${dryRun ? "would refresh" : "refreshed"}`;
    case "unchanged":
      return "AGENTS.md: up to date";
    case "kept-foreign":
      return "AGENTS.md: kept (no gestionado por Malahor; no se toca)";
  }
}

// Mensaje comun para instalaciones que todavia tienen el OPENCODE.md de versiones previas
// (inerte en OpenCode V2, que solo lee AGENTS.md).
export function legacyInstructionsHint(legacyPath: string): string | null {
  if (!fs.existsSync(legacyPath)) {
    return null;
  }

  return "OPENCODE.md: legado detectado (OpenCode V2 solo lee AGENTS.md); archivar con `malahor-ai doctor --self-heal`";
}
