import fs from "node:fs";
import path from "node:path";
import { backupFile } from "../core/backup";
import { copyAssets } from "../core/assets";
import { formatBuildAutonomy, formatModelSelection, loadConfig } from "../core/config";
import { detectEnvironment } from "../core/detector";
import { syncOpenCodeConfig } from "../core/injector";
import { resolvePackagePaths } from "../core/package";
import { isSandbox } from "../core/paths";

export interface UpdateOptions {
  dryRun: boolean;
  yes: boolean;
}

export function runUpdate(options: UpdateOptions): void {
  const config = loadConfig();
  const paths = config.paths;
  const detection = detectEnvironment(paths);
  const packagePaths = resolvePackagePaths(paths.cwd);
  const opencodeAsset = path.join(packagePaths.assetsDir, "opencode", "OPENCODE.md");

  printHeader("malahor-ai update");
  printLine(`Mode: ${config.mode}`);
  printLine(`Config file: ${paths.configFile}`);
  printLine(`Malahor home: ${paths.malahorHome}`);
  printLine(`OpenCode dir: ${paths.opencodeDir}`);
  printLine(`Plan model: ${formatModelSelection(config.models.planning)}`);
  printLine(`Build model: ${formatModelSelection(config.models.execution)}`);
  printLine(`Build autonomy: ${formatBuildAutonomy(config.autonomy.build)}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  if (detection.nodeMajor < 22) {
    throw new Error(`Node 22+ es requerido. Detectado: ${detection.nodeVersion}`);
  }

  if (!options.dryRun && !fs.existsSync(packagePaths.mnemoBuild)) {
    throw new Error("No existe dist/mnemo/index.js. Ejecuta `bun run build` antes de actualizar.");
  }

  if (!fs.existsSync(opencodeAsset)) {
    throw new Error("No existe assets/opencode/OPENCODE.md.");
  }

  if (!options.dryRun) {
    fs.mkdirSync(paths.mnemoDir, { recursive: true });
    fs.mkdirSync(paths.assetsDir, { recursive: true });
    fs.mkdirSync(paths.graphsDir, { recursive: true });
    fs.mkdirSync(paths.vaultDir, { recursive: true });
    fs.mkdirSync(paths.opencodeDir, { recursive: true });
  }

  const configBackup = backupFile(paths.opencodeConfig, paths.backupsDir, options.dryRun);
  const mdBackup = backupFile(paths.opencodeMd, paths.backupsDir, options.dryRun);

  if (!options.dryRun) {
    fs.copyFileSync(packagePaths.mnemoBuild, paths.mnemoIndex);
    fs.copyFileSync(opencodeAsset, paths.opencodeMd);
  }

  copyAssets(packagePaths.assetsDir, paths.assetsDir, options.dryRun);
  syncOpenCodeConfig(
    paths,
    {
      planningModel: config.models.planning,
      executionModel: config.models.execution,
      buildAutonomy: config.autonomy.build,
    },
    options.dryRun,
  );

  printLine(configBackup.created ? `Backup config: ${configBackup.destination}` : "Backup config: skipped");
  printLine(mdBackup.created ? `Backup OPENCODE.md: ${mdBackup.destination}` : "Backup OPENCODE.md: skipped");
  printLine(`Assets: ${options.dryRun ? "would refresh" : "refreshed"}`);
  printLine(`Mnemo MCP: ${options.dryRun ? "would refresh" : "refreshed"}`);
  printLine(config.models.planning ? `OpenCode plan agent: ${options.dryRun ? "would sync" : "synced"}` : "OpenCode plan agent: unchanged");
  printLine(config.models.execution ? `OpenCode build agent: ${options.dryRun ? "would sync" : "synced"}` : "OpenCode build agent: unchanged");
  printLine(config.autonomy.build ? `OpenCode build autonomy: ${options.dryRun ? "would sync" : "synced"}` : "OpenCode build autonomy: unchanged");
  printLine(`OPENCODE.md: ${options.dryRun ? "would refresh" : "refreshed"}`);
  printLine("Local data: kept");
  printLine("Next: run `malahor-ai doctor`");
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
