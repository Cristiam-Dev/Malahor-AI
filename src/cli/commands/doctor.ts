import fs from "node:fs";
import path from "node:path";
import { copyAssets } from "../core/assets";
import { formatExecutionPolicy, loadConfig, type MalahorConfig, type MalahorExecutionPolicy } from "../core/config";
import { levelForProject } from "../core/context";
import { detectEnvironment } from "../core/detector";
import { graphifyStatus } from "../core/graphify";
import { loadHookPolicy } from "../core/hooks/policy-loader";
import { isMalahorBashPolicy, readOpenCodeConfig, syncOpenCodeConfig, type OpenCodeConfig } from "../core/injector";
import { MALAHOR_COMMAND_FILES, syncOpenCodeCommands } from "../core/opencode-commands";
import { resolvePackagePaths, type MalahorPackagePaths } from "../core/package";
import { isSandbox, type MalahorPaths } from "../core/paths";
import { resolveProject } from "../core/project";

export interface DoctorOptions {
  dryRun: boolean;
  selfHeal: boolean;
}

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  critical: boolean;
}

export function runDoctor(options: DoctorOptions): void {
  const config = loadConfig();
  const paths = config.paths;

  const repairs = options.selfHeal ? selfHeal(config, paths, options.dryRun) : [];
  renderReport(config, paths, repairs, options);
}

function renderReport(config: MalahorConfig, paths: MalahorPaths, repairs: string[], options: DoctorOptions): void {
  const project = resolveProject(paths.cwd, config.projects.aliases);
  const detection = detectEnvironment(paths);
  const graphStatus = graphifyStatus(paths);
  const checks: CheckResult[] = [];

  checks.push({ name: "Node", ok: detection.nodeMajor >= 22, message: detection.nodeVersion, critical: true });
  checks.push({ name: "Supported runtime", ok: detection.platform === "linux" || detection.platform === "darwin" || detection.platform === "win32", message: `platform=${detection.platform} wsl=${String(detection.isWsl)}`, critical: true });
  checks.push({ name: "OpenCode command", ok: detection.commands.opencode, message: detection.commands.opencode ? "found" : "not found", critical: true });
  checks.push({ name: "Malahor home", ok: fs.existsSync(paths.malahorHome), message: paths.malahorHome, critical: true });
  checks.push({ name: "Mnemo dir", ok: fs.existsSync(paths.mnemoDir), message: paths.mnemoDir, critical: true });
  checks.push({ name: "Mnemo index", ok: fs.existsSync(paths.mnemoIndex), message: paths.mnemoIndex, critical: true });
  checks.push({ name: "Assets dir", ok: fs.existsSync(paths.assetsDir), message: paths.assetsDir, critical: true });
  checks.push({ name: "Graphs dir", ok: fs.existsSync(paths.graphsDir), message: paths.graphsDir, critical: true });
  checks.push({ name: "OpenCode config", ok: fs.existsSync(paths.opencodeConfig), message: paths.opencodeConfig, critical: true });
  checks.push({ name: "OPENCODE.md", ok: fs.existsSync(paths.opencodeMd), message: paths.opencodeMd, critical: true });
  checks.push(checkMnemoConfig(paths.opencodeConfig));
  checks.push(checkCompaction(paths.opencodeConfig));
  checks.push(checkOpenCodeCommands(paths));
  checks.push(checkHookPolicy(paths, project.canonicalKey));
  checks.push(...buildPolicyChecks(paths.opencodeConfig, config.execution));
  checks.push({
    name: "Graphify",
    ok: graphStatus.source !== "missing",
    message: graphStatus.source === "missing"
      ? `not installed (python=${graphStatus.python ?? "missing"}; reparable con \`malahor-ai graphify install\`)`
      : `${graphStatus.source}: ${graphStatus.command}${graphStatus.version ? ` (${graphStatus.version})` : ""}`,
    critical: false,
  });

  process.stdout.write(`\nmalahor-ai doctor${options.selfHeal ? " --self-heal" : ""}\n=================\n`);
  process.stdout.write(`Mode: ${config.mode}\n`);
  process.stdout.write(`Config file: ${paths.configFile}\n`);
  process.stdout.write(`Execution policy: ${formatExecutionPolicy(config.execution)}\n`);
  process.stdout.write(`Project: ${project.name}\n`);
  process.stdout.write(`Project root: ${project.root}\n`);
  process.stdout.write(`Canonical key: ${project.canonicalKey}\n`);
  process.stdout.write(`Project context: ${levelForProject(paths.projectsFile, project.canonicalKey)}\n`);
  process.stdout.write(`Project aliases: ${project.aliases.length > 0 ? project.aliases.join(", ") : "none"}\n`);
  process.stdout.write(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}\n\n`);

  if (options.selfHeal) {
    if (repairs.length > 0) {
      process.stdout.write("Reparado:\n");
      for (const repair of repairs) {
        process.stdout.write(`- ${repair}\n`);
      }
    } else {
      process.stdout.write("Reparado: nada (no se requerian cambios)\n");
    }
    process.stdout.write("\n");
  }

  for (const check of checks) {
    const status = check.ok ? "OK" : check.critical ? "FAIL" : "WARN";
    process.stdout.write(`${status} ${check.name}: ${check.message}\n`);
  }

  const failed = checks.filter((check) => !check.ok && check.critical);
  const warnings = checks.filter((check) => !check.ok && !check.critical);

  if (failed.length > 0) {
    process.stdout.write("\nAction: review failed checks. Run `malahor-ai doctor --self-heal` first, then `malahor-ai install --bootstrap --yes`.\n");
    process.exitCode = 1;
    return;
  }

  if (warnings.length > 0) {
    process.stdout.write(`\nStatus: ready with ${warnings.length} warning(s). Opcionales; ver lineas WARN.\n`);
    return;
  }

  process.stdout.write("\nStatus: ready\n");
}

// Self-heal agent-safe: repara lo declarable desde el paquete sin pedir consola.
// Jamas deja permisos mas restrictivos que los guardados en config; migrar legacy deny -> whitelist.
function selfHeal(config: MalahorConfig, paths: MalahorPaths, dryRun: boolean): string[] {
  const repairs: string[] = [];

  const missingDirs = [paths.mnemoDir, paths.assetsDir, paths.graphsDir, paths.vaultDir, paths.opencodeDir].filter((dir) => !fs.existsSync(dir));
  if (missingDirs.length > 0) {
    if (!dryRun) {
      for (const dir of missingDirs) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    repairs.push(`${dryRun ? "crearia" : "creados"} ${missingDirs.length} directorio(s): ${missingDirs.join(", ")}`);
  }

  const packagePaths = tryResolvePackagePaths(paths.cwd);

  if (!packagePaths) {
    repairs.push("AVISO: no se resolvio el paquete malahor-ai desde el cwd; reparaciones de assets/archivos omitidas (corre el heal dentro del repo o reinstala con npm)");
  } else {
    repairInstallFiles(packagePaths, paths, dryRun, repairs);
  }

  repairOpenCodeConfigFile(config, paths, dryRun, repairs);

  return repairs;
}

function tryResolvePackagePaths(cwd: string): MalahorPackagePaths | null {
  try {
    return resolvePackagePaths(cwd);
  } catch {
    return null;
  }
}

function repairInstallFiles(packagePaths: MalahorPackagePaths, paths: MalahorPaths, dryRun: boolean, repairs: string[]): void {
  const opencodeAsset = path.join(packagePaths.assetsDir, "opencode", "OPENCODE.md");
  const commandsAsset = path.join(packagePaths.assetsDir, "opencode", "commands");

  if (!fs.existsSync(paths.mnemoIndex) && fs.existsSync(packagePaths.mnemoBuild)) {
    if (!dryRun) {
      fs.mkdirSync(paths.mnemoDir, { recursive: true });
      fs.copyFileSync(packagePaths.mnemoBuild, paths.mnemoIndex);
    }
    repairs.push(`${dryRun ? "restauraria" : "restaurado"} Mnemo index`);
  }

  if (!fs.existsSync(paths.opencodeMd) && fs.existsSync(opencodeAsset)) {
    if (!dryRun) {
      fs.mkdirSync(paths.opencodeDir, { recursive: true });
      fs.copyFileSync(opencodeAsset, paths.opencodeMd);
    }
    repairs.push(`${dryRun ? "restauraria" : "restaurado"} OPENCODE.md`);
  }

  if (!fs.existsSync(paths.assetsDir) && fs.existsSync(packagePaths.assetsDir)) {
    copyAssets(packagePaths.assetsDir, paths.assetsDir, dryRun);
    repairs.push(`${dryRun ? "restauraria" : "restaurados"} assets`);
  }

  const commandsDir = path.join(paths.opencodeDir, "commands");
  const missingCommands = MALAHOR_COMMAND_FILES.filter((file) => !fs.existsSync(path.join(commandsDir, file)));
  if (missingCommands.length > 0 && fs.existsSync(commandsAsset)) {
    syncOpenCodeCommands(commandsAsset, paths, dryRun);
    repairs.push(`${dryRun ? "reinstalaria" : "reinstalados"} ${missingCommands.length} comando(s) OpenCode: ${missingCommands.join(", ")}`);
  }
}

function repairOpenCodeConfigFile(config: MalahorConfig, paths: MalahorPaths, dryRun: boolean, repairs: string[]): void {
  if (!fs.existsSync(paths.opencodeConfig)) {
    syncOpenCodeConfig(paths, { execution: config.execution }, dryRun);
    repairs.push(`${dryRun ? "crearia" : "creado"} opencode.jsonc con Mnemo/compaction/politica`);
    return;
  }

  let ocConfig: OpenCodeConfig;
  try {
    ocConfig = readOpenCodeConfig(paths.opencodeConfig);
  } catch (error) {
    repairs.push(`FALLO: ${paths.opencodeConfig} esta corrupto (${(error as Error).message}); restaurar backup de ${paths.backupsDir} manualmente`);
    return;
  }

  const problems: string[] = [];
  const mcp = asRecord(ocConfig.mcp);
  const mnemo = mcp ? asRecord(mcp.mnemo) : undefined;
  if (!mnemo || mnemo.type !== "local" || !Array.isArray(mnemo.command) || mnemo.enabled !== true) {
    problems.push("mcp.mnemo");
  }

  const compaction = asRecord(ocConfig.compaction);
  if (!compaction || compaction.auto !== true) {
    problems.push("compaction");
  }

  const build = agentConfig(ocConfig, "build");
  const marker = build ? asRecord(asRecord(build.options)?.malahor) : undefined;
  const markerExecution = marker ? asRecord(marker.execution) : undefined;
  const markerIntervention = markerExecution?.intervention;
  if (markerIntervention !== config.execution.intervention) {
    problems.push("politica desincronizada");
  }

  if (build !== undefined && hasLegacyLock(build)) {
    problems.push("legado deny -> whitelist v2");
  }

  if (problems.length > 0) {
    syncOpenCodeConfig(paths, { execution: config.execution }, dryRun);
    repairs.push(`${dryRun ? "sincronizaria" : "sincronizado"} opencode.jsonc (${problems.join(", ")})`);
  }
}

function hasLegacyLock(build: Record<string, unknown>): boolean {
  const permission = asRecord(build.permission);
  if (!permission) return false;
  if (permission.bash === "deny") return true;

  return permission.edit === "deny" && permission.task === "deny" && permission.bash === undefined && markerPolicyFormat(build) < 2;
}

function markerPolicyFormat(build: Record<string, unknown>): number {
  const marker = asRecord(asRecord(build.options)?.malahor);
  const value = marker?.policyFormat;
  return typeof value === "number" ? value : 1;
}

function buildPolicyChecks(configPath: string, expected: MalahorExecutionPolicy): CheckResult[] {
  if (!fs.existsSync(configPath)) {
    return [{ name: "Build intervention policy", ok: false, message: "opencode.jsonc missing", critical: false }];
  }

  try {
    const config = readOpenCodeConfig(configPath);

    return [checkBuildIntervention(config, expected), checkBuildVerification(config, expected), checkBuildPolicyFormat(config, expected)];
  } catch (error) {
    return [{ name: "Build intervention policy", ok: false, message: (error as Error).message, critical: false }];
  }
}

function checkBuildIntervention(config: OpenCodeConfig, expected: MalahorExecutionPolicy): CheckResult {
  const agent = agentConfig(config, "build");

  if (!agent) {
    return { name: "Build intervention policy", ok: false, message: "agent.build missing", critical: false };
  }

  const execution = asRecord(asRecord(agent.options)?.malahor)?.execution;
  const intervention = asRecord(execution)?.intervention;
  const ok = intervention === expected.intervention;

  return {
    name: "Build intervention policy",
    ok,
    message: ok ? expected.intervention : `expected ${expected.intervention} got ${String(intervention ?? "missing")}`,
    critical: false,
  };
}

function checkBuildPolicyFormat(config: OpenCodeConfig, expected: MalahorExecutionPolicy): CheckResult {
  if (expected.intervention === "ejecutar") {
    return { name: "Build policy format", ok: true, message: "sin bloqueos", critical: false };
  }

  const agent = agentConfig(config, "build");
  const permission = agent ? asRecord(agent.permission) : undefined;
  const bash = permission?.bash;

  if (isMalahorBashPolicy(bash)) {
    return { name: "Build policy format", ok: true, message: "whitelist agent-safe v2", critical: false };
  }

  if (bash === "deny") {
    return { name: "Build policy format", ok: false, message: "legado deny total; migrar con `malahor-ai doctor --self-heal`", critical: false };
  }

  return { name: "Build policy format", ok: false, message: `bash inesperado (${String(bash)}); resync con \`malahor-ai update --yes\``, critical: false };
}

function checkBuildVerification(config: OpenCodeConfig, expected: MalahorExecutionPolicy): CheckResult {
  const agent = agentConfig(config, "build");
  const execution = agent ? asRecord(asRecord(agent.options)?.malahor)?.execution : undefined;
  const verification = asRecord(execution)?.verification;
  const ok = verification === expected.verification;

  return {
    name: "Build read-only verification",
    ok,
    message: ok ? String(expected.verification) : `expected ${String(expected.verification)} got ${String(verification ?? "missing")}`,
    critical: false,
  };
}

function checkCompaction(configPath: string): CheckResult {
  if (!fs.existsSync(configPath)) {
    return { name: "Compaction", ok: false, message: "opencode.jsonc missing", critical: false };
  }

  try {
    const config = readOpenCodeConfig(configPath);
    const compaction = asRecord(config.compaction);
    const ok = Boolean(compaction) && compaction?.auto === true;

    return {
      name: "Compaction",
      ok,
      message: ok ? "auto=true" : "compaction.auto no habilitado",
      critical: false,
    };
  } catch (error) {
    return { name: "Compaction", ok: false, message: (error as Error).message, critical: false };
  }
}

function checkOpenCodeCommands(paths: MalahorPaths): CheckResult {
  const commandsDir = path.join(paths.opencodeDir, "commands");
  const missing = MALAHOR_COMMAND_FILES.filter((file) => !fs.existsSync(path.join(commandsDir, file)));

  return {
    name: "OpenCode commands",
    ok: missing.length === 0,
    message: missing.length === 0 ? `${MALAHOR_COMMAND_FILES.length} instalados` : `faltan: ${missing.join(", ")}`,
    critical: false,
  };
}

function checkHookPolicy(paths: MalahorPaths, project: string): CheckResult {
  const policyLoad = loadHookPolicy(paths, project);
  const ok = policyLoad.warnings.length === 0;

  return {
    name: "Hook policy",
    ok,
    message: ok
      ? `profile=${policyLoad.policy.profile} sources=${policyLoad.sources.length > 0 ? policyLoad.sources.length : "defaults"}`
      : policyLoad.warnings.join("; "),
    critical: false,
  };
}

function checkMnemoConfig(configPath: string): CheckResult {
  if (!fs.existsSync(configPath)) {
    return { name: "Mnemo MCP config", ok: false, message: "opencode.jsonc missing", critical: true };
  }

  try {
    const config = readOpenCodeConfig(configPath);
    const mcp = config.mcp;
    const mnemo = typeof mcp === "object" && mcp !== null ? (mcp as Record<string, unknown>).mnemo : undefined;

    if (typeof mnemo !== "object" || mnemo === null) {
      return { name: "Mnemo MCP config", ok: false, message: "mcp.mnemo missing", critical: true };
    }

    const entry = mnemo as Record<string, unknown>;
    const ok = entry.type === "local" && Array.isArray(entry.command) && entry.enabled === true;

    return {
      name: "Mnemo MCP config",
      ok,
      message: ok ? "type=local command=array enabled=true" : "expected type=local command=array enabled=true",
      critical: true,
    };
  } catch (error) {
    return { name: "Mnemo MCP config", ok: false, message: (error as Error).message, critical: true };
  }
}

function agentConfig(config: OpenCodeConfig, agentName: string): Record<string, unknown> | undefined {
  const agent = asRecord(config.agent);
  return agent ? asRecord(agent[agentName]) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}
