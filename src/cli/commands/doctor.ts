import fs from "node:fs";
import { loadConfig } from "../core/config";
import { detectEnvironment } from "../core/detector";
import { readOpenCodeConfig } from "../core/injector";
import { isSandbox } from "../core/paths";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  critical: boolean;
}

export function runDoctor(): void {
  const config = loadConfig();
  const paths = config.paths;
  const detection = detectEnvironment(paths);
  const checks: CheckResult[] = [];

  checks.push({ name: "Node", ok: detection.nodeMajor >= 22, message: detection.nodeVersion, critical: true });
  checks.push({ name: "Supported runtime", ok: detection.platform === "linux" || detection.platform === "darwin" || detection.platform === "win32", message: `platform=${detection.platform} wsl=${String(detection.isWsl)}`, critical: true });
  checks.push({ name: "OpenCode command", ok: detection.commands.opencode, message: detection.commands.opencode ? "found" : "not found", critical: true });
  checks.push({ name: "Malahor home", ok: fs.existsSync(paths.malahorHome), message: paths.malahorHome, critical: true });
  checks.push({ name: "Mnemo dir", ok: fs.existsSync(paths.mnemoDir), message: paths.mnemoDir, critical: true });
  checks.push({ name: "Mnemo index", ok: fs.existsSync(paths.mnemoIndex), message: paths.mnemoIndex, critical: true });
  checks.push({ name: "Graphs dir", ok: fs.existsSync(paths.graphsDir), message: paths.graphsDir, critical: true });
  checks.push({ name: "OpenCode config", ok: fs.existsSync(paths.opencodeConfig), message: paths.opencodeConfig, critical: true });
  checks.push({ name: "OPENCODE.md", ok: fs.existsSync(paths.opencodeMd), message: paths.opencodeMd, critical: true });
  checks.push(checkMnemoConfig(paths.opencodeConfig));
  checks.push({ name: "Graphify", ok: detection.commands.graphify, message: detection.commands.graphify ? "found" : "not found", critical: false });

  process.stdout.write(`\nmalahor-ai doctor\n=================\n`);
  process.stdout.write(`Mode: ${config.mode}\n`);
  process.stdout.write(`Config file: ${paths.configFile}\n`);
  process.stdout.write(`Sandbox: ${isSandbox(paths) ? "yes" : "no"}\n\n`);

  for (const check of checks) {
    const status = check.ok ? "OK" : check.critical ? "FAIL" : "WARN";
    process.stdout.write(`${status} ${check.name}: ${check.message}\n`);
  }

  const failed = checks.filter((check) => !check.ok && check.critical);
  if (failed.length > 0) {
    process.stdout.write("\nAction: review failed checks. Run `malahor-ai install` after fixing prerequisites.\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write("\nStatus: ready\n");
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
