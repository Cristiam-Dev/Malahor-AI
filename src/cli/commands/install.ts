import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { backupFile } from "../core/backup";
import { offerCodegraphSetup } from "./codegraph";
import { codegraphRoot } from "../core/codegraph-runtime";
import { copyAssets } from "../core/assets";
import {
  formatExecutionPolicy,
  loadConfig,
  saveExecutionPolicy,
  type MalahorExecutionPolicy,
} from "../core/config";
import { registerProjectRoot } from "../core/context";
import { detectEnvironment, detectOpenCodeHost, type DetectionResult, type OpenCodeHostKind } from "../core/detector";
import { parseExecutionLevel } from "../core/execution-policy";
import { assertHooksAllowed } from "../core/hooks/engine";
import { loadHookPolicy } from "../core/hooks/policy-loader";
import { syncOpenCodeConfig } from "../core/injector";
import { describeInstructionsSync, legacyInstructionsHint, syncManagedInstructions } from "../core/instructions";
import { describePluginSync, syncManagedPlugin } from "../core/managed-plugin";
import { assertAgentAssets, describeAgentSync, syncManagedAgents } from "../core/opencode-agents";
import { syncOpenCodeCommands } from "../core/opencode-commands";
import { describeSdkEnsure, ensureOpencodeSdk } from "../core/opencode-sdk";
import { resolvePackagePaths } from "../core/package";
import { isSandbox, type MalahorPaths } from "../core/paths";
import { resolveProject } from "../core/project";
import type { MalahorPackagePaths } from "../core/package";
import { validateInstallation } from "../core/validate";

export interface InstallOptions {
  dryRun: boolean;
  yes: boolean;
  bootstrap: boolean;
  policyAfter: string | undefined;
}

export async function runInstall(options: InstallOptions): Promise<void> {
  const config = loadConfig();
  const paths = config.paths;
  const detection = detectEnvironment(paths);
  const host = detectOpenCodeHost(paths);
  const packagePaths = resolvePackagePaths(paths.cwd);
  const agentsAsset = path.join(packagePaths.assetsDir, "opencode", "AGENTS.md");
  const commandsAsset = path.join(packagePaths.assetsDir, "opencode", "commands");
  const pluginAsset = path.join(packagePaths.assetsDir, "opencode", "plugins", "malahor", "index.ts");

  printHeader("malahor-ai install");
  printLine(`Mode: ${config.mode}`);
  printLine(`Config file: ${paths.configFile}`);
  printLine(`Malahor home: ${paths.malahorHome}`);
  printLine(`OpenCode dir: ${paths.opencodeDir}`);
  printLine(`Bootstrap: ${options.bootstrap ? "yes" : "no"}`);
  printLine(`Policy after: ${options.policyAfter ?? (options.yes ? "stored" : "prompt")}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  if (detection.nodeMajor < 22) {
    throw new Error(`Node 22+ es requerido. Detectado: ${detection.nodeVersion}`);
  }

  // Politica DIFERIDA: se valida todo antes de tocar permisos del agente.
  // Si la validacion falla, la politica guardada sigue intacta y el agente conserva salida.
  ensureBuild(packagePaths, paths, detection, options);

  if (!fs.existsSync(agentsAsset)) {
    throw new Error("No existe assets/opencode/AGENTS.md.");
  }

  if (!fs.existsSync(pluginAsset)) {
    throw new Error("No existe assets/opencode/plugins/malahor/index.ts.");
  }

  assertAgentAssets(packagePaths.assetsDir, host.kind);

  if (!options.dryRun) {
    fs.mkdirSync(paths.mnemoDir, { recursive: true });
    fs.mkdirSync(paths.assetsDir, { recursive: true });
    fs.mkdirSync(paths.vaultDir, { recursive: true });
    fs.mkdirSync(paths.opencodeDir, { recursive: true });
  }

  const configBackup = host.kind === "v2"
    ? { created: false, destination: null }
    : backupFile(paths.opencodeConfig, paths.backupsDir, options.dryRun);
  const agentsSync = syncManagedInstructions(agentsAsset, paths.agentsMd, paths.backupsDir, options.dryRun);

  if (!options.dryRun) {
    fs.copyFileSync(packagePaths.mnemoBuild, paths.mnemoIndex);
  }

  copyAssets(packagePaths.assetsDir, paths.assetsDir, options.dryRun);
  const commands = syncOpenCodeCommands(commandsAsset, paths, options.dryRun);
  const sdk = ensureOpencodeSdk({
    opencodeDir: paths.opencodeDir,
    backupsDir: paths.backupsDir,
    stateFile: paths.opencodeSdkState,
    dryRun: options.dryRun,
    commands: { bun: detection.commands.bun, npm: detection.commands.npm },
  });
  const plugin = syncManagedPlugin(pluginAsset, paths.malahorPluginDir, paths.backupsDir, options.dryRun);
  const agents = syncManagedAgents(packagePaths.assetsDir, paths, host.kind, options.dryRun);

  // MCP + compaction primero (sin tocar politica): Mnemo debe poder usarse ya.
  syncOpenCodeConfig(paths, {
    execution: config.execution,
    applyPolicy: false,
    manageMcp: host.kind !== "v2",
    verifyOnly: host.kind === "v2",
  }, options.dryRun);

  printLine(configBackup.created ? `Backup config: ${configBackup.destination}` : "Backup config: skipped");
  printLine(agentsSync.backup?.created ? `Backup AGENTS.md: ${agentsSync.backup.destination}` : "Backup AGENTS.md: skipped");
  printLine(`Assets: ${options.dryRun ? "would install" : "installed"}`);
  printLine(`OpenCode commands: ${options.dryRun ? "would install" : "installed"} ${commands.files} in ${commands.destination}`);
  printLine(describeSdkEnsure(sdk));
  printLine(describePluginSync(plugin));
  for (const agent of agents) {
    printLine(describeAgentSync(agent, options.dryRun));
  }
  printLine(`Mnemo MCP: ${host.kind === "v2" ? "runtime plugin transform" : "configured in legacy config"}`);
  printLine(`OpenCode compaction: ${host.kind === "v2" ? "runtime plugin hook (verify-only config)" : "configured"}`);

  validateBeforePolicy(paths, packagePaths, options, host.kind === "v2", host.kind === "v2", host.kind);

  const execution = await resolveFinalPolicy(config.execution, options);
  const project = resolveProject(packagePaths.root, config.projects.aliases);
  registerProjectRoot(paths.projectsFile, project.canonicalKey, project.root, options.dryRun);
  const policyLoad = loadHookPolicy(paths, project.canonicalKey);
  assertHooksAllowed({
    event: "install.beforePolicy",
    harness: "cli",
    profile: policyLoad.policy.profile,
    cwd: paths.cwd,
    projectRoot: packagePaths.root,
    malahorHome: paths.malahorHome,
    project: project.canonicalKey,
    policy: policyLoad.policy,
    security: policyLoad.security,
    policyMeta: policyLoad.policyMeta,
    metadata: {
      appliesPolicyBeforeValidation: false,
      bashDenyTotal: false,
    },
  });
  saveExecutionPolicy({ ...config, execution }, options.dryRun);
  syncOpenCodeConfig(paths, {
    execution,
    manageMcp: host.kind !== "v2",
    verifyOnly: host.kind === "v2",
  }, options.dryRun);

  printLine(`Malahor config: ${options.dryRun ? "would save" : "saved"}`);
  printLine(`OpenCode build policy: ${host.kind === "v2" ? "runtime plugin (config verify-only)" : (options.dryRun ? "would sync" : "synced")} (${formatExecutionPolicy(execution)})`);
  printLine(describeInstructionsSync(agentsSync, options.dryRun));
  const legacyHint = legacyInstructionsHint(paths.opencodeMd);
  if (legacyHint) printLine(legacyHint);
  printLine("Validation: passed (politica aplicada al final)");
  printLine("Next: run `malahor-ai doctor`. Si la politica cambio, abre una sesion nueva de OpenCode para recargarla.");
  printLine("Reparacion sin consola: /malahor-bootstrap y /malahor-reparar funcionan aunque el agente este bloqueado.");
  if (!options.dryRun && !options.yes && !options.bootstrap) {
    try {
      await offerCodegraphSetup(paths, project.canonicalKey, codegraphRoot(paths, project.canonicalKey).root);
    } catch (error) {
      printLine(`CodeGraph degradado: ${(error as Error).message}. La instalacion principal sigue operativa.`);
    }
  } else {
    printLine("CodeGraph: instalacion/indexado no automaticos; `malahor-ai codegraph guide`.");
  }
}

function ensureBuild(packagePaths: MalahorPackagePaths, _paths: MalahorPaths, detection: DetectionResult, options: InstallOptions): void {
  if (fs.existsSync(packagePaths.mnemoBuild)) return;

  const canAutoBuild = detection.commands.bun && fs.existsSync(path.join(packagePaths.root, "src"));

  if (options.bootstrap && canAutoBuild && !options.dryRun) {
    printLine("Bootstrap: dist/ no existe; corriendo `bun run build` automaticamente...");
    execFileSync("bun", ["run", "build"], { cwd: packagePaths.root, stdio: "inherit" });
    if (fs.existsSync(packagePaths.mnemoBuild)) return;
    throw new Error("`bun run build` no genero dist/mnemo/index.js. Corre el build manualmente y revisa errores.");
  }

  if (options.dryRun) return;

  throw new Error("No existe dist/mnemo/index.js. Ejecuta `bun run build` antes de instalar (o usa `install --bootstrap` con bun disponible).");
}

function validateBeforePolicy(
  paths: MalahorPaths,
  packagePaths: MalahorPackagePaths | null,
  options: InstallOptions,
  mcpManagedByPlugin: boolean,
  configManagedByPlugin: boolean,
  agentHost: OpenCodeHostKind,
): void {
  if (options.dryRun) {
    printLine("Validation: skipped in dry-run");
    return;
  }

  const problems = validateInstallation(paths, packagePaths, { mcpManagedByPlugin, configManagedByPlugin, agentHost });
  if (problems.length > 0) {
    printLine("Validation: FAILED (no se aplico politica de intervencion; el agente queda desbloqueado)");
    for (const problem of problems) {
      printLine(`  - ${problem}`);
    }
    printLine("Reparacion: `malahor-ai doctor --self-heal` o `malahor-ai install --bootstrap --yes`.");
    throw new Error(`La instalacion no paso validacion (${problems.length} problemas). La politica no fue aplicada a proposito.`);
  }
}

async function resolveFinalPolicy(stored: MalahorExecutionPolicy, options: InstallOptions): Promise<MalahorExecutionPolicy> {
  if (options.policyAfter !== undefined) {
    const intervention = parseExecutionLevel(options.policyAfter, stored.intervention);
    return { intervention, verification: intervention === "acompanar" ? false : stored.verification };
  }

  if (options.yes || options.bootstrap || !process.stdin.isTTY || !process.stdout.isTTY) {
    return stored;
  }

  // Interactivo sin --policy-after: preguntar ahora, al final (no antes de instalar).
  const { promptExecutionPolicy } = await import("../core/execution-policy");
  return promptExecutionPolicy(stored, false);
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
