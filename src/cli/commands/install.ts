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
  type MalahorExecutionPolicy,
} from "../core/config";
import { saveExecutionPolicy } from "../core/config-write";
import { registerProjectRoot } from "../core/context";
import {
  describeProjectDocsOnboarding,
  persistProjectDocsOnboarding,
  prepareProjectDocsOnboarding,
} from "../core/docs-onboarding";
import { detectEnvironment, detectOpenCodeHost, type DetectionResult, type OpenCodeHostKind } from "../core/detector";
import { parseExecutionLevel, reviseExecutionPolicy } from "../core/execution-policy";
import { assertHooksAllowed } from "../core/hooks/engine";
import { loadHookPolicy } from "../core/hooks/policy-loader";
import { syncOpenCodeConfig } from "../core/injector";
import { describeInstructionsSync, legacyInstructionsHint, syncManagedInstructions } from "../core/instructions";
import { describePluginSync, syncManagedPlugin } from "../core/managed-plugin";
import { beginManagedInstallation, pruneLegacyRuntimeArtifacts } from "../core/managed-installation";
import { assertAgentAssets, describeAgentSync, syncManagedAgents } from "../core/opencode-agents";
import { syncOpenCodeCommands } from "../core/opencode-commands";
import { describeSdkEnsure, ensureOpencodeSdk } from "../core/opencode-sdk";
import { syncOpenCodeSkills } from "../core/opencode-skills";
import { resolvePackagePaths } from "../core/package";
import { ensurePrivateDirectory, isSandbox, type MalahorPaths } from "../core/paths";
import { resolveProject } from "../core/project";
import type { MalahorPackagePaths } from "../core/package";
import { validateInstallation } from "../core/validate";
import { initializeDocsProject } from "../../docs/resolver";

export interface InstallOptions {
  dryRun: boolean;
  yes: boolean;
  bootstrap: boolean;
  policyAfter: string | undefined;
  docsPath?: string;
}

export async function runInstall(options: InstallOptions): Promise<void> {
  const config = loadConfig();
  const paths = config.paths;
  const detection = detectEnvironment(paths);
  const host = detectOpenCodeHost(paths);
  const packagePaths = resolvePackagePaths(paths.cwd);
  const project = resolveProject(packagePaths.root, config.projects.aliases);
  const agentsAsset = path.join(packagePaths.assetsDir, "opencode", "AGENTS.md");
  const commandsAsset = path.join(packagePaths.assetsDir, "opencode", "commands");
  const skillsAsset = path.join(packagePaths.assetsDir, "skills");
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

  const docsChoice = await prepareProjectDocsOnboarding({
    paths,
    aliases: config.projects.aliases,
    project: project.canonicalKey,
    codeRoots: [project.root],
    explicitPath: options.docsPath,
    yes: options.yes || options.bootstrap,
    dryRun: options.dryRun,
  });

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

  const transaction = beginManagedInstallation(paths, options.dryRun);
  try {

  if (!options.dryRun) {
    ensurePrivateDirectory(paths.mnemoDir);
    fs.mkdirSync(paths.docsDir, { recursive: true });
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
    fs.copyFileSync(packagePaths.docsBuild, paths.docsIndex);
  }
  const legacyRuntimeArtifacts = pruneLegacyRuntimeArtifacts(paths, options.dryRun);

  copyAssets(packagePaths.assetsDir, paths.assetsDir, options.dryRun);
  const commands = syncOpenCodeCommands(commandsAsset, paths, options.dryRun);
  const skills = syncOpenCodeSkills(skillsAsset, paths, options.dryRun);
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
  printLine(`Legacy runtime artifacts: ${legacyRuntimeArtifacts.length === 0 ? "none" : `${options.dryRun ? "would remove" : "removed"} ${legacyRuntimeArtifacts.length}`}`);
  printLine(`OpenCode commands: ${options.dryRun ? "would install" : "installed"} ${commands.files} in ${commands.destination}`);
  printLine(`OpenCode skills: ${options.dryRun ? "would sync" : "synced"} ${skills.total} (${skills.created} created, ${skills.updated} updated, ${skills.removed} removed, ${skills.preserved} preserved)`);
  printLine(describeSdkEnsure(sdk));
  printLine(describePluginSync(plugin));
  for (const agent of agents) {
    printLine(describeAgentSync(agent, options.dryRun));
  }
  printLine(`Mnemo MCP: ${host.kind === "v2" ? "runtime plugin transform" : "configured in legacy config"}`);
  printLine(`Docs MCP: ${host.kind === "v2" ? "runtime plugin transform" : "configured in legacy config"}`);
  printLine(`OpenCode compaction: ${host.kind === "v2" ? "runtime plugin hook (verify-only config)" : "configured"}`);

  validateBeforePolicy(paths, packagePaths, options, host.kind === "v2", host.kind === "v2", host.kind);

  const execution = await resolveFinalPolicy(config.execution, options);
  registerProjectRoot(paths.projectsFile, project.canonicalKey, project.root, options.dryRun);
  persistProjectDocsOnboarding(paths, docsChoice, options.dryRun);
  const initialized = initializeDocsProject(
    docsChoice.resolution,
    path.join(packagePaths.assetsDir, "vault-template"),
    options.dryRun,
  );
  printLine(`Docs vault: ${describeProjectDocsOnboarding(docsChoice, options.dryRun)}`);
  printLine(`Docs skeleton: ${options.dryRun ? "would initialize" : "initialized"} (${initialized.created.length} created, ${initialized.kept.length} kept)`);
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
  printLine("Next: run `malahor-ai doctor`. Un cambio de modo aplica desde el siguiente turno de la sesion actual.");
  printLine("Actualizacion posterior: usa /malahor-actualizar sobre una instalacion existente.");
  printLine("Bootstrap y reparacion: /malahor-bootstrap queda para ausencia o reinstalacion; /malahor-reparar aplica self-heal.");
  transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
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
  if (fs.existsSync(packagePaths.mnemoBuild) && fs.existsSync(packagePaths.docsBuild)) return;

  const canAutoBuild = detection.commands.bun && fs.existsSync(path.join(packagePaths.root, "src"));

  if (options.bootstrap && canAutoBuild && !options.dryRun) {
    printLine("Bootstrap: dist/ no existe; corriendo `bun run build` automaticamente...");
    execFileSync("bun", ["run", "build"], { cwd: packagePaths.root, stdio: "inherit" });
    if (fs.existsSync(packagePaths.mnemoBuild) && fs.existsSync(packagePaths.docsBuild)) return;
    throw new Error("`bun run build` no genero los runtimes dist/mnemo y dist/docs. Corre el build manualmente y revisa errores.");
  }

  if (options.dryRun) return;

  throw new Error("Falta dist/mnemo/index.js o dist/docs/index.js. Ejecuta `bun run build` antes de instalar (o usa `install --bootstrap` con bun disponible).");
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
    return reviseExecutionPolicy(stored, intervention, stored.verification);
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
