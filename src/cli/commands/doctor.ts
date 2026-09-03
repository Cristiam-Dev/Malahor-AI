import fs from "node:fs";
import { formatBuildAutonomy, formatModelSelection, loadConfig, type MalahorBuildAutonomy, type MalahorModelSelection } from "../core/config";
import { detectEnvironment } from "../core/detector";
import { readOpenCodeConfig, type OpenCodeConfig } from "../core/injector";
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
  checks.push({ name: "Assets dir", ok: fs.existsSync(paths.assetsDir), message: paths.assetsDir, critical: true });
  checks.push({ name: "Graphs dir", ok: fs.existsSync(paths.graphsDir), message: paths.graphsDir, critical: true });
  checks.push({ name: "OpenCode config", ok: fs.existsSync(paths.opencodeConfig), message: paths.opencodeConfig, critical: true });
  checks.push({ name: "OPENCODE.md", ok: fs.existsSync(paths.opencodeMd), message: paths.opencodeMd, critical: true });
  checks.push(checkMnemoConfig(paths.opencodeConfig));
  checks.push(...buildAgentChecks(paths.opencodeConfig, config.models.planning, config.models.execution, config.autonomy.build));
  checks.push({ name: "Graphify", ok: detection.commands.graphify, message: detection.commands.graphify ? "found" : "not found", critical: false });

  process.stdout.write(`\nmalahor-ai doctor\n=================\n`);
  process.stdout.write(`Mode: ${config.mode}\n`);
  process.stdout.write(`Config file: ${paths.configFile}\n`);
  process.stdout.write(`Plan model: ${formatModelSelection(config.models.planning)}\n`);
  process.stdout.write(`Build model: ${formatModelSelection(config.models.execution)}\n`);
  process.stdout.write(`Build autonomy: ${formatBuildAutonomy(config.autonomy.build)}\n`);
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

function buildAgentChecks(
  configPath: string,
  planningModel: MalahorModelSelection | undefined,
  executionModel: MalahorModelSelection | undefined,
  buildAutonomy: MalahorBuildAutonomy | undefined,
): CheckResult[] {
  if (!planningModel && !executionModel && !buildAutonomy) {
    return [];
  }

  if (!fs.existsSync(configPath)) {
    return missingAgentChecks(planningModel, executionModel, buildAutonomy, "opencode.jsonc missing");
  }

  try {
    const config = readOpenCodeConfig(configPath);
    const checks: CheckResult[] = [];

    if (planningModel) {
      checks.push(checkAgentModel(config, "plan", "Plan agent model", planningModel));
    }

    if (executionModel) {
      checks.push(checkAgentModel(config, "build", "Build agent model", executionModel));
    }

    if (buildAutonomy) {
      checks.push(checkBuildAutonomy(config, buildAutonomy));
    }

    return checks;
  } catch (error) {
    return missingAgentChecks(planningModel, executionModel, buildAutonomy, (error as Error).message);
  }
}

function missingAgentChecks(
  planningModel: MalahorModelSelection | undefined,
  executionModel: MalahorModelSelection | undefined,
  buildAutonomy: MalahorBuildAutonomy | undefined,
  message: string,
): CheckResult[] {
  const checks: CheckResult[] = [];

  if (planningModel) checks.push({ name: "Plan agent model", ok: false, message, critical: false });
  if (executionModel) checks.push({ name: "Build agent model", ok: false, message, critical: false });
  if (buildAutonomy) checks.push({ name: "Build agent autonomy", ok: false, message, critical: false });

  return checks;
}

function checkAgentModel(config: OpenCodeConfig, agentName: string, name: string, expected: MalahorModelSelection): CheckResult {
  const agent = agentConfig(config, agentName);

  if (!agent) {
    return { name, ok: false, message: `agent.${agentName} missing`, critical: false };
  }

  const actualModel = typeof agent.model === "string" ? agent.model : "";
  const actualVariant = typeof agent.variant === "string" ? agent.variant : "";
  const expectedVariant = expected.variant ?? "";
  const ok = actualModel === expected.model && actualVariant === expectedVariant;
  const actual = actualVariant ? `${actualModel} (${actualVariant})` : actualModel || "missing";

  return {
    name,
    ok,
    message: ok ? actual : `expected ${formatModelSelection(expected)} got ${actual}`,
    critical: false,
  };
}

function checkBuildAutonomy(config: OpenCodeConfig, expected: MalahorBuildAutonomy): CheckResult {
  const agent = agentConfig(config, "build");

  if (!agent) {
    return { name: "Build agent autonomy", ok: false, message: "agent.build missing", critical: false };
  }

  const permission = asRecord(agent.permission) ?? {};
  const locked = permission.edit === "deny" && permission.bash === "deny" && permission.task === "deny";
  const ok = expected === "advise" ? locked : !locked;

  return {
    name: "Build agent autonomy",
    ok,
    message: ok ? expected : `expected ${expected} but build agent permissions are ${locked ? "advisory" : "execution-enabled"}`,
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
