import fs from "node:fs";
import { backupFile } from "../core/backup";
import { loadConfig } from "../core/config";
import { removeBuildPolicyConfig, removeMalahorMcpConfig } from "../core/injector";
import { removeManagedInstructions } from "../core/instructions";
import {
  describePluginStateRemoval,
  describePluginSync,
  removeManagedPlugin,
  removePluginState,
} from "../core/managed-plugin";
import {
  beginManagedInstallation,
  pruneLegacyRuntimeArtifacts,
  removeManagedAssets,
} from "../core/managed-installation";
import { removeOpenCodeCommands } from "../core/opencode-commands";
import { describeAgentRemoval, removeManagedAgents } from "../core/opencode-agents";
import { describeSdkRemove, removeOpencodeSdk } from "../core/opencode-sdk";
import { removeOpenCodeSkills } from "../core/opencode-skills";
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

  const transaction = beginManagedInstallation(paths, options.dryRun);
  try {

  const configBackup = backupFile(paths.opencodeConfig, paths.backupsDir, options.dryRun);
  const instructionsRemoval = removeManagedInstructions(paths.agentsMd, paths.backupsDir, options.dryRun);
  const legacyRemoval = removeManagedInstructions(paths.opencodeMd, paths.backupsDir, options.dryRun);

  removeMalahorMcpConfig(paths, options.dryRun);
  const buildPolicy = removeBuildPolicyConfig(paths, options.dryRun);
  const removedCommands = removeOpenCodeCommands(paths, options.dryRun);
  const removedSkills = removeOpenCodeSkills(paths, options.dryRun);
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
  const memoryRuntimeExisted = fs.existsSync(paths.mnemoIndex);
  const assetsExisted = removeManagedAssets(paths, options.dryRun);
  const legacyRuntimeArtifacts = pruneLegacyRuntimeArtifacts(paths, options.dryRun);

  if (!options.dryRun) {
    if (docsRuntimeExisted) {
      fs.unlinkSync(paths.docsIndex);
      if (fs.existsSync(paths.docsDir) && fs.readdirSync(paths.docsDir).length === 0) fs.rmdirSync(paths.docsDir);
    }
    if (memoryRuntimeExisted) fs.unlinkSync(paths.mnemoIndex);
  }

  printLine(configBackup.created ? `Backup config: ${configBackup.destination}` : "Backup config: skipped");
  printLine(instructionsRemoval.backup?.created ? `Backup AGENTS.md: ${instructionsRemoval.backup.destination}` : "Backup AGENTS.md: skipped");
  printLine(legacyRemoval.backup?.created ? `Backup OPENCODE.md: ${legacyRemoval.backup.destination}` : "Backup OPENCODE.md: skipped");
  printLine(`Managed MCP registrations (Mnemo + docs): ${options.dryRun ? "would remove" : "removed"}; foreign definitions kept`);
  printLine(`Docs runtime: ${docsRuntimeExisted ? (options.dryRun ? "would remove" : "removed") : "nothing to remove"}`);
  printLine(`Memory runtime: ${memoryRuntimeExisted ? (options.dryRun ? "would remove" : "removed") : "nothing to remove"}`);
  printLine(`Managed assets: ${assetsExisted ? (options.dryRun ? "would remove" : "removed") : "nothing to remove"}`);
  printLine(`Legacy runtime artifacts: ${legacyRuntimeArtifacts.length === 0 ? "none" : `${options.dryRun ? "would remove" : "removed"} ${legacyRuntimeArtifacts.length}`}`);
  printLine(buildPolicy.removed
    ? `Build policy: ${options.dryRun ? "would remove locks" : `removed locks (${buildPolicy.cleaned.join(", ") || "marker"})`}`
    : "Build policy: nothing to remove");
  printLine(`OpenCode commands: ${options.dryRun ? "would remove" : "removed"} ${removedCommands}`);
  printLine(`OpenCode skills: ${options.dryRun ? "would remove" : "removed"} ${removedSkills.removed}; preserved ${removedSkills.preserved}`);
  printLine(describeSdkRemove(sdkRemoval));
  printLine(describePluginSync(pluginRemoval));
  printLine(describePluginStateRemoval(pluginStateRemoval));
  for (const agentRemoval of agentRemovals) {
    printLine(describeAgentRemoval(agentRemoval, options.dryRun));
    if (agentRemoval.backup?.created) {
      printLine(`Backup ${agentRemoval.agent}: ${agentRemoval.backup.destination}`);
    }
  }
  printLine(describeInstructionRemoval("AGENTS.md", instructionsRemoval.action));
  printLine(describeInstructionRemoval("OPENCODE.md", legacyRemoval.action));
  printLine("Local data: kept");
  printLine(`Docs vault: kept (${paths.vaultDir}); external project overrides are never removed`);
  transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
}

function describeInstructionRemoval(
  label: string,
  action: "removed" | "would-remove" | "kept-foreign" | "nothing-to-remove",
): string {
  if (action === "removed") return `${label}: removed`;
  if (action === "would-remove") return `${label}: would remove`;
  if (action === "kept-foreign") return `${label}: kept (no gestionado por Malahor; no se toca)`;
  return `${label}: nothing to remove`;
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
