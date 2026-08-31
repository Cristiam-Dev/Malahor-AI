import fs from "node:fs";
import path from "node:path";
import { backupFile } from "../core/backup";
import { loadConfig } from "../core/config";
import { detectEnvironment } from "../core/detector";
import { injectMnemoConfig } from "../core/injector";
import { isSandbox } from "../core/paths";

export interface InstallOptions {
  dryRun: boolean;
  yes: boolean;
}

export function runInstall(options: InstallOptions): void {
  const config = loadConfig();
  const paths = config.paths;
  const detection = detectEnvironment(paths);
  const assetsDir = path.resolve(paths.cwd, "assets");
  const mnemoBuild = path.resolve(paths.cwd, "dist", "mnemo", "index.js");
  const opencodeAsset = path.join(assetsDir, "opencode", "OPENCODE.md");

  printHeader("malahor-ai install");
  printLine(`Mode: ${config.mode}`);
  printLine(`Config file: ${paths.configFile}`);
  printLine(`Malahor home: ${paths.malahorHome}`);
  printLine(`OpenCode dir: ${paths.opencodeDir}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  if (detection.nodeMajor < 22) {
    throw new Error(`Node 22+ es requerido. Detectado: ${detection.nodeVersion}`);
  }

  if (!options.dryRun && !fs.existsSync(mnemoBuild)) {
    throw new Error("No existe dist/mnemo/index.js. Ejecuta `bun run build` antes de instalar.");
  }

  if (!fs.existsSync(opencodeAsset)) {
    throw new Error("No existe assets/opencode/OPENCODE.md.");
  }

  if (!options.dryRun) {
    fs.mkdirSync(paths.mnemoDir, { recursive: true });
    fs.mkdirSync(paths.graphsDir, { recursive: true });
    fs.mkdirSync(paths.vaultDir, { recursive: true });
    fs.mkdirSync(paths.opencodeDir, { recursive: true });
  }

  const configBackup = backupFile(paths.opencodeConfig, paths.backupsDir, options.dryRun);
  const mdBackup = backupFile(paths.opencodeMd, paths.backupsDir, options.dryRun);

  if (!options.dryRun) {
    fs.copyFileSync(mnemoBuild, paths.mnemoIndex);
    fs.copyFileSync(opencodeAsset, paths.opencodeMd);
  }

  injectMnemoConfig(paths, options.dryRun);

  printLine(configBackup.created ? `Backup config: ${configBackup.destination}` : "Backup config: skipped");
  printLine(mdBackup.created ? `Backup OPENCODE.md: ${mdBackup.destination}` : "Backup OPENCODE.md: skipped");
  printLine("Mnemo MCP: configured");
  printLine("OPENCODE.md: installed");
  printLine(detection.commands.graphify ? "Graphify: found" : "Graphify: not found. Install with `pip install graphifyy`.");
  printLine("Next: run `malahor-ai doctor`");
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
