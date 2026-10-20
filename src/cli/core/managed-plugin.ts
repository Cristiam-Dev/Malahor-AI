import fs from "node:fs";
import path from "node:path";

import { backupFile, type BackupResult } from "./backup";

export const MANAGED_PLUGIN_MARKER = "malahor-managed";
const MARKER_SCAN_LINES = 5;

export type ManagedPluginStatus =
  | "installed"
  | "updated"
  | "up-to-date"
  | "would-install"
  | "would-update"
  | "skipped-foreign"
  | "missing-asset"
  | "removed"
  | "would-remove"
  | "nothing-to-remove"
  | "kept-foreign";

export interface ManagedPluginResult {
  status: ManagedPluginStatus;
  destination: string;
  backup: BackupResult | null;
}

export function syncManagedPlugin(
  assetFile: string,
  destinationDir: string,
  backupsDir: string,
  dryRun: boolean,
): ManagedPluginResult {
  const destination = path.join(destinationDir, "index.ts");

  if (!fs.existsSync(assetFile)) {
    return { status: "missing-asset", destination, backup: null };
  }

  const asset = fs.readFileSync(assetFile, "utf8");

  if (!fs.existsSync(destination)) {
    if (!dryRun) {
      fs.mkdirSync(destinationDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, asset, { encoding: "utf8", mode: 0o644 });
      fs.chmodSync(destination, 0o644);
    }
    return { status: dryRun ? "would-install" : "installed", destination, backup: null };
  }

  const current = fs.readFileSync(destination, "utf8");

  if (!isManagedContent(current)) {
    return { status: "skipped-foreign", destination, backup: null };
  }

  if (current === asset) {
    return { status: "up-to-date", destination, backup: null };
  }

  const backup = backupFile(destination, backupsDir, dryRun);
  if (!dryRun) {
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, asset, { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(destination, 0o644);
  }

  return { status: dryRun ? "would-update" : "updated", destination, backup };
}

export function removeManagedPlugin(
  destinationDir: string,
  backupsDir: string,
  dryRun: boolean,
): ManagedPluginResult {
  const destination = path.join(destinationDir, "index.ts");

  if (!fs.existsSync(destination)) {
    return { status: "nothing-to-remove", destination, backup: null };
  }

  const current = fs.readFileSync(destination, "utf8");

  if (!isManagedContent(current)) {
    return { status: "kept-foreign", destination, backup: null };
  }

  const backup = backupFile(destination, backupsDir, dryRun);
  if (!dryRun) {
    fs.unlinkSync(destination);
    try {
      fs.rmdirSync(destinationDir);
    } catch {
      // El directorio conserva archivos ajenos: no se toca.
    }
  }

  return { status: dryRun ? "would-remove" : "removed", destination, backup };
}

export type PluginStateRemovalStatus = "removed" | "would-remove" | "nothing-to-remove";

export function removePluginState(stateFile: string, dryRun: boolean): PluginStateRemovalStatus {
  if (!fs.existsSync(stateFile)) {
    return "nothing-to-remove";
  }

  if (!dryRun) {
    fs.rmSync(stateFile, { force: true });
  }

  return dryRun ? "would-remove" : "removed";
}

export function describePluginStateRemoval(status: PluginStateRemovalStatus): string {
  switch (status) {
    case "removed":
      return "Plugin state: removed";
    case "would-remove":
      return "Plugin state: would remove";
    case "nothing-to-remove":
      return "Plugin state: nothing to remove";
  }
}

export function isManagedContent(content: string): boolean {
  return content
    .split(/\r?\n/, MARKER_SCAN_LINES)
    .some((line) => line.includes(`// ${MANAGED_PLUGIN_MARKER}`));
}

export function describePluginSync(result: ManagedPluginResult): string {
  switch (result.status) {
    case "installed":
      return `Plugin: installed ${result.destination}`;
    case "updated":
      return `Plugin: updated ${result.destination}${backupSuffix(result)}`;
    case "up-to-date":
      return `Plugin: up to date ${result.destination}`;
    case "would-install":
      return `Plugin: would install ${result.destination}`;
    case "would-update":
      return `Plugin: would update ${result.destination}`;
    case "skipped-foreign":
      return `Plugin: WARN ${result.destination} no gestionado; no se toca`;
    case "missing-asset":
      return "Plugin: WARN asset no encontrado";
    case "removed":
      return `Plugin: removed ${result.destination}${backupSuffix(result)}`;
    case "would-remove":
      return `Plugin: would remove ${result.destination}`;
    case "nothing-to-remove":
      return "Plugin: nothing to remove";
    case "kept-foreign":
      return `Plugin: kept (${result.destination} no gestionado)`;
  }
}

function backupSuffix(result: ManagedPluginResult): string {
  return result.backup?.created && result.backup.destination
    ? ` (backup: ${result.backup.destination})`
    : "";
}
