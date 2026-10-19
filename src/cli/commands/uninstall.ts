import fs from "node:fs";
import { backupFile } from "../core/backup";
import { loadConfig } from "../core/config";
import { removeBuildPolicyConfig, removeMnemoConfig } from "../core/injector";
import { instructionsState } from "../core/instructions";
import { removeOpenCodeCommands } from "../core/opencode-commands";
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
  const agentsState = instructionsState(paths.agentsMd);
  const agentsBackup = agentsState === "managed" ? backupFile(paths.agentsMd, paths.backupsDir, options.dryRun) : null;
  const mdBackup = backupFile(paths.opencodeMd, paths.backupsDir, options.dryRun);
  const legacyExisted = fs.existsSync(paths.opencodeMd);

  removeMnemoConfig(paths, options.dryRun);
  const buildPolicy = removeBuildPolicyConfig(paths, options.dryRun);
  const removedCommands = removeOpenCodeCommands(paths, options.dryRun);

  if (!options.dryRun) {
    if (agentsState === "managed" && fs.existsSync(paths.agentsMd)) {
      fs.unlinkSync(paths.agentsMd);
    }
    if (legacyExisted) {
      fs.unlinkSync(paths.opencodeMd);
    }
  }

  printLine(configBackup.created ? `Backup config: ${configBackup.destination}` : "Backup config: skipped");
  printLine(agentsBackup?.created ? `Backup AGENTS.md: ${agentsBackup.destination}` : "Backup AGENTS.md: skipped");
  printLine(mdBackup.created ? `Backup OPENCODE.md: ${mdBackup.destination}` : "Backup OPENCODE.md: skipped");
  printLine(`Mnemo MCP: ${options.dryRun ? "would remove from OpenCode config" : "removed from OpenCode config"}`);
  printLine(buildPolicy.removed
    ? `Build policy: ${options.dryRun ? "would remove locks" : `removed locks (${buildPolicy.cleaned.join(", ") || "marker"})`}`
    : "Build policy: nothing to remove");
  printLine(`OpenCode commands: ${options.dryRun ? "would remove" : "removed"} ${removedCommands}`);
  printLine(agentsState === "managed"
    ? `AGENTS.md: ${options.dryRun ? "would remove" : "removed"}`
    : agentsState === "foreign"
      ? "AGENTS.md: kept (no gestionado por Malahor; no se toca)"
      : "AGENTS.md: nothing to remove");
  printLine(legacyExisted ? `OPENCODE.md: ${options.dryRun ? "would remove" : "removed"}` : "OPENCODE.md: nothing to remove");
  printLine("Local data: kept");
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
