import fs from "node:fs";
import { backupFile } from "../core/backup";
import { loadConfig } from "../core/config";
import { removeBuildPolicyConfig, removeMalahorMcpConfig } from "../core/injector";
import { instructionsState } from "../core/instructions";
import {
  describePluginStateRemoval,
  describePluginSync,
  removeManagedPlugin,
  removePluginState,
} from "../core/managed-plugin";
import { removeOpenCodeCommands } from "../core/opencode-commands";
import { describeAgentRemoval, removeManagedAgents } from "../core/opencode-agents";
import { describeSdkRemove, removeOpencodeSdk } from "../core/opencode-sdk";
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

  removeMalahorMcpConfig(paths, options.dryRun);
  const buildPolicy = removeBuildPolicyConfig(paths, options.dryRun);
  const removedCommands = removeOpenCodeCommands(paths, options.dryRun);
  const sdkRemoval = removeOpencodeSdk({
    opencodeDir: paths.opencodeDir,
    backupsDir: paths.backupsDir,
    stateFile: paths.opencodeSdkState,
    dryRun: options.dryRun,
  });
  const pluginRemoval = removeManagedPlugin(paths.malahorPluginDir, paths.backupsDir, options.dryRun);
  const pluginStateRemoval = removePluginState(paths.pluginState, options.dryRun);
  const agentRemovals = removeManagedAgents(paths, options.dryRun);
  const docsRuntimeExisted = fs.existsSync(paths.docsIndex);

  if (!options.dryRun) {
    if (agentsState === "managed" && fs.existsSync(paths.agentsMd)) {
      fs.unlinkSync(paths.agentsMd);
    }
    if (legacyExisted) {
      fs.unlinkSync(paths.opencodeMd);
    }
    if (docsRuntimeExisted) {
      fs.unlinkSync(paths.docsIndex);
      if (fs.existsSync(paths.docsDir) && fs.readdirSync(paths.docsDir).length === 0) fs.rmdirSync(paths.docsDir);
    }
  }

  printLine(configBackup.created ? `Backup config: ${configBackup.destination}` : "Backup config: skipped");
  printLine(agentsBackup?.created ? `Backup AGENTS.md: ${agentsBackup.destination}` : "Backup AGENTS.md: skipped");
  printLine(mdBackup.created ? `Backup OPENCODE.md: ${mdBackup.destination}` : "Backup OPENCODE.md: skipped");
  printLine(`Managed MCP registrations (Mnemo + docs): ${options.dryRun ? "would remove" : "removed"}; foreign definitions kept`);
  printLine(`Docs runtime: ${docsRuntimeExisted ? (options.dryRun ? "would remove" : "removed") : "nothing to remove"}`);
  printLine(buildPolicy.removed
    ? `Build policy: ${options.dryRun ? "would remove locks" : `removed locks (${buildPolicy.cleaned.join(", ") || "marker"})`}`
    : "Build policy: nothing to remove");
  printLine(`OpenCode commands: ${options.dryRun ? "would remove" : "removed"} ${removedCommands}`);
  printLine(describeSdkRemove(sdkRemoval));
  printLine(describePluginSync(pluginRemoval));
  printLine(describePluginStateRemoval(pluginStateRemoval));
  for (const agentRemoval of agentRemovals) {
    printLine(describeAgentRemoval(agentRemoval, options.dryRun));
    if (agentRemoval.backup?.created) {
      printLine(`Backup ${agentRemoval.agent}: ${agentRemoval.backup.destination}`);
    }
  }
  printLine(agentsState === "managed"
    ? `AGENTS.md: ${options.dryRun ? "would remove" : "removed"}`
    : agentsState === "foreign"
      ? "AGENTS.md: kept (no gestionado por Malahor; no se toca)"
      : "AGENTS.md: nothing to remove");
  printLine(legacyExisted ? `OPENCODE.md: ${options.dryRun ? "would remove" : "removed"}` : "OPENCODE.md: nothing to remove");
  printLine("Local data: kept");
  printLine(`Docs vault: kept (${paths.vaultDir}); external project overrides are never removed`);
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
