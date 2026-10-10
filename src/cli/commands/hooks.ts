import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "../core/config";
import { formatHookResult, runHooks } from "../core/hooks/engine";
import { loadHookPolicy, parseHookProfile, saveHookProfile } from "../core/hooks/policy-loader";
import type { HookContext, HookEvent } from "../core/hooks/types";
import { isSandbox } from "../core/paths";
import { resolveCanonicalProjectKey, resolveProject } from "../core/project";

export interface HooksOptions {
  action: string;
  args: string[];
  command: string | undefined;
  paths: string | undefined;
  profile: string | undefined;
  project: string | undefined;
  confirm: string | undefined;
  json: boolean;
}

export function runHooksCommand(options: HooksOptions): void {
  const action = options.action || "help";

  switch (action) {
    case "check":
      printHookCheck(options);
      return;
    case "events":
      printEvents();
      return;
    case "status":
      printHooksStatus(options);
      return;
    case "profile":
      printHooksProfile(options);
      return;
    case "help":
    case "--help":
    case "-h":
      printHooksHelp();
      return;
    default:
      throw new Error(`Comando hooks invalido: ${action}. Usa check, events o help.`);
  }
}

function printHookCheck(options: HooksOptions): void {
  const config = loadConfig();
  const project = resolveProject(config.paths.cwd, config.projects.aliases);
  const event = parseHookEvent(options.args[0]);
  const projectKey = options.project ? resolveCanonicalProjectKey(options.project, config.projects.aliases) : project.canonicalKey;
  const profileOverride = options.profile ? parseHookProfile(options.profile) : undefined;
  const policyLoad = loadHookPolicy(config.paths, projectKey, profileOverride);
  const targetPaths = parseTargetPaths(options.paths, config.paths.cwd, event);
  const context: HookContext = {
    event,
    harness: "cli",
    profile: policyLoad.policy.profile,
    cwd: config.paths.cwd,
    projectRoot: project.root,
    malahorHome: config.paths.malahorHome,
    project: projectKey,
    policy: policyLoad.policy,
    command: options.command,
    targetPaths,
    confirmation: options.confirm,
    destructive: event.includes(".apply") || event.startsWith("git.reset") || event.startsWith("git.checkout"),
    metadata: metadataForEvent(event, options.confirm),
  };
  const result = runHooks(context);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\nmalahor-ai hooks\n================\n`);
    process.stdout.write(`Project: ${projectKey}\n`);
    process.stdout.write(`Project root: ${project.root}\n`);
    process.stdout.write(`Policy sources: ${policyLoad.sources.length > 0 ? policyLoad.sources.join(", ") : "defaults"}\n`);
    process.stdout.write(`Sandbox: ${isSandbox(config.paths) ? "yes" : "no"}\n`);
    process.stdout.write(`${formatHookResult(result)}\n`);
  }

  if (result.decision === "deny") {
    process.exitCode = 2;
  }
}

function printHooksStatus(options: HooksOptions): void {
  const config = loadConfig();
  const currentProject = resolveProject(config.paths.cwd, config.projects.aliases);
  const projectKey = options.project ? resolveCanonicalProjectKey(options.project, config.projects.aliases) : currentProject.canonicalKey;
  const policyLoad = loadHookPolicy(config.paths, projectKey, options.profile ? parseHookProfile(options.profile) : undefined);

  process.stdout.write(`\nmalahor-ai hooks status\n=======================\n`);
  process.stdout.write(`Project: ${projectKey}\n`);
  process.stdout.write(`Profile: ${policyLoad.policy.profile}\n`);
  process.stdout.write(`Default policy: ${policyLoad.defaultPath}\n`);
  process.stdout.write(`Project policy: ${policyLoad.projectPath ?? "none"}\n`);
  process.stdout.write(`Sources: ${policyLoad.sources.length > 0 ? policyLoad.sources.join(", ") : "built-in defaults"}\n`);
  if (policyLoad.warnings.length > 0) {
    process.stdout.write(`Warnings:\n- ${policyLoad.warnings.join("\n- ")}\n`);
  }
  process.stdout.write(`Rules:\n`);
  process.stdout.write(`- git.blockDestructiveCommands=${policyLoad.policy.git.blockDestructiveCommands}\n`);
  process.stdout.write(`- git.requireChecksBeforePush=${policyLoad.policy.git.requireChecksBeforePush}\n`);
  process.stdout.write(`- git.validateCommitMessage=${policyLoad.policy.git.validateCommitMessage}\n`);
  process.stdout.write(`- secrets.scanBeforeCommit=${policyLoad.policy.secrets.scanBeforeCommit}\n`);
  process.stdout.write(`- memory.destructiveRequiresPreview=${policyLoad.policy.memory.destructiveRequiresPreview}\n`);
  process.stdout.write(`- policy.enforceDeferredPolicy=${policyLoad.policy.policy.enforceDeferredPolicy}\n`);
  process.stdout.write(`- policy.blockTotalBashDeny=${policyLoad.policy.policy.blockTotalBashDeny}\n`);
  process.stdout.write(`- quality.warnLargeFiles=${policyLoad.policy.quality.warnLargeFiles}\n`);
  process.stdout.write(`- quality.warnGenericModules=${policyLoad.policy.quality.warnGenericModules}\n`);
}

function printHooksProfile(options: HooksOptions): void {
  const subcommand = options.args[0] ?? "get";
  const config = loadConfig();
  const currentProject = resolveProject(config.paths.cwd, config.projects.aliases);
  const projectKey = options.project ? resolveCanonicalProjectKey(options.project, config.projects.aliases) : undefined;

  if (subcommand === "get") {
    const policyLoad = loadHookPolicy(config.paths, projectKey ?? currentProject.canonicalKey, options.profile ? parseHookProfile(options.profile) : undefined);
    process.stdout.write(`Project: ${projectKey ?? currentProject.canonicalKey}\n`);
    process.stdout.write(`Profile: ${policyLoad.policy.profile}\n`);
    process.stdout.write(`Sources: ${policyLoad.sources.length > 0 ? policyLoad.sources.join(", ") : "built-in defaults"}\n`);
    return;
  }

  if (subcommand === "set") {
    const profile = parseHookProfile(options.args[1] ?? "");
    const filePath = saveHookProfile(config.paths, profile, projectKey);
    process.stdout.write(`Profile: ${profile}\n`);
    process.stdout.write(`Scope: ${projectKey ? `project ${projectKey}` : "default"}\n`);
    process.stdout.write(`Saved: ${filePath}\n`);
    return;
  }

  throw new Error("Uso: malahor-ai hooks profile get|set <profile> [--project <key>]");
}

function parseTargetPaths(value: string | undefined, cwd: string, event: HookEvent): string[] {
  if (value?.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  if (event === "git.commit.before" || event === "git.push.before" || event === "file.stage.before") {
    return changedFiles(cwd);
  }

  return [];
}

function changedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--short"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) ?? line : line)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function metadataForEvent(event: HookEvent, confirm: string | undefined): Record<string, unknown> {
  if (event === "memory.delete.apply" || event === "memory.move.apply" || event === "memory.restore.apply") {
    return {
      previewToken: confirm ? "cli-preview-confirmed" : "",
      requiresConfirmation: confirm ?? "<requiresConfirmation del preview>",
    };
  }

  return {};
}

function parseHookEvent(value: string | undefined): HookEvent {
  if (!value) throw new Error("Uso: malahor-ai hooks check <event>");
  if (HOOK_EVENTS.includes(value as HookEvent)) return value as HookEvent;
  throw new Error(`Evento hook invalido: ${value}. Usa \`malahor-ai hooks events\`.`);
}

const HOOK_EVENTS: HookEvent[] = [
  "project.resolve.before",
  "context.recover.before",
  "context.save.before",
  "memory.write.before",
  "memory.delete.preview",
  "memory.delete.apply",
  "memory.move.preview",
  "memory.move.apply",
  "memory.restore.preview",
  "memory.restore.apply",
  "obsidian.write.before",
  "graphify.generate.before",
  "install.preflight",
  "install.beforePolicy",
  "update.preflight",
  "uninstall.beforeRemove",
  "git.commit.before",
  "git.push.before",
  "git.reset.before",
  "git.checkout.before",
  "git.rebase.before",
  "file.stage.before",
  "dependency.add.before",
  "api.change.before",
  "database.change.before",
  "quality.check.before",
];

function printEvents(): void {
  process.stdout.write(`${HOOK_EVENTS.join("\n")}\n`);
}

function printHooksHelp(): void {
  process.stdout.write(`
Usage:
  malahor-ai hooks check <event> [--profile standard|strict|release] [--command <cmd>] [--paths a,b] [--confirm TOKEN] [--json]
  malahor-ai hooks status [--project <key>]
  malahor-ai hooks profile get [--project <key>]
  malahor-ai hooks profile set off|light|standard|strict|release [--project <key>]
  malahor-ai hooks events

Ejemplos:
  malahor-ai hooks check git.commit.before
  malahor-ai hooks check git.push.before --confirm CHECKS_OK
  malahor-ai hooks check git.reset.before --command "git reset --hard"
  malahor-ai hooks check file.stage.before --paths .env,src/index.ts

Decisiones:
  allow: sin hallazgos
  warn: continuar con cuidado
  ask: requiere confirmacion humana o evidencia
  deny: bloqueado; salida 2
`);
}
