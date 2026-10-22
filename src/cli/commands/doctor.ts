import fs from "node:fs";
import path from "node:path";
import { copyAssets } from "../core/assets";
import { backupFile } from "../core/backup";
import { formatExecutionPolicy, loadConfig, type MalahorConfig, type MalahorExecutionPolicy } from "../core/config";
import { levelForProject } from "../core/context";
import { detectEnvironment, detectOpenCodeHost, type DetectionResult, type OpenCodeHostInfo } from "../core/detector";
import { graphifyStatus } from "../core/graphify";
import { loadHookPolicy } from "../core/hooks/policy-loader";
import { isMalahorBashPolicy, readOpenCodeConfig, syncOpenCodeConfig, type OpenCodeConfig } from "../core/injector";
import { instructionsState, syncManagedInstructions } from "../core/instructions";
import { describePluginSync, isManagedContent, syncManagedPlugin } from "../core/managed-plugin";
import { MALAHOR_COMMAND_FILES, syncOpenCodeCommands } from "../core/opencode-commands";
import { hasDuplicateConfigs } from "../core/opencode-config/preview";
import { describeSdkEnsure, ensureOpencodeSdk } from "../core/opencode-sdk";
import { resolvePackagePaths, type MalahorPackagePaths } from "../core/package";
import { isSandbox, type MalahorPaths } from "../core/paths";
import { pluginHealthChecks, type PluginHealthCheck } from "../core/plugin-health";
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
  const detection = detectEnvironment(paths);
  const host = detectOpenCodeHost(paths);
  const packagePaths = tryResolvePackagePaths(paths.cwd);

  const repairs = options.selfHeal ? selfHeal(config, paths, detection, host, packagePaths, options.dryRun) : [];
  renderReport(config, paths, detection, host, packagePaths, repairs, options);
}

function renderReport(
  config: MalahorConfig,
  paths: MalahorPaths,
  detection: DetectionResult,
  host: OpenCodeHostInfo,
  packagePaths: MalahorPackagePaths | null,
  repairs: string[],
  options: DoctorOptions,
): void {
  const project = resolveProject(paths.cwd, config.projects.aliases);
  const graphStatus = graphifyStatus(paths);
  const checks: CheckResult[] = [];

  checks.push({ name: "Node", ok: detection.nodeMajor >= 22, message: detection.nodeVersion, critical: true });
  checks.push({ name: "Supported runtime", ok: detection.platform === "linux" || detection.platform === "darwin" || detection.platform === "win32", message: `platform=${detection.platform} wsl=${String(detection.isWsl)}`, critical: true });
  checks.push({ name: "OpenCode command", ok: detection.commands.opencode, message: detection.commands.opencode ? "found" : "not found", critical: true });
  checks.push(checkOpenCodeHost(host));
  checks.push({ name: "Malahor home", ok: fs.existsSync(paths.malahorHome), message: paths.malahorHome, critical: true });
  checks.push({ name: "Mnemo dir", ok: fs.existsSync(paths.mnemoDir), message: paths.mnemoDir, critical: true });
  checks.push({ name: "Mnemo index", ok: fs.existsSync(paths.mnemoIndex), message: paths.mnemoIndex, critical: true });
  checks.push({ name: "Assets dir", ok: fs.existsSync(paths.assetsDir), message: paths.assetsDir, critical: true });
  checks.push({ name: "Graphs dir", ok: fs.existsSync(paths.graphsDir), message: paths.graphsDir, critical: true });
  checks.push({ name: "OpenCode config", ok: fs.existsSync(paths.opencodeConfig), message: paths.opencodeConfig, critical: true });
  checks.push(checkInstructions(paths));
  checks.push(checkLegacyInstructions(paths));
  checks.push(checkMnemoConfig(paths.opencodeConfig, host, paths));
  checks.push(checkCompaction(paths.opencodeConfig));
  checks.push(checkOpenCodeCommands(paths));
  checks.push(checkOpenCodeConfigDuplicates(paths));
  for (const check of pluginHealthChecks({ paths, host, packagePaths })) {
    checks.push(fromPluginHealth(check));
  }
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
  process.stdout.write(`OpenCode dir: ${paths.opencodeDir}\n`);
  process.stdout.write(`OpenCode host: ${formatOpenCodeHost(host)}\n`);
  process.stdout.write(`Execution policy: ${formatExecutionPolicy(config.execution)}\n`);
  process.stdout.write(`Project: ${project.name}\n`);
  process.stdout.write(`Project root: ${project.root}\n`);
  process.stdout.write(`Canonical key: ${project.canonicalKey}\n`);
  process.stdout.write(`Project context: ${levelForProject(paths.projectsFile, project.canonicalKey)}\n`);
  process.stdout.write(`Project aliases: ${project.aliases.length > 0 ? project.aliases.join(", ") : "none"}\n`);
  process.stdout.write(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}\n\n`);

  if (options.selfHeal) {
    const repairLabel = options.dryRun ? "Repararia (dry-run)" : "Reparado";
    if (repairs.length > 0) {
      process.stdout.write(`${repairLabel}:\n`);
      for (const repair of repairs) {
        process.stdout.write(`- ${repair}\n`);
      }
    } else {
      process.stdout.write(`${repairLabel}: nada (no se requerian cambios)\n`);
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
function selfHeal(
  config: MalahorConfig,
  paths: MalahorPaths,
  detection: DetectionResult,
  host: OpenCodeHostInfo,
  packagePaths: MalahorPackagePaths | null,
  dryRun: boolean,
): string[] {
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

  if (!packagePaths) {
    repairs.push("AVISO: no se resolvio el paquete malahor-ai desde el cwd; reparaciones de assets/archivos omitidas (corre el heal dentro del repo o reinstala con npm)");
  } else {
    repairInstallFiles(packagePaths, paths, dryRun, repairs);
    repairManagedPlugin(packagePaths, paths, dryRun, repairs);
  }

  repairSdk(paths, detection, dryRun, repairs);

  archiveLegacyInstructions(paths, dryRun, repairs);

  repairOpenCodeConfigFile(config, paths, host, dryRun, repairs);

  return repairs;
}

function tryResolvePackagePaths(cwd: string): MalahorPackagePaths | null {
  try {
    return resolvePackagePaths(cwd);
  } catch {
    return null;
  }
}

function repairManagedPlugin(packagePaths: MalahorPackagePaths, paths: MalahorPaths, dryRun: boolean, repairs: string[]): void {
  const pluginAsset = path.join(packagePaths.assetsDir, "opencode", "plugins", "malahor", "index.ts");

  if (!fs.existsSync(pluginAsset)) {
    repairs.push("AVISO: asset del plugin no encontrado; no se repara el plugin");
    return;
  }

  const plugin = syncManagedPlugin(pluginAsset, paths.malahorPluginDir, paths.backupsDir, dryRun);
  if (plugin.status !== "up-to-date") {
    repairs.push(describePluginSync(plugin));
  }
}

function repairSdk(paths: MalahorPaths, detection: DetectionResult, dryRun: boolean, repairs: string[]): void {
  const sdk = ensureOpencodeSdk({
    opencodeDir: paths.opencodeDir,
    backupsDir: paths.backupsDir,
    stateFile: paths.opencodeSdkState,
    dryRun,
    commands: { bun: detection.commands.bun, npm: detection.commands.npm },
  });

  if (sdk.status !== "up-to-date") {
    repairs.push(describeSdkEnsure(sdk));
  }
}

function repairInstallFiles(packagePaths: MalahorPackagePaths, paths: MalahorPaths, dryRun: boolean, repairs: string[]): void {
  const agentsAsset = path.join(packagePaths.assetsDir, "opencode", "AGENTS.md");
  const commandsAsset = path.join(packagePaths.assetsDir, "opencode", "commands");

  if (!fs.existsSync(paths.mnemoIndex) && fs.existsSync(packagePaths.mnemoBuild)) {
    if (!dryRun) {
      fs.mkdirSync(paths.mnemoDir, { recursive: true });
      fs.copyFileSync(packagePaths.mnemoBuild, paths.mnemoIndex);
    }
    repairs.push(`${dryRun ? "restauraria" : "restaurado"} Mnemo index`);
  }

  if (fs.existsSync(agentsAsset)) {
    const agentsSync = syncManagedInstructions(agentsAsset, paths.agentsMd, paths.backupsDir, dryRun);

    if (agentsSync.action === "created") {
      repairs.push(`${dryRun ? "crearia" : "creado"} AGENTS.md gestionado`);
    } else if (agentsSync.action === "refreshed") {
      repairs.push(`${dryRun ? "refrescaria" : "refrescado"} AGENTS.md gestionado (backup ${agentsSync.backup?.destination ?? "en backups"})`);
    }
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

// Migracion asistida: el OPENCODE.md de versiones previas quedo inerte en OpenCode V2
// (solo lee AGENTS.md). Se archiva (copia a backups + retiro); nunca se pierde contenido.
function archiveLegacyInstructions(paths: MalahorPaths, dryRun: boolean, repairs: string[]): void {
  if (!fs.existsSync(paths.opencodeMd)) return;

  const backup = backupFile(paths.opencodeMd, paths.backupsDir, dryRun);

  if (!dryRun) {
    fs.unlinkSync(paths.opencodeMd);
  }

  repairs.push(`${dryRun ? "archivaria" : "archivado"} OPENCODE.md legado (inerte en V2) en ${backup.destination ?? paths.backupsDir}`);
}

function repairOpenCodeConfigFile(config: MalahorConfig, paths: MalahorPaths, host: OpenCodeHostInfo, dryRun: boolean, repairs: string[]): void {
  if (hasDuplicateConfigs(paths.opencodeDir)) {
    repairs.push("AVISO: opencode.json y opencode.jsonc coexisten; el self-heal no consolida ni reescribe. Usa `malahor-ai config`.");
    return;
  }

  if (!fs.existsSync(paths.opencodeConfig)) {
    syncOpenCodeConfig(paths, { execution: config.execution, manageMcp: host.kind !== "v2" }, dryRun);
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
  const validLegacyMnemo = mnemo && mnemo.type === "local" && Array.isArray(mnemo.command) && mnemo.enabled === true;
  if (!validLegacyMnemo && !(host.kind === "v2" && pluginManagesMcp(paths))) {
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
    syncOpenCodeConfig(paths, { execution: config.execution, manageMcp: host.kind !== "v2" }, dryRun);
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
  const agent = agentConfig(config, "build");
  const permission = agent ? asRecord(agent.permission) : undefined;
  const bash = permission?.bash;

  if (isMalahorBashPolicy(bash)) {
    return {
      name: "Build policy format",
      ok: false,
      message: "whitelist bash legacy presente; se conserva, pero ya no es la fuente de verdad: autoriza el motor de hooks/plugin (T-5.1.7 la retira)",
      critical: false,
    };
  }

  if (bash === "deny") {
    return { name: "Build policy format", ok: false, message: "legado bash:deny total; no se borra en T-5.1.3; la autorizacion efectiva es el motor de hooks", critical: false };
  }

  if (expected.intervention === "ejecutar") {
    return { name: "Build policy format", ok: true, message: "sin bloqueos", critical: false };
  }

  if (bash === undefined) {
    return { name: "Build policy format", ok: true, message: "sin whitelist bash legacy; autorizacion en motor de hooks/plugin", critical: false };
  }

  return { name: "Build policy format", ok: false, message: `bash inesperado (${String(bash)}); revisar configuracion, no se reescribe en T-5.1.3`, critical: false };
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

function checkOpenCodeConfigDuplicates(paths: MalahorPaths): CheckResult {
  if (!hasDuplicateConfigs(paths.opencodeDir)) {
    return { name: "OpenCode config duplicados", ok: true, message: "opencode.json/opencode.jsonc sin duplicados", critical: false };
  }

  return { name: "OpenCode config duplicados", ok: false, message: "opencode.json y opencode.jsonc coexisten; usar `malahor-ai config` (el self-heal no los consolida)", critical: false };
}

function checkInstructions(paths: MalahorPaths): CheckResult {
  const state = instructionsState(paths.agentsMd);

  if (state === "managed") {
    return { name: "AGENTS.md", ok: true, message: `${paths.agentsMd} (gestionado por Malahor)`, critical: true };
  }

  if (state === "foreign") {
    return { name: "AGENTS.md", ok: true, message: `${paths.agentsMd} (propio; no gestionado por Malahor)`, critical: true };
  }

  return { name: "AGENTS.md", ok: false, message: `falta: ${paths.agentsMd} (corre \`malahor-ai update --yes\` o \`malahor-ai doctor --self-heal\`)`, critical: true };
}

function checkLegacyInstructions(paths: MalahorPaths): CheckResult {
  if (!fs.existsSync(paths.opencodeMd)) {
    return { name: "OPENCODE.md (legado)", ok: true, message: "no presente", critical: false };
  }

  return { name: "OPENCODE.md (legado)", ok: false, message: "inerte en V2 (solo se lee AGENTS.md); archivar con `malahor-ai doctor --self-heal`", critical: false };
}

function checkHookPolicy(paths: MalahorPaths, project: string): CheckResult {
  const policyLoad = loadHookPolicy(paths, project);
  const gaps = policyLoad.policyMeta.criticalGaps;
  const ok = policyLoad.warnings.length === 0 && gaps.length === 0;
  const details = [
    `profile=${policyLoad.policy.profile}`,
    `hash=${policyLoad.policyMeta.policyHash.slice(0, 12)}`,
    `corporate=${policyLoad.policyMeta.corporateStatus}`,
    `sources=${policyLoad.sources.length > 0 ? policyLoad.sources.join(",") : "defaults"}`,
    ...(gaps.length > 0 ? [`criticalGaps=${gaps.join(",")}`] : []),
    ...policyLoad.warnings,
  ];

  return {
    name: "Hook policy",
    ok,
    message: details.join("; "),
    critical: gaps.length > 0,
  };
}

function checkMnemoConfig(configPath: string, host: OpenCodeHostInfo, paths: MalahorPaths): CheckResult {
  if (!fs.existsSync(configPath)) {
    if (host.kind === "v2" && pluginManagesMcp(paths)) {
      return { name: "Mnemo MCP config", ok: true, message: "runtime ctx.mcp.transform (sin registro legacy en config)", critical: true };
    }
    return { name: "Mnemo MCP config", ok: false, message: "opencode.jsonc missing", critical: true };
  }

  try {
    const config = readOpenCodeConfig(configPath);
    const mcp = config.mcp;
    const mnemo = typeof mcp === "object" && mcp !== null ? (mcp as Record<string, unknown>).mnemo : undefined;

    if (typeof mnemo !== "object" || mnemo === null) {
      if (host.kind === "v2" && pluginManagesMcp(paths)) {
        return { name: "Mnemo MCP config", ok: true, message: "runtime ctx.mcp.transform (sin registro legacy en config)", critical: true };
      }
      return { name: "Mnemo MCP config", ok: false, message: "mcp.mnemo missing", critical: true };
    }

    const entry = mnemo as Record<string, unknown>;
    const ok = entry.type === "local" && Array.isArray(entry.command) && entry.enabled === true;

    return {
      name: "Mnemo MCP config",
      ok: ok || (host.kind === "v2" && pluginManagesMcp(paths)),
      message: ok
        ? "type=local command=array enabled=true"
        : host.kind === "v2" && pluginManagesMcp(paths)
          ? "runtime ctx.mcp.transform (legacy entry ignored)"
          : "expected type=local command=array enabled=true",
      critical: true,
    };
  } catch (error) {
    return { name: "Mnemo MCP config", ok: false, message: (error as Error).message, critical: true };
  }
}

function pluginManagesMcp(paths: MalahorPaths): boolean {
  const pluginFile = path.join(paths.malahorPluginDir, "index.ts");
  if (!fs.existsSync(pluginFile) || !fs.existsSync(paths.mnemoIndex)) return false;

  try {
    return isManagedContent(fs.readFileSync(pluginFile, "utf8"));
  } catch {
    return false;
  }
}

function checkOpenCodeHost(host: OpenCodeHostInfo): CheckResult {
  if (host.kind === "unknown") {
    return {
      name: "OpenCode host",
      ok: false,
      message: `unknown${host.error ? ` (${host.error})` : ""}`,
      critical: false,
    };
  }

  if (host.kind === "v1") {
    return {
      name: "OpenCode host",
      ok: false,
      message: `${host.kind} ${host.version ?? ""} (V1 sin hooks de mediacion; doctor no certifica cobertura; T-5.6.4 pendiente)`.trim(),
      critical: false,
    };
  }

  return {
    name: "OpenCode host",
    ok: true,
    message: `${host.kind} ${host.version ?? ""}`.trim(),
    critical: true,
  };
}

function formatOpenCodeHost(host: OpenCodeHostInfo): string {
  if (host.kind === "unknown") {
    return `unknown${host.error ? ` (${host.error})` : ""}`;
  }

  return `${host.kind} ${host.version ?? ""}`.trim();
}

function fromPluginHealth(check: PluginHealthCheck): CheckResult {
  return {
    name: check.name,
    ok: check.status === "ok",
    message: check.message,
    critical: check.status === "fail",
  };
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
