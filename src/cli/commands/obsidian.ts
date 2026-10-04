import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { backupFile } from "../core/backup";
import { loadConfig } from "../core/config";
import { detectEnvironment } from "../core/detector";
import { readOpenCodeConfig, type OpenCodeConfig } from "../core/injector";
import { isSandbox, type MalahorPaths } from "../core/paths";

export type ObsidianMode = "wsl-windows" | "windows-local";

export interface ObsidianOptions {
  action: string;
  args: string[];
  dryRun: boolean;
  mode?: string;
  yes: boolean;
}

export interface ObsidianArtifacts {
  secretFile: string;
  scriptFile: string;
}

interface ObsidianStatus {
  mode: ObsidianMode;
  isWsl: boolean;
  uvx: boolean;
  windowsHost: string | null;
  secretFile: boolean;
  scriptFile: boolean;
  scriptExecutable: boolean;
  opencodeConfig: string;
  opencodeObsidian: boolean;
  externalDirectoryDenied: boolean;
}

export async function runObsidian(options: ObsidianOptions): Promise<void> {
  const config = loadConfig();
  const paths = config.paths;
  const action = options.action || "help";
  const mode = resolveObsidianMode(paths, options.mode);

  printHeader("malahor-ai obsidian");
  printLine(`Mode: ${mode}`);
  printLine(`Malahor home: ${paths.malahorHome}`);
  printLine(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}`);
  printLine(`Dry-run: ${options.dryRun ? "yes" : "no"}`);

  switch (action) {
    case "status":
      assertNoArgs(options.args, "Uso: malahor-ai obsidian status [--mode wsl-windows|windows-local]");
      printStatus(readStatus(paths, mode));
      return;
    case "guide":
      assertNoArgs(options.args, "Uso: malahor-ai obsidian guide [--mode wsl-windows|windows-local]");
      printGuide(mode);
      return;
    case "verify":
      assertNoArgs(options.args, "Uso: malahor-ai obsidian verify [--mode wsl-windows|windows-local]");
      await printVerify(paths, mode);
      return;
    case "setup":
      assertNoArgs(options.args, "Uso: malahor-ai obsidian setup [--dry-run] [--yes] [--mode wsl-windows|windows-local]");
      await runSetup(paths, mode, options);
      return;
    case "help":
    case "--help":
    case "-h":
      printObsidianHelp();
      return;
    default:
      throw new Error(`Comando obsidian invalido: ${action}. Usa status, guide, verify o setup.`);
  }
}

async function runSetup(paths: MalahorPaths, mode: ObsidianMode, options: ObsidianOptions): Promise<void> {
  const status = readStatus(paths, mode);
  printStatus(status);

  if (mode === "wsl-windows" && !status.isWsl) {
    printLine("Warning: WSL no detectado en modo wsl-windows. Usa --mode windows-local si todo corre nativo en Windows.");
  }

  if (!status.uvx) {
    printLine("Warning: uvx no esta disponible. Instala uv antes de usar el MCP: https://docs.astral.sh/uv/");
  }

  if (mode === "wsl-windows" && !status.windowsHost) {
    printLine("Warning: no se pudo resolver la IP del host Windows desde WSL.");
  }

  const apiKey = await resolveApiKey(paths, mode, options);
  const port = process.env.MALAHOR_OBSIDIAN_PORT || "27124";
  const { secretFile, scriptFile } = artifactPaths(paths, mode);
  const opencodeConfig = resolveOpenCodeConfigPath(paths);

  if (mode === "windows-local") {
    writePowerShellSecret(secretFile, apiKey, port, options.dryRun);
    writePowerShellScript(scriptFile, secretFile, options.dryRun);
  } else {
    writeShellSecret(secretFile, apiKey, port, options.dryRun);
    writeShellScript(scriptFile, secretFile, options.dryRun);
  }

  syncOpenCodeObsidian(paths, opencodeConfig, mode, scriptFile, options.dryRun);

  printLine(`Secret: ${options.dryRun ? "would write" : "written"} ${secretFile}`);
  printLine(`Script: ${options.dryRun ? "would write" : "written"} ${scriptFile}`);
  printLine(`OpenCode config: ${options.dryRun ? "would sync" : "synced"} ${opencodeConfig}`);
  printLine("Permission: external_directory=deny");

  if (!options.dryRun) {
    await printVerify(paths, mode);
  } else {
    printLine("Guide: run `malahor-ai obsidian guide` for manual steps.");
  }
}

export function resolveObsidianMode(paths: MalahorPaths, override?: string): ObsidianMode {
  if (override) {
    if (override === "wsl-windows" || override === "windows-local") return override;
    throw new Error(`Modo obsidian invalido: ${override}. Usa wsl-windows o windows-local.`);
  }

  if (process.platform === "win32") return "windows-local";
  return "wsl-windows";
}

export function artifactPaths(paths: MalahorPaths, mode: ObsidianMode): ObsidianArtifacts {
  if (mode === "windows-local") {
    return {
      secretFile: path.join(paths.secretsDir, "obsidian.ps1"),
      scriptFile: path.join(paths.scriptsDir, "mcp-obsidian.ps1"),
    };
  }

  return {
    secretFile: path.join(paths.secretsDir, "obsidian.env"),
    scriptFile: path.join(paths.scriptsDir, "mcp-obsidian.sh"),
  };
}

function expectedCommand(mode: ObsidianMode, scriptFile: string): string[] {
  if (mode === "windows-local") {
    return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile];
  }

  return [scriptFile];
}

function readStatus(paths: MalahorPaths, mode: ObsidianMode): ObsidianStatus {
  const detection = detectEnvironment(paths);
  const { secretFile, scriptFile } = artifactPaths(paths, mode);
  const opencodeConfig = resolveOpenCodeConfigPath(paths);
  const openCode = readOpenCodeConfig(opencodeConfig);
  const obsidian = asRecord(openCode.mcp)?.obsidian;
  const permission = asRecord(openCode.permission);

  return {
    mode,
    isWsl: detection.isWsl,
    uvx: commandExistsQuiet("uvx"),
    windowsHost: resolveWindowsHost(),
    secretFile: fs.existsSync(secretFile),
    scriptFile: fs.existsSync(scriptFile),
    scriptExecutable: mode === "windows-local" ? fs.existsSync(scriptFile) : isExecutable(scriptFile),
    opencodeConfig,
    opencodeObsidian: isObsidianMcpEntry(obsidian, mode, scriptFile),
    externalDirectoryDenied: permission?.external_directory === "deny",
  };
}

function printStatus(status: ObsidianStatus): void {
  printLine("Status:");
  printLine(`- Mode: ${status.mode}`);
  if (status.mode === "wsl-windows") {
    printCheck("WSL", status.isWsl, status.isWsl ? "detected" : "not detected");
    printCheck("Windows host", Boolean(status.windowsHost), status.windowsHost ?? "not resolved");
  }
  printCheck("uvx", status.uvx, status.uvx ? "found" : "missing");
  printCheck("Secret file", status.secretFile, status.secretFile ? "found" : "missing");
  printCheck("MCP script", status.scriptFile, status.scriptFile ? "found" : "missing");
  if (status.mode === "wsl-windows") {
    printCheck("MCP script executable", status.scriptExecutable, status.scriptExecutable ? "yes" : "no");
  }
  printCheck("OpenCode obsidian MCP", status.opencodeObsidian, status.opencodeConfig);
  printCheck("OpenCode external_directory", status.externalDirectoryDenied, status.externalDirectoryDenied ? "deny" : "not denied");
}

async function printVerify(paths: MalahorPaths, mode: ObsidianMode): Promise<void> {
  const status = readStatus(paths, mode);
  printLine("Verify:");
  printStatus(status);

  const host = mode === "windows-local" ? "127.0.0.1" : status.windowsHost;
  if (!host) {
    printLine("Obsidian REST: skipped, Windows host not resolved");
    printGuide(mode);
    return;
  }

  const { secretFile } = artifactPaths(paths, mode);
  const secret = readSecret(secretFile);
  if (!secret.apiKey) {
    printLine("Obsidian REST: skipped, API key missing");
    printGuide(mode);
    return;
  }

  const result = await probeObsidianRest(host, secret.port, secret.apiKey);
  printCheck("Obsidian REST", result.ok, result.message);

  if (!result.ok) {
    printGuide(mode);
  }
}

function printGuide(mode: ObsidianMode): void {
  printLine(`Guide (${mode}):`);

  if (mode === "windows-local") {
    printLine("1. Abre Obsidian en Windows.");
    printLine("2. Instala y activa el plugin comunitario \"Local REST API\".");
    printLine("3. Copia la API key del plugin.");
    printLine("4. Ejecuta: malahor-ai obsidian setup");
    printLine("5. Verifica con: malahor-ai obsidian verify");
    return;
  }

  printLine("1. Abre Obsidian en Windows y activa el plugin \"Local REST API\".");
  printLine("2. Confirma en el plugin que la interfaz HTTPS responde en el puerto 27124.");
  printLine("3. Si WSL no conecta, permite los puertos 27123 y 27124 en el Firewall de Windows.");
  printLine("4. Copia la API key.");
  printLine("5. Ejecuta: malahor-ai obsidian setup");
  printLine("6. Verifica con: malahor-ai obsidian verify");
}

async function resolveApiKey(paths: MalahorPaths, mode: ObsidianMode, options: ObsidianOptions): Promise<string> {
  if (process.env.MALAHOR_OBSIDIAN_API_KEY) return process.env.MALAHOR_OBSIDIAN_API_KEY;
  const { secretFile } = artifactPaths(paths, mode);
  const current = readSecret(secretFile).apiKey;
  if (current) return current;
  if (options.dryRun) return "dry-run-api-key";

  if (options.yes || !process.stdin.isTTY) {
    throw new Error("Falta API key. Define MALAHOR_OBSIDIAN_API_KEY o ejecuta sin --yes en una terminal interactiva.");
  }

  printLine("Copia la API key del plugin Obsidian Local REST API.");
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("OBSIDIAN_API_KEY: ");
    if (!answer.trim()) throw new Error("API key vacia.");
    return answer.trim();
  } finally {
    rl.close();
  }
}

function writeShellSecret(filePath: string, apiKey: string, port: string, dryRun: boolean): void {
  const content = `export OBSIDIAN_API_KEY=${shellQuote(apiKey)}\nexport OBSIDIAN_PORT=${shellQuote(port)}\n`;
  writeSecretFile(filePath, content, dryRun);
}

function writePowerShellSecret(filePath: string, apiKey: string, port: string, dryRun: boolean): void {
  const content = `$env:OBSIDIAN_API_KEY = ${powershellQuote(apiKey)}\n$env:OBSIDIAN_PORT = ${powershellQuote(port)}\n`;
  writeSecretFile(filePath, content, dryRun);
}

function writeSecretFile(filePath: string, content: string, dryRun: boolean): void {
  if (dryRun) return;
  ensureSecureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  secureChmod(filePath, 0o600);
}

function writeShellScript(filePath: string, secretFile: string, dryRun: boolean): void {
  const content = `#!/bin/bash\nset -euo pipefail\nWINHOST=$(ip route | awk '/default/ {print $3; exit}')\nsource ${shellQuote(secretFile)}\nexport OBSIDIAN_HOST="$WINHOST"\nexport OBSIDIAN_PORT="\${OBSIDIAN_PORT:-27124}"\nexec uvx mcp-obsidian\n`;

  if (dryRun) return;
  ensureSecureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o700 });
  secureChmod(filePath, 0o700);
}

function writePowerShellScript(filePath: string, secretFile: string, dryRun: boolean): void {
  const content = [
    '$ErrorActionPreference = "Stop"',
    '$env:OBSIDIAN_HOST = "127.0.0.1"',
    `. ${powershellQuote(secretFile)}`,
    'if (-not $env:OBSIDIAN_PORT) { $env:OBSIDIAN_PORT = "27124" }',
    "uvx mcp-obsidian",
    "",
  ].join("\n");

  if (dryRun) return;
  ensureSecureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  secureChmod(filePath, 0o600);
}

function ensureSecureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  secureChmod(dir, 0o700);
}

function secureChmod(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows no soporta permisos POSIX; se ignora.
  }
}

function syncOpenCodeObsidian(paths: MalahorPaths, configPath: string, mode: ObsidianMode, scriptFile: string, dryRun: boolean): OpenCodeConfig {
  const backup = backupFile(configPath, paths.backupsDir, dryRun);
  const current = readOpenCodeConfig(configPath);
  const permission = { ...(asRecord(current.permission) ?? {}), external_directory: "deny" };
  const next: OpenCodeConfig = {
    ...current,
    mcp: {
      ...(current.mcp ?? {}),
      obsidian: {
        type: "local",
        command: expectedCommand(mode, scriptFile),
        enabled: true,
      },
    },
    permission,
  };

  if (!dryRun) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  printLine(backup.created ? `Backup OpenCode config: ${backup.destination}` : "Backup OpenCode config: skipped");
  return next;
}

function resolveOpenCodeConfigPath(paths: MalahorPaths): string {
  const json = path.join(paths.opencodeDir, "opencode.json");
  if (fs.existsSync(json)) return json;
  return paths.opencodeConfig;
}

function resolveWindowsHost(): string | null {
  if (process.platform === "win32") return null;

  try {
    return execFileSync("bash", ["-lc", "ip route | awk '/default/ {print $3; exit}'"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function commandExistsQuiet(command: string): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      return true;
    }

    execFileSync("bash", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isExecutable(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && Boolean(fs.statSync(filePath).mode & 0o100);
  } catch {
    return false;
  }
}

function isObsidianMcpEntry(value: unknown, mode: ObsidianMode, scriptFile: string): boolean {
  const entry = asRecord(value);
  if (!entry || entry.type !== "local" || entry.enabled !== true) return false;
  const command = entry.command;
  if (!Array.isArray(command)) return false;
  const expected = expectedCommand(mode, scriptFile);
  return command.length === expected.length && command.every((item, index) => item === expected[index]);
}

function readSecret(filePath: string): { apiKey: string | null; port: string } {
  if (!fs.existsSync(filePath)) return { apiKey: null, port: "27124" };

  const raw = fs.readFileSync(filePath, "utf8");
  const apiKey = readExport(raw, "OBSIDIAN_API_KEY") ?? readPowerShellAssign(raw, "OBSIDIAN_API_KEY");
  const port = readExport(raw, "OBSIDIAN_PORT") ?? readPowerShellAssign(raw, "OBSIDIAN_PORT") ?? "27124";
  return { apiKey, port };
}

function readExport(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^export ${key}=(.*)$`, "m"));
  if (!match) return null;
  return unquoteShellValue(match[1]?.trim() ?? "");
}

function readPowerShellAssign(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^\\$env:${key}\\s*=\\s*(.*)$`, "m"));
  if (!match) return null;
  return unquoteShellValue(match[1]?.trim() ?? "");
}

function unquoteShellValue(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("'\\''", "'").replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

async function probeObsidianRest(host: string, port: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  const httpsResult = await requestObsidian("https", host, port, apiKey);
  if (httpsResult.ok) return httpsResult;
  const httpResult = await requestObsidian("http", host, "27123", apiKey);
  if (httpResult.ok) return httpResult;
  return { ok: false, message: `${httpsResult.message}; ${httpResult.message}` };
}

function requestObsidian(protocol: "http" | "https", host: string, port: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const client = protocol === "https" ? https : http;
    const request = client.request({
      host,
      port,
      path: "/",
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      rejectUnauthorized: false,
      timeout: 2000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const authenticated = body.includes('"authenticated":true') || body.includes('"authenticated": true');
        const suffix = authenticated ? "authenticated" : "not authenticated";
        resolve({ ok: Boolean(response.statusCode && response.statusCode < 500 && authenticated), message: `${protocol}://${host}:${port} status=${response.statusCode ?? "unknown"} ${suffix}` });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, message: `${protocol}://${host}:${port} ${error.message}` });
    });
    request.end();
  });
}

function assertNoArgs(args: string[], usage: string): void {
  if (args.length > 0) throw new Error(usage);
}

function printObsidianHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai obsidian status [--mode wsl-windows|windows-local]
  malahor-ai obsidian guide [--mode wsl-windows|windows-local]
  malahor-ai obsidian setup [--dry-run] [--yes] [--mode wsl-windows|windows-local]
  malahor-ai obsidian verify [--mode wsl-windows|windows-local]

Modos:
  wsl-windows    OpenCode en WSL + Obsidian en Windows (wrapper .sh)
  windows-local  OpenCode y Obsidian nativos en Windows (wrapper .ps1)

Environment:
  MALAHOR_OBSIDIAN_API_KEY  API key del plugin Obsidian Local REST API
  MALAHOR_OBSIDIAN_PORT     Puerto HTTPS del plugin, default 27124
`);
}

function printCheck(label: string, ok: boolean, message: string): void {
  printLine(`- ${label}: ${ok ? "ok" : "missing"} (${message})`);
}

function printHeader(value: string): void {
  process.stdout.write(`\n${value}\n${"=".repeat(value.length)}\n`);
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
