import fs from "node:fs";
import { backupFile } from "../core/backup";
import { loadConfig } from "../core/config";
import { removeMnemoConfig } from "../core/injector";
import { isSandbox } from "../core/paths";

export interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
}

export function runUninstall(options: UninstallOptions): void {
  const config = loadConfig();
  const paths = config.paths;

  printHeader("malahor-ai uninstall");
  printLine(`Mode: ${config.mode}`);
  printLine(`Config file: ${paths.configFile}`);
  printLine(`Malahor home: ${paths.malahorHome}`);
  printLine(`OpenCode dir: ${paths.opencodeDir}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  const configBackup = backupFile(paths.opencodeConfig, paths.backupsDir, options.dryRun);
  const mdBackup = backupFile(paths.opencodeMd, paths.backupsDir, options.dryRun);

  removeMnemoConfig(paths, options.dryRun);

  if (!options.dryRun && fs.existsSync(paths.opencodeMd)) {
    fs.unlinkSync(paths.opencodeMd);
  }

  printLine(configBackup.created ? `Backup config: ${configBackup.destination}` : "Backup config: skipped");
  printLine(mdBackup.created ? `Backup OPENCODE.md: ${mdBackup.destination}` : "Backup OPENCODE.md: skipped");
  printLine(`Mnemo MCP: ${options.dryRun ? "would remove from OpenCode config" : "removed from OpenCode config"}`);
  printLine(`OPENCODE.md: ${options.dryRun ? "would remove" : "removed"}`);
  printLine("Local data: kept");
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
